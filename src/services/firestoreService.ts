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
  calculateShiftMetrics,
  getCurrentHHMM,
  getTodayISO,
  sortRecordsNewestFirst,
} from '../utils/time';
import { db, handleFirestoreError, OperationType } from './firebaseClient';

const EMPLOYEES_COL = 'employees';
const ATTENDANCE_COL = 'attendance';
const SETTINGS_COL = 'settings';
const ADMIN_EMAILS_COL = 'admin_emails';
const WORKSPACE_DOC_ID = 'workspace';

function sanitizeEmployeePayload(emp: Employee): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: emp.id.trim().slice(0, 80),
    empCode: emp.empCode.trim().slice(0, 30),
    name: emp.name.trim().slice(0, 80),
    department: (emp.department || 'General').trim().slice(0, 60),
    breakMinutes: Math.max(0, Math.min(180, Math.round(emp.breakMinutes || 30))),
    active: Boolean(emp.active),
  };

  if (emp.individualSheetId && emp.individualSheetId.trim()) {
    payload.individualSheetId = emp.individualSheetId.trim().slice(0, 128);
  }
  if (emp.individualSheetUrl && emp.individualSheetUrl.trim()) {
    payload.individualSheetUrl = emp.individualSheetUrl.trim().slice(0, 300);
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

  return {
    id,
    date: String(data.date ?? ''),
    empId: String(data.empId ?? ''),
    empCode: String(data.empCode ?? ''),
    empName: String(data.empName ?? ''),
    inTime: String(data.inTime ?? '09:00'),
    outTime: data.outTime ? String(data.outTime) : null,
    grossMinutes: typeof data.grossMinutes === 'number' ? data.grossMinutes : null,
    breakMinutes: typeof data.breakMinutes === 'number' ? data.breakMinutes : 30,
    netMinutes: typeof data.netMinutes === 'number' ? data.netMinutes : null,
    netDecimalHours: typeof data.netDecimalHours === 'number' ? data.netDecimalHours : null,
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
    grossMinutes: null,
    breakMinutes: 30,
    netMinutes: null,
    netDecimalHours: null,
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
      grossMinutes: null,
      breakMinutes: 30,
      netMinutes: null,
      netDecimalHours: null,
      status: 'on_duty',
      syncedToSheet: false,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function guardMarkOut(record: AttendanceRecord): Promise<AttendanceRecord> {
  const outTime = getCurrentHHMM();
  const calc = calculateShiftMetrics(record.inTime, outTime, record.breakMinutes ?? 30);
  const path = `${ATTENDANCE_COL}/${record.id}`;

  try {
    await updateDoc(doc(db, ATTENDANCE_COL, record.id), {
      outTime,
      grossMinutes: calc.grossMinutes,
      netMinutes: calc.netMinutes,
      netDecimalHours: calc.netDecimalHours,
      status: calc.status,
      syncedToSheet: false,
      updatedAt: serverTimestamp(),
    });

    return {
      ...record,
      outTime,
      grossMinutes: calc.grossMinutes,
      netMinutes: calc.netMinutes,
      netDecimalHours: calc.netDecimalHours,
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
  onData: (employees: Employee[]) => void,
  onError: (err: Error) => void
): () => void {
  return onSnapshot(
    collection(db, EMPLOYEES_COL),
    (snapshot) => {
      const list: Employee[] = snapshot.docs
        .map((d) => {
          const data = d.data();
          return {
            id: String(data.id ?? d.id),
            empCode: String(data.empCode ?? ''),
            name: String(data.name ?? ''),
            department: String(data.department ?? 'General'),
            breakMinutes: typeof data.breakMinutes === 'number' ? data.breakMinutes : 30,
            active: data.active !== false,
            individualSheetId: data.individualSheetId
              ? String(data.individualSheetId)
              : undefined,
            individualSheetUrl: data.individualSheetUrl
              ? String(data.individualSheetUrl)
              : undefined,
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
  let updateFields: Record<string, unknown>;

  if (record.outTime) {
    const calc = calculateShiftMetrics(record.inTime, record.outTime, record.breakMinutes);
    updateFields = {
      date: record.date,
      inTime: record.inTime,
      outTime: record.outTime,
      grossMinutes: calc.grossMinutes,
      breakMinutes: calc.breakDeductedMinutes,
      netMinutes: calc.netMinutes,
      netDecimalHours: calc.netDecimalHours,
      status: calc.status,
      syncedToSheet: false,
      updatedAt: serverTimestamp(),
    };
  } else {
    updateFields = {
      date: record.date,
      inTime: record.inTime,
      outTime: null,
      grossMinutes: null,
      breakMinutes: record.breakMinutes,
      netMinutes: null,
      netDecimalHours: null,
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
        batch.set(doc(db, ATTENDANCE_COL, docId), {
          id: docId,
          date: r.date,
          empId: r.empId,
          empCode: r.empCode.slice(0, 30),
          empName: r.empName.slice(0, 80),
          inTime: r.inTime,
          outTime: r.outTime,
          grossMinutes: r.grossMinutes,
          breakMinutes: r.breakMinutes,
          netMinutes: r.netMinutes,
          netDecimalHours: r.netDecimalHours,
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

