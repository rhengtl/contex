/**
 * Per-caller rate limiting -- the Durable Object replacement for the in-process
 * deque in contex/web/security.py.
 *
 * The original is explicit that it counts requests inside ONE process, so under
 * N gunicorn workers a caller effectively gets N times the allowance. This
 * version is genuinely global: one object per caller, so the limit is the limit.
 * That is a strict improvement, and one of the few places where moving to the
 * edge fixes something rather than costing something.
 *
 * The algorithm is unchanged: a sliding window of timestamps rather than a
 * counter with a reset, so a caller cannot get a full fresh allowance by
 * waiting for a tick boundary.
 */

// (requests, seconds) per caller, per route group -- the values from
// security.py _RATE_LIMITS. Set either to 0 to turn that group's limit off.
export const LIMITS = {
  convert: [30, 300],
  auth: [20, 300],
};

export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { group } = await request.json();
    const [allowance, window] = LIMITS[group] || [0, 0];
    if (allowance <= 0) return Response.json({ limited: false, retryAfter: 0 });

    const now = Date.now() / 1000;
    const key = `b:${group}`;
    let seen = (await this.state.storage.get(key)) || [];
    seen = seen.filter((t) => now - t <= window);

    if (seen.length >= allowance) {
      const retryAfter = Math.max(1, Math.ceil(window - (now - seen[0])));
      return Response.json({ limited: true, retryAfter });
    }
    seen.push(now);
    await this.state.storage.put(key, seen);
    return Response.json({ limited: false, retryAfter: 0 });
  }
}

/**
 * Ask the limiter whether this caller has used up `group`'s allowance.
 * Identity: the signed-in uid when there is one, the client address otherwise.
 * Fails open -- a limiter outage must not take conversion down with it.
 */
export async function rateLimited(env, request, session, group) {
  if (!env.RATE_LIMITER) return { limited: false, retryAfter: 0 };
  const caller = session.uid || request.headers.get('CF-Connecting-IP') || 'unknown';
  const id = env.RATE_LIMITER.idFromName(`${group}:${caller}`);
  try {
    const res = await env.RATE_LIMITER.get(id).fetch('https://limiter/check', {
      method: 'POST',
      body: JSON.stringify({ group }),
    });
    return await res.json();
  } catch {
    return { limited: false, retryAfter: 0 };
  }
}
