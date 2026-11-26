import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  AdminEmailEntry,
  AttendanceRecord,
  CategorySheetConfigs,
  CompanyCategory,
  Employee,
  GateEmployeeView,
  GuardAccount,
  GuardSession,
  SheetConfig,
} from '../types/attendance';
import {
  buildStarterEmployees,
  calculateMetricsFromWorkedMinutes,
  calculateShiftMetrics,
  getCurrentHHMM,
  getTodayISO,
  isSundayISO,
  normalizeCompanyCategory,
  sortRecordsNewestFirst,
} from '../utils/time';
import { db, handleFirestoreError, OperationType } from './firebaseClient';

const EMPLOYEES_COL = 'employees';
const ATTENDANCE_COL = 'attendance';
const SETTINGS_COL = 'settings';
const ADMIN_EMAILS_COL = 'admin_emails';
const GUARDS_COL = 'guards';
const GUARD_SALTS_COL = 'guard_salts';
const GUARD_SESSIONS_COL = 'guard_sessions';
const LEGACY_WORKSPACE_DOC_ID = 'workspace';

const GUARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function normalizeGuardUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidGuardUsernameFormat(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length >= 3 && trimmed.length <= 40 && /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

function generateHexBytes(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hashGuardPassword(password: string, saltHex: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Secure browser cryptography is required for guard login.');
  }
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(`gatelog:${saltHex}`),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function getWorkspaceDocId(category: CompanyCategory): string {
  return category === 'Sukhsa Export Temporary'
    ? 'workspace_temporary'
    : 'workspace_permanent';
}

function sanitizeMonthlyThikada(
  raw?: Record<string, number>
): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const clean: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (/^\d{4}-\d{2}$/.test(key) && typeof val === 'number' && !Number.isNaN(val) && val > 0) {
      clean[key] = Math.min(44640, Math.round(val));
    }
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function sanitizeEmployeePayload(emp: Employee): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: emp.id.trim().slice(0, 80),
    empCode: emp.empCode.trim().slice(0, 30),
    name: emp.name.trim().slice(0, 80),
    department: (emp.department || 'General').trim().slice(0, 60),
    companyCategory: normalizeCompanyCategory(emp.companyCategory),
    breakMinutes: Math.max(0, Math.min(180, Math.round(emp.breakMinutes || 30))),
    active: Boolean(emp.active),
  };

  if (
    typeof emp.hourlyRate === 'number' &&
    !Number.isNaN(emp.hourlyRate) &&
    emp.hourlyRate >= 0
  ) {
    payload.hourlyRate = Math.min(1000000, Number(emp.hourlyRate.toFixed(5)));
  }

  if (emp.individualSheetId && emp.individualSheetId.trim()) {
    payload.individualSheetId = emp.individualSheetId.trim().slice(0, 128);
  }
  if (emp.individualSheetUrl && emp.individualSheetUrl.trim()) {
    payload.individualSheetUrl = emp.individualSheetUrl.trim().slice(0, 300);
  }
  const cleanThikada = sanitizeMonthlyThikada(emp.monthlyThikadaMinutes);
  if (cleanThikada) {
    payload.monthlyThikadaMinutes = cleanThikada;
  }
  return payload;
}

function docToAttendanceRecord(id: string, data: Record<string, unknown>): AttendanceRecord {
  const updatedAtRaw = data.updatedAt as { toDate?: () => Date } | string | undefined;
  const updatedAt =
    updatedAtRaw && typeof updatedAtRaw === 'object' && typeof updatedAtRaw.toDate === 'function'
      ? updatedAtRaw.toDate().toISOString()
      : typeof updatedAtRaw === 'string'
      ? updatedAtRaw
      : new Date().toISOString();

  const date = String(data.date ?? '');
  const netMinutes = typeof data.netMinutes === 'number' ? data.netMinutes : null;
  const isSunday =
    typeof data.isSunday === 'boolean' ? data.isSunday : date ? isSundayISO(date) : false;

  const fallbackOtMins =
    netMinutes !== null
      ? isSunday
        ? netMinutes
        : Math.max(0, netMinutes - 480)
      : null;
  const overtimeMinutes =
    typeof data.overtimeMinutes === 'number' ? data.overtimeMinutes : fallbackOtMins;
  const overtimeDecimalHours =
    typeof data.overtimeDecimalHours === 'number'
      ? data.overtimeDecimalHours
      : overtimeMinutes !== null
      ? Number((overtimeMinutes / 60).toFixed(2))
      : null;

  const thikadaMinutes =
    typeof data.thikadaMinutes === 'number' ? Math.max(0, Math.round(data.thikadaMinutes)) : 0;

  const presentCount =
    typeof data.presentCount === 'number'
      ? data.presentCount
      : netMinutes !== null
      ? !isSunday && netMinutes >= 480
        ? 1
        : 0
      : null;

  const grossNormalMins =
    netMinutes !== null
      ? isSunday
        ? netMinutes
        : netMinutes >= 480
        ? netMinutes - 480
        : netMinutes
      : null;

  const normalMinutes =
    typeof data.normalMinutes === 'number'
      ? data.normalMinutes
      : grossNormalMins !== null
      ? Math.max(0, grossNormalMins - thikadaMinutes)
      : null;

  const normalDecimalHours =
    typeof data.normalDecimalHours === 'number'
      ? data.normalDecimalHours
      : normalMinutes !== null
      ? Number((normalMinutes / 60).toFixed(2))
      : null;

  return {
    id,
    date,
    empId: String(data.empId ?? ''),
    empCode: String(data.empCode ?? ''),
    empName: String(data.empName ?? ''),
    inTime: String(data.inTime ?? '09:00'),
    outTime: data.outTime ? String(data.outTime) : null,
    startedAtMs: typeof data.startedAtMs === 'number' ? data.startedAtMs : null,
    isPaused: Boolean(data.isPaused),
    pausedAtMs: typeof data.pausedAtMs === 'number' ? data.pausedAtMs : null,
    pausedTotalSeconds:
      typeof data.pausedTotalSeconds === 'number' ? data.pausedTotalSeconds : 0,
    grossMinutes: typeof data.grossMinutes === 'number' ? data.grossMinutes : null,
    breakMinutes: typeof data.breakMinutes === 'number' ? data.breakMinutes : 30,
    netMinutes,
    netDecimalHours: typeof data.netDecimalHours === 'number' ? data.netDecimalHours : null,
    overtimeMinutes,
    overtimeDecimalHours,
    presentCount,
    thikadaMinutes,
    normalMinutes,
    normalDecimalHours,
    isSunday,
    status: (data.status as AttendanceRecord['status']) || 'on_duty',
    syncedToSheet: Boolean(data.syncedToSheet),
    guardSessionId:
      typeof data.guardSessionId === 'string' ? data.guardSessionId : undefined,
    markedByGuard:
      typeof data.markedByGuard === 'string' ? data.markedByGuard : undefined,
    updatedAt,
  };
}

// ============================================================================
// PUBLIC GUARD SUBSCRIPTIONS & ACTIONS (No login required)
// ============================================================================
export function subscribeActiveEmployees(
  onData: (employees: GateEmployeeView[]) => void,
  onError: (err: Error) => void
): () => void {
  const q = query(collection(db, EMPLOYEES_COL), where('active', '==', true));
  return onSnapshot(
    q,
    (snapshot) => {
      const list: GateEmployeeView[] = snapshot.docs
        .map((d) => {
          const data = d.data();
          return {
            id: String(data.id ?? d.id),
            empCode: String(data.empCode ?? ''),
            name: String(data.name ?? ''),
            department: String(data.department ?? 'General'),
            companyCategory: normalizeCompanyCategory(data.companyCategory),
          };
        })
        .sort((a, b) => a.empCode.localeCompare(b.empCode));
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, EMPLOYEES_COL);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribeTodayAttendance(
  dateIso: string,
  onData: (records: AttendanceRecord[]) => void,
  onError: (err: Error) => void
): () => void {
  const q = query(collection(db, ATTENDANCE_COL), where('date', '==', dateIso));
  return onSnapshot(
    q,
    (snapshot) => {
      const list = snapshot.docs.map((d) =>
        docToAttendanceRecord(d.id, d.data() as Record<string, unknown>)
      );
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, ATTENDANCE_COL);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

function buildGuardSessionFields(guardSession?: GuardSession | null): Record<string, string> {
  if (!guardSession?.sessionId || !guardSession?.username) {
    return {};
  }
  return {
    guardSessionId: guardSession.sessionId,
    markedByGuard: guardSession.username,
  };
}

export async function guardMarkIn(
  employee: GateEmployeeView,
  guardSession?: GuardSession | null
): Promise<AttendanceRecord> {
  const date = getTodayISO();
  const inTime = getCurrentHHMM();
  const nowMs = Date.now();
  const isSunday = isSundayISO(date);
  const docId = `${date}_${employee.id}`;
  const path = `${ATTENDANCE_COL}/${docId}`;
  const sessionFields = buildGuardSessionFields(guardSession);

  const payload = {
    id: docId,
    date,
    empId: employee.id,
    empCode: employee.empCode.slice(0, 30),
    empName: employee.name.slice(0, 80),
    inTime,
    outTime: null,
    startedAtMs: nowMs,
    isPaused: false,
    pausedAtMs: null,
    pausedTotalSeconds: 0,
    grossMinutes: null,
    breakMinutes: 30,
    netMinutes: null,
    netDecimalHours: null,
    overtimeMinutes: null,
    overtimeDecimalHours: null,
    presentCount: null,
    thikadaMinutes: 0,
    normalMinutes: null,
    normalDecimalHours: null,
    isSunday,
    status: 'on_duty' as const,
    syncedToSheet: false,
    ...sessionFields,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, ATTENDANCE_COL, docId), payload);
    return {
      id: docId,
      date,
      empId: employee.id,
      empCode: employee.empCode,
      empName: employee.name,
      inTime,
      outTime: null,
      startedAtMs: nowMs,
      isPaused: false,
      pausedAtMs: null,
      pausedTotalSeconds: 0,
      grossMinutes: null,
      breakMinutes: 30,
      netMinutes: null,
      netDecimalHours: null,
      overtimeMinutes: null,
      overtimeDecimalHours: null,
      presentCount: null,
      thikadaMinutes: 0,
      normalMinutes: null,
      normalDecimalHours: null,
      isSunday,
      status: 'on_duty',
      syncedToSheet: false,
      ...sessionFields,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function guardPauseTiming(
  record: AttendanceRecord,
  guardSession?: GuardSession | null
): Promise<AttendanceRecord> {
  const nowMs = Date.now();
  const path = `${ATTENDANCE_COL}/${record.id}`;
  const isSunday = record.isSunday ?? isSundayISO(record.date);
  const pausedTotalSeconds = Math.max(0, Math.round(record.pausedTotalSeconds ?? 0));
  const sessionFields = buildGuardSessionFields(guardSession);

  try {
    await updateDoc(doc(db, ATTENDANCE_COL, record.id), {
      isPaused: true,
      pausedAtMs: nowMs,
      pausedTotalSeconds,
      isSunday,
      overtimeMinutes: record.overtimeMinutes ?? null,
      overtimeDecimalHours: record.overtimeDecimalHours ?? null,
      ...sessionFields,
      updatedAt: serverTimestamp(),
    });

    return {
      ...record,
      isPaused: true,
      pausedAtMs: nowMs,
      pausedTotalSeconds,
      isSunday,
      ...sessionFields,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function guardResumeTiming(
  record: AttendanceRecord,
  guardSession?: GuardSession | null
): Promise<AttendanceRecord> {
  const nowMs = Date.now();
  const path = `${ATTENDANCE_COL}/${record.id}`;
  const isSunday = record.isSunday ?? isSundayISO(record.date);
  const pauseStarted = record.pausedAtMs ?? nowMs;
  const pauseDeltaSec = Math.max(0, Math.floor((nowMs - pauseStarted) / 1000));
  const nextPausedTotalSeconds = Math.min(
    86400,
    Math.max(0, Math.round(record.pausedTotalSeconds ?? 0)) + pauseDeltaSec
  );
  const sessionFields = buildGuardSessionFields(guardSession);

  try {
    await updateDoc(doc(db, ATTENDANCE_COL, record.id), {
      isPaused: false,
      pausedAtMs: null,
      pausedTotalSeconds: nextPausedTotalSeconds,
      isSunday,
      overtimeMinutes: record.overtimeMinutes ?? null,
      overtimeDecimalHours: record.overtimeDecimalHours ?? null,
      ...sessionFields,
      updatedAt: serverTimestamp(),
    });

    return {
      ...record,
      isPaused: false,
      pausedAtMs: null,
      pausedTotalSeconds: nextPausedTotalSeconds,
      isSunday,
      ...sessionFields,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function guardMarkOut(
  record: AttendanceRecord,
  guardSession?: GuardSession | null
): Promise<AttendanceRecord> {
  const nowMs = Date.now();
  const outTime = getCurrentHHMM();
  const path = `${ATTENDANCE_COL}/${record.id}`;
  const sessionFields = buildGuardSessionFields(guardSession);

  const extraPauseSec =
    record.isPaused && record.pausedAtMs
      ? Math.max(0, Math.floor((nowMs - record.pausedAtMs) / 1000))
      : 0;
  const finalPausedSeconds = Math.min(
    86400,
    Math.max(0, Math.round(record.pausedTotalSeconds ?? 0)) + extraPauseSec
  );

  const thikadaMins = Math.max(0, Math.round(record.thikadaMinutes ?? 0));
  const calc =
    typeof record.startedAtMs === 'number' && record.startedAtMs > 0
      ? calculateMetricsFromWorkedMinutes(
          Math.max(0, Math.round((Math.floor((nowMs - record.startedAtMs) / 1000) - finalPausedSeconds) / 60)),
          record.breakMinutes ?? 30,
          record.date,
          false,
          thikadaMins
        )
      : calculateShiftMetrics(
          record.inTime,
          outTime,
          record.breakMinutes ?? 30,
          record.date,
          Math.round(finalPausedSeconds / 60),
          thikadaMins
        );

  try {
    await updateDoc(doc(db, ATTENDANCE_COL, record.id), {
      outTime,
      isPaused: false,
      pausedAtMs: null,
      pausedTotalSeconds: finalPausedSeconds,
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
      ...sessionFields,
      updatedAt: serverTimestamp(),
    });

    return {
      ...record,
      outTime,
      isPaused: false,
      pausedAtMs: null,
      pausedTotalSeconds: finalPausedSeconds,
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
      ...sessionFields,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ============================================================================
// GUARD AUTHENTICATION (Rule-verified username & password login)
// ============================================================================
export async function guardSignIn(
  usernameRaw: string,
  password: string
): Promise<GuardSession> {
  const usernameKey = normalizeGuardUsername(usernameRaw);
  if (!isValidGuardUsernameFormat(usernameKey) || !password) {
    throw new Error('Invalid guard username or password.');
  }

  let saltSnap;
  try {
    saltSnap = await getDoc(doc(db, GUARD_SALTS_COL, usernameKey));
  } catch {
    throw new Error('Could not verify guard credentials. Please try again.');
  }

  if (!saltSnap.exists()) {
    throw new Error('Invalid guard username or password.');
  }

  const salt = String(saltSnap.data()?.salt ?? '');
  if (!salt) {
    throw new Error('Invalid guard username or password.');
  }

  const authProof = await hashGuardPassword(password, salt);
  const sessionId = `gs_${generateHexBytes(16)}`;
  const expiresAtMs = Date.now() + GUARD_SESSION_TTL_MS;

  try {
    await setDoc(doc(db, GUARD_SESSIONS_COL, sessionId), {
      id: sessionId,
      guardUsername: usernameKey,
      authProof,
      active: true,
      expiresAtMs,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? '';
    if (code === 'permission-denied') {
      throw new Error('Invalid guard username or password, or account is inactive.');
    }
    throw new Error('Could not sign in as guard. Please try again.');
  }

  return {
    sessionId,
    username: usernameKey,
    displayName: usernameKey,
    role: 'guard',
    expiresAtMs,
  };
}

export async function guardSignOut(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    await updateDoc(doc(db, GUARD_SESSIONS_COL, sessionId), {
      active: false,
    });
  } catch {
    // Best-effort server-side session revocation
  }
}

// ============================================================================
// ADMIN SUBSCRIPTIONS & MUTATIONS (Requires verified Admin Google Sign-In)
// ============================================================================
export function subscribeAllEmployees(
  onData: (employees: Employee[], missingCategoryEmployees: Employee[]) => void,
  onError: (err: Error) => void
): () => void {
  return onSnapshot(
    collection(db, EMPLOYEES_COL),
    (snapshot) => {
      const missingCategoryEmployees: Employee[] = [];
      const list: Employee[] = snapshot.docs
        .map((d) => {
          const data = d.data();
          const rawMonthly = data.monthlyThikadaMinutes as Record<string, unknown> | undefined;
          const monthlyThikadaMinutes =
            rawMonthly && typeof rawMonthly === 'object'
              ? Object.fromEntries(
                  Object.entries(rawMonthly).filter(
                    ([k, v]) => /^\d{4}-\d{2}$/.test(k) && typeof v === 'number'
                  )
                ) as Record<string, number>
              : undefined;
          const normalizedCategory = normalizeCompanyCategory(data.companyCategory);
          const emp: Employee = {
            id: String(data.id ?? d.id),
            empCode: String(data.empCode ?? ''),
            name: String(data.name ?? ''),
            department: String(data.department ?? 'General'),
            companyCategory: normalizedCategory,
            breakMinutes: typeof data.breakMinutes === 'number' ? data.breakMinutes : 30,
            hourlyRate:
              typeof data.hourlyRate === 'number' && !Number.isNaN(data.hourlyRate) && data.hourlyRate >= 0
                ? Number(data.hourlyRate.toFixed(5))
                : 0,
            active: data.active !== false,
            individualSheetId: data.individualSheetId
              ? String(data.individualSheetId)
              : undefined,
            individualSheetUrl: data.individualSheetUrl
              ? String(data.individualSheetUrl)
              : undefined,
            monthlyThikadaMinutes,
          };
          if (typeof data.companyCategory !== 'string' || !data.companyCategory.trim()) {
            missingCategoryEmployees.push(emp);
          }
          return emp;
        })
        .sort((a, b) => a.empCode.localeCompare(b.empCode));
      onData(list, missingCategoryEmployees);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, EMPLOYEES_COL);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribeAllAttendance(
  onData: (records: AttendanceRecord[]) => void,
  onError: (err: Error) => void
): () => void {
  return onSnapshot(
    collection(db, ATTENDANCE_COL),
    (snapshot) => {
      const list = snapshot.docs.map((d) =>
        docToAttendanceRecord(d.id, d.data() as Record<string, unknown>)
      );
      onData(sortRecordsNewestFirst(list));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, ATTENDANCE_COL);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

function docToSheetConfig(
  data: Record<string, unknown>,
  fallbackCategory?: CompanyCategory
): SheetConfig {
  return {
    companyCategory: data.companyCategory
      ? normalizeCompanyCategory(data.companyCategory)
      : fallbackCategory,
    spreadsheetId: String(data.spreadsheetId ?? ''),
    spreadsheetTitle: String(data.spreadsheetTitle ?? ''),
    spreadsheetUrl: String(data.spreadsheetUrl ?? ''),
    lastSyncedAt: data.lastSyncedAt ? String(data.lastSyncedAt) : null,
    tabNames: Array.isArray(data.tabNames) ? data.tabNames.map(String) : [],
  };
}

export function subscribeWorkspaceSettings(
  onData: (configs: CategorySheetConfigs) => void,
  onError: (err: Error) => void
): () => void {
  return onSnapshot(
    collection(db, SETTINGS_COL),
    (snapshot) => {
      let permanent: SheetConfig | null = null;
      let temporary: SheetConfig | null = null;
      let legacy: SheetConfig | null = null;

      for (const d of snapshot.docs) {
        const data = d.data() as Record<string, unknown>;
        if (!data?.spreadsheetId) continue;
        if (d.id === 'workspace_permanent') {
          permanent = docToSheetConfig(data, 'Sukhsa Export Permanent');
        } else if (d.id === 'workspace_temporary') {
          temporary = docToSheetConfig(data, 'Sukhsa Export Temporary');
        } else if (d.id === LEGACY_WORKSPACE_DOC_ID) {
          legacy = docToSheetConfig(data, 'Sukhsa Export Permanent');
        }
      }

      onData({
        'Sukhsa Export Permanent': permanent ?? legacy,
        'Sukhsa Export Temporary': temporary,
      });
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, SETTINGS_COL);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export async function adminSaveEmployee(emp: Employee): Promise<void> {
  const safeId = emp.id.trim().replace(/[^a-zA-Z0-9_-]/g, '') || `emp-${Date.now()}`;
  const path = `${EMPLOYEES_COL}/${safeId}`;
  try {
    await setDoc(doc(db, EMPLOYEES_COL, safeId), sanitizeEmployeePayload({ ...emp, id: safeId }));
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function adminDeleteEmployee(
  employee: Employee,
  empRecords: AttendanceRecord[]
): Promise<void> {
  const safeId = employee.id.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const path = `${EMPLOYEES_COL}/${safeId}`;
  try {
    const recordIds = Array.from(new Set(empRecords.map((r) => r.id).filter(Boolean)));
    if (recordIds.length === 0) {
      await deleteDoc(doc(db, EMPLOYEES_COL, safeId));
      return;
    }

    const firstChunk = recordIds.slice(0, 400);
    const firstBatch = writeBatch(db);
    firstBatch.delete(doc(db, EMPLOYEES_COL, safeId));
    for (const rid of firstChunk) {
      firstBatch.delete(doc(db, ATTENDANCE_COL, rid));
    }
    await firstBatch.commit();

    for (let i = 400; i < recordIds.length; i += 450) {
      const batch = writeBatch(db);
      for (const rid of recordIds.slice(i, i + 450)) {
        batch.delete(doc(db, ATTENDANCE_COL, rid));
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function adminBackfillEmployeeCompanyCategories(
  employeesMissingCategory: Employee[]
): Promise<void> {
  if (employeesMissingCategory.length === 0) return;
  for (let i = 0; i < employeesMissingCategory.length; i += 450) {
    const chunk = employeesMissingCategory.slice(i, i + 450);
    const batch = writeBatch(db);
    for (const emp of chunk) {
      const safeId = emp.id.trim().replace(/[^a-zA-Z0-9_-]/g, '');
      if (!safeId) continue;
      batch.set(
        doc(db, EMPLOYEES_COL, safeId),
        sanitizeEmployeePayload({
          ...emp,
          id: safeId,
          companyCategory: normalizeCompanyCategory(emp.companyCategory),
        })
      );
    }
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, EMPLOYEES_COL);
    }
  }
}

export async function adminLoadStarterEmployees(): Promise<void> {
  const starter = buildStarterEmployees();
  const batch = writeBatch(db);
  for (const emp of starter) {
    batch.set(doc(db, EMPLOYEES_COL, emp.id), sanitizeEmployeePayload(emp));
  }
  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, EMPLOYEES_COL);
  }
}

export async function adminUpdateAttendance(record: AttendanceRecord): Promise<void> {
  const path = `${ATTENDANCE_COL}/${record.id}`;
  const isSunday = isSundayISO(record.date);
  const pausedSeconds = Math.max(0, Math.round(record.pausedTotalSeconds ?? 0));
  const thikadaMins = Math.max(0, Math.round(record.thikadaMinutes ?? 0));
  let updateFields: Record<string, unknown>;

  if (record.outTime) {
    const calc = calculateShiftMetrics(
      record.inTime,
      record.outTime,
      record.breakMinutes,
      record.date,
      Math.round(pausedSeconds / 60),
      thikadaMins
    );
    updateFields = {
      date: record.date,
      inTime: record.inTime,
      outTime: record.outTime,
      isPaused: false,
      pausedAtMs: null,
      pausedTotalSeconds: pausedSeconds,
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
      updatedAt: serverTimestamp(),
    };
  } else {
    updateFields = {
      date: record.date,
      inTime: record.inTime,
      outTime: null,
      isPaused: Boolean(record.isPaused),
      pausedAtMs: record.pausedAtMs ?? null,
      pausedTotalSeconds: pausedSeconds,
      grossMinutes: null,
      breakMinutes: record.breakMinutes,
      netMinutes: null,
      netDecimalHours: null,
      overtimeMinutes: null,
      overtimeDecimalHours: null,
      presentCount: null,
      thikadaMinutes: thikadaMins,
      normalMinutes: null,
      normalDecimalHours: null,
      isSunday,
      status: 'on_duty',
      syncedToSheet: false,
      updatedAt: serverTimestamp(),
    };
  }

  try {
    await updateDoc(doc(db, ATTENDANCE_COL, record.id), updateFields);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function adminSaveBulkAttendance(
  records: AttendanceRecord[],
  syncedToSheet = false
): Promise<void> {
  if (records.length === 0) return;

  for (let i = 0; i < records.length; i += 450) {
    const batch = writeBatch(db);
    for (const r of records.slice(i, i + 450)) {
      const docId = `${r.date}_${r.empId}`.replace(/[^a-zA-Z0-9_-]/g, '');
      const isSunday = r.isSunday ?? isSundayISO(r.date);
      const pausedSeconds = Math.max(0, Math.round(r.pausedTotalSeconds ?? 0));
      const thikadaMins = Math.max(0, Math.round(r.thikadaMinutes ?? 0));

      batch.set(doc(db, ATTENDANCE_COL, docId), {
        id: docId,
        date: r.date,
        empId: r.empId,
        empCode: r.empCode.slice(0, 30),
        empName: r.empName.slice(0, 80),
        inTime: r.inTime,
        outTime: r.outTime,
        startedAtMs: null,
        isPaused: false,
        pausedAtMs: null,
        pausedTotalSeconds: pausedSeconds,
        grossMinutes: r.grossMinutes,
        breakMinutes: r.breakMinutes,
        netMinutes: r.netMinutes,
        netDecimalHours: r.netDecimalHours,
        overtimeMinutes: r.overtimeMinutes ?? null,
        overtimeDecimalHours: r.overtimeDecimalHours ?? null,
        presentCount: r.presentCount ?? null,
        thikadaMinutes: thikadaMins,
        normalMinutes: r.normalMinutes ?? null,
        normalDecimalHours: r.normalDecimalHours ?? null,
        isSunday,
        status: r.status,
        syncedToSheet,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, ATTENDANCE_COL);
    }
  }
}

export async function adminDeleteAttendance(recordId: string): Promise<void> {
  const path = `${ATTENDANCE_COL}/${recordId}`;
  try {
    await deleteDoc(doc(db, ATTENDANCE_COL, recordId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function adminSaveSheetConfig(
  category: CompanyCategory,
  config: SheetConfig | null
): Promise<void> {
  const docId = getWorkspaceDocId(category);
  const path = `${SETTINGS_COL}/${docId}`;
  try {
    if (!config) {
      await deleteDoc(doc(db, SETTINGS_COL, docId));
      if (category === 'Sukhsa Export Permanent') {
        await deleteDoc(doc(db, SETTINGS_COL, LEGACY_WORKSPACE_DOC_ID)).catch(() => {});
      }
      return;
    }
    await setDoc(doc(db, SETTINGS_COL, docId), {
      companyCategory: category,
      spreadsheetId: config.spreadsheetId.slice(0, 128),
      spreadsheetTitle: config.spreadsheetTitle.slice(0, 200),
      spreadsheetUrl: config.spreadsheetUrl.slice(0, 300),
      lastSyncedAt: config.lastSyncedAt ?? null,
      tabNames: config.tabNames.slice(0, 500),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function adminMarkRecordsSynced(records: AttendanceRecord[]): Promise<void> {
  const unsynced = records.filter((r) => !r.syncedToSheet);
  if (unsynced.length === 0) return;

  // Firestore batch limit is 500 writes
  for (let i = 0; i < unsynced.length; i += 450) {
    const chunk = unsynced.slice(i, i + 450);
    const batch = writeBatch(db);
    for (const r of chunk) {
      batch.update(doc(db, ATTENDANCE_COL, r.id), {
        syncedToSheet: true,
        updatedAt: serverTimestamp(),
      });
    }
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, ATTENDANCE_COL);
    }
  }
}

export async function adminImportFromSheet(
  employees: Employee[],
  records: AttendanceRecord[],
  sheetConfig: SheetConfig,
  category: CompanyCategory = 'Sukhsa Export Permanent'
): Promise<void> {
  try {
    for (let i = 0; i < employees.length; i += 450) {
      const batch = writeBatch(db);
      for (const emp of employees.slice(i, i + 450)) {
        const safeId = emp.id.replace(/[^a-zA-Z0-9_-]/g, '') || `emp-${Date.now()}`;
        batch.set(
          doc(db, EMPLOYEES_COL, safeId),
          sanitizeEmployeePayload({
            ...emp,
            id: safeId,
            companyCategory: emp.companyCategory ?? category,
          })
        );
      }
      await batch.commit();
    }

    for (let i = 0; i < records.length; i += 450) {
      const batch = writeBatch(db);
      for (const r of records.slice(i, i + 450)) {
        const docId = `${r.date}_${r.empId}`.replace(/[^a-zA-Z0-9_-]/g, '');
        const isSunday = r.isSunday ?? isSundayISO(r.date);
        batch.set(doc(db, ATTENDANCE_COL, docId), {
          id: docId,
          date: r.date,
          empId: r.empId,
          empCode: r.empCode.slice(0, 30),
          empName: r.empName.slice(0, 80),
          inTime: r.inTime,
          outTime: r.outTime,
          startedAtMs: null,
          isPaused: false,
          pausedAtMs: null,
          pausedTotalSeconds: Math.max(0, Math.round(r.pausedTotalSeconds ?? 0)),
          grossMinutes: r.grossMinutes,
          breakMinutes: r.breakMinutes,
          netMinutes: r.netMinutes,
          netDecimalHours: r.netDecimalHours,
          overtimeMinutes: r.overtimeMinutes ?? null,
          overtimeDecimalHours: r.overtimeDecimalHours ?? null,
          presentCount: r.presentCount ?? null,
          thikadaMinutes: Math.max(0, Math.round(r.thikadaMinutes ?? 0)),
          normalMinutes: r.normalMinutes ?? null,
          normalDecimalHours: r.normalDecimalHours ?? null,
          isSunday,
          status: r.status,
          syncedToSheet: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }

    await adminSaveSheetConfig(category, { ...sheetConfig, companyCategory: category });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, SETTINGS_COL);
  }
}

export function subscribeAdminEmails(
  onData: (list: AdminEmailEntry[]) => void,
  onError: (err: Error) => void
): () => void {
  return onSnapshot(
    collection(db, ADMIN_EMAILS_COL),
    (snapshot) => {
      const list: AdminEmailEntry[] = snapshot.docs
        .map((d) => {
          const data = d.data();
          const createdAtRaw = data.createdAt as { toDate?: () => Date } | string | undefined;
          const createdAt =
            createdAtRaw && typeof createdAtRaw === 'object' && typeof createdAtRaw.toDate === 'function'
              ? createdAtRaw.toDate().toISOString()
              : typeof createdAtRaw === 'string'
              ? createdAtRaw
              : new Date().toISOString();
          return {
            email: String(data.email ?? d.id).toLowerCase(),
            addedBy: String(data.addedBy ?? ''),
            createdAt,
          };
        })
        .sort((a, b) => a.email.localeCompare(b.email));
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, ADMIN_EMAILS_COL);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export async function adminAddEmail(email: string, addedBy: string): Promise<void> {
  const emailLower = email.trim().toLowerCase();
  if (!/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(emailLower) || emailLower.length > 120) {
    throw new Error('Please enter a valid Gmail or Google Workspace email address.');
  }

  const path = `${ADMIN_EMAILS_COL}/${emailLower}`;
  try {
    await setDoc(doc(db, ADMIN_EMAILS_COL, emailLower), {
      email: emailLower,
      addedBy: (addedBy || 'admin').trim().toLowerCase().slice(0, 120),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function adminRemoveEmail(email: string): Promise<void> {
  const emailLower = email.trim().toLowerCase();
  const path = `${ADMIN_EMAILS_COL}/${emailLower}`;
  try {
    await deleteDoc(doc(db, ADMIN_EMAILS_COL, emailLower));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ============================================================================
// ADMIN GUARD CREDENTIALS MANAGEMENT (Username + Password + Role: 'guard')
// ============================================================================
export function subscribeGuardAccounts(
  onData: (guards: GuardAccount[]) => void,
  onError: (err: Error) => void
): () => void {
  return onSnapshot(
    collection(db, GUARDS_COL),
    (snapshot) => {
      const toIso = (raw: unknown): string => {
        const ts = raw as { toDate?: () => Date } | string | undefined;
        if (ts && typeof ts === 'object' && typeof ts.toDate === 'function') {
          return ts.toDate().toISOString();
        }
        return typeof ts === 'string' ? ts : new Date().toISOString();
      };
      const list: GuardAccount[] = snapshot.docs
        .map((d) => {
          const data = d.data();
          return {
            id: String(data.id ?? d.id),
            username: String(data.username ?? d.id),
            displayName: String(data.displayName ?? data.username ?? d.id),
            role: 'guard' as const,
            active: data.active !== false,
            createdBy: String(data.createdBy ?? ''),
            createdAt: toIso(data.createdAt),
            updatedAt: toIso(data.updatedAt),
          };
        })
        .sort((a, b) => a.username.localeCompare(b.username));
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, GUARDS_COL);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export interface SaveGuardAccountInput {
  isNew: boolean;
  previousId?: string;
  username: string;
  displayName: string;
  password?: string;
  active: boolean;
  createdBy: string;
}

export async function adminSaveGuardAccount(
  input: SaveGuardAccountInput
): Promise<void> {
  const trimmedUsername = input.username.trim();
  if (!isValidGuardUsernameFormat(trimmedUsername)) {
    throw new Error(
      'Guard username must be 3-40 characters using only letters, numbers, underscores (_) or hyphens (-).'
    );
  }
  const usernameKey = normalizeGuardUsername(trimmedUsername);
  const cleanDisplayName = (input.displayName.trim() || trimmedUsername).slice(0, 80);
  const cleanPassword = input.password ?? '';
  const cleanCreatedBy = (input.createdBy || 'admin').trim().toLowerCase().slice(0, 120);

  if (input.isNew && cleanPassword.length < 4) {
    throw new Error('Password must be at least 4 characters.');
  }
  if (!input.isNew && cleanPassword.length > 0 && cleanPassword.length < 4) {
    throw new Error('New password must be at least 4 characters.');
  }

  const isRename = Boolean(!input.isNew && input.previousId && input.previousId !== usernameKey);
  const path = `${GUARDS_COL}/${usernameKey}`;

  try {
    if (input.isNew || isRename) {
      const existingTarget = await getDoc(doc(db, GUARDS_COL, usernameKey));
      if (existingTarget.exists()) {
        throw new Error(`Guard username "${trimmedUsername}" already exists.`);
      }
    }

    if (input.isNew) {
      const salt = generateHexBytes(16);
      const passwordHash = await hashGuardPassword(cleanPassword, salt);
      const batch = writeBatch(db);
      batch.set(doc(db, GUARDS_COL, usernameKey), {
        id: usernameKey,
        username: trimmedUsername,
        displayName: cleanDisplayName,
        role: 'guard',
        passwordHash,
        active: Boolean(input.active),
        createdBy: cleanCreatedBy,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, GUARD_SALTS_COL, usernameKey), {
        id: usernameKey,
        salt,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      return;
    }

    if (isRename && input.previousId) {
      const oldGuardSnap = await getDoc(doc(db, GUARDS_COL, input.previousId));
      const oldSaltSnap = await getDoc(doc(db, GUARD_SALTS_COL, input.previousId));
      if (!oldGuardSnap.exists()) {
        throw new Error('Original guard account could not be found.');
      }

      let nextSalt: string;
      let nextHash: string;
      if (cleanPassword.length > 0) {
        nextSalt = generateHexBytes(16);
        nextHash = await hashGuardPassword(cleanPassword, nextSalt);
      } else {
        nextSalt = String(oldSaltSnap.data()?.salt ?? '');
        nextHash = String(oldGuardSnap.data()?.passwordHash ?? '');
        if (!nextSalt || !nextHash) {
          throw new Error('Please enter a password when renaming this guard account.');
        }
      }

      const batch = writeBatch(db);
      batch.set(doc(db, GUARDS_COL, usernameKey), {
        id: usernameKey,
        username: trimmedUsername,
        displayName: cleanDisplayName,
        role: 'guard',
        passwordHash: nextHash,
        active: Boolean(input.active),
        createdBy: String(oldGuardSnap.data()?.createdBy ?? cleanCreatedBy),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, GUARD_SALTS_COL, usernameKey), {
        id: usernameKey,
        salt: nextSalt,
        updatedAt: serverTimestamp(),
      });
      batch.delete(doc(db, GUARDS_COL, input.previousId));
      batch.delete(doc(db, GUARD_SALTS_COL, input.previousId));
      await batch.commit();
      return;
    }

    // Update existing guard at the same username key
    const batch = writeBatch(db);
    const guardUpdates: Record<string, unknown> = {
      username: trimmedUsername,
      displayName: cleanDisplayName,
      active: Boolean(input.active),
      updatedAt: serverTimestamp(),
    };

    if (cleanPassword.length > 0) {
      const newSalt = generateHexBytes(16);
      const newHash = await hashGuardPassword(cleanPassword, newSalt);
      guardUpdates.passwordHash = newHash;
      batch.set(doc(db, GUARD_SALTS_COL, usernameKey), {
        id: usernameKey,
        salt: newSalt,
        updatedAt: serverTimestamp(),
      });
    }

    batch.update(doc(db, GUARDS_COL, usernameKey), guardUpdates);
    await batch.commit();
  } catch (error) {
    const err = error as Error & { code?: string };
    if (!err.code && err.message) {
      throw err;
    }
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function adminToggleGuardActive(guard: GuardAccount): Promise<void> {
  const path = `${GUARDS_COL}/${guard.id}`;
  try {
    await updateDoc(doc(db, GUARDS_COL, guard.id), {
      active: !guard.active,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function adminDeleteGuardAccount(guardId: string): Promise<void> {
  const safeId = normalizeGuardUsername(guardId);
  const path = `${GUARDS_COL}/${safeId}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, GUARDS_COL, safeId));
    batch.delete(doc(db, GUARD_SALTS_COL, safeId));
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

