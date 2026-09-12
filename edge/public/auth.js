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

import { el, on, setText, toggle } from '/ui.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.7.1/';

let sdkPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = resolve;
    tag.onerror = () => {
      // Shaped like a Firebase error so the one translation table below
      // can name it; the URL is for the console, not for the person.
      const error = new Error(`Could not load ${src}`);
      error.code = 'contex/sdk-unavailable';
      reject(error);
    };
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
 *
 * `onPhase` is told where the wait is: 'google' while the SDK is loading and
 * the popup is open, 'verify' once Google has answered and the token is on
 * its way to the Worker. The button uses it to say which of the two it is
 * waiting for, because they feel different -- one is in another window, the
 * other is on this page.
 */
export async function loginWithGoogle(config, onPhase = () => {}) {
  onPhase('google');
  const auth = await firebaseAuth(config);
  if (!auth) throw new Error('Google sign-in is not configured.');
  const provider = new window.firebase.auth.GoogleAuthProvider();
  const result = await auth.signInWithPopup(provider);
  onPhase('verify');
  const idToken = await result.user.getIdToken();
  // The browser's own Firebase session has served its purpose. Ours is the
  // signed cookie the Worker issues, so this one is dropped rather than left
  // running alongside it with a life of its own.
  try { await auth.signOut(); } catch { /* best effort */ }
  return postJson('/api/auth/login', { idToken });
}

/**
 * What the person is told when the Google flow fails, by Firebase error code.
 *
 * The SDK's own messages are written for the developer reading a console --
 * "The popup has been closed by the user before finalizing the operation.
 * (auth/popup-closed-by-user)" -- and one of those reached the page for a
 * while. Nothing Firebase says is shown any more; a code that is not in this
 * table gets the last line. The Worker's messages are not translated: those
 * are auth.py's own wording and were written to be read.
 *
 * null means say nothing: cancelled-popup-request is what the FIRST attempt
 * is told when a second one starts, and the second is already in progress.
 */
const GOOGLE_ERRORS = {
  'auth/popup-closed-by-user':
    'The Google window was closed before it finished. Nothing has changed - '
    + 'you can try again whenever you like.',
  'auth/cancelled-popup-request': null,
  'auth/popup-blocked':
    'Your browser blocked the Google window from opening. Allow pop-ups for '
    + 'this site, then try again.',
  'auth/network-request-failed':
    'Google could not be reached. Check your connection and try again.',
  'auth/too-many-requests':
    'Too many attempts in a short time. Wait a moment and try again.',
  'auth/user-disabled':
    'This account has been disabled.',
  'auth/account-exists-with-different-credential':
    'An account with this email already exists. Sign in with your email and '
    + 'password instead.',
  'auth/web-storage-unsupported':
    'Your browser is blocking the storage Google sign-in needs. Try again '
    + 'outside private browsing, or use your email and password.',
  'contex/sdk-unavailable':
    'Google sign-in could not be loaded. Check your connection and try again.',
};

// Everything in this family means the project, not the person: a domain not
// on the allow-list, a provider not enabled, a bad key.
const GOOGLE_MISCONFIGURED = /^auth\/(unauthorized-domain|operation-not-allowed|invalid-api-key|configuration-not-found|app-not-authorized|argument-error)$/;

const GOOGLE_UNAVAILABLE = 'Google sign-in is not available at the moment. '
  + 'You can still use your email and password.';

const GOOGLE_FAILED = 'Google sign-in did not complete. Please try again.';

/** A message for the person, never Firebase's. */
function describeGoogleError(error) {
  const code = (error && error.code) || '';
  if (code in GOOGLE_ERRORS) return GOOGLE_ERRORS[code];
  if (GOOGLE_MISCONFIGURED.test(code)) return GOOGLE_UNAVAILABLE;
  return GOOGLE_FAILED;
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

/**
 * Wire the three auth forms.
 *
 * DELIBERATELY TAKES NOTHING AND AWAITS NOTHING. The Flask templates gave each
 * form `method="POST" action="{{ url_for('auth.login') }}"`, so a submit that
 * arrived before any script had run still did the right thing. These forms
 * have no action, because the handler below is what submits them -- which
 * means that until this listener exists, a submit is a NATIVE GET to the
 * current URL and every field goes into the query string, the password
 * included. It would then sit in history, and in the Referer of the next
 * navigation.
 *
 * So this must not sit behind `await auth.session()`. It is called first, and
 * the parts that genuinely need the shell are in setupGoogle().
 */
export function setupForms() {
  setupReveals();

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
}

// ---------------------------------------------------------------------------
// Continue with Google
// ---------------------------------------------------------------------------
//
// The button has three states -- idle, busy, failed -- and busy has two
// phases, because the wait genuinely moves: first it is in the Google window,
// then it is on this page while the Worker checks the token.
//
// WHY THE STATUS LINE EXISTS. When the Google window is closed before it
// finishes, the Firebase SDK does not say so at once: it notices the window
// has gone and then waits a further eight seconds before rejecting, in case
// the result is still on its way (firebase-auth-compat.js, the
// popup-closed-by-user timeout). For those eight seconds this page used to
// show a greyed-out button and nothing else, which is exactly what a hung page
// looks like. The line under the button now says where the action is and that
// closing the window takes a moment to register -- so the silence is
// explained rather than merely endured. Nothing here shortens it: the SDK
// owns the popup, and there is no handle to poll ourselves.

const GOOGLE_LABEL = 'Continue with Google';

const GOOGLE_PHASES = {
  google: {
    label: 'Waiting for Google\u2026',
    status: 'Finish in the Google window that opened. If you close it, this '
      + 'page takes a few seconds to notice.',
  },
  verify: {
    label: 'Signing you in\u2026',
    status: 'Google answered - checking with ConTeX.',
  },
};

/** Put the Google button into a state: a key of GOOGLE_PHASES, or null for idle. */
function googleState(phase) {
  const button = el('google-signin');
  if (!button) return;
  const busy = !!phase;
  const words = busy ? GOOGLE_PHASES[phase] : null;
  button.disabled = busy;
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
  toggle('google-mark', !busy);
  toggle('google-spinner', busy);
  setText('google-label', busy ? words.label : GOOGLE_LABEL);
  setText('google-status', busy ? words.status : '');
  toggle('google-status', busy);
}

function googleError(message) {
  const box = el('google-error');
  if (!box) return;
  box.textContent = message || '';
  toggle('google-error', !!message);
}

/** The federated button, which cannot be wired until the config has arrived. */
export function setupGoogle(shell) {
  const google = el('google-signin');
  if (!google) return;
  // No config means no federated sign-in, and a button that cannot work is
  // worse than one that is absent -- which is what the {% if firebase_config %}
  // around this block meant in the Flask template.
  if (!shell || !shell.firebaseConfig) return;
  toggle('google-block', true);

  let attempt = 0;

  google.addEventListener('click', async () => {
    // The button is disabled while busy, so a second attempt can only begin
    // after the first has ended -- but the SDK's own reject for a superseded
    // popup arrives late, and must not be allowed to undo a newer attempt's
    // state. Each attempt therefore acts only while it is the current one.
    const mine = ++attempt;
    const current = () => mine === attempt;

    googleError('');
    googleState('google');
    try {
      const result = await loginWithGoogle(shell.firebaseConfig, (phase) => {
        if (current()) googleState(phase);
      });
      if (!current()) return;
      if (!result.ok) {
        googleState(null);
        googleError(result.error || 'Authentication failed');
        return;
      }
      // Left busy on purpose: "Signing you in" stays true until the next
      // document has replaced this one. See the pageshow handler below for
      // the way back.
      window.location.href = '/';
    } catch (error) {
      if (!current()) return;
      googleState(null);
      // Disabling a focused button drops focus on the document in most
      // browsers. Put it back, so the keyboard user who pressed the button
      // is still on it when it comes back to life.
      if (document.activeElement === document.body) google.focus();
      const message = describeGoogleError(error);
      if (message) googleError(message);
    }
  });

  // A successful sign-in navigates away with the button still busy. When the
  // browser restores this page from its back-forward cache, it restores that
  // state with it -- a spinning button on a page nobody is signing in on.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    attempt += 1;
    googleState(null);
    googleError('');
  });
}

// ---------------------------------------------------------------------------
// Show / hide a password
// ---------------------------------------------------------------------------
//
// The toggle flips the input's type; that is the whole mechanism, and it is
// what every browser's own password field does when it offers the same
// control. Each button acts on the input beside it in the same .field-wrap,
// so the sign-up page's two fields are independent: revealing the password
// does not reveal its confirmation, and a person can compare the two by
// revealing both.

function revealPassword(button) {
  const input = button.parentElement && button.parentElement.querySelector('input');
  if (!input) return;
  const shown = input.type === 'password';
  input.type = shown ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(shown));
  button.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
  // By class, through toggle(): an <svg> has no .hidden property to set.
  for (const icon of button.querySelectorAll('[data-reveal-icon]')) {
    toggle(icon, (icon.dataset.revealIcon === 'show') !== shown);
  }
}

function setupReveals() {
  for (const button of document.querySelectorAll('.field-reveal')) {
    const input = button.parentElement.querySelector('input');
    if (input && input.id) button.setAttribute('aria-controls', input.id);
  }
  on('reveal-password', revealPassword);
}
