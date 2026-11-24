import React, { useState } from 'react';
import { Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import { AdminAuthStatus } from '../types/attendance';
import { GoogleSignInButton } from './GoogleSignInButton';

interface AdminAuthGateProps {
  authStatus: AdminAuthStatus;
  authStatusLoading: boolean;
  authStatusError: string | null;
  onRetryAuthStatus: () => void;
  isSigningInGoogle: boolean;
  onPasswordLogin: (password: string) => Promise<void>;
  onSetupPassword: (password: string) => Promise<void>;
  onGoogleAdminLogin: () => Promise<void>;
  onBackToGuard: () => void;
}

export const AdminAuthGate: React.FC<AdminAuthGateProps> = ({
  authStatus,
  authStatusLoading,
  authStatusError,
  onRetryAuthStatus,
  isSigningInGoogle,
  onPasswordLogin,
  onSetupPassword,
  onGoogleAdminLogin,
  onBackToGuard,
}) => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const needsFirstRunSetup = !authStatus.hasEnvPasscode && !authStatus.isAdminClaimed;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (needsFirstRunSetup) {
      if (password.trim().length < 4) {
        setError('Admin password must be at least 4 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
      setSubmitting(true);
      try {
        await onSetupPassword(password.trim());
      } catch (err) {
        setError((err as Error).message || 'Could not set Admin password.');
      } finally {
        setSubmitting(false);
      }
    } else {
      if (!password.trim()) {
        setError('Enter your Admin password.');
        return;
      }
      setSubmitting(true);
      try {
        await onPasswordLogin(password.trim());
      } catch (err) {
        setError((err as Error).message || 'Incorrect Admin password.');
      } finally {
        setSubmitting(false);
      }
    }
  };

  if (authStatusLoading) {
    return (
      <div className="mx-auto max-w-md py-8">
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center space-y-3">
          <RefreshCw className="mx-auto h-5 w-5 animate-spin text-slate-500" />
          <p className="text-sm font-medium text-slate-700">
            Checking Admin authentication status...
          </p>
        </div>
      </div>
    );
  }

  if (authStatusError) {
    return (
      <div className="mx-auto max-w-md py-8">
        <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 space-y-4">
          <h2 className="text-base font-bold text-slate-900">
            Unable to Reach GateLog Server
          </h2>
          <p className="text-xs leading-relaxed text-red-700">{authStatusError}</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onRetryAuthStatus}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Retry</span>
            </button>
            <button
              type="button"
              onClick={onBackToGuard}
              className="text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              Back to Guard Gate Desk
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 space-y-6">
        <div className="flex items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-900">
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {needsFirstRunSetup ? 'Set Admin Password' : 'Admin Access Required'}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {needsFirstRunSetup
                ? 'Guard Gate Desk stays open for attendance marking. Create an Admin password to protect employee records and Google Sheets controls.'
                : authStatus.hasEnvPasscode
                ? 'Enter the configured Admin passcode (from Secrets) or sign in with your authorized Google account.'
                : 'This section is restricted to Admin. Unlock with your Admin password or authorized Google account.'}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="admin-password-input"
              className="block text-xs font-medium text-slate-700"
            >
              {needsFirstRunSetup ? 'Create Admin Password' : 'Admin Password'}
            </label>
            <input
              id="admin-password-input"
              type="password"
              required
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              placeholder={needsFirstRunSetup ? 'Minimum 4 characters' : 'Enter password...'}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
            />
          </div>

          {needsFirstRunSetup && (
            <div>
              <label
                htmlFor="admin-password-confirm"
                className="block text-xs font-medium text-slate-700"
              >
                Confirm Admin Password
              </label>
              <input
                id="admin-password-confirm"
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  setError(null);
                }}
                placeholder="Re-enter password..."
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
              />
            </div>
          )}

          {error && <p className="text-xs font-medium text-red-700">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full min-h-[42px] rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-400 transition-colors"
          >
            {submitting
              ? 'Verifying...'
              : needsFirstRunSetup
              ? 'Save Admin Password & Unlock'
              : 'Unlock Admin Panel'}
          </button>
        </form>

        <div className="relative flex items-center py-1">
          <div className="flex-grow border-t border-slate-200" />
          <span className="mx-3 shrink text-xs text-slate-400">or</span>
          <div className="flex-grow border-t border-slate-200" />
        </div>

        <div className="flex flex-col items-center gap-3">
          <GoogleSignInButton
            onClick={onGoogleAdminLogin}
            disabled={isSigningInGoogle}
            label={isSigningInGoogle ? 'Signing in...' : 'Sign in with Google (Admin)'}
          />
          {authStatus.adminEmail && (
            <p className="text-xs text-slate-500 text-center">
              Workspace Admin: {authStatus.adminEmail}
            </p>
          )}
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
