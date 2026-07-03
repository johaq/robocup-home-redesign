import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import {
  initializeFirestore,
  memoryLocalCache,
  connectFirestoreEmulator
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import {
  initializeAuth, browserLocalPersistence,
  signInAnonymously, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, connectAuthEmulator
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDGeFlm93CEj4ZZBckdSY41t1lq4gw2Sss",
  authDomain: "robocup-home.firebaseapp.com",
  projectId: "robocup-home",
  storageBucket: "robocup-home.firebasestorage.app",
  messagingSenderId: "581379577493",
  appId: "1:581379577493:web:4ab4f7b5ba8fb5ea17ad9c"
};

const app = initializeApp(firebaseConfig);

// ── EMULATOR (localhost only) ── KEEP IN SYNC with src/lib/firebase.ts ──
// localhost → local emulator, deployed → real DB. Decided automatically by hostname so
// production (johaq.github.io) is never affected.
const USE_EMULATOR =
  typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

// Memory cache: avoids all IndexedDB usage. IndexedDB initialization hangs silently
// on some Safari/iOS versions (empty console, perpetual loading), so we use the same
// in-memory approach as firebase-public.js. Referee pages use onSnapshot listeners
// for live data, so no persistent cache is needed within a session.
// Long-polling flags are mutually exclusive — the SDK throws if both are set (which
// crashes the whole module at import → perpetual "loading…"). Force it against the
// emulator (WebChannel is flaky there); auto-detect in production.
export const db = initializeFirestore(app, {
  localCache: memoryLocalCache(),
  ...(USE_EMULATOR
    ? { experimentalForceLongPolling: true }
    : { experimentalAutoDetectLongPolling: true })
});

// initializeAuth without a popupRedirectResolver prevents Firebase from loading
// its cross-origin auth iframe (/__/auth/iframe). That iframe is only needed for
// signInWithPopup/Redirect; we use email+password only. Safari's ITP blocks the
// iframe's cookie access, causing authStateReady() to hang forever → empty console
// and perpetual "loading…" on iOS devices.
export const auth = initializeAuth(app, {
  persistence: browserLocalPersistence,
});

if (USE_EMULATOR) {
  connectFirestoreEmulator(db, 'localhost', 8080);
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
}

// Used by display, competition (public pages) — signs in anonymously if needed.
// Must wait for authStateReady() so we don't overwrite an existing email session.
export async function ensureAuth() {
  await auth.authStateReady();
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
  return auth.currentUser;
}

// Used by scoresheet and dashboard — requires email/password login (referee or admin).
// Returns a Promise that resolves once an email-authenticated session exists.
// Rejects if no login UI element is available.
export async function ensureRefereeAuth() {
  await auth.authStateReady();

  if (auth.currentUser?.email) return auth.currentUser;

  return new Promise((resolve, reject) => {
    const overlay  = document.getElementById('referee-login-overlay');
    const form     = document.getElementById('referee-login-form');
    const emailEl  = document.getElementById('referee-login-email');
    const passEl   = document.getElementById('referee-login-password');
    const btn      = document.getElementById('referee-login-btn');
    const errorEl  = document.getElementById('referee-login-error');

    if (!overlay || !form) { reject(new Error('No login overlay found')); return; }

    // Prevent any programmatic form.submit() calls (e.g. from password managers)
    form.submit = () => {};
    overlay.hidden = false;

    form.addEventListener('submit', function handler(e) {
      e.preventDefault();
      if (btn.disabled) return;

      errorEl.hidden  = true;
      btn.disabled    = true;
      btn.textContent = 'Signing in…';

      signInWithEmailAndPassword(auth, emailEl.value.trim(), passEl.value)
        .then(cred => {
          form.removeEventListener('submit', handler);
          overlay.hidden = true;
          resolve(cred.user);
        })
        .catch(err => {
          const badCreds = ['auth/invalid-credential', 'auth/invalid-login-credentials',
                            'auth/wrong-password', 'auth/user-not-found'];
          errorEl.textContent = badCreds.includes(err.code)
            ? 'Incorrect email or password.'
            : `Sign-in failed: ${err.code}`;
          errorEl.hidden  = false;
          btn.disabled    = false;
          btn.textContent = 'Sign in';
        });
    });
  });
}

// Re-exported for admin.js and anywhere else that needs direct auth access
export { signInWithEmailAndPassword, signOut, onAuthStateChanged };
