import {
  collection,
  deleteDoc,
  doc,
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
  Employee,
  GateEmployeeView,
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
const WORKSPACE_DOC_ID = 'workspace';

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

export async function guardMarkIn(employee: GateEmployeeView): Promise<AttendanceRecord> {
  const date = getTodayISO();
  const inTime = getCurrentHHMM();
  const nowMs = Date.now();
  const isSunday = isSundayISO(date);
  const docId = `${date}_${employee.id}`;
  const path = `${ATTENDANCE_COL}/${docId}`;

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
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function guardPauseTiming(record: AttendanceRecord): Promise<AttendanceRecord> {
  const nowMs = Date.now();
  const path = `${ATTENDANCE_COL}/${record.id}`;
  const isSunday = record.isSunday ?? isSundayISO(record.date);
  const pausedTotalSeconds = Math.max(0, Math.round(record.pausedTotalSeconds ?? 0));

  try {
    await updateDoc(doc(db, ATTENDANCE_COL, record.id), {
      isPaused: true,
      pausedAtMs: nowMs,
      pausedTotalSeconds,
      isSunday,
      overtimeMinutes: record.overtimeMinutes ?? null,
      overtimeDecimalHours: record.overtimeDecimalHours ?? null,
      updatedAt: serverTimestamp(),
    });

    return {
      ...record,
      isPaused: true,
      pausedAtMs: nowMs,
      pausedTotalSeconds,
      isSunday,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function guardResumeTiming(record: AttendanceRecord): Promise<AttendanceRecord> {
  const nowMs = Date.now();
  const path = `${ATTENDANCE_COL}/${record.id}`;
  const isSunday = record.isSunday ?? isSundayISO(record.date);
  const pauseStarted = record.pausedAtMs ?? nowMs;
  const pauseDeltaSec = Math.max(0, Math.floor((nowMs - pauseStarted) / 1000));
  const nextPausedTotalSeconds = Math.min(
    86400,
    Math.max(0, Math.round(record.pausedTotalSeconds ?? 0)) + pauseDeltaSec
  );

  try {
    await updateDoc(doc(db, ATTENDANCE_COL, record.id), {
      isPaused: false,
      pausedAtMs: null,
      pausedTotalSeconds: nextPausedTotalSeconds,
      isSunday,
      overtimeMinutes: record.overtimeMinutes ?? null,
      overtimeDecimalHours: record.overtimeDecimalHours ?? null,
      updatedAt: serverTimestamp(),
    });

    return {
      ...record,
      isPaused: false,
      pausedAtMs: null,
      pausedTotalSeconds: nextPausedTotalSeconds,
      isSunday,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function guardMarkOut(record: AttendanceRecord): Promise<AttendanceRecord> {
  const nowMs = Date.now();
  const outTime = getCurrentHHMM();
  const path = `${ATTENDANCE_COL}/${record.id}`;

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
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
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

export function subscribeWorkspaceSettings(
  onData: (config: SheetConfig | null) => void,
  onError: (err: Error) => void
): () => void {
  const path = `${SETTINGS_COL}/${WORKSPACE_DOC_ID}`;
  return onSnapshot(
    doc(db, SETTINGS_COL, WORKSPACE_DOC_ID),
    (snap) => {
      if (!snap.exists()) {
        onData(null);
        return;
      }
      const data = snap.data();
      onData({
        spreadsheetId: String(data.spreadsheetId ?? ''),
        spreadsheetTitle: String(data.spreadsheetTitle ?? ''),
        spreadsheetUrl: String(data.spreadsheetUrl ?? ''),
        lastSyncedAt: data.lastSyncedAt ? String(data.lastSyncedAt) : null,
        tabNames: Array.isArray(data.tabNames) ? data.tabNames.map(String) : [],
      });
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
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

export async function adminSaveSheetConfig(config: SheetConfig | null): Promise<void> {
  const path = `${SETTINGS_COL}/${WORKSPACE_DOC_ID}`;
  try {
    if (!config) {
      await deleteDoc(doc(db, SETTINGS_COL, WORKSPACE_DOC_ID));
      return;
    }
    await setDoc(doc(db, SETTINGS_COL, WORKSPACE_DOC_ID), {
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
  sheetConfig: SheetConfig
): Promise<void> {
  try {
    for (let i = 0; i < employees.length; i += 450) {
      const batch = writeBatch(db);
      for (const emp of employees.slice(i, i + 450)) {
        const safeId = emp.id.replace(/[^a-zA-Z0-9_-]/g, '') || `emp-${Date.now()}`;
        batch.set(
          doc(db, EMPLOYEES_COL, safeId),
          sanitizeEmployeePayload({ ...emp, id: safeId })
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

    await adminSaveSheetConfig(sheetConfig);
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

