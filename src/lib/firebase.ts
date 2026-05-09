import { initializeApp, getApps } from 'firebase/app';
import { initializeFirestore, memoryLocalCache } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyDGeFlm93CEj4ZZBckdSY41t1lq4gw2Sss',
  authDomain: 'robocup-home.firebaseapp.com',
  projectId: 'robocup-home',
  storageBucket: 'robocup-home.firebasestorage.app',
  messagingSenderId: '581379577493',
  appId: '1:581379577493:web:4ab4f7b5ba8fb5ea17ad9c',
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const db = initializeFirestore(app, { localCache: memoryLocalCache() });
export const auth = getAuth(app);

export async function ensureAuth() {
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser;
}
