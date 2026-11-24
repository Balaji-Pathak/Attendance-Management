export type NavSection =
  | 'guard-gate'
  | 'master-log'
  | 'individual-sheets'
  | 'employees'
  | 'sheets-sync';

export type AttendanceStatus = 'on_duty' | 'completed' | 'short_shift';

export interface Employee {
  id: string;
  empCode: string;
  name: string;
  department: string;
  breakMinutes: number; // Defaults to 30
  active: boolean;
  individualSheetId?: string;
  individualSheetUrl?: string;
}

export interface AttendanceRecord {
  id: string;
  date: string; // YYYY-MM-DD
  empId: string;
  empCode: string;
  empName: string;
  inTime: string; // HH:MM (24h)
  outTime: string | null; // HH:MM (24h) or null if still on duty
  startedAtMs?: number | null;
  isPaused?: boolean;
  pausedAtMs?: number | null;
  pausedTotalSeconds?: number;
  grossMinutes: number | null;
  breakMinutes: number; // Deducted break minutes (30)
  netMinutes: number | null;
  netDecimalHours: number | null;
  overtimeMinutes?: number | null;
  overtimeDecimalHours?: number | null;
  isSunday?: boolean;
  status: AttendanceStatus;
  syncedToSheet: boolean;
  updatedAt: string;
}

export interface GateEmployeeView {
  id: string;
  empCode: string;
  name: string;
  department: string;
}

export interface SheetConfig {
  spreadsheetId: string;
  spreadsheetTitle: string;
  spreadsheetUrl: string;
  lastSyncedAt: string | null;
  tabNames: string[];
}

export interface DriveSpreadsheetItem {
  id: string;
  name: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface ConfirmRequest {
  title: string;
  description: string;
  affectedTarget?: string;
  details?: string[];
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
}

export interface AdminAuthStatus {
  hasEnvPasscode: boolean;
  isAdminClaimed: boolean;
  adminEmail: string | null;
}

export interface AdminEmailEntry {
  email: string;
  addedBy: string;
  createdAt: string;
}
