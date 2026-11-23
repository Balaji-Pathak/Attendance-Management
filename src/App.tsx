import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileSpreadsheet,
  Menu,
  ShieldCheck,
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
  NavSection,
  SheetConfig,
} from './types/attendance';
import {
  buildStarterEmployees,
  calculateShiftMetrics,
  getEmployeeSheetTabName,
  sortRecordsNewestFirst,
} from './utils/time';
import {
  clearCachedToken,
  getAccessToken,
  googleSignIn,
  initAuth,
  logout,
} from './services/firebaseAuth';
import {
  createMasterSpreadsheet,
  createOrUpdateStandaloneEmployeeSheet,
  extractSpreadsheetId,
  listAppSpreadsheets,
  loadWorkbookData,
  syncEmployeeAndMasterTabs,
  syncFullWorkbook,
} from './services/googleSheets';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { ConfirmDialog } from './components/ConfirmDialog';
import { GuardGateView } from './components/GuardGateView';
import { MasterAttendanceView } from './components/MasterAttendanceView';
import { IndividualEmployeeView } from './components/IndividualEmployeeView';
import { EmployeesView } from './components/EmployeesView';
import { GoogleSheetsSyncView } from './components/GoogleSheetsSyncView';

const STORAGE_EMPLOYEES_KEY = 'gatelog_employees_v1';
const STORAGE_RECORDS_KEY = 'gatelog_records_v1';
const STORAGE_SHEET_ID_KEY = 'gatelog_sheet_id_v1';
const STORAGE_GUARD_NAME_KEY = 'gatelog_guard_name_v1';

interface NoticeState {
  type: 'success' | 'error' | 'info';
  message: string;
}

const NAV_ITEMS: Array<{ id: NavSection; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'guard-gate', label: 'Guard Gate Desk', icon: ShieldCheck },
  { id: 'master-log', label: 'Master Attendance', icon: ClipboardList },
  { id: 'individual-sheets', label: 'Individual Sheets', icon: UserSquare2 },
  { id: 'employees', label: 'Employees', icon: Users },
  { id: 'sheets-sync', label: 'Google Sheets Sync', icon: FileSpreadsheet },
];

export default function App() {
  const [activeNav, setActiveNav] = useState<NavSection>('guard-gate');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Auth state (token stays strictly in memory inside firebaseAuth.ts)
  const [user, setUser] = useState<User | null>(null);
  const [needsAuth, setNeedsAuth] = useState<boolean>(true);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  // Domain state
  const [employees, setEmployees] = useState<Employee[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_EMPLOYEES_KEY);
      return raw ? (JSON.parse(raw) as Employee[]) : [];
    } catch {
      return [];
    }
  });

  const [records, setRecords] = useState<AttendanceRecord[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_RECORDS_KEY);
      return raw ? (JSON.parse(raw) as AttendanceRecord[]) : [];
    } catch {
      return [];
    }
  });

  const [guardName, setGuardName] = useState<string>(() => {
    return localStorage.getItem(STORAGE_GUARD_NAME_KEY) || 'Guard Uncle';
  });

  // Google Sheets state
  const [sheetConfig, setSheetConfig] = useState<SheetConfig | null>(null);
  const [driveFiles, setDriveFiles] = useState<DriveSpreadsheetItem[]>([]);
  const [loadingDriveFiles, setLoadingDriveFiles] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // Feedback & Confirmation Modal
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);

  // Persist domain state locally
  useEffect(() => {
    localStorage.setItem(STORAGE_EMPLOYEES_KEY, JSON.stringify(employees));
  }, [employees]);

  useEffect(() => {
    localStorage.setItem(STORAGE_RECORDS_KEY, JSON.stringify(records));
  }, [records]);

  useEffect(() => {
    localStorage.setItem(STORAGE_GUARD_NAME_KEY, guardName);
  }, [guardName]);

  const handleApiError = useCallback((err: unknown, fallbackMsg: string) => {
    const errorObj = err as Error & { status?: number };
    if (errorObj?.status === 401) {
      clearCachedToken();
      setNeedsAuth(true);
      setNotice({
        type: 'error',
        message: 'Google session expired. Please sign in with Google again to continue syncing.',
      });
      return;
    }
    setNotice({
      type: 'error',
      message: errorObj?.message || fallbackMsg,
    });
  }, []);

  const refreshDriveFiles = useCallback(async (tokenOverride?: string) => {
    const token = tokenOverride || getAccessToken();
    if (!token) return;
    setLoadingDriveFiles(true);
    try {
      const files = await listAppSpreadsheets(token);
      setDriveFiles(files);
    } catch (err) {
      handleApiError(err, 'Failed to list spreadsheets from Google Drive.');
    } finally {
      setLoadingDriveFiles(false);
    }
  }, [handleApiError]);

  const connectSpreadsheet = useCallback(
    async (idOrUrl: string, tokenOverride?: string, loadDataIntoApp = false) => {
      const token = tokenOverride || getAccessToken();
      if (!token) {
        setNeedsAuth(true);
        return;
      }
      const spreadsheetId = extractSpreadsheetId(idOrUrl);
      setIsSyncing(true);
      try {
        const loaded = await loadWorkbookData(token, spreadsheetId);
        setSheetConfig(loaded.config);
        localStorage.setItem(STORAGE_SHEET_ID_KEY, loaded.config.spreadsheetId);

        if (loadDataIntoApp) {
          if (loaded.employees.length > 0) {
            setEmployees(loaded.employees);
          }
          if (loaded.records.length > 0) {
            setRecords(sortRecordsNewestFirst(loaded.records));
          }
          setNotice({
            type: 'success',
            message: `Loaded ${loaded.employees.length} employees and ${loaded.records.length} attendance records from "${loaded.config.spreadsheetTitle}".`,
          });
        } else {
          setNotice({
            type: 'success',
            message: `Connected to Google Sheet "${loaded.config.spreadsheetTitle}".`,
          });
        }
      } catch (err) {
        handleApiError(err, 'Could not connect to the specified Google Spreadsheet.');
      } finally {
        setIsSyncing(false);
      }
    },
    [handleApiError]
  );

  useEffect(() => {
    const unsubscribe = initAuth(
      (authedUser, token) => {
        setUser(authedUser);
        setNeedsAuth(false);
        refreshDriveFiles(token);
        const savedSheetId = localStorage.getItem(STORAGE_SHEET_ID_KEY);
        if (savedSheetId && !sheetConfig) {
          connectSpreadsheet(savedSheetId, token, false);
        }
      },
      (maybeUser) => {
        setUser(maybeUser);
        setNeedsAuth(true);
      }
    );
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true);
    setNotice(null);
    try {
      const { user: authedUser, accessToken } = await googleSignIn();
      setUser(authedUser);
      setNeedsAuth(false);
      await refreshDriveFiles(accessToken);

      const savedSheetId = localStorage.getItem(STORAGE_SHEET_ID_KEY);
      if (savedSheetId) {
        await connectSpreadsheet(savedSheetId, accessToken, false);
      } else {
        setNotice({
          type: 'success',
          message: `Signed in as ${authedUser.email}. Create or select your Master Attendance Sheet in Google Sheets Sync.`,
        });
      }
    } catch (err) {
      handleApiError(err, 'Google sign-in failed or was cancelled.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleGoogleLogout = async () => {
    await logout();
    setUser(null);
    setNeedsAuth(true);
    setDriveFiles([]);
    setSheetConfig(null);
    setNotice({
      type: 'info',
      message: 'Signed out of Google Workspace.',
    });
  };

  // Helper to sync one employee + master to connected sheet
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
      setSheetConfig(updatedCfg);
      setRecords((prev) => prev.map((r) => ({ ...r, syncedToSheet: true })));
    } catch (err) {
      handleApiError(err, 'Saved locally, but Google Sheets sync failed.');
    } finally {
      setIsSyncing(false);
    }
  };

  // Guard Gate Actions (already confirmed inside GuardGateView's confirmation dialog)
  const handleMarkCheckIn = async ({
    employee,
    date,
    inTime,
    markedBy,
    notes,
  }: {
    employee: Employee;
    date: string;
    inTime: string;
    markedBy: string;
    notes: string;
  }) => {
    const newRecord: AttendanceRecord = {
      id: `att-${Date.now()}`,
      date,
      empId: employee.id,
      empCode: employee.empCode,
      empName: employee.name,
      department: employee.department,
      inTime,
      outTime: null,
      grossMinutes: null,
      breakMinutes: employee.breakMinutes ?? 30,
      netMinutes: null,
      netDecimalHours: null,
      status: 'on_duty',
      markedBy,
      notes,
      syncedToSheet: false,
      updatedAt: new Date().toISOString(),
    };

    const nextRecords = sortRecordsNewestFirst([newRecord, ...records]);
    setRecords(nextRecords);

    if (sheetConfig && getAccessToken()) {
      await syncOneEmployeeAndMaster(employee, employees, nextRecords);
      setNotice({
        type: 'success',
        message: `Checked in ${employee.name} at ${inTime} and synced to Google Sheets.`,
      });
    } else {
      setNotice({
        type: 'success',
        message: `Checked in ${employee.name} at ${inTime}.`,
      });
    }
  };

  const handleMarkCheckOut = async ({
    record,
    employee,
    outTime,
    breakMinutes,
    markedBy,
    notes,
  }: {
    record: AttendanceRecord;
    employee: Employee;
    outTime: string;
    breakMinutes: number;
    markedBy: string;
    notes: string;
  }) => {
    const calc = calculateShiftMetrics(record.inTime, outTime, breakMinutes);
    const updatedRecord: AttendanceRecord = {
      ...record,
      outTime,
      grossMinutes: calc.grossMinutes,
      breakMinutes: calc.breakDeductedMinutes,
      netMinutes: calc.netMinutes,
      netDecimalHours: calc.netDecimalHours,
      status: calc.status,
      markedBy,
      notes,
      syncedToSheet: false,
      updatedAt: new Date().toISOString(),
    };

    const nextRecords = sortRecordsNewestFirst(
      records.map((r) => (r.id === record.id ? updatedRecord : r))
    );
    setRecords(nextRecords);

    if (sheetConfig && getAccessToken()) {
      await syncOneEmployeeAndMaster(employee, employees, nextRecords);
      setNotice({
        type: 'success',
        message: `Checked out ${employee.name} at ${outTime} (${calc.netDecimalHours.toFixed(2)} net hrs after ${calc.breakDeductedMinutes}m break) and synced to Google Sheets.`,
      });
    } else {
      setNotice({
        type: 'success',
        message: `Checked out ${employee.name} at ${outTime} (${calc.netDecimalHours.toFixed(2)} net hrs after ${calc.breakDeductedMinutes}m break).`,
      });
    }
  };

  // Master Attendance Edit & Delete (with explicit confirmation when mutating Google Sheets or deleting)
  const handleUpdateRecord = async (updated: AttendanceRecord) => {
    const emp = employees.find(
      (e) => e.id === updated.empId || e.empCode === updated.empCode
    );
    const nextRecords = sortRecordsNewestFirst(
      records.map((r) => (r.id === updated.id ? updated : r))
    );

    if (sheetConfig && getAccessToken() && emp) {
      setConfirmRequest({
        title: 'Update Attendance Entry in Google Sheets?',
        description: `Save modified attendance timings for ${updated.empName} on ${updated.date} and update Google Sheets.`,
        affectedTarget: sheetConfig.spreadsheetTitle,
        details: [
          'Updates Master Attendance tab',
          `Updates individual tab: ${getEmployeeSheetTabName(emp.empCode, emp.name)}`,
        ],
        confirmLabel: 'Save & Sync Sheet',
        onConfirm: async () => {
          setRecords(nextRecords);
          await syncOneEmployeeAndMaster(emp, employees, nextRecords);
          setNotice({
            type: 'success',
            message: `Updated ${updated.empName}'s entry and synced to Google Sheets.`,
          });
        },
      });
    } else {
      setRecords(nextRecords);
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
      description: `Permanently remove the ${record.date} entry for ${record.empName} (${record.inTime}${record.outTime ? ` – ${record.outTime}` : ''}).`,
      affectedTarget: hasSheet ? sheetConfig?.spreadsheetTitle : undefined,
      details: hasSheet
        ? [
            'Removes the row from Master Attendance tab',
            `Updates ${record.empName}'s individual sheet tab`,
          ]
        : ['Removes the record from your local attendance register'],
      confirmLabel: 'Delete Entry',
      destructive: true,
      onConfirm: async () => {
        const nextRecords = records.filter((r) => r.id !== record.id);
        setRecords(nextRecords);
        if (hasSheet && emp) {
          await syncOneEmployeeAndMaster(emp, employees, nextRecords);
        }
        setNotice({
          type: 'info',
          message: `Deleted attendance record for ${record.empName} (${record.date}).`,
        });
      },
    });
  };

  // Employee Directory Mutations
  const handleSaveEmployee = async (emp: Employee, isNew: boolean) => {
    const nextEmployees = isNew
      ? [...employees, emp]
      : employees.map((e) => (e.id === emp.id ? emp : e));

    if (sheetConfig && getAccessToken()) {
      setConfirmRequest({
        title: isNew ? 'Add Employee & Create Sheet Tab?' : 'Update Employee in Google Sheets?',
        description: isNew
          ? `Add ${emp.name} (${emp.empCode}) to your roster and create their individual tab in the Master Google Sheet.`
          : `Save changes for ${emp.name} (${emp.empCode}) and update the Employees & individual sheet tabs.`,
        affectedTarget: sheetConfig.spreadsheetTitle,
        details: [
          'Updates Employees tab',
          `Creates/updates tab: ${getEmployeeSheetTabName(emp.empCode, emp.name)}`,
        ],
        confirmLabel: isNew ? 'Add & Sync Tab' : 'Save & Sync',
        onConfirm: async () => {
          setEmployees(nextEmployees);
          await syncOneEmployeeAndMaster(emp, nextEmployees, records);
          setNotice({
            type: 'success',
            message: `${isNew ? 'Added' : 'Updated'} ${emp.name} and synced to Google Sheets.`,
          });
        },
      });
    } else {
      setEmployees(nextEmployees);
      setNotice({
        type: 'success',
        message: `${isNew ? 'Added' : 'Updated'} ${emp.name} in roster.`,
      });
    }
  };

  const handleToggleActive = async (emp: Employee) => {
    const updated = { ...emp, active: !emp.active };
    await handleSaveEmployee(updated, false);
  };

  const handleLoadStarterRoster = () => {
    const starter = buildStarterEmployees();
    setEmployees(starter);
    setNotice({
      type: 'success',
      message: 'Loaded 5 starter staff profiles. Guard can now mark check-in and check-out times.',
    });
  };

  // Google Sheets Sync Actions (all guarded by ConfirmDialog)
  const handleRequestCreateMasterSheet = (title: string) => {
    const token = getAccessToken();
    if (!token) {
      setNeedsAuth(true);
      return;
    }

    setConfirmRequest({
      title: 'Create Master Attendance Google Sheet?',
      description: `This will create a new Google Spreadsheet named "${title}" in your Google Drive with structured tabs for all attendance records and individual employee sheets.`,
      affectedTarget: title,
      details: [
        'Tab 1: Master Attendance (all guard check-in/out logs & net hours)',
        'Tab 2: Employees (roster, shifts & 30-min break rules)',
        `Individual Tabs: ${employees.length} employee sheet tab(s) with summary formulas`,
      ],
      confirmLabel: 'Create Google Sheet',
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          const cfg = await createMasterSpreadsheet(token, title, employees, records);
          setSheetConfig(cfg);
          localStorage.setItem(STORAGE_SHEET_ID_KEY, cfg.spreadsheetId);
          setRecords((prev) => prev.map((r) => ({ ...r, syncedToSheet: true })));
          await refreshDriveFiles(token);
          setNotice({
            type: 'success',
            message: `Created "${cfg.spreadsheetTitle}" with Master Attendance and ${employees.length} individual employee tabs.`,
          });
        } catch (err) {
          handleApiError(err, 'Failed to create Google Spreadsheet.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handleRequestSyncAll = () => {
    const token = getAccessToken();
    if (!token || !sheetConfig) {
      setNeedsAuth(true);
      return;
    }

    setConfirmRequest({
      title: 'Sync All Attendance & Employee Tabs?',
      description: `Overwrite and synchronize the Master Attendance log, Employees roster, and all ${employees.length} individual employee tabs in "${sheetConfig.spreadsheetTitle}".`,
      affectedTarget: sheetConfig.spreadsheetTitle,
      details: [
        `Master Attendance: ${records.length} record(s)`,
        `Employees Roster: ${employees.length} employee(s)`,
        `Individual Employee Tabs: ${employees.length} tab(s) updated`,
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
          setSheetConfig(cfg);
          setRecords((prev) => prev.map((r) => ({ ...r, syncedToSheet: true })));
          setNotice({
            type: 'success',
            message: `Synchronized all tabs in "${cfg.spreadsheetTitle}".`,
          });
        } catch (err) {
          handleApiError(err, 'Failed to synchronize Google Sheet.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handleRequestSyncEmployeeTab = (employee: Employee) => {
    const token = getAccessToken();
    if (!token || !sheetConfig) {
      setNeedsAuth(true);
      return;
    }
    const tabName = getEmployeeSheetTabName(employee.empCode, employee.name);

    setConfirmRequest({
      title: `Sync ${employee.name}'s Sheet Tab?`,
      description: `Update "${tabName}" and Master Attendance in "${sheetConfig.spreadsheetTitle}" with ${employee.name}'s attendance records.`,
      affectedTarget: `${sheetConfig.spreadsheetTitle} · Tab: ${tabName}`,
      confirmLabel: 'Sync Employee Tab',
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
      setNeedsAuth(true);
      return;
    }
    const isUpdate = Boolean(employee.individualSheetId);

    setConfirmRequest({
      title: isUpdate
        ? `Update ${employee.name}'s Dedicated Google Sheet?`
        : `Create Dedicated Google Sheet for ${employee.name}?`,
      description: isUpdate
        ? `Overwrite the standalone Google Sheet for ${employee.name} (${employee.empCode}) with their latest attendance entries and summary formulas.`
        : `Create a separate standalone Google Spreadsheet file in Google Drive dedicated exclusively to ${employee.name} (${employee.empCode}).`,
      affectedTarget: `Attendance Sheet - ${employee.empCode} ${employee.name}`,
      confirmLabel: isUpdate ? 'Update Dedicated Sheet' : 'Create Dedicated Sheet',
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          const res = await createOrUpdateStandaloneEmployeeSheet(token, employee, records);
          const updatedEmp: Employee = {
            ...employee,
            individualSheetId: res.spreadsheetId,
            individualSheetUrl: res.spreadsheetUrl,
          };
          const nextEmployees = employees.map((e) =>
            e.id === employee.id ? updatedEmp : e
          );
          setEmployees(nextEmployees);

          if (sheetConfig) {
            await syncOneEmployeeAndMaster(updatedEmp, nextEmployees, records);
          }
          await refreshDriveFiles(token);
          setNotice({
            type: 'success',
            message: `${isUpdate ? 'Updated' : 'Created'} dedicated Google Sheet for ${employee.name}.`,
          });
        } catch (err) {
          handleApiError(err, 'Could not create or update dedicated employee sheet.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handlePullFromSheet = () => {
    const token = getAccessToken();
    if (!token || !sheetConfig) return;

    setConfirmRequest({
      title: 'Load Attendance & Staff from Google Sheet?',
      description: `Replace local workspace records with the current data stored in "${sheetConfig.spreadsheetTitle}".`,
      affectedTarget: sheetConfig.spreadsheetTitle,
      confirmLabel: 'Load from Sheet',
      onConfirm: async () => {
        await connectSpreadsheet(sheetConfig.spreadsheetId, token, true);
      },
    });
  };

  const activeNavLabel = NAV_ITEMS.find((n) => n.id === activeNav)?.label ?? 'Guard Gate Desk';

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
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveNav(item.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-4 text-xs text-slate-500 space-y-1">
          <div className="font-medium text-slate-700">Break Deduction Rule</div>
          <div>30 min auto-deducted per shift</div>
          {sheetConfig && (
            <div className="pt-2 truncate font-medium text-teal-800">
              Sheet: {sheetConfig.spreadsheetTitle}
            </div>
          )}
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
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveNav(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium whitespace-nowrap ${
                      active
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar Contract: Breadcrumb on left, Primary Action / Auth on right */}
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
              <h1 className="font-semibold text-slate-900 truncate">{activeNavLabel}</h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {needsAuth ? (
              <GoogleSignInButton
                onClick={handleGoogleLogin}
                disabled={isLoggingIn}
                label={isLoggingIn ? 'Signing in...' : 'Sign in with Google'}
              />
            ) : sheetConfig ? (
              <a
                href={sheetConfig.spreadsheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <span>{isSyncing ? 'Syncing...' : 'Open Google Sheet'}</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <button
                type="button"
                onClick={() => setActiveNav('sheets-sync')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                <span>Connect Google Sheet</span>
              </button>
            )}
          </div>
        </header>

        {/* Main Viewport */}
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8 space-y-6">
          {/* Action Feedback Banner */}
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
              employees={employees}
              records={records}
              sheetConfig={sheetConfig}
              isGoogleAuthed={!needsAuth}
              guardName={guardName}
              onGuardNameChange={setGuardName}
              onMarkCheckIn={handleMarkCheckIn}
              onMarkCheckOut={handleMarkCheckOut}
              onNavigateToEmployees={() => setActiveNav('employees')}
              onLoadStarterRoster={handleLoadStarterRoster}
            />
          )}

          {activeNav === 'master-log' && (
            <MasterAttendanceView
              employees={employees}
              records={records}
              sheetConfig={sheetConfig}
              onUpdateRecord={handleUpdateRecord}
              onDeleteRecord={handleDeleteRecord}
              onRequestSyncAll={handleRequestSyncAll}
            />
          )}

          {activeNav === 'individual-sheets' && (
            <IndividualEmployeeView
              employees={employees}
              records={records}
              sheetConfig={sheetConfig}
              isGoogleAuthed={!needsAuth}
              onRequestSyncEmployeeTab={handleRequestSyncEmployeeTab}
              onRequestStandaloneSheet={handleRequestStandaloneSheet}
            />
          )}

          {activeNav === 'employees' && (
            <EmployeesView
              employees={employees}
              onSaveEmployee={handleSaveEmployee}
              onToggleActive={handleToggleActive}
              onLoadStarterRoster={handleLoadStarterRoster}
            />
          )}

          {activeNav === 'sheets-sync' && (
            <GoogleSheetsSyncView
              user={user}
              hasToken={!needsAuth}
              isSigningIn={isLoggingIn}
              onGoogleLogin={handleGoogleLogin}
              onGoogleLogout={handleGoogleLogout}
              sheetConfig={sheetConfig}
              driveFiles={driveFiles}
              loadingDriveFiles={loadingDriveFiles}
              onRefreshDriveFiles={() => refreshDriveFiles()}
              onRequestCreateMasterSheet={handleRequestCreateMasterSheet}
              onConnectSpreadsheetById={(idOrUrl) => connectSpreadsheet(idOrUrl, undefined, false)}
              onRequestSyncAll={handleRequestSyncAll}
              onPullFromSheet={handlePullFromSheet}
              onDisconnectSheet={() => {
                setSheetConfig(null);
                localStorage.removeItem(STORAGE_SHEET_ID_KEY);
              }}
            />
          )}
        </main>
      </div>

      {/* Explicit Confirmation Modal for Workspace API Mutations */}
      <ConfirmDialog
        request={confirmRequest}
        onClose={() => setConfirmRequest(null)}
      />
    </div>
  );
}
