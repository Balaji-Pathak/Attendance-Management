export type NavSection =
  | 'guard-gate'
  | 'master-log'
  | 'individual-sheets'
  | 'employees'
  | 'sheets-sync';

export type AttendanceStatus = 'on_duty' | 'completed' | 'short_shift';

export type CompanyCategory =
  | 'Sukhsa Export Permanent'
  | 'Sukhsa Export Temporary';

export const COMPANY_CATEGORIES: readonly CompanyCategory[] = [
  'Sukhsa Export Permanent',
  'Sukhsa Export Temporary',
] as const;

export const DEFAULT_COMPANY_CATEGORY: CompanyCategory =
  'Sukhsa Export Permanent';

export interface Employee {
  id: string;
  empCode: string;
  name: string;
  department: string;
  companyCategory?: CompanyCategory;
  breakMinutes: number; // Defaults to 30
  hourlyRate?: number; // Per-hour wage rate
  active: boolean;
  individualSheetId?: string;
  individualSheetUrl?: string;
  monthlyThikadaMinutes?: Record<string, number>; // Keyed by YYYY-MM
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
  presentCount?: number | null; // 1 for >=8h Mon-Sat, 0 otherwise
  thikadaMinutes?: number; // Piece-rate / contractor hours deducted from Normal Hours (H)
  normalMinutes?: number | null; // H = (<8h OR >8h OT OR Sunday 100% OT) - thikadaMinutes
  normalDecimalHours?: number | null;
  isSunday?: boolean;
  status: AttendanceStatus;
  syncedToSheet: boolean;
  guardSessionId?: string;
  markedByGuard?: string;
  updatedAt: string;
}

export interface GuardAccount {
  id: string; // Normalized lowercase username
  username: string;
  displayName: string;
  role: 'guard';
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GuardSession {
  sessionId: string;
  username: string;
  displayName: string;
  role: 'guard';
  expiresAtMs: number;
}

export interface GateEmployeeView {
  id: string;
  empCode: string;
  name: string;
  department: string;
  companyCategory?: CompanyCategory;
}

export interface SheetConfig {
  companyCategory?: CompanyCategory;
  spreadsheetId: string;
  spreadsheetTitle: string;
  spreadsheetUrl: string;
  lastSyncedAt: string | null;
  tabNames: string[];
}

export type CategorySheetConfigs = Record<CompanyCategory, SheetConfig | null>;

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
