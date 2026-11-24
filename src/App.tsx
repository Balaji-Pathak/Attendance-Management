import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileSpreadsheet,
  Lock,
  Menu,
  ShieldCheck,
  Unlock,
  Users,
  UserSquare2,
  X,
} from 'lucide-react';
import { User } from 'firebase/auth';
import {
  AttendanceRecord,
  ConfirmRequest,
  DriveSpreadsheetItem,
  Employee,
  GateEmployeeView,
  NavSection,
  SheetConfig,
} from './types/attendance';
import {
  getEmployeeSheetTabName,
  getTodayISO,
  sortRecordsNewestFirst,
} from './utils/time';
import {
  checkIsAuthorizedAdmin,
  clearCachedToken,
  getAccessToken,
  googleSignIn,
  initAuth,
  logout,
} from './services/firebaseAuth';
import {
  adminDeleteAttendance,
  adminImportFromSheet,
  adminLoadStarterEmployees,
  adminMarkRecordsSynced,
  adminSaveEmployee,
  adminSaveSheetConfig,
  adminUpdateAttendance,
  guardMarkIn,
  guardMarkOut,
  subscribeActiveEmployees,
  subscribeAllAttendance,
  subscribeAllEmployees,
  subscribeTodayAttendance,
  subscribeWorkspaceSettings,
} from './services/firestoreService';
import {
  createMasterSpreadsheet,
  createOrUpdateStandaloneEmployeeSheet,
  extractSpreadsheetId,
  listAppSpreadsheets,
  loadWorkbookData,
  syncEmployeeAndMasterTabs,
  syncFullWorkbook,
} from './services/googleSheets';
import { ConfirmDialog } from './components/ConfirmDialog';
import { AdminAuthGate } from './components/AdminAuthGate';
import { GuardGateView } from './components/GuardGateView';
import { MasterAttendanceView } from './components/MasterAttendanceView';
import { IndividualEmployeeView } from './components/IndividualEmployeeView';
import { EmployeesView } from './components/EmployeesView';
import { GoogleSheetsSyncView } from './components/GoogleSheetsSyncView';

interface NoticeState {
  type: 'success' | 'error' | 'info';
  message: string;
}

const NAV_ITEMS: Array<{
  id: NavSection;
  label: string;
  adminOnly: boolean;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'guard-gate', label: 'Guard Gate Desk', adminOnly: false, icon: ShieldCheck },
  { id: 'master-log', label: 'Master Attendance', adminOnly: true, icon: ClipboardList },
  { id: 'individual-sheets', label: 'Individual Sheets', adminOnly: true, icon: UserSquare2 },
  { id: 'employees', label: 'Employees', adminOnly: true, icon: Users },
  { id: 'sheets-sync', label: 'Google Sheets Sync', adminOnly: true, icon: FileSpreadsheet },
];

export default function App() {
  const [activeNav, setActiveNav] = useState<NavSection>('guard-gate');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Firebase Auth + Google Workspace OAuth state
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [isAdminAuthorized, setIsAdminAuthorized] = useState<boolean>(false);
  const [isLockedBySession, setIsLockedBySession] = useState<boolean>(false);
  const [hasGoogleToken, setHasGoogleToken] = useState<boolean>(false);
  const [isLoggingInGoogle, setIsLoggingInGoogle] = useState<boolean>(false);

  // Public Guard state (Firestore live subscriptions — no login required)
  const [todayDate, setTodayDate] = useState<string>(() => getTodayISO());
  const [gateEmployees, setGateEmployees] = useState<GateEmployeeView[]>([]);
  const [todayRecords, setTodayRecords] = useState<AttendanceRecord[]>([]);

  // Protected Admin state (Firestore live subscriptions — only when Admin unlocked)
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [sheetConfig, setSheetConfig] = useState<SheetConfig | null>(null);
  const [driveFiles, setDriveFiles] = useState<DriveSpreadsheetItem[]>([]);
  const [loadingDriveFiles, setLoadingDriveFiles] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);

  const isAdminUnlocked = Boolean(googleUser && isAdminAuthorized && !isLockedBySession);

  // Keep todayDate accurate if a gate tablet stays open past midnight
  useEffect(() => {
    const timer = setInterval(() => {
      const current = getTodayISO();
      if (current !== todayDate) {
        setTodayDate(current);
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [todayDate]);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = initAuth(async (authedUser, hasToken) => {
      setGoogleUser(authedUser);
      setHasGoogleToken(hasToken);
      if (authedUser) {
        const authorized = await checkIsAuthorizedAdmin(authedUser);
        setIsAdminAuthorized(authorized);
      } else {
        setIsAdminAuthorized(false);
        setIsLockedBySession(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // Public Guard Firestore listeners (active employees + today's attendance)
  useEffect(() => {
    const unsubEmps = subscribeActiveEmployees(
      (list) => setGateEmployees(list),
      (err) => {
        setNotice({ type: 'error', message: `Could not load active staff: ${err.message}` });
      }
    );
    const unsubToday = subscribeTodayAttendance(
      todayDate,
      (list) => setTodayRecords(list),
      (err) => {
        setNotice({ type: 'error', message: `Could not load today's attendance: ${err.message}` });
      }
    );
    return () => {
      unsubEmps();
      unsubToday();
    };
  }, [todayDate]);

  // Protected Admin Firestore listeners (only attached when Admin is unlocked)
  useEffect(() => {
    if (!isAdminUnlocked) {
      setEmployees([]);
      setRecords([]);
      setSheetConfig(null);
      return;
    }

    const unsubEmps = subscribeAllEmployees(
      (list) => setEmployees(list),
      (err) => setNotice({ type: 'error', message: err.message })
    );
    const unsubAtt = subscribeAllAttendance(
      (list) => setRecords(list),
      (err) => setNotice({ type: 'error', message: err.message })
    );
    const unsubSettings = subscribeWorkspaceSettings(
      (cfg) => setSheetConfig(cfg),
      (err) => setNotice({ type: 'error', message: err.message })
    );

    return () => {
      unsubEmps();
      unsubAtt();
      unsubSettings();
    };
  }, [isAdminUnlocked]);

  const handleGoogleError = useCallback((err: unknown, fallbackMsg: string) => {
    const errorObj = err as Error & { status?: number };
    if (errorObj?.status === 401) {
      clearCachedToken();
      setHasGoogleToken(false);
      setNotice({
        type: 'error',
        message: 'Google Sheets session expired. Please reconnect Google Sheets.',
      });
      return;
    }
    setNotice({
      type: 'error',
      message: errorObj?.message || fallbackMsg,
    });
  }, []);

  const refreshDriveFiles = useCallback(
    async (tokenOverride?: string) => {
      const token = tokenOverride || getAccessToken();
      if (!token) return;
      setLoadingDriveFiles(true);
      try {
        const files = await listAppSpreadsheets(token);
        setDriveFiles(files);
      } catch (err) {
        handleGoogleError(err, 'Failed to list spreadsheets from Google Drive.');
      } finally {
        setLoadingDriveFiles(false);
      }
    },
    [handleGoogleError]
  );

  // ============================================================================
  // GUARD ACTIONS (No login required, live time + 30m break enforced)
  // ============================================================================
  const handleGuardMarkIn = async (empId: string) => {
    const emp = gateEmployees.find((e) => e.id === empId);
    if (!emp) return;
    try {
      const created = await guardMarkIn(emp);
      setNotice({
        type: 'success',
        message: `Marked IN: ${created.empName} at ${created.inTime}.`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        message: (err as Error).message || 'Could not mark check-in.',
      });
    }
  };

  const handleGuardMarkOut = async (recordId: string) => {
    const rec = todayRecords.find((r) => r.id === recordId);
    if (!rec) return;
    try {
      const updated = await guardMarkOut(rec);
      setNotice({
        type: 'success',
        message: `Marked OUT: ${updated.empName} (${updated.netDecimalHours?.toFixed(2)}h after 30m break).`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        message: (err as Error).message || 'Could not mark check-out.',
      });
    }
  };

  // ============================================================================
  // ADMIN AUTH ACTIONS
  // ============================================================================
  const handleGoogleAdminLogin = async () => {
    setIsLoggingInGoogle(true);
    setNotice(null);
    try {
      const { user: authedUser, accessToken } = await googleSignIn();
      setGoogleUser(authedUser);
      setHasGoogleToken(true);

      const authorized = await checkIsAuthorizedAdmin(authedUser);
      setIsAdminAuthorized(authorized);

      if (!authorized) {
        setNotice({
          type: 'error',
          message: `${authedUser.email} is not authorized for Admin access.`,
        });
        return;
      }

      setIsLockedBySession(false);
      await refreshDriveFiles(accessToken);
      setNotice({
        type: 'success',
        message: `Admin unlocked as ${authedUser.email}.`,
      });
    } catch (err) {
      handleGoogleError(err, 'Google sign-in failed or was cancelled.');
    } finally {
      setIsLoggingInGoogle(false);
    }
  };

  const handleConnectGoogleForSheetsOnly = async () => {
    setIsLoggingInGoogle(true);
    try {
      const { user: authedUser, accessToken } = await googleSignIn();
      setGoogleUser(authedUser);
      setHasGoogleToken(true);
      await refreshDriveFiles(accessToken);
      setNotice({
        type: 'success',
        message: `Connected Google Sheets as ${authedUser.email}.`,
      });
    } catch (err) {
      handleGoogleError(err, 'Google sign-in failed.');
    } finally {
      setIsLoggingInGoogle(false);
    }
  };

  const handleLockAdmin = async () => {
    setIsLockedBySession(true);
    setActiveNav('guard-gate');
    await logout();
    setGoogleUser(null);
    setHasGoogleToken(false);
    setIsAdminAuthorized(false);
    setDriveFiles([]);
    setNotice({
      type: 'info',
      message: 'Admin panel locked. Guard Gate Desk remains open.',
    });
  };

  const handleGoogleLogout = async () => {
    await logout();
    setGoogleUser(null);
    setHasGoogleToken(false);
    setIsAdminAuthorized(false);
    setDriveFiles([]);
    setActiveNav('guard-gate');
    setNotice({ type: 'info', message: 'Signed out of Google Admin account.' });
  };

  // ============================================================================
  // ADMIN DATA & GOOGLE SHEETS MUTATIONS
  // ============================================================================
  const syncOneEmployeeAndMaster = async (
    employee: Employee,
    nextEmployees: Employee[],
    nextRecords: AttendanceRecord[]
  ) => {
    const token = getAccessToken();
    if (!token || !sheetConfig) return;
    setIsSyncing(true);
    try {
      const updatedCfg = await syncEmployeeAndMasterTabs(
        token,
        sheetConfig.spreadsheetId,
        employee,
        nextEmployees,
        nextRecords
      );
      await adminSaveSheetConfig(updatedCfg);
      await adminMarkRecordsSynced(nextRecords);
    } catch (err) {
      handleGoogleError(err, 'Saved in Firestore, but Google Sheets sync failed.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveEmployee = async (emp: Employee, isNew: boolean) => {
    const nextEmployees = isNew
      ? [...employees, emp]
      : employees.map((e) => (e.id === emp.id ? emp : e));

    if (sheetConfig && getAccessToken()) {
      setConfirmRequest({
        title: isNew ? 'Add Employee & Create Sheet Tab?' : 'Update Employee in Google Sheets?',
        description: isNew
          ? `Add ${emp.name} (${emp.empCode}) and create their individual sheet tab in "${sheetConfig.spreadsheetTitle}".`
          : `Save changes for ${emp.name} (${emp.empCode}) and update Google Sheets.`,
        affectedTarget: sheetConfig.spreadsheetTitle,
        details: [
          'Updates Employees tab',
          `Updates tab: ${getEmployeeSheetTabName(emp.empCode, emp.name)}`,
        ],
        confirmLabel: isNew ? 'Add & Sync' : 'Save & Sync',
        onConfirm: async () => {
          await adminSaveEmployee(emp);
          await syncOneEmployeeAndMaster(emp, nextEmployees, records);
          setNotice({
            type: 'success',
            message: `${isNew ? 'Added' : 'Updated'} ${emp.name} and synced to Google Sheets.`,
          });
        },
      });
    } else {
      await adminSaveEmployee(emp);
      setNotice({
        type: 'success',
        message: `${isNew ? 'Added' : 'Updated'} ${emp.name}.`,
      });
    }
  };

  const handleToggleActive = async (emp: Employee) => {
    await handleSaveEmployee({ ...emp, active: !emp.active }, false);
  };

  const handleLoadStarterRoster = async () => {
    await adminLoadStarterEmployees();
    setNotice({
      type: 'success',
      message: 'Loaded 5 starter employees. Guard can now mark check-in and check-out.',
    });
  };

  const handleUpdateRecord = async (updated: AttendanceRecord) => {
    const emp = employees.find(
      (e) => e.id === updated.empId || e.empCode === updated.empCode
    );
    const nextRecords = sortRecordsNewestFirst(
      records.map((r) => (r.id === updated.id ? updated : r))
    );

    if (sheetConfig && getAccessToken() && emp) {
      setConfirmRequest({
        title: 'Update Entry in Google Sheets?',
        description: `Save corrected timings for ${updated.empName} (${updated.date}) and update Google Sheets.`,
        affectedTarget: sheetConfig.spreadsheetTitle,
        details: [
          'Updates Master Attendance tab',
          `Updates tab: ${getEmployeeSheetTabName(emp.empCode, emp.name)}`,
        ],
        confirmLabel: 'Save & Sync',
        onConfirm: async () => {
          await adminUpdateAttendance(updated);
          await syncOneEmployeeAndMaster(emp, employees, nextRecords);
          setNotice({
            type: 'success',
            message: `Updated ${updated.empName}'s entry and synced to Google Sheets.`,
          });
        },
      });
    } else {
      await adminUpdateAttendance(updated);
      setNotice({
        type: 'success',
        message: `Updated ${updated.empName}'s attendance entry.`,
      });
    }
  };

  const handleDeleteRecord = (record: AttendanceRecord) => {
    const emp = employees.find(
      (e) => e.id === record.empId || e.empCode === record.empCode
    );
    const hasSheet = Boolean(sheetConfig && getAccessToken());

    setConfirmRequest({
      title: 'Delete Attendance Record?',
      description: `Permanently delete ${record.empName}'s entry for ${record.date}.`,
      affectedTarget: hasSheet ? sheetConfig?.spreadsheetTitle : undefined,
      details: hasSheet
        ? ['Removes row from Master Attendance and employee sheet tab']
        : ['Removes entry from Firestore attendance register'],
      confirmLabel: 'Delete Entry',
      destructive: true,
      onConfirm: async () => {
        await adminDeleteAttendance(record.id);
        const nextRecords = records.filter((r) => r.id !== record.id);
        if (hasSheet && emp) {
          await syncOneEmployeeAndMaster(emp, employees, nextRecords);
        }
        setNotice({
          type: 'info',
          message: `Deleted record for ${record.empName} (${record.date}).`,
        });
      },
    });
  };

  const handleRequestCreateMasterSheet = (title: string) => {
    const token = getAccessToken();
    if (!token) return;

    setConfirmRequest({
      title: 'Create Master Attendance Google Sheet?',
      description: `Create "${title}" in Google Drive with clean Master Attendance, Employees, and Individual Employee tabs.`,
      affectedTarget: title,
      details: [
        'Master Attendance: Date, Employee ID, Name, In Time, Out Time, Working Hours',
        `Individual Tabs: ${employees.length} employee tab(s) with total hours formula`,
      ],
      confirmLabel: 'Create Google Sheet',
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          const cfg = await createMasterSpreadsheet(token, title, employees, records);
          await adminSaveSheetConfig(cfg);
          await adminMarkRecordsSynced(records);
          await refreshDriveFiles(token);
          setNotice({
            type: 'success',
            message: `Created "${cfg.spreadsheetTitle}" with ${employees.length} individual employee tabs.`,
          });
        } catch (err) {
          handleGoogleError(err, 'Failed to create Google Spreadsheet.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const connectSpreadsheet = async (idOrUrl: string, loadDataIntoApp = false) => {
    const token = getAccessToken();
    if (!token) return;
    const spreadsheetId = extractSpreadsheetId(idOrUrl);
    setIsSyncing(true);
    try {
      const loaded = await loadWorkbookData(token, spreadsheetId);
      if (loadDataIntoApp) {
        const nextEmps = loaded.employees.length > 0 ? loaded.employees : employees;
        const nextRecs =
          loaded.records.length > 0
            ? sortRecordsNewestFirst(loaded.records)
            : records;
        await adminImportFromSheet(nextEmps, nextRecs, loaded.config);
        setNotice({
          type: 'success',
          message: `Loaded ${loaded.employees.length} employees and ${loaded.records.length} entries from "${loaded.config.spreadsheetTitle}".`,
        });
      } else {
        await adminSaveSheetConfig(loaded.config);
        setNotice({
          type: 'success',
          message: `Connected to "${loaded.config.spreadsheetTitle}".`,
        });
      }
    } catch (err) {
      handleGoogleError(err, 'Could not connect to that Google Spreadsheet.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleRequestSyncAll = () => {
    const token = getAccessToken();
    if (!token || !sheetConfig) {
      setActiveNav('sheets-sync');
      setNotice({
        type: 'info',
        message: 'Click "Connect Google Sheets" to grant Google Sheets write permission for this session.',
      });
      return;
    }

    setConfirmRequest({
      title: 'Sync All Attendance & Individual Tabs?',
      description: `Update Master Attendance, Employees, and all ${employees.length} individual employee tabs in "${sheetConfig.spreadsheetTitle}".`,
      affectedTarget: sheetConfig.spreadsheetTitle,
      details: [
        `${records.length} attendance record(s)`,
        `${employees.length} individual employee sheet tab(s)`,
      ],
      confirmLabel: 'Sync All Tabs',
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          const cfg = await syncFullWorkbook(
            token,
            sheetConfig.spreadsheetId,
            employees,
            records
          );
          await adminSaveSheetConfig(cfg);
          await adminMarkRecordsSynced(records);
          setNotice({
            type: 'success',
            message: `Synced all tabs in "${cfg.spreadsheetTitle}".`,
          });
        } catch (err) {
          handleGoogleError(err, 'Failed to sync Google Sheet.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handleRequestSyncEmployeeTab = (employee: Employee) => {
    const token = getAccessToken();
    if (!token || !sheetConfig) return;
    const tabName = getEmployeeSheetTabName(employee.empCode, employee.name);

    setConfirmRequest({
      title: `Sync ${employee.name}'s Tab?`,
      description: `Update "${tabName}" and Master Attendance in "${sheetConfig.spreadsheetTitle}".`,
      affectedTarget: `${sheetConfig.spreadsheetTitle} · ${tabName}`,
      confirmLabel: 'Sync Tab',
      onConfirm: async () => {
        await syncOneEmployeeAndMaster(employee, employees, records);
        setNotice({
          type: 'success',
          message: `Synced "${tabName}" in Google Sheets.`,
        });
      },
    });
  };

  const handleRequestStandaloneSheet = (employee: Employee) => {
    const token = getAccessToken();
    if (!token) {
      setActiveNav('sheets-sync');
      setNotice({
        type: 'info',
        message: 'Connect Google Sheets in Google Sheets Sync first.',
      });
      return;
    }
    const isUpdate = Boolean(employee.individualSheetId);

    setConfirmRequest({
      title: isUpdate
        ? `Update ${employee.name}'s Individual Google Sheet?`
        : `Create Individual Google Sheet for ${employee.name}?`,
      description: isUpdate
        ? `Update the standalone Google Sheet for ${employee.name} with their attendance records.`
        : `Create a dedicated standalone Google Sheet file in Google Drive for ${employee.name} (${employee.empCode}).`,
      affectedTarget: `${employee.empCode} - ${employee.name} Attendance`,
      confirmLabel: isUpdate ? 'Update Sheet' : 'Create Sheet',
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          const res = await createOrUpdateStandaloneEmployeeSheet(token, employee, records);
          const updatedEmp: Employee = {
            ...employee,
            individualSheetId: res.spreadsheetId,
            individualSheetUrl: res.spreadsheetUrl,
          };
          await adminSaveEmployee(updatedEmp);
          const nextEmps = employees.map((e) =>
            e.id === employee.id ? updatedEmp : e
          );
          if (sheetConfig) {
            await syncOneEmployeeAndMaster(updatedEmp, nextEmps, records);
          }
          await refreshDriveFiles(token);
          setNotice({
            type: 'success',
            message: `${isUpdate ? 'Updated' : 'Created'} individual Google Sheet for ${employee.name}.`,
          });
        } catch (err) {
          handleGoogleError(err, 'Could not create or update individual Google Sheet.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handlePullFromSheet = () => {
    if (!sheetConfig) return;
    setConfirmRequest({
      title: 'Load Data from Google Sheet?',
      description: `Load employees and attendance records from "${sheetConfig.spreadsheetTitle}" into Firestore.`,
      affectedTarget: sheetConfig.spreadsheetTitle,
      confirmLabel: 'Load from Sheet',
      onConfirm: async () => {
        await connectSpreadsheet(sheetConfig.spreadsheetId, true);
      },
    });
  };

  const currentNavItem = NAV_ITEMS.find((n) => n.id === activeNav) ?? NAV_ITEMS[0];
  const requiresAdminGate = currentNavItem.adminOnly && !isAdminUnlocked;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:shrink-0 lg:flex-col lg:border-r lg:border-slate-200 lg:bg-white">
        <div className="flex h-16 items-center border-b border-slate-200 px-6">
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            GateLog
          </span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Primary Navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.id;
            const locked = item.adminOnly && !isAdminUnlocked;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveNav(item.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {locked && (
                  <Lock
                    className={`h-3.5 w-3.5 shrink-0 ${
                      active ? 'text-slate-300' : 'text-slate-400'
                    }`}
                    aria-label="Admin protected"
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-4 text-xs text-slate-500 space-y-1">
          <div className="font-medium text-slate-700">
            {isAdminUnlocked ? 'Admin Mode Active' : 'Guard Mode (Open)'}
          </div>
          <div>30 min break deducted on Mark Out</div>
        </div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-10 flex w-64 flex-col bg-white border-r border-slate-200">
            <div className="flex h-16 items-center justify-between border-b border-slate-200 px-6">
              <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
                GateLog
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 px-3 py-4">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeNav === item.id;
                const locked = item.adminOnly && !isAdminUnlocked;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveNav(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm font-medium whitespace-nowrap ${
                      active
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </span>
                    {locked && <Lock className="h-3.5 w-3.5 text-slate-400" />}
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 text-sm truncate">
              <span className="font-medium text-slate-400 hidden sm:inline">GateLog</span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <h1 className="font-semibold text-slate-900 truncate">
                {currentNavItem.label}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {isAdminUnlocked ? (
              <>
                {sheetConfig && hasGoogleToken && (
                  <a
                    href={sheetConfig.spreadsheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
                  >
                    <span>{isSyncing ? 'Syncing...' : 'Open Google Sheet'}</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={handleLockAdmin}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                >
                  <Lock className="h-3.5 w-3.5" />
                  <span>Lock Admin</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setActiveNav('master-log')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Unlock className="h-3.5 w-3.5" />
                <span>Admin Login</span>
              </button>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8 space-y-6">
          {notice && (
            <div
              className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-xs font-medium ${
                notice.type === 'error'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : notice.type === 'success'
                  ? 'border-teal-200 bg-teal-50 text-teal-900'
                  : 'border-slate-200 bg-white text-slate-700'
              }`}
            >
              <div className="flex items-center gap-2.5">
                {notice.type === 'error' ? (
                  <AlertCircle className="h-4 w-4 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                )}
                <span>{notice.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="rounded p-1 hover:bg-black/5"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {activeNav === 'guard-gate' && (
            <GuardGateView
              employees={gateEmployees}
              todayRecords={todayRecords}
              serverDate={todayDate}
              onMarkIn={handleGuardMarkIn}
              onMarkOut={handleGuardMarkOut}
              onOpenAdminGate={() => setActiveNav('employees')}
            />
          )}

          {requiresAdminGate && (
            <AdminAuthGate
              isSigningInGoogle={isLoggingInGoogle}
              isLockedBySession={isLockedBySession}
              signedInEmail={googleUser?.email ?? null}
              onGoogleAdminLogin={handleGoogleAdminLogin}
              onBackToGuard={() => setActiveNav('guard-gate')}
            />
          )}

          {isAdminUnlocked && activeNav === 'master-log' && (
            <MasterAttendanceView
              employees={employees}
              records={records}
              sheetConfig={sheetConfig}
              onUpdateRecord={handleUpdateRecord}
              onDeleteRecord={handleDeleteRecord}
              onRequestSyncAll={handleRequestSyncAll}
            />
          )}

          {isAdminUnlocked && activeNav === 'individual-sheets' && (
            <IndividualEmployeeView
              employees={employees}
              records={records}
              sheetConfig={sheetConfig}
              isGoogleAuthed={hasGoogleToken}
              onRequestSyncEmployeeTab={handleRequestSyncEmployeeTab}
              onRequestStandaloneSheet={handleRequestStandaloneSheet}
            />
          )}

          {isAdminUnlocked && activeNav === 'employees' && (
            <EmployeesView
              employees={employees}
              onSaveEmployee={handleSaveEmployee}
              onToggleActive={handleToggleActive}
              onLoadStarterRoster={handleLoadStarterRoster}
            />
          )}

          {isAdminUnlocked && activeNav === 'sheets-sync' && (
            <GoogleSheetsSyncView
              user={googleUser}
              hasGoogleToken={hasGoogleToken}
              isSigningIn={isLoggingInGoogle}
              onGoogleLogin={handleConnectGoogleForSheetsOnly}
              onGoogleLogout={handleGoogleLogout}
              sheetConfig={sheetConfig}
              driveFiles={driveFiles}
              loadingDriveFiles={loadingDriveFiles}
              onRefreshDriveFiles={() => refreshDriveFiles()}
              onRequestCreateMasterSheet={handleRequestCreateMasterSheet}
              onConnectSpreadsheetById={(idOrUrl) => connectSpreadsheet(idOrUrl, false)}
              onRequestSyncAll={handleRequestSyncAll}
              onPullFromSheet={handlePullFromSheet}
              onDisconnectSheet={async () => {
                await adminSaveSheetConfig(null);
              }}
            />
          )}
        </main>
      </div>

      <ConfirmDialog
        request={confirmRequest}
        onClose={() => setConfirmRequest(null)}
      />
    </div>
  );
}
