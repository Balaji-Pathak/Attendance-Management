import React, { useMemo, useState } from 'react';
import {
  CloudDownload,
  ExternalLink,
  FilePlus2,
  FileSpreadsheet,
  Link2,
  LogOut,
  RefreshCw,
  Share2,
  ShieldCheck,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { User } from 'firebase/auth';
import {
  AdminEmailEntry,
  CategorySheetConfigs,
  COMPANY_CATEGORIES,
  CompanyCategory,
  DriveSpreadsheetItem,
  Employee,
} from '../types/attendance';
import { PRIMARY_ADMIN_EMAIL } from '../services/firebaseAuth';
import { normalizeCompanyCategory } from '../utils/time';
import { GoogleSignInButton } from './GoogleSignInButton';

interface GoogleSheetsSyncViewProps {
  user: User | null;
  hasGoogleToken: boolean;
  isSigningIn: boolean;
  isSyncing: boolean;
  onGoogleLogin: () => void;
  onGoogleLogout: () => void;
  employees: Employee[];
  sheetConfigs: CategorySheetConfigs;
  driveFiles: DriveSpreadsheetItem[];
  loadingDriveFiles: boolean;
  onRefreshDriveFiles: () => void;
  onRequestCreateMasterSheet: (category: CompanyCategory, title: string) => void;
  onConnectSpreadsheetById: (category: CompanyCategory, idOrUrl: string) => void;
  onRequestSyncCategorySheet: (category: CompanyCategory) => void;
  onRequestUpdateAllSheets: () => void;
  onPullFromSheet: (category: CompanyCategory) => void;
  onSwitchCategorySheet: (category: CompanyCategory) => void;
  onDeleteCategorySheet: (category: CompanyCategory) => void;
  onDeleteDriveFile: (file: DriveSpreadsheetItem) => void;
  onGoToIndividualSheets: () => void;
  adminEmails: AdminEmailEntry[];
  onAddAdminEmail: (email: string) => Promise<void>;
  onRemoveAdminEmail: (email: string) => void;
  onShareAllSheetsWithAdmins: () => Promise<void>;
}

export const GoogleSheetsSyncView: React.FC<GoogleSheetsSyncViewProps> = ({
  user,
  hasGoogleToken,
  isSigningIn,
  isSyncing,
  onGoogleLogin,
  onGoogleLogout,
  employees,
  sheetConfigs,
  driveFiles,
  loadingDriveFiles,
  onRefreshDriveFiles,
  onRequestCreateMasterSheet,
  onConnectSpreadsheetById,
  onRequestSyncCategorySheet,
  onRequestUpdateAllSheets,
  onPullFromSheet,
  onSwitchCategorySheet,
  onDeleteCategorySheet,
  onDeleteDriveFile,
  onGoToIndividualSheets,
  adminEmails,
  onAddAdminEmail,
  onRemoveAdminEmail,
  onShareAllSheetsWithAdmins,
}) => {
  const [newTitles, setNewTitles] = useState<Record<CompanyCategory, string>>({
    'Sukhsa Export Permanent': 'Sukhsa Export Permanent - Master Attendance',
    'Sukhsa Export Temporary': 'Sukhsa Export Temporary - Master Attendance',
  });
  const [manualLinks, setManualLinks] = useState<Record<CompanyCategory, string>>({
    'Sukhsa Export Permanent': '',
    'Sukhsa Export Temporary': '',
  });
  const [manageOpenFor, setManageOpenFor] = useState<CompanyCategory | null>(null);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [addingAdmin, setAddingAdmin] = useState(false);
  const [sharingSheets, setSharingSheets] = useState(false);

  const staffStats = useMemo(() => {
    const byCategory: Record<CompanyCategory, number> = {
      'Sukhsa Export Permanent': 0,
      'Sukhsa Export Temporary': 0,
    };
    let individualCount = 0;
    for (const emp of employees) {
      byCategory[normalizeCompanyCategory(emp.companyCategory)] += 1;
      if (emp.individualSheetId) individualCount += 1;
    }
    return {
      byCategory,
      individualCount,
      totalEmployees: employees.length,
    };
  }, [employees]);

  const individualOwnerBySheetId = useMemo(() => {
    const map = new Map<string, Employee>();
    for (const emp of employees) {
      if (emp.individualSheetId) {
        map.set(emp.individualSheetId, emp);
      }
    }
    return map;
  }, [employees]);

  const hasAnyConnectedSheet = Boolean(
    sheetConfigs['Sukhsa Export Permanent'] ||
      sheetConfigs['Sukhsa Export Temporary'] ||
      staffStats.individualCount > 0
  );

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
      {/* 1. Google Account */}
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Google Account</h2>
            <p className="mt-1 text-xs text-slate-500">
              {hasGoogleToken && user
                ? `Connected as ${user.displayName || user.email} (${user.email})`
                : 'Connect your Google account to create, update, or replace your company attendance sheets.'}
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
          {/* 2. Simple One-Click Update All Banner */}
          <section className="rounded-xl border border-teal-200 bg-teal-50/70 px-6 py-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Keep All Master &amp; Individual Sheets Up to Date
              </h3>
              <p className="mt-0.5 text-xs text-slate-600">
                Updates both Company Master Sheets and all {staffStats.individualCount} Individual
                Employee Sheet{staffStats.individualCount === 1 ? '' : 's'} with separate tabs for
                each month (so November, October, etc. stay cleanly separated).
              </p>
            </div>
            <button
              type="button"
              onClick={onRequestUpdateAllSheets}
              disabled={isSyncing || !hasAnyConnectedSheet}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-400 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Updating Sheets...' : 'Update All Sheets Now'}</span>
            </button>
          </section>

          {/* 3. Two Clear Company Master Sheets (Permanent & Temporary) */}
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {COMPANY_CATEGORIES.map((category) => {
              const cfg = sheetConfigs[category];
              const isPermanent = category === 'Sukhsa Export Permanent';
              const staffCount = staffStats.byCategory[category];
              const isManaging = manageOpenFor === category;

              return (
                <div
                  key={category}
                  className="rounded-xl border border-slate-200 bg-white p-6 flex flex-col justify-between space-y-5"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`inline-flex items-center rounded-md px-2.5 py-1 text-[11px] font-semibold border ${
                          isPermanent
                            ? 'border-teal-200 bg-teal-50 text-teal-800'
                            : 'border-amber-200 bg-amber-50 text-amber-800'
                        }`}
                      >
                        {category}
                      </span>
                      <span className="font-mono text-xs text-slate-500 tabular-nums">
                        {staffCount} {staffCount === 1 ? 'employee' : 'employees'}
                      </span>
                    </div>

                    {cfg ? (
                      <div className="mt-4 space-y-4">
                        <div>
                          <div className="text-xs font-medium text-slate-500">
                            Connected Master Sheet
                          </div>
                          <h3 className="mt-0.5 text-base font-bold text-slate-900">
                            {cfg.spreadsheetTitle}
                          </h3>
                          <p className="mt-1 text-xs text-slate-500">
                            {cfg.lastSyncedAt
                              ? `Last updated ${new Date(cfg.lastSyncedAt).toLocaleString()}`
                              : 'Ready to sync'}
                            {' · '}
                            {cfg.tabNames.length} tab{cfg.tabNames.length === 1 ? '' : 's'}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            href={cfg.spreadsheetUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-teal-700 bg-teal-50 px-3.5 py-2 text-xs font-medium text-teal-800 hover:bg-teal-100 whitespace-nowrap shrink-0"
                          >
                            <span>Open Sheet</span>
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>

                          <button
                            type="button"
                            onClick={() => onRequestSyncCategorySheet(category)}
                            disabled={isSyncing}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-400 whitespace-nowrap shrink-0"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                            <span>Sync Now</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => setManageOpenFor(isManaging ? null : category)}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                          >
                            {isManaging ? 'Hide Options' : 'Change / Delete'}
                          </button>
                        </div>

                        {isManaging && (
                          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-2.5">
                            <div className="text-xs font-medium text-slate-700">
                              Manage Connected Sheet
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => onPullFromSheet(category)}
                                disabled={isSyncing}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                              >
                                <CloudDownload className="h-3.5 w-3.5" />
                                <span>Load Data from Sheet</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  setManageOpenFor(null);
                                  onSwitchCategorySheet(category);
                                }}
                                disabled={isSyncing}
                                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                              >
                                Switch Sheet (Keep Old File)
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  setManageOpenFor(null);
                                  onDeleteCategorySheet(category);
                                }}
                                disabled={isSyncing}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 whitespace-nowrap"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                <span>Delete Old Sheet</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-4 space-y-5">
                        <div>
                          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                            <FilePlus2 className="h-4 w-4 text-teal-700" />
                            <span>Create Master Sheet</span>
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            Creates a dedicated Master Sheet for {category} employees and attendance.
                          </p>
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              const title = newTitles[category]?.trim();
                              if (title) onRequestCreateMasterSheet(category, title);
                            }}
                            className="mt-3 flex flex-wrap gap-2"
                          >
                            <input
                              type="text"
                              required
                              value={newTitles[category]}
                              onChange={(e) =>
                                setNewTitles((prev) => ({
                                  ...prev,
                                  [category]: e.target.value,
                                }))
                              }
                              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-700 focus:outline-none"
                            />
                            <button
                              type="submit"
                              disabled={isSyncing}
                              className="rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-400 whitespace-nowrap shrink-0"
                            >
                              Create Sheet
                            </button>
                          </form>
                        </div>

                        <div className="border-t border-slate-100 pt-4">
                          <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                            <Link2 className="h-3.5 w-3.5 text-slate-600" />
                            <span>Or Connect Existing Sheet Link</span>
                          </div>
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              const link = manualLinks[category]?.trim();
                              if (link) {
                                onConnectSpreadsheetById(category, link);
                                setManualLinks((prev) => ({ ...prev, [category]: '' }));
                              }
                            }}
                            className="mt-2.5 flex flex-wrap gap-2"
                          >
                            <input
                              type="text"
                              required
                              value={manualLinks[category]}
                              onChange={(e) =>
                                setManualLinks((prev) => ({
                                  ...prev,
                                  [category]: e.target.value,
                                }))
                              }
                              placeholder="Paste Google Sheets URL or ID..."
                              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-700 focus:outline-none"
                            />
                            <button
                              type="submit"
                              disabled={isSyncing}
                              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
                            >
                              Connect
                            </button>
                          </form>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          {/* 4. Individual Employee Sheets Overview */}
          <section className="rounded-xl border border-slate-200 bg-white px-6 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Individual Employee Sheets ({staffStats.individualCount} of{' '}
                {staffStats.totalEmployees} linked)
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Each employee&apos;s standalone Google Sheet shows their Company Category banner,
                monthly attendance, and Theka deductions.
              </p>
            </div>
            <button
              type="button"
              onClick={onGoToIndividualSheets}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              Open Individual Sheets
            </button>
          </section>

          {/* 5. Saved Spreadsheets in Drive */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Spreadsheets in Google Drive
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Assign a sheet to Permanent or Temporary Master, or delete old unused sheets.
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
                  : 'No spreadsheets created with GateLog found in Drive yet.'}
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {driveFiles.map((file) => {
                  const isPerm =
                    sheetConfigs['Sukhsa Export Permanent']?.spreadsheetId === file.id;
                  const isTemp =
                    sheetConfigs['Sukhsa Export Temporary']?.spreadsheetId === file.id;
                  const empOwner = individualOwnerBySheetId.get(file.id);

                  return (
                    <div
                      key={file.id}
                      className="flex flex-wrap items-center justify-between gap-4 px-6 py-3.5 hover:bg-slate-50/70"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <FileSpreadsheet className="h-4 w-4 shrink-0 text-teal-700" />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-slate-900">
                              {file.name}
                            </span>
                            {isPerm && (
                              <span className="rounded bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800 border border-teal-200">
                                Permanent Master
                              </span>
                            )}
                            {isTemp && (
                              <span className="rounded bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 border border-amber-200">
                                Temporary Master
                              </span>
                            )}
                            {empOwner && (
                              <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                                {empOwner.empCode} · {normalizeCompanyCategory(empOwner.companyCategory)}
                              </span>
                            )}
                          </div>
                          {file.modifiedTime && (
                            <div className="mt-0.5 text-xs text-slate-400">
                              Updated {new Date(file.modifiedTime).toLocaleDateString()}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
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

                        {!isPerm && !empOwner && (
                          <button
                            type="button"
                            onClick={() =>
                              onConnectSpreadsheetById('Sukhsa Export Permanent', file.id)
                            }
                            disabled={isSyncing}
                            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                          >
                            Use as Permanent
                          </button>
                        )}

                        {!isTemp && !empOwner && (
                          <button
                            type="button"
                            onClick={() =>
                              onConnectSpreadsheetById('Sukhsa Export Temporary', file.id)
                            }
                            disabled={isSyncing}
                            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                          >
                            Use as Temporary
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => onDeleteDriveFile(file)}
                          disabled={isSyncing}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700"
                          aria-label={`Delete ${file.name}`}
                          title="Move sheet to Google Drive Trash"
                        >
                          <Trash2 className="h-4 w-4" />
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

      {/* 6. Company Admins */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-teal-700 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900">
                Authorized Company Admins
              </h3>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              All listed admins can sign in and automatically receive Editor access to both
              Company Master Sheets and every Individual Employee Sheet.
            </p>
          </div>
          {hasGoogleToken && (
            <button
              type="button"
              disabled={sharingSheets}
              onClick={async () => {
                setSharingSheets(true);
                try {
                  await onShareAllSheetsWithAdmins();
                } finally {
                  setSharingSheets(false);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Share2 className="h-3.5 w-3.5" />
              <span>{sharingSheets ? 'Sharing Sheets...' : 'Share All Sheets with Admins'}</span>
            </button>
          )}
        </div>

        <div className="p-6 space-y-5">
          <form onSubmit={handleAdminFormSubmit} className="flex flex-wrap gap-2">
            <input
              type="email"
              required
              value={newAdminEmail}
              onChange={(e) => setNewAdminEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-teal-700 focus:outline-none"
            />
            <button
              type="submit"
              disabled={addingAdmin}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <UserPlus className="h-3.5 w-3.5" />
              <span>{addingAdmin ? 'Adding...' : 'Add Admin Email'}</span>
            </button>
          </form>

          <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            <div className="flex items-center justify-between gap-4 px-4 py-3 bg-slate-50/60">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-medium text-slate-900">
                  {PRIMARY_ADMIN_EMAIL}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">Primary Company Admin</div>
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
        </div>
      </section>
    </div>
  );
};
