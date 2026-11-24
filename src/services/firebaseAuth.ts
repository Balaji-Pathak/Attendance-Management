import {
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebaseClient';

export const PRIMARY_ADMIN_EMAIL = 'balajeepathak74@gmail.com';

export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

const provider = new GoogleAuthProvider();
for (const scope of WORKSPACE_SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({
  prompt: 'select_account',
});

let isSigningIn = false;
// Strictly in-memory token cache (never stored in localStorage or sessionStorage)
let cachedAccessToken: string | null = null;

export const initAuth = (
  onAuthChange: (user: User | null, hasToken: boolean) => void
) => {
  return onAuthStateChanged(auth, (user: User | null) => {
    if (!user && !isSigningIn) {
      cachedAccessToken = null;
    }
    onAuthChange(user, Boolean(user && cachedAccessToken));
  });
};

export const checkIsAuthorizedAdmin = async (user: User | null): Promise<boolean> => {
  if (!user || !user.emailVerified) return false;
  if (user.email?.toLowerCase() === PRIMARY_ADMIN_EMAIL) {
    return true;
  }
  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists();
  } catch {
    return false;
  }
};

export const googleSignIn = async (): Promise<{
  user: User;
  accessToken: string;
}> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Could not obtain Google access token. Please try signing in again.');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (err: unknown) {
    const fbErr = err as { code?: string; message?: string };
    if (fbErr?.code === 'auth/unauthorized-domain') {
      const host = typeof window !== 'undefined' ? window.location.hostname : 'current domain';
      throw new Error(
        `Google Sign-In is not authorized for "${host}". Add "${host}" in Firebase Console → Authentication → Settings → Authorized domains.`
      );
    }
    throw err;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const clearCachedToken = (): void => {
  cachedAccessToken = null;
};

export const logout = async (): Promise<void> => {
  await auth.signOut();
  cachedAccessToken = null;
};
