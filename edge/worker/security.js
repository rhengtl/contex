/**
 * Response headers and the Content-Security-Policy, ported from
 * contex/web/security.py.
 *
 * The policy is default-deny with no 'unsafe-inline' in script-src or
 * style-src -- that property is the point of the original and is preserved
 * here. Two additions are forced by the new architecture and nothing else:
 *
 *   'wasm-unsafe-eval'   the LaTeX engine and the formula model are WASM.
 *                        It permits WebAssembly compilation; it does NOT
 *                        permit eval().
 *   worker-src           SwiftLaTeX runs the engine in a Worker (same origin)
 *                        and ONNX Runtime Web creates one from a blob:.
 *
 * Deliberately absent: COOP/COEP. Cross-origin isolation would buy
 * SharedArrayBuffer for multi-threaded ONNX, and would break the Firebase Auth
 * popup and the gstatic SDK load. See spec R3.
 */

function csp(nonce, authDomain) {
  const firebase = [
    'https://www.gstatic.com',
    'https://apis.google.com',
    authDomain ? `https://${authDomain}` : '',
  ].filter(Boolean).join(' ');

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval' ${firebase}`.trimEnd(),
    "worker-src 'self' blob:",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // blob: for the camera preview, the canvas export and the compiled PDF;
    // data: for the small inline marks; googleusercontent for a Google
    // account's avatar.
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "media-src 'self' blob:",
    `frame-src 'self' blob: ${firebase}`.trimEnd(),
    // Where fetch() may go: this app, and the Firebase Auth endpoints the
    // browser SDK calls directly. The authDomain is in `firebase` above, which
    // is why it is read from config rather than hard-coded -- exactly as
    // security.py does it.
    'connect-src \'self\' https://identitytoolkit.googleapis.com ' +
      'https://securetoken.googleapis.com https://www.googleapis.com ' +
      firebase,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function makeNonce() {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...raw)).replace(/[+/=]/g, '');
}

/**
 * Apply the security headers to a response. Set on every response rather than
 * on HTML routes only: a policy that applies to some responses is a policy
 * with a gap in it.
 */
export function withSecurityHeaders(response, { nonce = '', env = {} } = {}) {
  const h = new Headers(response.headers);
  const set = (k, v) => { if (!h.has(k)) h.set(k, v); };

  set('Content-Security-Policy', csp(nonce, env.FIREBASE_AUTH_DOMAIN || ''));
  // Never let a browser guess that a .tex is HTML.
  set('X-Content-Type-Options', 'nosniff');
  // frame-ancestors above is the real control; this is for older browsers.
  set('X-Frame-Options', 'DENY');
  // A converted document's URL should not travel to another site.
  set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // The app asks for the camera itself and needs nothing else.
  set('Permissions-Policy',
      'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), ' +
      'interest-cohort=()');
  // Always on: Pages and Workers are HTTPS-only, so the production-only guard
  // the Flask app needed does not apply here.
  set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h,
  });
}
