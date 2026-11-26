import React, { useState } from 'react';
import { AlertCircle, Eye, EyeOff, KeyRound, Lock, ShieldCheck } from 'lucide-react';

interface GuardAuthGateProps {
  onGuardLogin: (username: string, password: string) => Promise<void>;
  onSwitchToAdminLogin: () => void;
}

export const GuardAuthGate: React.FC<GuardAuthGateProps> = ({
  onGuardLogin,
  onSwitchToAdminLogin,
}) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await onGuardLogin(username, password);
      setPassword('');
    } catch (err) {
      setErrorMsg((err as Error).message || 'Invalid guard username or password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md py-8">
      <div className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 space-y-6">
        <div className="flex items-start gap-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-teal-200 bg-teal-50 text-teal-800">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Guard Login Required
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Guard Gate Desk is protected. Sign in with the Guard Username and Password created by your Admin to view staff and mark In, Out, or Break timings.
            </p>
          </div>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-xs font-medium text-red-800"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="guard-login-username"
              className="block text-xs font-medium text-slate-700"
            >
              Guard Username
            </label>
            <input
              id="guard-login-username"
              type="text"
              required
              autoComplete="username"
              value={username}
              onChange={(e) => {
                setErrorMsg(null);
                setUsername(e.target.value);
              }}
              placeholder="e.g., gate1"
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="guard-login-password"
              className="block text-xs font-medium text-slate-700"
            >
              Password
            </label>
            <div className="relative mt-1.5">
              <input
                id="guard-login-password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setErrorMsg(null);
                  setPassword(e.target.value);
                }}
                placeholder="Enter guard password"
                className="w-full rounded-lg border border-slate-300 bg-white pl-3.5 pr-10 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-full min-h-[44px] items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-400 transition-colors"
          >
            <KeyRound className="h-4 w-4" />
            <span>{submitting ? 'Signing in...' : 'Sign In to Guard Desk'}</span>
          </button>
        </form>

        <div className="border-t border-slate-100 pt-4 flex items-center justify-between gap-3 text-xs">
          <span className="text-slate-500">Need to manage staff or guards?</span>
          <button
            type="button"
            onClick={onSwitchToAdminLogin}
            className="inline-flex items-center gap-1.5 font-medium text-teal-700 hover:underline whitespace-nowrap"
          >
            <Lock className="h-3.5 w-3.5" />
            <span>Admin Login</span>
          </button>
        </div>
      </div>
    </div>
  );
};
