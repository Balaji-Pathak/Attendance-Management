import React, { useState } from 'react';
import {
  CloudDownload,
  ExternalLink,
  FilePlus2,
  FileSpreadsheet,
  Info,
  Link2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { User } from 'firebase/auth';
import { AdminEmailEntry, DriveSpreadsheetItem, SheetConfig } from '../types/attendance';
import { PRIMARY_ADMIN_EMAIL } from '../services/firebaseAuth';
import { GoogleSignInButton } from './GoogleSignInButton';

interface GoogleSheetsSyncViewProps {
  user: User | null;
  hasGoogleToken: boolean;
  isSigningIn: boolean;
  onGoogleLogin: () => void;
  onGoogleLogout: () => void;
  sheetConfig: SheetConfig | null;
  driveFiles: DriveSpreadsheetItem[];
  loadingDriveFiles: boolean;
  onRefreshDriveFiles: () => void;
  onRequestCreateMasterSheet: (title: string) => void;
  onConnectSpreadsheetById: (idOrUrl: string) => void;
  onRequestSyncAll: () => void;
  onPullFromSheet: () => void;
  onDisconnectSheet: () => void;
  adminEmails: AdminEmailEntry[];
  onAddAdminEmail: (email: string) => Promise<void>;
  onRemoveAdminEmail: (email: string) => void;
}

export const GoogleSheetsSyncView: React.FC<GoogleSheetsSyncViewProps> = ({
  user,
  hasGoogleToken,
  isSigningIn,
  onGoogleLogin,
  onGoogleLogout,
  sheetConfig,
  driveFiles,
  loadingDriveFiles,
  onRefreshDriveFiles,
  onRequestCreateMasterSheet,
  onConnectSpreadsheetById,
  onRequestSyncAll,
  onPullFromSheet,
  onDisconnectSheet,
  adminEmails,
  onAddAdminEmail,
  onRemoveAdminEmail,
}) => {
  const [newSheetTitle, setNewSheetTitle] = useState('GateLog Attendance Master');
  const [manualUrlOrId, setManualUrlOrId] = useState('');
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [addingAdmin, setAddingAdmin] = useState(false);

  const handleAdminFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = newAdminEmail.trim().toLowerCase();
    if (!cleaned || addingAdmin) return;
    setAddingAdmin(true);
    try {
      await onAddAdminEmail(cleaned);
      setNewAdminEmail('');
    } finally {
      setAddingAdmin(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Google Sheets & Drive Account
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {hasGoogleToken && user
                ? `Connected as ${user.displayName || user.email} (${user.email})`
                : 'Grant Google Sheets & Drive permission to create and synchronize your Master Attendance Sheet and Individual Employee Sheets.'}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {hasGoogleToken && user ? (
              <button
                type="button"
                onClick={onGoogleLogout}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Sign Out</span>
              </button>
            ) : (
              <GoogleSignInButton
                onClick={onGoogleLogin}
                disabled={isSigningIn}
                label={isSigningIn ? 'Signing in...' : 'Connect Google Sheets'}
              />
            )}
          </div>
        </div>
      </section>

      {hasGoogleToken && (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            {sheetConfig ? (
              <div className="space-y-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="text-xs font-medium text-teal-700">
                      Connected Master Workbook
                    </div>
                    <h3 className="mt-1 text-lg font-bold text-slate-900">
                      {sheetConfig.spreadsheetTitle}
                    </h3>
                    <p className="mt-1 font-mono text-xs text-slate-500 break-all">
                      ID: {sheetConfig.spreadsheetId}
                      {sheetConfig.lastSyncedAt
                        ? ` · Last Synced: ${new Date(sheetConfig.lastSyncedAt).toLocaleString()}`
                        : ''}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <a
                      href={sheetConfig.spreadsheetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-teal-700 bg-teal-50 px-3.5 py-2 text-xs font-medium text-teal-800 hover:bg-teal-100 whitespace-nowrap shrink-0"
                    >
                      <span>Open in Google Sheets</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={onPullFromSheet}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                    >
                      <CloudDownload className="h-3.5 w-3.5" />
                      <span>Load from Sheet</span>
                    </button>
                    <button
                      type="button"
                      onClick={onRequestSyncAll}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>Sync All Tabs Now</span>
                    </button>
                    <button
                      type="button"
                      onClick={onDisconnectSheet}
                      className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-800 whitespace-nowrap shrink-0"
                    >
                      Switch Sheet
                    </button>
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-4">
                  <div className="text-xs font-medium text-slate-500">
                    Sheet Tabs ({sheetConfig.tabNames.length})
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-700">
                    {sheetConfig.tabNames.map((t, idx) => (
                      <span key={t} className="font-mono">
                        {idx > 0 && <span className="mr-4 text-slate-300">/</span>}
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <FilePlus2 className="h-4 w-4 text-teal-700" />
                    <span>Create New Master Attendance Sheet</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                    Creates a clean Google Spreadsheet with Master Attendance (6 columns), Employees roster, and an individual sheet tab with total hours formula for each employee.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (newSheetTitle.trim()) {
                        onRequestCreateMasterSheet(newSheetTitle.trim());
                      }
                    }}
                    className="mt-4 flex flex-wrap gap-2"
                  >
                    <input
                      type="text"
                      required
                      value={newSheetTitle}
                      onChange={(e) => setNewSheetTitle(e.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-teal-700 focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      Create Google Sheet
                    </button>
                  </form>
                </div>

                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <Link2 className="h-4 w-4 text-slate-700" />
                    <span>Connect Existing Google Sheet</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                    Paste a Google Sheets URL or Spreadsheet ID to link an existing workbook.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (manualUrlOrId.trim()) {
                        onConnectSpreadsheetById(manualUrlOrId.trim());
                        setManualUrlOrId('');
                      }
                    }}
                    className="mt-4 flex flex-wrap gap-2"
                  >
                    <input
                      type="text"
                      required
                      value={manualUrlOrId}
                      onChange={(e) => setManualUrlOrId(e.target.value)}
                      placeholder="https://docs.google.com/spreadsheets/d/..."
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-teal-700 focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
                    >
                      Connect Sheet
                    </button>
                  </form>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Attendance Spreadsheets in Google Drive
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Spreadsheets created or opened through GateLog
                </p>
              </div>
              <button
                type="button"
                onClick={onRefreshDriveFiles}
                disabled={loadingDriveFiles}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingDriveFiles ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
            </div>

            {driveFiles.length === 0 ? (
              <div className="px-6 py-10 text-center text-xs text-slate-500">
                {loadingDriveFiles
                  ? 'Loading spreadsheets from Google Drive...'
                  : 'No spreadsheets created with this app found in Drive yet.'}
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {driveFiles.map((file) => {
                  const isCurrent = sheetConfig?.spreadsheetId === file.id;
                  return (
                    <div
                      key={file.id}
                      className="flex flex-wrap items-center justify-between gap-4 px-6 py-3.5 hover:bg-slate-50/70"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <FileSpreadsheet className="h-4 w-4 shrink-0 text-teal-700" />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900">
                            {file.name}
                          </div>
                          <div className="text-xs text-slate-500 font-mono">
                            {file.id}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {file.webViewLink && (
                          <a
                            href={file.webViewLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                          >
                            <span>Open</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => onConnectSpreadsheetById(file.id)}
                          disabled={isCurrent}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                            isCurrent
                              ? 'bg-teal-50 text-teal-800 border border-teal-200'
                              : 'bg-slate-900 text-white hover:bg-slate-800'
                          }`}
                        >
                          {isCurrent ? 'Connected' : 'Use This Sheet'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-teal-700 shrink-0" />
            <h3 className="text-sm font-semibold text-slate-900">
              Authorized Company Admins
            </h3>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Allow additional company Gmail accounts to unlock Admin tabs, manage employees, and sync Google Sheets.
          </p>
        </div>

        <div className="p-6 space-y-5">
          <form onSubmit={handleAdminFormSubmit} className="flex flex-wrap gap-2">
            <input
              type="email"
              required
              value={newAdminEmail}
              onChange={(e) => setNewAdminEmail(e.target.value)}
              placeholder="colleague@gmail.com"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-teal-700 focus:outline-none"
            />
            <button
              type="submit"
              disabled={addingAdmin}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <UserPlus className="h-3.5 w-3.5" />
              <span>{addingAdmin ? 'Adding...' : 'Add Admin Gmail'}</span>
            </button>
          </form>

          <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            <div className="flex items-center justify-between gap-4 px-4 py-3 bg-slate-50/60">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-medium text-slate-900">
                  {PRIMARY_ADMIN_EMAIL}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  Primary Owner Admin (always authorized)
                </div>
              </div>
              <span className="text-xs font-medium text-teal-700 whitespace-nowrap shrink-0">
                Owner
              </span>
            </div>

            {adminEmails
              .filter((entry) => entry.email !== PRIMARY_ADMIN_EMAIL)
              .map((entry) => (
                <div
                  key={entry.email}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs font-medium text-slate-900">
                      {entry.email}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      Added by {entry.addedBy || PRIMARY_ADMIN_EMAIL}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveAdminEmail(entry.email)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 whitespace-nowrap shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Remove</span>
                  </button>
                </div>
              ))}
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs leading-relaxed text-slate-600">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
            <div>
              <span className="font-medium text-slate-800">Google OAuth Note for Other Gmails: </span>
              If a newly added Gmail sees Google&apos;s{' '}
              <span className="font-mono text-slate-800">Error 403: access_denied</span> screen, open{' '}
              <span className="font-medium text-slate-800">
                Google Cloud Console → APIs &amp; Services → OAuth consent screen (Audience)
              </span>{' '}
              for project <span className="font-mono text-slate-800">gen-lang-client-0550725378</span> and either add their Gmail under{' '}
              <span className="font-medium text-slate-800">Test users</span> or click{' '}
              <span className="font-medium text-slate-800">Publish App</span> so any Google account can sign in.
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

