import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js";
import {
  initializeFirestore,
  memoryLocalCache
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
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

export const db = initializeFirestore(app, {
  localCache: memoryLocalCache()
});

export const auth = getAuth(app);

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
