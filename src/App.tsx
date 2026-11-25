import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  AdminEmailEntry,
  AttendanceRecord,
  CategorySheetConfigs,
  COMPANY_CATEGORIES,
  CompanyCategory,
  ConfirmRequest,
  DriveSpreadsheetItem,
  Employee,
  GateEmployeeView,
  NavSection,
} from './types/attendance';
import {
  buildStarterEmployees,
  calculateShiftMetrics,
  formatMonthLabel,
  getEmployeeSheetTabName,
  getTodayISO,
  normalizeCompanyCategory,
  sortRecordsNewestFirst,
} from './utils/time';
import {
  checkIsAuthorizedAdmin,
  clearCachedToken,
  getAccessToken,
  googleSignIn,
  initAuth,
  logout,
  PRIMARY_ADMIN_EMAIL,
} from './services/firebaseAuth';
import {
  adminAddEmail,
  adminBackfillEmployeeCompanyCategories,
  adminDeleteAttendance,
  adminDeleteEmployee,
  adminImportFromSheet,
  adminLoadStarterEmployees,
  adminMarkRecordsSynced,
  adminRemoveEmail,
  adminSaveBulkAttendance,
  adminSaveEmployee,
  adminSaveSheetConfig,
  adminUpdateAttendance,
  guardMarkIn,
  guardMarkOut,
  guardPauseTiming,
  guardResumeTiming,
  subscribeActiveEmployees,
  subscribeAdminEmails,
  subscribeAllAttendance,
  subscribeAllEmployees,
  subscribeTodayAttendance,
  subscribeWorkspaceSettings,
} from './services/firestoreService';
import {
  createMasterSpreadsheet,
  createOrUpdateStandaloneEmployeeSheet,
  extractSpreadsheetId,
  importEmployeeGoogleSheet,
  listAppSpreadsheets,
  loadWorkbookData,
  revokeSpreadsheetAccess,
  shareSpreadsheetWithEmails,
  syncEmployeeAndMasterTabs,
  syncFullWorkbook,
  trashSpreadsheet,
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

const EMPTY_SHEET_CONFIGS: CategorySheetConfigs = {
  'Sukhsa Export Permanent': null,
  'Sukhsa Export Temporary': null,
};

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
  const [sheetConfigs, setSheetConfigs] = useState<CategorySheetConfigs>(EMPTY_SHEET_CONFIGS);
  const [adminEmails, setAdminEmails] = useState<AdminEmailEntry[]>([]);
  const [driveFiles, setDriveFiles] = useState<DriveSpreadsheetItem[]>([]);
  const [loadingDriveFiles, setLoadingDriveFiles] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const backfilledEmpIdsRef = useRef<Set<string>>(new Set());

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
      setSheetConfigs(EMPTY_SHEET_CONFIGS);
      setAdminEmails([]);
      return;
    }

    const unsubEmps = subscribeAllEmployees(
      (list, missingCategory) => {
        setEmployees(list);
        const pending = missingCategory.filter((e) => !backfilledEmpIdsRef.current.has(e.id));
        if (pending.length > 0) {
          for (const emp of pending) {
            backfilledEmpIdsRef.current.add(emp.id);
          }
          adminBackfillEmployeeCompanyCategories(pending).catch(() => {});
        }
      },
      (err) => setNotice({ type: 'error', message: err.message })
    );
    const unsubAtt = subscribeAllAttendance(
      (list) => setRecords(list),
      (err) => setNotice({ type: 'error', message: err.message })
    );
    const unsubSettings = subscribeWorkspaceSettings(
      (cfgs) => setSheetConfigs(cfgs),
      (err) => setNotice({ type: 'error', message: err.message })
    );
    const unsubAdmins = subscribeAdminEmails(
      (list) => setAdminEmails(list),
      (err) => setNotice({ type: 'error', message: err.message })
    );

    return () => {
      unsubEmps();
      unsubAtt();
      unsubSettings();
      unsubAdmins();
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
      const otPart =
        updated.overtimeDecimalHours && updated.overtimeDecimalHours > 0
          ? `, +${updated.overtimeDecimalHours.toFixed(2)}h OT`
          : '';
      setNotice({
        type: 'success',
        message: `Marked OUT: ${updated.empName} (${updated.netDecimalHours?.toFixed(2)}h net${otPart}).`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        message: (err as Error).message || 'Could not mark check-out.',
      });
    }
  };

  const handleGuardPauseTiming = async (recordId: string) => {
    const rec = todayRecords.find((r) => r.id === recordId);
    if (!rec || rec.isPaused) return;
    const optimisticPausedAt = Date.now();
    setTodayRecords((prev) =>
      prev.map((r) =>
        r.id === recordId ? { ...r, isPaused: true, pausedAtMs: optimisticPausedAt } : r
      )
    );
    try {
      const updated = await guardPauseTiming(rec);
      setTodayRecords((prev) => prev.map((r) => (r.id === recordId ? updated : r)));
      setNotice({
        type: 'info',
        message: `Paused timer for ${updated.empName}. Tap "Start Timing" when they return.`,
      });
    } catch (err) {
      setTodayRecords((prev) => prev.map((r) => (r.id === recordId ? rec : r)));
      setNotice({
        type: 'error',
        message: (err as Error).message || 'Could not pause working timer.',
      });
    }
  };

  const handleGuardResumeTiming = async (recordId: string) => {
    const rec = todayRecords.find((r) => r.id === recordId);
    if (!rec || !rec.isPaused) return;
    try {
      const updated = await guardResumeTiming(rec);
      setTodayRecords((prev) => prev.map((r) => (r.id === recordId ? updated : r)));
      setNotice({
        type: 'success',
        message: `Resumed working timer for ${updated.empName}.`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        message: (err as Error).message || 'Could not resume working timer.',
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

  const ensureGoogleToken = async (): Promise<string | null> => {
    const existing = getAccessToken();
    if (existing) return existing;
    setIsLoggingInGoogle(true);
    try {
      const { user: authedUser, accessToken } = await googleSignIn();
      setGoogleUser(authedUser);
      setHasGoogleToken(true);
      await refreshDriveFiles(accessToken);
      return accessToken;
    } catch (err) {
      handleGoogleError(err, 'Google Sheets authorization was cancelled or failed.');
      return null;
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
  const getAllAdminEmails = useCallback(
    (extraEmail?: string): string[] => {
      const list = [
        PRIMARY_ADMIN_EMAIL,
        ...adminEmails.map((a) => a.email.toLowerCase()),
      ];
      if (extraEmail) {
        list.push(extraEmail.trim().toLowerCase());
      }
      return Array.from(new Set(list.filter(Boolean)));
    },
    [adminEmails]
  );

  const collectAllManagedSheetIds = useCallback(
    (extraIds: Array<string | undefined | null> = []): string[] => {
      const ids = [
        sheetConfigs['Sukhsa Export Permanent']?.spreadsheetId,
        sheetConfigs['Sukhsa Export Temporary']?.spreadsheetId,
        ...employees.map((e) => e.individualSheetId),
        ...extraIds,
      ]
        .map((id) => (id ? id.trim() : ''))
        .filter(Boolean);
      return Array.from(new Set(ids));
    },
    [sheetConfigs, employees]
  );

  const shareSheetsWithEmails = useCallback(
    async (
      token: string,
      sheetIds: string[],
      targetEmails: string[]
    ): Promise<{ sharedCount: number; failedCount: number }> => {
      let sharedCount = 0;
      let failedCount = 0;
      for (const sheetId of sheetIds) {
        const res = await shareSpreadsheetWithEmails(
          token,
          sheetId,
          targetEmails,
          googleUser?.email
        );
        sharedCount += res.shared.length;
        failedCount += res.failed.length;
      }
      return { sharedCount, failedCount };
    },
    [googleUser]
  );

  const upsertLocalEmployee = useCallback((emp: Employee) => {
    setEmployees((prev) => {
      const exists = prev.some((e) => e.id === emp.id);
      const next = exists
        ? prev.map((e) => (e.id === emp.id ? emp : e))
        : [...prev, emp];
      return [...next].sort((a, b) => a.empCode.localeCompare(b.empCode));
    });
    setGateEmployees((prev) => {
      if (!emp.active) {
        return prev.filter((e) => e.id !== emp.id);
      }
      const view: GateEmployeeView = {
        id: emp.id,
        empCode: emp.empCode,
        name: emp.name,
        department: emp.department,
        companyCategory: normalizeCompanyCategory(emp.companyCategory),
      };
      const exists = prev.some((e) => e.id === emp.id);
      const next = exists
        ? prev.map((e) => (e.id === emp.id ? view : e))
        : [...prev, view];
      return [...next].sort((a, b) => a.empCode.localeCompare(b.empCode));
    });
  }, []);

  const getRecordsForCategory = (
    allEmployees: Employee[],
    allRecords: AttendanceRecord[],
    category: CompanyCategory
  ): AttendanceRecord[] => {
    const catEmps = allEmployees.filter(
      (e) => normalizeCompanyCategory(e.companyCategory) === category
    );
    const empIds = new Set(catEmps.map((e) => e.id));
    const empCodes = new Set(catEmps.map((e) => e.empCode));
    return allRecords.filter((r) => empIds.has(r.empId) || empCodes.has(r.empCode));
  };

  const syncOneEmployeeAndMaster = async (
    employee: Employee,
    nextEmployees: Employee[],
    nextRecords: AttendanceRecord[],
    overrideCategory?: CompanyCategory,
    tokenOverride?: string
  ) => {
    const token = tokenOverride || getAccessToken();
    const targetCategory = overrideCategory ?? normalizeCompanyCategory(employee.companyCategory);
    const targetCfg = sheetConfigs[targetCategory];
    if (!token || !targetCfg) return;
    setIsSyncing(true);
    try {
      const updatedCfg = await syncEmployeeAndMasterTabs(
        token,
        targetCfg.spreadsheetId,
        employee,
        nextEmployees,
        nextRecords,
        targetCategory
      );
      await adminSaveSheetConfig(targetCategory, updatedCfg);
      await adminMarkRecordsSynced(getRecordsForCategory(nextEmployees, nextRecords, targetCategory));
      await shareSheetsWithEmails(
        token,
        collectAllManagedSheetIds([updatedCfg.spreadsheetId, employee.individualSheetId]),
        getAllAdminEmails()
      );
    } catch (err) {
      handleGoogleError(err, 'Saved changes, but Google Sheets sync failed.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveEmployee = async (emp: Employee, isNew: boolean) => {
    const trimmedCode = emp.empCode.trim();
    if (!trimmedCode) {
      const msg = 'Employee ID is required.';
      setNotice({ type: 'error', message: msg });
      throw new Error(msg);
    }

    const activeConflict = employees.find(
      (e) =>
        e.id !== emp.id &&
        e.active &&
        e.empCode.trim().toLowerCase() === trimmedCode.toLowerCase()
    );
    if (activeConflict) {
      const msg = `Employee ID "${trimmedCode}" is already assigned to active employee ${activeConflict.name}. You can only reuse an Employee ID if that employee is Inactive.`;
      setNotice({ type: 'error', message: msg });
      throw new Error(msg);
    }

    const normalizedEmp: Employee = {
      ...emp,
      empCode: trimmedCode,
      companyCategory: normalizeCompanyCategory(emp.companyCategory),
    };
    const prevEmp = employees.find((e) => e.id === normalizedEmp.id);
    const prevCat = prevEmp ? normalizeCompanyCategory(prevEmp.companyCategory) : null;
    const newCat = normalizeCompanyCategory(normalizedEmp.companyCategory);
    const categoryChanged = Boolean(!isNew && prevCat && prevCat !== newCat);

    const nextEmployees = isNew
      ? [...employees, normalizedEmp].sort((a, b) => a.empCode.localeCompare(b.empCode))
      : employees.map((e) => (e.id === normalizedEmp.id ? normalizedEmp : e));

    await adminSaveEmployee(normalizedEmp);
    upsertLocalEmployee(normalizedEmp);
    setNotice({
      type: 'success',
      message: `${isNew ? 'Added' : 'Updated'} ${normalizedEmp.name} (${newCat}).`,
    });

    const oldMasterCfg = categoryChanged && prevCat ? sheetConfigs[prevCat] : null;
    const newMasterCfg = sheetConfigs[newCat];
    const hasStandalone = Boolean(normalizedEmp.individualSheetId);

    if (oldMasterCfg || newMasterCfg || hasStandalone) {
      const details: string[] = [];
      if (oldMasterCfg && prevCat) {
        details.push(
          `Removes ${normalizedEmp.name} from "${oldMasterCfg.spreadsheetTitle}" (${prevCat})`
        );
      }
      if (newMasterCfg) {
        details.push(
          `Updates Monthly Summary & Employees tabs in "${newMasterCfg.spreadsheetTitle}" (${newCat})`
        );
      }
      if (hasStandalone) {
        details.push('Updates standalone Individual Google Sheet company & month tabs');
      }

      const affectedTarget = [
        oldMasterCfg?.spreadsheetTitle,
        newMasterCfg?.spreadsheetTitle,
        hasStandalone ? `${normalizedEmp.empCode} - ${normalizedEmp.name}` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');

      setConfirmRequest({
        title: categoryChanged
          ? 'Move Employee Between Company Sheets?'
          : isNew
          ? 'Sync New Employee to Google Sheets?'
          : 'Sync Updated Employee to Google Sheets?',
        description: categoryChanged
          ? `${normalizedEmp.name} moved from ${prevCat} to ${newCat}. Update connected Google Sheets now?`
          : `${normalizedEmp.name} (${normalizedEmp.empCode} · ${newCat}) is saved. Update connected Google Sheets now?`,
        affectedTarget,
        details,
        confirmLabel: 'Update Sheets',
        onConfirm: async () => {
          const activeToken = getAccessToken() || (await ensureGoogleToken());
          if (!activeToken) return;
          setIsSyncing(true);
          try {
            if (oldMasterCfg && prevCat) {
              const updatedOld = await syncFullWorkbook(
                activeToken,
                oldMasterCfg.spreadsheetId,
                nextEmployees,
                records,
                prevCat
              );
              await adminSaveSheetConfig(prevCat, updatedOld);
            }
            if (newMasterCfg) {
              const updatedNew = await syncEmployeeAndMasterTabs(
                activeToken,
                newMasterCfg.spreadsheetId,
                normalizedEmp,
                nextEmployees,
                records,
                newCat
              );
              await adminSaveSheetConfig(newCat, updatedNew);
              await adminMarkRecordsSynced(
                getRecordsForCategory(nextEmployees, records, newCat)
              );
            }
            if (normalizedEmp.individualSheetId) {
              await createOrUpdateStandaloneEmployeeSheet(
                activeToken,
                normalizedEmp,
                records
              );
            }
            await shareSheetsWithEmails(
              activeToken,
              collectAllManagedSheetIds([
                oldMasterCfg?.spreadsheetId,
                newMasterCfg?.spreadsheetId,
                normalizedEmp.individualSheetId,
              ]),
              getAllAdminEmails()
            );
            await refreshDriveFiles(activeToken);
            setNotice({
              type: 'success',
              message: categoryChanged
                ? `Moved ${normalizedEmp.name} to ${newCat} and updated Google Sheets.`
                : `${isNew ? 'Added' : 'Updated'} ${normalizedEmp.name} and synced Google Sheets.`,
            });
          } catch (err) {
            handleGoogleError(err, 'Saved employee, but Google Sheets update failed.');
          } finally {
            setIsSyncing(false);
          }
        },
      });
    }
  };

  const handleToggleActive = async (emp: Employee) => {
    await handleSaveEmployee({ ...emp, active: !emp.active }, false);
  };

  const handleDeleteEmployee = (emp: Employee) => {
    const empCategory = normalizeCompanyCategory(emp.companyCategory);
    const otherCategory = COMPANY_CATEGORIES.find((c) => c !== empCategory);
    const matchesEmployeeRecord = (r: AttendanceRecord) =>
      r.empId === emp.id || (!r.empId && r.empCode === emp.empCode);
    const empRecords = records.filter(matchesEmployeeRecord);
    const empTabName = getEmployeeSheetTabName(emp.empCode, emp.name);
    const targetMasterCfg = sheetConfigs[empCategory];
    const otherMasterCfg = otherCategory ? sheetConfigs[otherCategory] : null;
    const shouldSyncOtherMaster = Boolean(
      otherMasterCfg && otherMasterCfg.tabNames.includes(empTabName)
    );
    const needsSheetSync = Boolean(
      targetMasterCfg || shouldSyncOtherMaster || emp.individualSheetId
    );

    const details: string[] = [
      `Removes ${emp.name} (${emp.empCode}) permanently from Employees & Guard Gate Desk`,
      `Deletes ${empRecords.length} attendance record(s) from Master Attendance`,
    ];
    if (targetMasterCfg) {
      details.push(
        `Removes ${emp.name}'s tab & rows from "${targetMasterCfg.spreadsheetTitle}"`
      );
    }
    if (shouldSyncOtherMaster && otherMasterCfg) {
      details.push(
        `Removes ${emp.name}'s tab & rows from "${otherMasterCfg.spreadsheetTitle}"`
      );
    }
    if (emp.individualSheetId) {
      details.push(
        `Moves "${emp.empCode} - ${emp.name} Attendance" Google Sheet to Drive Trash`
      );
    }

    setConfirmRequest({
      title: `Delete Employee ${emp.name}?`,
      description: `Permanently delete ${emp.name} (${emp.empCode} · ${empCategory}) and their attendance records. If you want to keep their past attendance history, click Cancel and use Deactivate instead.`,
      affectedTarget: `${emp.empCode} - ${emp.name}`,
      details,
      confirmLabel: 'Delete Employee',
      destructive: true,
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          await adminDeleteEmployee(emp, empRecords);
          const nextEmployees = employees.filter((e) => e.id !== emp.id);
          const nextRecords = records.filter((r) => !matchesEmployeeRecord(r));
          setEmployees(nextEmployees);
          setGateEmployees((prev) => prev.filter((e) => e.id !== emp.id));
          setRecords(nextRecords);

          let sheetsUpdated = false;
          if (needsSheetSync) {
            const activeToken = getAccessToken() || (await ensureGoogleToken());
            if (activeToken) {
              if (targetMasterCfg) {
                const updatedCfg = await syncFullWorkbook(
                  activeToken,
                  targetMasterCfg.spreadsheetId,
                  nextEmployees,
                  nextRecords,
                  empCategory,
                  [empTabName]
                );
                await adminSaveSheetConfig(empCategory, updatedCfg);
              }
              if (shouldSyncOtherMaster && otherMasterCfg && otherCategory) {
                const updatedOtherCfg = await syncFullWorkbook(
                  activeToken,
                  otherMasterCfg.spreadsheetId,
                  nextEmployees,
                  nextRecords,
                  otherCategory,
                  [empTabName]
                );
                await adminSaveSheetConfig(otherCategory, updatedOtherCfg);
              }
              if (emp.individualSheetId) {
                await trashSpreadsheet(activeToken, emp.individualSheetId);
              }
              await refreshDriveFiles(activeToken);
              sheetsUpdated = true;
            }
          }

          setNotice({
            type: needsSheetSync && !sheetsUpdated ? 'info' : 'success',
            message:
              needsSheetSync && !sheetsUpdated
                ? `Deleted ${emp.name} (${emp.empCode}) and ${empRecords.length} record(s). Connect Google Sheets and click "Update All Sheets" to remove them from your Mega Sheet.`
                : sheetsUpdated
                ? `Deleted ${emp.name} (${emp.empCode}), ${empRecords.length} record(s), and updated connected Google Sheets.`
                : `Deleted ${emp.name} (${emp.empCode}) and ${empRecords.length} attendance record(s).`,
          });
        } catch (err) {
          handleGoogleError(err, `Could not delete ${emp.name}.`);
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handleLoadStarterRoster = async () => {
    const starter = buildStarterEmployees();
    await adminLoadStarterEmployees();
    for (const emp of starter) {
      upsertLocalEmployee(emp);
    }
    setNotice({
      type: 'success',
      message: 'Loaded 5 starter employees. Guard Gate Desk is ready for check-in.',
    });
  };

  const handleUpdateRecord = async (updated: AttendanceRecord) => {
    const emp = employees.find(
      (e) => e.id === updated.empId || e.empCode === updated.empCode
    );
    const empCategory = emp ? normalizeCompanyCategory(emp.companyCategory) : null;
    const targetCfg = empCategory ? sheetConfigs[empCategory] : null;
    const hasIndividualSheet = Boolean(emp?.individualSheetId);
    const needsSheetSync = Boolean(emp && (targetCfg || hasIndividualSheet));
    const nextRecords = sortRecordsNewestFirst(
      records.map((r) => (r.id === updated.id ? updated : r))
    );
    const recordMonth = updated.date.slice(0, 7);

    if (needsSheetSync && emp) {
      const details: string[] = [];
      if (hasIndividualSheet) {
        details.push(
          `Updates "${formatMonthLabel(recordMonth)}" in ${emp.name}'s Individual Google Sheet`
        );
      }
      if (targetCfg && empCategory) {
        details.push(
          `Updates ${formatMonthLabel(recordMonth)} summary in "${targetCfg.spreadsheetTitle}" (${empCategory})`
        );
      }

      setConfirmRequest({
        title: 'Update Entry in Google Sheets?',
        description: `Save corrected timings for ${updated.empName} (${updated.date}) and update connected Google Sheets.`,
        affectedTarget: [
          hasIndividualSheet ? `${emp.empCode} - ${emp.name} Attendance` : undefined,
          targetCfg?.spreadsheetTitle,
        ]
          .filter(Boolean)
          .join(' · '),
        details,
        confirmLabel: 'Save & Sync',
        onConfirm: async () => {
          setIsSyncing(true);
          try {
            await adminUpdateAttendance(updated);
            setRecords(nextRecords);
            const activeToken = getAccessToken() || (await ensureGoogleToken());
            if (activeToken) {
              if (emp.individualSheetId) {
                await createOrUpdateStandaloneEmployeeSheet(
                  activeToken,
                  emp,
                  nextRecords,
                  recordMonth
                );
              }
              if (targetCfg && empCategory) {
                await syncOneEmployeeAndMaster(
                  emp,
                  employees,
                  nextRecords,
                  empCategory,
                  activeToken
                );
              }
              await refreshDriveFiles(activeToken);
            }
            setNotice({
              type: 'success',
              message: `Updated ${updated.empName}'s entry and synced Google Sheets.`,
            });
          } catch (err) {
            handleGoogleError(err, `Updated ${updated.empName}'s entry, but Google Sheets sync failed.`);
          } finally {
            setIsSyncing(false);
          }
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
    const empCategory = emp ? normalizeCompanyCategory(emp.companyCategory) : null;
    const targetCfg = empCategory ? sheetConfigs[empCategory] : null;
    const hasIndividualSheet = Boolean(emp?.individualSheetId);
    const needsSheetSync = Boolean(emp && (targetCfg || hasIndividualSheet));
    const recordMonth = record.date.slice(0, 7);

    const details: string[] = [
      `Permanently removes ${record.empName}'s ${record.date} entry (no default row kept)`,
    ];
    if (hasIndividualSheet && emp) {
      details.push(
        `Updates "${formatMonthLabel(recordMonth)}" in ${emp.name}'s Individual Google Sheet`
      );
    }
    if (targetCfg) {
      details.push(
        `Updates ${formatMonthLabel(recordMonth)} summary in "${targetCfg.spreadsheetTitle}"`
      );
    }

    setConfirmRequest({
      title: `Delete Attendance for ${record.date}?`,
      description: `Permanently delete ${record.empName}'s attendance record for ${record.date}.`,
      affectedTarget:
        [
          hasIndividualSheet && emp ? `${emp.empCode} - ${emp.name} Attendance` : undefined,
          targetCfg?.spreadsheetTitle,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      details,
      confirmLabel: 'Delete Attendance',
      destructive: true,
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          await adminDeleteAttendance(record.id);
          const nextRecords = records.filter((r) => r.id !== record.id);
          setRecords(nextRecords);

          let sheetsUpdated = false;
          if (needsSheetSync && emp) {
            const activeToken = getAccessToken() || (await ensureGoogleToken());
            if (activeToken) {
              if (emp.individualSheetId) {
                await createOrUpdateStandaloneEmployeeSheet(
                  activeToken,
                  emp,
                  nextRecords,
                  recordMonth
                );
              }
              if (targetCfg && empCategory) {
                await syncOneEmployeeAndMaster(
                  emp,
                  employees,
                  nextRecords,
                  empCategory,
                  activeToken
                );
              }
              await refreshDriveFiles(activeToken);
              sheetsUpdated = true;
            }
          }

          setNotice({
            type: needsSheetSync && !sheetsUpdated ? 'info' : 'success',
            message:
              needsSheetSync && !sheetsUpdated
                ? `Deleted ${record.empName}'s entry for ${record.date}. Connect Google Sheets and click "Update All Sheets" to sync.`
                : sheetsUpdated
                ? `Deleted ${record.empName}'s entry for ${record.date} and updated Google Sheets.`
                : `Deleted attendance record for ${record.empName} (${record.date}).`,
          });
        } catch (err) {
          handleGoogleError(err, `Could not delete record for ${record.date}.`);
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handleRequestCreateMasterSheet = (category: CompanyCategory, title: string) => {
    const token = getAccessToken();
    if (!token) return;

    const catEmployees = employees.filter(
      (e) => normalizeCompanyCategory(e.companyCategory) === category
    );
    const catRecords = getRecordsForCategory(employees, records, category);

    setConfirmRequest({
      title: `Create ${category} Mega Sheet?`,
      description: `Create "${title}" in Google Drive with monthly summary tabs for ${category} staff.`,
      affectedTarget: title,
      details: [
        `Separate tab per month listing all ${category} employees (${catEmployees.length} staff)`,
        'Columns: Employee ID, Name, Working Hours, Present (P), Theka Work, Normal (H), Net Payable',
        'Includes Employees roster tab',
      ],
      confirmLabel: 'Create Google Sheet',
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          const cfg = await createMasterSpreadsheet(
            token,
            title,
            employees,
            records,
            category
          );
          await adminSaveSheetConfig(category, cfg);
          await adminMarkRecordsSynced(catRecords);
          await shareSheetsWithEmails(token, [cfg.spreadsheetId], getAllAdminEmails());
          await refreshDriveFiles(token);
          setNotice({
            type: 'success',
            message: `Created "${cfg.spreadsheetTitle}" for ${category} (${catEmployees.length} employee tabs) and shared with company admins.`,
          });
        } catch (err) {
          handleGoogleError(err, 'Failed to create Google Spreadsheet.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const connectSpreadsheet = async (
    category: CompanyCategory,
    idOrUrl: string,
    loadDataIntoApp = false
  ) => {
    const token = getAccessToken();
    if (!token) return;
    const spreadsheetId = extractSpreadsheetId(idOrUrl);
    setIsSyncing(true);
    try {
      const loaded = await loadWorkbookData(token, spreadsheetId);
      const taggedEmployees = loaded.employees.map((e) => ({
        ...e,
        companyCategory: e.companyCategory ?? category,
      }));
      const taggedConfig = { ...loaded.config, companyCategory: category };

      if (loadDataIntoApp) {
        const nextEmps = taggedEmployees.length > 0 ? taggedEmployees : employees;
        const nextRecs =
          loaded.records.length > 0
            ? sortRecordsNewestFirst(loaded.records)
            : records;
        await adminImportFromSheet(nextEmps, nextRecs, taggedConfig, category);
        for (const emp of nextEmps) {
          upsertLocalEmployee(emp);
        }
        await shareSheetsWithEmails(
          token,
          collectAllManagedSheetIds([taggedConfig.spreadsheetId]),
          getAllAdminEmails()
        );
        await refreshDriveFiles(token);
        setNotice({
          type: 'success',
          message: `Loaded ${taggedEmployees.length} employees and ${loaded.records.length} entries from "${taggedConfig.spreadsheetTitle}" into ${category}.`,
        });
      } else {
        await adminSaveSheetConfig(category, taggedConfig);
        await shareSheetsWithEmails(
          token,
          collectAllManagedSheetIds([taggedConfig.spreadsheetId]),
          getAllAdminEmails()
        );
        await refreshDriveFiles(token);
        setNotice({
          type: 'success',
          message: `Connected "${taggedConfig.spreadsheetTitle}" as the ${category} Master Sheet.`,
        });
      }
    } catch (err) {
      handleGoogleError(err, 'Could not connect to that Google Spreadsheet.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleRequestSyncAll = async (categoryFilter: 'all' | CompanyCategory = 'all') => {
    const targetCategories =
      categoryFilter === 'all'
        ? COMPANY_CATEGORIES.filter((cat) => Boolean(sheetConfigs[cat]))
        : sheetConfigs[categoryFilter]
        ? [categoryFilter]
        : [];

    if (targetCategories.length === 0) {
      setActiveNav('sheets-sync');
      setNotice({
        type: 'info',
        message:
          categoryFilter === 'all'
            ? 'Create or connect a Permanent or Temporary Master Sheet first.'
            : `Create or connect a Master Sheet for ${categoryFilter} first.`,
      });
      return;
    }

    const token = await ensureGoogleToken();
    if (!token) return;

    const titles = targetCategories
      .map((cat) => sheetConfigs[cat]?.spreadsheetTitle)
      .filter(Boolean)
      .join(' & ');

    setConfirmRequest({
      title:
        targetCategories.length === 1
          ? `Update ${targetCategories[0]} Mega Sheet?`
          : 'Update Connected Company Mega Sheets?',
      description: `Updates monthly summary tabs (Present P, Working Hours, Theka, Normal H, Net Payable) and Employees tab.`,
      affectedTarget: titles,
      details: targetCategories.map((cat) => {
        const count = employees.filter(
          (e) => normalizeCompanyCategory(e.companyCategory) === cat
        ).length;
        return `${cat}: ${count} employee(s) summarized per month`;
      }),
      confirmLabel: 'Update Mega Sheets',
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          for (const cat of targetCategories) {
            const cfg = sheetConfigs[cat];
            if (!cfg) continue;
            const updatedCfg = await syncFullWorkbook(
              token,
              cfg.spreadsheetId,
              employees,
              records,
              cat
            );
            await adminSaveSheetConfig(cat, updatedCfg);
            await adminMarkRecordsSynced(
              getRecordsForCategory(employees, records, cat)
            );
          }
          await shareSheetsWithEmails(
            token,
            collectAllManagedSheetIds(),
            getAllAdminEmails()
          );
          await refreshDriveFiles(token);
          setNotice({
            type: 'success',
            message: `Synced ${targetCategories.join(' & ')} Master Sheet(s) and updated admin access.`,
          });
        } catch (err) {
          handleGoogleError(err, 'Failed to sync Google Sheet.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handleRequestUpdateAllSheets = async () => {
    const token = await ensureGoogleToken();
    if (!token) return;

    const connectedCategories = COMPANY_CATEGORIES.filter((cat) =>
      Boolean(sheetConfigs[cat])
    );
    const standaloneEmployees = employees.filter((e) => Boolean(e.individualSheetId));

    if (connectedCategories.length === 0 && standaloneEmployees.length === 0) {
      setNotice({
        type: 'info',
        message: 'No Master or Individual Google Sheets are connected yet.',
      });
      return;
    }

    const details: string[] = [];
    for (const cat of connectedCategories) {
      const catCount = employees.filter(
        (e) => normalizeCompanyCategory(e.companyCategory) === cat
      ).length;
      details.push(`Updates "${sheetConfigs[cat]?.spreadsheetTitle}" (${catCount} ${cat} staff)`);
    }
    if (standaloneEmployees.length > 0) {
      details.push(
        `Updates ${standaloneEmployees.length} Individual Employee Google Sheet(s) with separate tabs per month (e.g. November 2026, October 2026)`
      );
    }
    details.push('Verifies Editor sharing for all authorized company admins');

    setConfirmRequest({
      title: 'Update All Google Sheets Now?',
      description:
        'Updates both Company Master Sheets and every Individual Employee Sheet so each month has its own clean tab (no mixed months).',
      affectedTarget: `${connectedCategories.length} Master Sheet(s) · ${standaloneEmployees.length} Individual Sheet(s)`,
      details,
      confirmLabel: 'Update All Sheets',
      onConfirm: async () => {
        setIsSyncing(true);
        let updatedMasters = 0;
        let updatedIndividuals = 0;
        let failedIndividuals = 0;

        try {
          for (const cat of connectedCategories) {
            const cfg = sheetConfigs[cat];
            if (!cfg) continue;
            const updatedCfg = await syncFullWorkbook(
              token,
              cfg.spreadsheetId,
              employees,
              records,
              cat
            );
            await adminSaveSheetConfig(cat, updatedCfg);
            updatedMasters += 1;
          }

          for (const emp of standaloneEmployees) {
            try {
              await createOrUpdateStandaloneEmployeeSheet(token, emp, records);
              updatedIndividuals += 1;
            } catch (err) {
              const errorObj = err as Error & { status?: number };
              if (errorObj?.status === 401) throw err;
              failedIndividuals += 1;
            }
          }

          await adminMarkRecordsSynced(records);
          await shareSheetsWithEmails(
            token,
            collectAllManagedSheetIds(),
            getAllAdminEmails()
          );
          await refreshDriveFiles(token);

          setNotice({
            type: failedIndividuals > 0 ? 'info' : 'success',
            message:
              failedIndividuals > 0
                ? `Updated ${updatedMasters} Master Sheet(s) and ${updatedIndividuals} Individual Sheet(s). (${failedIndividuals} sheet(s) could not be accessed.)`
                : `Updated ${updatedMasters} Master Sheet(s) and ${updatedIndividuals} Individual Sheet(s) for Permanent & Temporary categories.`,
          });
        } catch (err) {
          handleGoogleError(err, 'Failed while updating all Google Sheets.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handleRequestSyncEmployeeTab = async (employee: Employee) => {
    const category = normalizeCompanyCategory(employee.companyCategory);
    const targetCfg = sheetConfigs[category];
    if (!targetCfg) {
      setActiveNav('sheets-sync');
      setNotice({
        type: 'info',
        message: `Connect or create a ${category} Mega Sheet first in Google Sheets Sync.`,
      });
      return;
    }
    const token = await ensureGoogleToken();
    if (!token) return;

    setConfirmRequest({
      title: `Update ${category} Mega Sheet?`,
      description: `Update monthly summary tabs (including ${employee.name}) in "${targetCfg.spreadsheetTitle}".`,
      affectedTarget: targetCfg.spreadsheetTitle,
      confirmLabel: 'Update Mega Sheet',
      onConfirm: async () => {
        await syncOneEmployeeAndMaster(employee, employees, records, category, token);
        setNotice({
          type: 'success',
          message: `Updated monthly summaries in ${category} Mega Sheet.`,
        });
      },
    });
  };

  const handleRequestStandaloneSheet = async (employee: Employee, monthFilter?: string) => {
    const token = await ensureGoogleToken();
    if (!token) return;
    const latestEmp = employees.find((e) => e.id === employee.id) ?? employee;
    const category = normalizeCompanyCategory(latestEmp.companyCategory);
    const targetCfg = sheetConfigs[category];
    const isUpdate = Boolean(latestEmp.individualSheetId);
    const monthLabel = monthFilter ? formatMonthLabel(monthFilter) : null;

    setConfirmRequest({
      title: monthLabel
        ? `${isUpdate ? 'Update' : 'Create'} ${monthLabel} Tab in ${latestEmp.name}'s Google Sheet?`
        : isUpdate
        ? `Update ${latestEmp.name}'s Individual Google Sheet?`
        : `Create Individual Google Sheet for ${latestEmp.name}?`,
      description: monthLabel
        ? `Creates or updates a dedicated "${monthLabel}" tab inside ${latestEmp.name}'s Google Sheet (Present P, Theka Work, Net Normal Hours H) without mixing other months.`
        : isUpdate
        ? `Organizes ${latestEmp.name}'s Google Sheet (${category}) into separate monthly tabs (one tab per month) so months are never mixed.`
        : `Create a standalone Google Sheet for ${latestEmp.name} (${latestEmp.empCode} · ${category}) with a separate tab for each month.`,
      affectedTarget: `${latestEmp.empCode} - ${latestEmp.name} Attendance${monthLabel ? ` · ${monthLabel}` : ''}`,
      confirmLabel: isUpdate ? 'Update Sheet' : 'Create Sheet',
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          const freshEmp = employees.find((e) => e.id === latestEmp.id) ?? latestEmp;
          const res = await createOrUpdateStandaloneEmployeeSheet(
            token,
            freshEmp,
            records,
            monthFilter
          );
          const updatedEmp: Employee = {
            ...freshEmp,
            individualSheetId: res.spreadsheetId,
            individualSheetUrl: res.spreadsheetUrl,
          };
          await adminSaveEmployee(updatedEmp);
          upsertLocalEmployee(updatedEmp);
          await shareSheetsWithEmails(
            token,
            [res.spreadsheetId],
            getAllAdminEmails()
          );
          const nextEmps = employees.map((e) =>
            e.id === updatedEmp.id ? updatedEmp : e
          );
          if (targetCfg) {
            await syncOneEmployeeAndMaster(updatedEmp, nextEmps, records, category);
          }
          await refreshDriveFiles(token);
          setNotice({
            type: 'success',
            message: monthLabel
              ? `Updated "${monthLabel}" in ${updatedEmp.name}'s Google Sheet and shared with all company admins.`
              : `${isUpdate ? 'Updated' : 'Created'} individual Google Sheet for ${updatedEmp.name} and shared with all company admins.`,
          });
        } catch (err) {
          handleGoogleError(err, 'Could not create or update individual Google Sheet.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const mergeRecordsList = useCallback(
    (existing: AttendanceRecord[], incoming: AttendanceRecord[]): AttendanceRecord[] => {
      const map = new Map<string, AttendanceRecord>();
      for (const r of existing) {
        map.set(r.id, r);
      }
      for (const r of incoming) {
        map.set(r.id, r);
      }
      return sortRecordsNewestFirst(Array.from(map.values()));
    },
    []
  );

  const handleImportEmployeeSheet = async (employee: Employee, sheetUrlOrId: string) => {
    const token = await ensureGoogleToken();
    if (!token) return;

    const category = normalizeCompanyCategory(employee.companyCategory);
    const targetCfg = sheetConfigs[category];

    setIsSyncing(true);
    try {
      const imported = await importEmployeeGoogleSheet(token, sheetUrlOrId, employee);
      if (imported.records.length === 0) {
        setNotice({
          type: 'error',
          message: `No valid attendance rows found in "${imported.spreadsheetTitle}". Check that Date and In/Out columns exist.`,
        });
        return;
      }

      await adminSaveBulkAttendance(imported.records, true);
      const updatedEmp: Employee = {
        ...employee,
        individualSheetId: imported.spreadsheetId,
        individualSheetUrl: imported.spreadsheetUrl,
      };
      await adminSaveEmployee(updatedEmp);
      upsertLocalEmployee(updatedEmp);

      const nextRecords = mergeRecordsList(records, imported.records);
      setRecords(nextRecords);

      await shareSheetsWithEmails(token, [imported.spreadsheetId], getAllAdminEmails());

      if (targetCfg) {
        const nextEmps = employees.map((e) => (e.id === employee.id ? updatedEmp : e));
        await syncOneEmployeeAndMaster(updatedEmp, nextEmps, nextRecords, category);
      }

      const totalP = imported.records.reduce((acc, r) => acc + (r.presentCount ?? 0), 0);
      const totalH = imported.records.reduce((acc, r) => acc + (r.normalDecimalHours ?? 0), 0);
      setNotice({
        type: 'success',
        message: `Imported ${imported.records.length} day(s) (${totalP} P, ${totalH.toFixed(2)}h Normal H) from "${imported.spreadsheetTitle}" for ${employee.name}.`,
      });
    } catch (err) {
      handleGoogleError(err, 'Failed to import employee Google Sheet.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveEmployeeMonthRecords = async (
    employee: Employee,
    monthRecords: AttendanceRecord[],
    syncToStandaloneSheet: boolean,
    monthFilter?: string
  ) => {
    const category = normalizeCompanyCategory(employee.companyCategory);
    const targetCfg = sheetConfigs[category];

    setIsSyncing(true);
    try {
      await adminSaveBulkAttendance(monthRecords, false);
      const nextRecords = mergeRecordsList(records, monthRecords);
      setRecords(nextRecords);

      const token = syncToStandaloneSheet ? await ensureGoogleToken() : getAccessToken();
      let updatedEmp = employee;

      if (syncToStandaloneSheet && token) {
        const res = await createOrUpdateStandaloneEmployeeSheet(
          token,
          employee,
          nextRecords,
          monthFilter
        );
        updatedEmp = {
          ...employee,
          individualSheetId: res.spreadsheetId,
          individualSheetUrl: res.spreadsheetUrl,
        };
        await adminSaveEmployee(updatedEmp);
        upsertLocalEmployee(updatedEmp);
        await shareSheetsWithEmails(token, [res.spreadsheetId], getAllAdminEmails());
        await adminMarkRecordsSynced(monthRecords);
        await refreshDriveFiles(token);
      }

      if (targetCfg && token) {
        const nextEmps = employees.map((e) => (e.id === employee.id ? updatedEmp : e));
        await syncOneEmployeeAndMaster(updatedEmp, nextEmps, nextRecords, category);
      }

      const totalP = monthRecords.reduce((acc, r) => acc + (r.presentCount ?? 0), 0);
      const totalH = monthRecords.reduce((acc, r) => acc + (r.normalDecimalHours ?? 0), 0);
      setNotice({
        type: 'success',
        message: `Saved ${monthRecords.length} day(s) (${totalP} P, ${totalH.toFixed(2)}h Normal H) to ${employee.name}'s history${syncToStandaloneSheet && token ? ' and updated Google Sheets' : ''}.`,
      });
    } catch (err) {
      handleGoogleError(err, 'Could not save monthly attendance records.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleUpdateSingleRecord = async (updated: AttendanceRecord) => {
    await adminUpdateAttendance(updated);
    const pausedMins = Math.round((updated.pausedTotalSeconds ?? 0) / 60);
    const thikadaMins = Math.max(0, Math.round(updated.thikadaMinutes ?? 0));
    const recalculated: AttendanceRecord = updated.outTime
      ? (() => {
          const calc = calculateShiftMetrics(
            updated.inTime,
            updated.outTime,
            updated.breakMinutes,
            updated.date,
            pausedMins,
            thikadaMins
          );
          return {
            ...updated,
            grossMinutes: calc.grossMinutes,
            breakMinutes: calc.breakDeductedMinutes,
            netMinutes: calc.netMinutes,
            netDecimalHours: calc.netDecimalHours,
            overtimeMinutes: calc.overtimeMinutes,
            overtimeDecimalHours: calc.overtimeDecimalHours,
            presentCount: calc.presentCount,
            thikadaMinutes: calc.thikadaMinutes,
            normalMinutes: calc.normalMinutes,
            normalDecimalHours: calc.normalDecimalHours,
            isSunday: calc.isSunday,
            status: calc.status,
            syncedToSheet: false,
            updatedAt: new Date().toISOString(),
          };
        })()
      : {
          ...updated,
          thikadaMinutes: thikadaMins,
          syncedToSheet: false,
          updatedAt: new Date().toISOString(),
        };

    const nextRecords = sortRecordsNewestFirst(
      records.map((r) => (r.id === recalculated.id ? recalculated : r))
    );
    setRecords(nextRecords);

    const emp = employees.find(
      (e) => e.id === recalculated.empId || e.empCode === recalculated.empCode
    );
    const token = getAccessToken();
    let sheetUpdated = false;
    if (token && emp) {
      const empCategory = normalizeCompanyCategory(emp.companyCategory);
      const targetCfg = sheetConfigs[empCategory];
      const recordMonth = recalculated.date.slice(0, 7);
      if (emp.individualSheetId || targetCfg) {
        setIsSyncing(true);
        try {
          if (emp.individualSheetId) {
            await createOrUpdateStandaloneEmployeeSheet(
              token,
              emp,
              nextRecords,
              recordMonth
            );
            sheetUpdated = true;
          }
          if (targetCfg) {
            await syncOneEmployeeAndMaster(emp, employees, nextRecords, empCategory, token);
            sheetUpdated = true;
          }
        } catch (err) {
          handleGoogleError(err, `Updated ${updated.empName} (${updated.date}), but sheet sync failed.`);
          return;
        } finally {
          setIsSyncing(false);
        }
      }
    }

    setNotice({
      type: 'success',
      message: sheetUpdated
        ? `Updated ${updated.empName} (${updated.date}) and synced Google Sheets.`
        : `Updated ${updated.empName} (${updated.date}).`,
    });
  };

  const handleSaveMonthlyThikada = async (
    employee: Employee,
    yearMonth: string,
    thikadaMinutes: number
  ): Promise<{ sheetUpdated: boolean }> => {
    const category = normalizeCompanyCategory(employee.companyCategory);
    const targetCfg = sheetConfigs[category];

    const nextMap: Record<string, number> = {
      ...(employee.monthlyThikadaMinutes ?? {}),
    };
    if (thikadaMinutes > 0) {
      nextMap[yearMonth] = thikadaMinutes;
    } else {
      delete nextMap[yearMonth];
    }

    let updatedEmp: Employee = {
      ...employee,
      monthlyThikadaMinutes: Object.keys(nextMap).length > 0 ? nextMap : undefined,
    };

    await adminSaveEmployee(updatedEmp);
    upsertLocalEmployee(updatedEmp);

    const token = getAccessToken();
    let sheetUpdated = false;

    if (token && (updatedEmp.individualSheetId || targetCfg)) {
      setIsSyncing(true);
      try {
        if (updatedEmp.individualSheetId) {
          const res = await createOrUpdateStandaloneEmployeeSheet(
            token,
            updatedEmp,
            records,
            yearMonth
          );
          updatedEmp = {
            ...updatedEmp,
            individualSheetId: res.spreadsheetId,
            individualSheetUrl: res.spreadsheetUrl,
          };
          await adminSaveEmployee(updatedEmp);
          upsertLocalEmployee(updatedEmp);
          await shareSheetsWithEmails(token, [res.spreadsheetId], getAllAdminEmails());
          sheetUpdated = true;
        }
        if (targetCfg) {
          const nextEmps = employees.map((e) => (e.id === updatedEmp.id ? updatedEmp : e));
          await syncOneEmployeeAndMaster(updatedEmp, nextEmps, records, category);
          sheetUpdated = true;
        }
        await refreshDriveFiles(token);
      } catch (err) {
        handleGoogleError(
          err,
          'Applied Theka deduction in GateLog, but Google Sheet update failed.'
        );
        return { sheetUpdated: false };
      } finally {
        setIsSyncing(false);
      }
    }

    setNotice({
      type: 'success',
      message: sheetUpdated
        ? `Applied ${(thikadaMinutes / 60).toFixed(2)}h Theka work deduction for ${formatMonthLabel(yearMonth)} and updated Google Sheets.`
        : `Applied ${(thikadaMinutes / 60).toFixed(2)}h Theka work deduction for ${formatMonthLabel(yearMonth)}.`,
    });

    return { sheetUpdated };
  };

  const handlePullFromSheet = (category: CompanyCategory) => {
    const cfg = sheetConfigs[category];
    if (!cfg) return;
    setConfirmRequest({
      title: `Load Data from ${category} Sheet?`,
      description: `Load employees and attendance records from "${cfg.spreadsheetTitle}" into GateLog (${category}).`,
      affectedTarget: cfg.spreadsheetTitle,
      confirmLabel: 'Load from Sheet',
      onConfirm: async () => {
        await connectSpreadsheet(category, cfg.spreadsheetId, true);
      },
    });
  };

  const handleSwitchCategorySheet = (category: CompanyCategory) => {
    const cfg = sheetConfigs[category];
    if (!cfg) return;
    setConfirmRequest({
      title: `Switch ${category} Master Sheet?`,
      description: `Unlink "${cfg.spreadsheetTitle}" from GateLog so you can connect or create a different sheet. The spreadsheet file stays safe in Google Drive.`,
      affectedTarget: cfg.spreadsheetTitle,
      confirmLabel: 'Switch Sheet (Keep File)',
      onConfirm: async () => {
        await adminSaveSheetConfig(category, null);
        setNotice({
          type: 'info',
          message: `Unlinked "${cfg.spreadsheetTitle}" from ${category}. You can now connect or create a new Master Sheet.`,
        });
      },
    });
  };

  const handleDeleteCategorySheet = async (category: CompanyCategory) => {
    const cfg = sheetConfigs[category];
    if (!cfg) return;
    const token = await ensureGoogleToken();
    if (!token) return;

    setConfirmRequest({
      title: `Delete Old ${category} Master Sheet?`,
      description: `Move "${cfg.spreadsheetTitle}" to Google Drive Trash and disconnect it from GateLog.`,
      affectedTarget: cfg.spreadsheetTitle,
      details: [
        'Moves the spreadsheet file to Google Drive Trash (recoverable from Drive Trash for 30 days)',
        `Clears the ${category} Master Sheet link so you can start fresh`,
      ],
      confirmLabel: 'Delete Old Sheet',
      destructive: true,
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          const trashRes = await trashSpreadsheet(token, cfg.spreadsheetId);
          await adminSaveSheetConfig(category, null);
          await refreshDriveFiles(token);
          setNotice({
            type: trashRes.trashed ? 'success' : 'info',
            message: trashRes.trashed
              ? `Moved "${cfg.spreadsheetTitle}" to Google Drive Trash and disconnected it from ${category}.`
              : `Disconnected "${cfg.spreadsheetTitle}" from GateLog. (${trashRes.reason})`,
          });
        } catch (err) {
          handleGoogleError(err, 'Could not delete old Master Sheet.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handleDeleteDriveFile = async (file: DriveSpreadsheetItem) => {
    const token = await ensureGoogleToken();
    if (!token) return;

    setConfirmRequest({
      title: 'Delete Spreadsheet from Google Drive?',
      description: `Move "${file.name}" to Google Drive Trash and unlink it if connected in GateLog.`,
      affectedTarget: file.name,
      confirmLabel: 'Move to Trash',
      destructive: true,
      onConfirm: async () => {
        setIsSyncing(true);
        try {
          const trashRes = await trashSpreadsheet(token, file.id);
          if (!trashRes.trashed) {
            setNotice({
              type: 'error',
              message: trashRes.reason || `Could not trash "${file.name}".`,
            });
            return;
          }

          for (const cat of COMPANY_CATEGORIES) {
            if (sheetConfigs[cat]?.spreadsheetId === file.id) {
              await adminSaveSheetConfig(cat, null);
            }
          }

          const linkedEmployees = employees.filter((e) => e.individualSheetId === file.id);
          for (const emp of linkedEmployees) {
            const cleared: Employee = {
              ...emp,
              individualSheetId: undefined,
              individualSheetUrl: undefined,
            };
            await adminSaveEmployee(cleared);
            upsertLocalEmployee(cleared);
          }

          await refreshDriveFiles(token);
          setNotice({
            type: 'info',
            message: `Moved "${file.name}" to Google Drive Trash.`,
          });
        } catch (err) {
          handleGoogleError(err, 'Could not delete spreadsheet from Google Drive.');
        } finally {
          setIsSyncing(false);
        }
      },
    });
  };

  const handleAddAdminEmail = async (email: string) => {
    const emailLower = email.trim().toLowerCase();
    if (emailLower === PRIMARY_ADMIN_EMAIL) {
      setNotice({
        type: 'info',
        message: `${PRIMARY_ADMIN_EMAIL} is already the Primary Company Admin.`,
      });
      return;
    }
    try {
      await adminAddEmail(emailLower, googleUser?.email || PRIMARY_ADMIN_EMAIL);
      setAdminEmails((prev) => {
        if (prev.some((e) => e.email === emailLower)) return prev;
        return [
          ...prev,
          {
            email: emailLower,
            addedBy: googleUser?.email || PRIMARY_ADMIN_EMAIL,
            createdAt: new Date().toISOString(),
          },
        ].sort((a, b) => a.email.localeCompare(b.email));
      });

      const token = getAccessToken();
      const sheetIds = collectAllManagedSheetIds();
      if (token && sheetIds.length > 0) {
        const res = await shareSheetsWithEmails(token, sheetIds, [emailLower]);
        setNotice({
          type: 'success',
          message:
            res.failedCount > 0 && res.sharedCount === 0
              ? `Added ${emailLower} as Admin. Note: Ask the sheet owner to click "Share All Sheets with Admins" to grant Drive access.`
              : `Added ${emailLower} as Admin and granted Editor access to ${sheetIds.length} attendance sheet(s).`,
        });
      } else {
        setNotice({
          type: 'success',
          message: `Added ${emailLower} as an authorized Company Admin.`,
        });
      }
    } catch (err) {
      setNotice({
        type: 'error',
        message: (err as Error).message || 'Could not add Admin email.',
      });
    }
  };

  const handleRemoveAdminEmail = (email: string) => {
    const emailLower = email.trim().toLowerCase();
    if (emailLower === PRIMARY_ADMIN_EMAIL) return;
    setConfirmRequest({
      title: 'Remove Admin Access?',
      description: `Revoke Admin dashboard and spreadsheet access for ${emailLower}.`,
      affectedTarget: emailLower,
      confirmLabel: 'Remove Admin',
      destructive: true,
      onConfirm: async () => {
        await adminRemoveEmail(emailLower);
        setAdminEmails((prev) => prev.filter((e) => e.email !== emailLower));
        const token = getAccessToken();
        if (token) {
          for (const sheetId of collectAllManagedSheetIds()) {
            await revokeSpreadsheetAccess(token, sheetId, emailLower);
          }
        }
        setNotice({
          type: 'info',
          message: `Removed Admin access for ${emailLower}.`,
        });
      },
    });
  };

  const handleShareAllSheetsWithAdmins = async () => {
    const token = getAccessToken();
    if (!token) {
      setNotice({
        type: 'info',
        message: 'Connect Google Sheets first to share spreadsheet access.',
      });
      return;
    }
    const sheetIds = collectAllManagedSheetIds();
    const targetEmails = getAllAdminEmails();
    if (sheetIds.length === 0) {
      setNotice({
        type: 'info',
        message: 'No Master or Individual Google Sheets are connected yet.',
      });
      return;
    }
    const res = await shareSheetsWithEmails(token, sheetIds, targetEmails);
    if (res.failedCount > 0 && res.sharedCount === 0) {
      setNotice({
        type: 'error',
        message: 'Could not update sharing on some sheets. Please ensure you own those spreadsheets.',
      });
    } else {
      setNotice({
        type: 'success',
        message: `Verified Editor access across ${sheetIds.length} spreadsheet(s) for all authorized company admins.`,
      });
    }
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
          <div>30m break deducted for 4.5h+ shifts</div>
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
                {hasGoogleToken &&
                  COMPANY_CATEGORIES.map((cat) => {
                    const cfg = sheetConfigs[cat];
                    if (!cfg) return null;
                    const shortLabel =
                      cat === 'Sukhsa Export Permanent'
                        ? 'Permanent Sheet'
                        : 'Temporary Sheet';
                    return (
                      <a
                        key={cat}
                        href={cfg.spreadsheetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hidden md:inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
                        title={cfg.spreadsheetTitle}
                      >
                        <span>{isSyncing ? 'Syncing...' : shortLabel}</span>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    );
                  })}
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
              onPauseTiming={handleGuardPauseTiming}
              onResumeTiming={handleGuardResumeTiming}
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
              sheetConfigs={sheetConfigs}
              onUpdateRecord={handleUpdateRecord}
              onDeleteRecord={handleDeleteRecord}
              onRequestSyncAll={handleRequestSyncAll}
            />
          )}

          {isAdminUnlocked && activeNav === 'individual-sheets' && (
            <IndividualEmployeeView
              employees={employees}
              records={records}
              sheetConfigs={sheetConfigs}
              isGoogleAuthed={hasGoogleToken}
              isSyncing={isSyncing}
              onRequestSyncEmployeeTab={handleRequestSyncEmployeeTab}
              onRequestStandaloneSheet={handleRequestStandaloneSheet}
              onImportEmployeeSheet={handleImportEmployeeSheet}
              onSaveEmployeeMonthRecords={handleSaveEmployeeMonthRecords}
              onUpdateSingleRecord={handleUpdateSingleRecord}
              onDeleteSingleRecord={handleDeleteRecord}
              onSaveMonthlyThikada={handleSaveMonthlyThikada}
            />
          )}

          {isAdminUnlocked && activeNav === 'employees' && (
            <EmployeesView
              employees={employees}
              hasConnectedSheets={Boolean(
                sheetConfigs['Sukhsa Export Permanent'] ||
                  sheetConfigs['Sukhsa Export Temporary'] ||
                  employees.some((e) => Boolean(e.individualSheetId))
              )}
              isSyncing={isSyncing}
              onSaveEmployee={handleSaveEmployee}
              onToggleActive={handleToggleActive}
              onDeleteEmployee={handleDeleteEmployee}
              onLoadStarterRoster={handleLoadStarterRoster}
              onRequestUpdateAllSheets={handleRequestUpdateAllSheets}
            />
          )}

          {isAdminUnlocked && activeNav === 'sheets-sync' && (
            <GoogleSheetsSyncView
              user={googleUser}
              hasGoogleToken={hasGoogleToken}
              isSigningIn={isLoggingInGoogle}
              isSyncing={isSyncing}
              onGoogleLogin={handleConnectGoogleForSheetsOnly}
              onGoogleLogout={handleGoogleLogout}
              employees={employees}
              sheetConfigs={sheetConfigs}
              driveFiles={driveFiles}
              loadingDriveFiles={loadingDriveFiles}
              onRefreshDriveFiles={() => refreshDriveFiles()}
              onRequestCreateMasterSheet={handleRequestCreateMasterSheet}
              onConnectSpreadsheetById={(category, idOrUrl) =>
                connectSpreadsheet(category, idOrUrl, false)
              }
              onRequestSyncCategorySheet={(category) => handleRequestSyncAll(category)}
              onRequestUpdateAllSheets={handleRequestUpdateAllSheets}
              onPullFromSheet={handlePullFromSheet}
              onSwitchCategorySheet={handleSwitchCategorySheet}
              onDeleteCategorySheet={handleDeleteCategorySheet}
              onDeleteDriveFile={handleDeleteDriveFile}
              onGoToIndividualSheets={() => setActiveNav('individual-sheets')}
              adminEmails={adminEmails}
              onAddAdminEmail={handleAddAdminEmail}
              onRemoveAdminEmail={handleRemoveAdminEmail}
              onShareAllSheetsWithAdmins={handleShareAllSheetsWithAdmins}
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
