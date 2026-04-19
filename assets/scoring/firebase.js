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

// Used by display, competition (public pages) — signs in anonymously if needed
export async function ensureAuth() {
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

  // Not signed in with email — wait for login via a shared login overlay
  return new Promise((resolve, reject) => {
    const overlay  = document.getElementById('referee-login-overlay');
    const form     = document.getElementById('referee-login-form');
    const emailEl  = document.getElementById('referee-login-email');
    const passEl   = document.getElementById('referee-login-password');
    const btn      = document.getElementById('referee-login-btn');
    const errorEl  = document.getElementById('referee-login-error');

    if (!overlay) { reject(new Error('No login overlay found')); return; }
    overlay.hidden = false;

    form.onsubmit = async e => {
      e.preventDefault();
      errorEl.hidden = true;
      btn.disabled   = true;
      btn.textContent = 'Signing in…';
      try {
        const cred = await signInWithEmailAndPassword(auth, emailEl.value.trim(), passEl.value);
        overlay.hidden = true;
        resolve(cred.user);
      } catch (err) {
        errorEl.textContent = err.code === 'auth/invalid-credential'
          || err.code === 'auth/wrong-password'
          || err.code === 'auth/user-not-found'
          ? 'Incorrect email or password.'
          : 'Sign-in failed. Check your connection.';
        errorEl.hidden  = false;
        btn.disabled    = false;
        btn.textContent = 'Sign in';
      }
    };
  });
}

// Re-exported for admin.js and anywhere else that needs direct auth access
export { signInWithEmailAndPassword, signOut, onAuthStateChanged };
