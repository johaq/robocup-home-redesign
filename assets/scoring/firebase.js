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

// Used by dashboard, scoresheet, display, competition — signs in anonymously if needed
export async function ensureAuth() {
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
  return auth.currentUser;
}

// Used by admin — requires email/password auth, never falls back to anonymous
export { signInWithEmailAndPassword, signOut, onAuthStateChanged };
