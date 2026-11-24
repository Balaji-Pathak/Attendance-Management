import React from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { GoogleSignInButton } from './GoogleSignInButton';

interface AdminAuthGateProps {
  isSigningInGoogle: boolean;
  isLockedBySession: boolean;
  signedInEmail: string | null;
  onGoogleAdminLogin: () => Promise<void>;
  onBackToGuard: () => void;
}

export const AdminAuthGate: React.FC<AdminAuthGateProps> = ({
  isSigningInGoogle,
  isLockedBySession,
  signedInEmail,
  onGoogleAdminLogin,
  onBackToGuard,
}) => {
  return (
    <div className="mx-auto max-w-md py-8">
      <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 space-y-6">
        <div className="flex items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-900">
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {isLockedBySession ? 'Admin Panel Locked' : 'Admin Sign-In Required'}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Guard Gate Desk remains open for attendance marking. Sign in with an authorized company Google account to manage employees, review attendance logs, and sync Google Sheets.
            </p>
          </div>
        </div>

        {signedInEmail && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
            <span className="font-medium">{signedInEmail}</span> does not have Admin access. Please sign in with an authorized company Admin account.
          </div>
        )}

        <div className="flex flex-col items-center gap-3">
          <GoogleSignInButton
            onClick={onGoogleAdminLogin}
            disabled={isSigningInGoogle}
            label={isSigningInGoogle ? 'Signing in...' : 'Sign in with Google (Admin)'}
          />
        </div>

        <div className="border-t border-slate-100 pt-4 text-center">
          <button
            type="button"
            onClick={onBackToGuard}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-700 hover:underline"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Back to Guard Gate Desk</span>
          </button>
        </div>
      </div>
    </div>
  );
};
