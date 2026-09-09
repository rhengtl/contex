/**
 * Signing in, signing up, and getting back in -- the browser half of
 * contex/web/auth.py and the Firebase block in templates/auth/login.html.
 *
 * Nothing here decides what counts as a valid credential. Every form posts to
 * the Worker, which asks Firebase, exactly as the Flask routes asked
 * services/accounts.py. The one thing that genuinely has to happen in the
 * browser is the Google popup: only the Firebase SDK can run it, and all it
 * produces is an ID token, which is then verified server-side before any
 * session is issued. That is the same division auth.py had.
 *
 * The SDK is loaded from gstatic, from the same URL and version the Flask
 * templates used, and the CSP names that origin for exactly this reason
 * (security.py _FIREBASE_ORIGINS). It is NOT inlined and not fetched from a
 * CDN of our choosing -- script-src has no 'unsafe-inline' and is not getting
 * one. The <script> elements are created rather than written into the page,
 * which is an external script load and not inline script.
 */

import { el, setText, toggle } from '/ui.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.7.1/';

let sdkPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = resolve;
    tag.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(tag);
  });
}

/**
 * Load and initialise the Firebase browser SDK, once.
 *
 * `config` is the public apiKey/authDomain/projectId trio from /api/session --
 * they identify the project, they are not credentials, and the security rules
 * are what actually protect the data.
 */
export async function firebaseAuth(config) {
  if (!config) return null;
  if (!sdkPromise) {
    sdkPromise = (async () => {
      await loadScript(`${SDK}firebase-app-compat.js`);
      await loadScript(`${SDK}firebase-auth-compat.js`);
      window.firebase.initializeApp(config);
      return window.firebase.auth();
    })().catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let payload = {};
  try { payload = await res.json(); } catch { /* a body we cannot read */ }
  return { ok: res.ok, status: res.status, ...payload };
}

/** Email and password. The Worker answers with auth.py's own wording. */
export function login(email, password, remember) {
  return postJson('/api/auth/login', { email, password, remember: !!remember });
}

/**
 * Google sign-in. The popup runs here; the token it produces is handed
 * straight over and verified server-side before any session exists.
 */
export async function loginWithGoogle(config) {
  const auth = await firebaseAuth(config);
  if (!auth) throw new Error('Google sign-in is not configured.');
  const provider = new window.firebase.auth.GoogleAuthProvider();
  const result = await auth.signInWithPopup(provider);
  const idToken = await result.user.getIdToken();
  // The browser's own Firebase session has served its purpose. Ours is the
  // signed cookie the Worker issues, so this one is dropped rather than left
  // running alongside it with a life of its own.
  try { await auth.signOut(); } catch { /* best effort */ }
  return postJson('/api/auth/login', { idToken });
}

export function signup(fields) {
  return postJson('/api/auth/signup', fields);
}

export function forgotPassword(email) {
  return postJson('/api/auth/forgot', { email });
}

export function logout() {
  return postJson('/api/auth/logout', {});
}

/** shell_context() plus the terms answer, asked once per page load. */
export async function session() {
  const res = await fetch('/api/session', { headers: { accept: 'application/json' } });
  if (!res.ok) {
    return { isAuthenticated: false, hasAcceptedTerms: false,
             maxUploadMb: 32, firebaseConfig: null };
  }
  return res.json();
}

/** pages.py accept_terms(): the version is what was agreed to. */
export function acceptTerms(version) {
  return postJson('/api/session/terms', { version });
}

// ---------------------------------------------------------------------------
// The three account pages
// ---------------------------------------------------------------------------
//
// Flask posted these as real forms and re-rendered the page with an error or a
// success note in it. There is no server to render them here, so the same two
// note boxes are in the markup and this fills one -- which is why the wording
// below is auth.py's own: a message the user reads must not change because the
// code that displays it moved.
//
// The Google button was bound by an inline <script nonce> on each of those
// two templates. It is bound here instead, for the reason the CSP comment in
// _headers gives: this frontend has no inline script at all, so 'self' alone
// is strictly stronger than a nonce.

function showError(message) {
  setText('auth-error-text', message);
  toggle('auth-error', !!message);
  if (message) toggle('auth-success', false);
}

function showSuccess(message) {
  setText('auth-success-text', message);
  toggle('auth-success', !!message);
  if (message) toggle('auth-error', false);
}

/** Disable while a request is in flight, so a double submit cannot happen. */
function submitting(form, working) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = working;
}

function onSubmit(id, handler) {
  const form = el(id);
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    submitting(form, true);
    try {
      await handler(form);
    } finally {
      submitting(form, false);
    }
  });
}

export function setupForms(shell) {
  onSubmit('login-form', async () => {
    const result = await login(el('email').value, el('password').value,
                               el('remember')?.checked);
    if (!result.ok) { showError(result.error || 'Authentication failed'); return; }
    // A fresh document, not a patched one. session.py start_session() clears
    // the whole session on sign-in and says why: "On a shared computer the
    // person signing in is not necessarily the person who was just using it."
    // Navigating away is how that rule reaches the page.
    window.location.href = '/';
  });

  onSubmit('signup-form', async () => {
    const result = await signup({
      fullname: el('fullname').value,
      email: el('email').value,
      password: el('password').value,
      confirm_password: el('confirm-password').value,
      terms: el('terms').checked,
    });
    if (result.ok) showSuccess(result.success || 'Your account is ready.');
    else showError(result.error || 'Failed to create account');
  });

  onSubmit('forgot-form', async () => {
    const result = await forgotPassword(el('email').value);
    if (result.ok) showSuccess(result.success || 'If that address has an account, a reset link is on its way.');
    else showError(result.error || 'An error occurred');
  });

  const google = el('google-signin');
  if (!google) return;
  // No config means no federated sign-in, and a button that cannot work is
  // worse than one that is absent -- which is what the {% if firebase_config %}
  // around this block meant in the Flask template.
  if (!shell.firebaseConfig) return;
  toggle('google-block', true);

  google.addEventListener('click', async () => {
    google.disabled = true;
    toggle('google-error', false);
    try {
      const result = await loginWithGoogle(shell.firebaseConfig);
      if (!result.ok) throw new Error(result.error || 'Authentication failed');
      window.location.href = '/';
    } catch (error) {
      const box = el('google-error');
      if (box) {
        box.textContent = 'Google sign-in did not complete: '
          + (error && error.message ? error.message : 'unknown error');
        box.classList.remove('hidden');
      }
      google.disabled = false;
    }
  });
}
