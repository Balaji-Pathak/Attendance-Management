import {
  AttendanceRecord,
  AttendanceStatus,
  CompanyCategory,
  DEFAULT_COMPANY_CATEGORY,
  Employee,
} from '../types/attendance';

export function normalizeCompanyCategory(raw?: unknown): CompanyCategory {
  if (typeof raw === 'string') {
    const cleaned = raw.trim().toLowerCase();
    if (cleaned.includes('temporary') || cleaned === 'temp') {
      return 'Sukhsa Export Temporary';
    }
  }
  return DEFAULT_COMPANY_CATEGORY;
}

export function getEmployeeHourlyRate(
  emp?: Pick<Employee, 'hourlyRate'> | null
): number {
  const rate = emp?.hourlyRate;
  if (typeof rate === 'number' && !Number.isNaN(rate) && rate > 0) {
    return Number(rate.toFixed(5));
  }
  return 0;
}

export function formatHourlyRateINR(rate: number): string {
  const safe = Number.isFinite(rate) ? rate : 0;
  return `₹${safe.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 5,
  })}`;
}

export function formatCurrencyINR(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `₹${safe.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function getTodayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getCurrentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function getCurrentHHMM(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function parseTimeToMinutes(hhmm: string): number {
  const parts = hhmm.split(':');
  if (parts.length < 2) return 0;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

export function formatDisplayTime(hhmm: string | null): string {
  if (!hhmm) return '—';
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
}

export function parseDisplayTimeToHHMM(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed || trimmed === '—') return null;

  const ampmMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampmMatch) {
    let h = Number(ampmMatch[1]);
    const m = Number(ampmMatch[2]);
    const period = ampmMatch[3].toUpperCase();
    if (period === 'PM' && h < 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  const h24Match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (h24Match) {
    return `${String(Number(h24Match[1])).padStart(2, '0')}:${h24Match[2]}`;
  }

  return null;
}

export const STANDARD_SHIFT_MINUTES = 480; // 8 hours standard shift
export const BREAK_THRESHOLD_MINUTES = 270; // 4.5 hours minimum before break deduction

export function isSundayISO(dateIso: string): boolean {
  const parts = dateIso.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return false;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d).getDay() === 0;
}

export function getDayNameShort(dateIso: string): string {
  const parts = dateIso.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return '';
  const [y, m, d] = parts;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' });
}

export function formatHMS(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function getRecordStartTimestampMs(
  record: Pick<AttendanceRecord, 'date' | 'inTime' | 'startedAtMs'>
): number {
  if (typeof record.startedAtMs === 'number' && record.startedAtMs > 0) {
    return record.startedAtMs;
  }
  const [y, m, d] = record.date.split('-').map(Number);
  const [hh, mm] = record.inTime.split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) {
    return Date.now();
  }
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

export function computeLiveElapsedSeconds(
  record: Pick<
    AttendanceRecord,
    'date' | 'inTime' | 'startedAtMs' | 'isPaused' | 'pausedAtMs' | 'pausedTotalSeconds'
  >,
  nowMs: number
): number {
  const startMs = getRecordStartTimestampMs(record);
  const pausedPrev = Math.max(0, record.pausedTotalSeconds ?? 0);
  const endMs =
    record.isPaused && typeof record.pausedAtMs === 'number' && record.pausedAtMs > 0
      ? record.pausedAtMs
      : nowMs;
  return Math.max(0, Math.floor((endMs - startMs) / 1000) - pausedPrev);
}

export function formatDurationHM(totalMinutes: number | null | undefined): string {
  if (totalMinutes === null || totalMinutes === undefined || Number.isNaN(totalMinutes)) return '—';
  const safe = Math.max(0, Math.round(totalMinutes));
  const hrs = Math.floor(safe / 60);
  const mins = safe % 60;
  return `${hrs}h ${String(mins).padStart(2, '0')}m`;
}

export interface ShiftCalculationResult {
  grossMinutes: number;
  breakDeductedMinutes: number;
  netMinutes: number;
  netDecimalHours: number;
  presentCount: number;
  overtimeMinutes: number;
  overtimeDecimalHours: number;
  thikadaMinutes: number;
  thikadaDecimalHours: number;
  grossNormalMinutes: number;
  normalMinutes: number;
  normalDecimalHours: number;
  isSunday: boolean;
  isOvernight: boolean;
  status: AttendanceStatus;
}

export function calculateMetricsFromWorkedMinutes(
  grossActiveMinutes: number,
  breakMinutes: number,
  dateIso?: string,
  isOvernight = false,
  thikadaMinutes = 0
): ShiftCalculationResult {
  const grossMinutes = Math.max(0, Math.round(grossActiveMinutes));
  const safeBreak = Math.max(0, breakMinutes);
  const breakDeductedMinutes =
    grossMinutes >= BREAK_THRESHOLD_MINUTES ? Math.min(safeBreak, grossMinutes) : 0;
  const netMinutes = Math.max(0, grossMinutes - breakDeductedMinutes);
  const netDecimalHours = Number((netMinutes / 60).toFixed(2));
  const isSunday = dateIso ? isSundayISO(dateIso) : false;

  // Present Day (P) = 1 only for complete 8h+ shift on Mon-Sat.
  // <8h Mon-Sat goes into Normal Hours (H); >8h overtime & Sunday 100% also go into Normal Hours (H).
  let presentCount = 0;
  let overtimeMinutes = 0;
  let grossNormalMinutes = 0;

  if (isSunday) {
    presentCount = 0;
    overtimeMinutes = netMinutes;
    grossNormalMinutes = netMinutes;
  } else if (netMinutes >= STANDARD_SHIFT_MINUTES) {
    presentCount = 1;
    overtimeMinutes = netMinutes - STANDARD_SHIFT_MINUTES;
    grossNormalMinutes = overtimeMinutes;
  } else {
    presentCount = 0;
    overtimeMinutes = 0;
    grossNormalMinutes = netMinutes;
  }

  const safeThikadaMinutes = Math.max(0, Math.round(thikadaMinutes || 0));
  const normalMinutes = Math.max(0, grossNormalMinutes - safeThikadaMinutes);
  const normalDecimalHours = Number((normalMinutes / 60).toFixed(2));
  const overtimeDecimalHours = Number((overtimeMinutes / 60).toFixed(2));
  const thikadaDecimalHours = Number((safeThikadaMinutes / 60).toFixed(2));
  const status: AttendanceStatus =
    isSunday && netMinutes > 0
      ? 'completed'
      : netMinutes >= STANDARD_SHIFT_MINUTES
      ? 'completed'
      : 'short_shift';

  return {
    grossMinutes,
    breakDeductedMinutes,
    netMinutes,
    netDecimalHours,
    presentCount,
    overtimeMinutes,
    overtimeDecimalHours,
    thikadaMinutes: safeThikadaMinutes,
    thikadaDecimalHours,
    grossNormalMinutes,
    normalMinutes,
    normalDecimalHours,
    isSunday,
    isOvernight,
    status,
  };
}

export function calculateShiftMetrics(
  inTime: string,
  outTime: string,
  breakMinutes = 30,
  dateIso?: string,
  pausedMinutes = 0,
  thikadaMinutes = 0
): ShiftCalculationResult {
  const inMins = parseTimeToMinutes(inTime);
  let outMins = parseTimeToMinutes(outTime);
  let isOvernight = false;

  if (outMins < inMins) {
    outMins += 24 * 60;
    isOvernight = true;
  }

  const spanMinutes = Math.max(0, outMins - inMins);
  const activeGrossMinutes = Math.max(0, spanMinutes - Math.max(0, pausedMinutes));
  return calculateMetricsFromWorkedMinutes(
    activeGrossMinutes,
    breakMinutes,
    dateIso,
    isOvernight,
    thikadaMinutes
  );
}

export interface RecordPayrollBreakdown {
  isSunday: boolean;
  presentCount: number;
  overtimeMinutes: number;
  overtimeDecimalHours: number;
  thikadaMinutes: number;
  thikadaDecimalHours: number;
  grossNormalMinutes: number;
  normalMinutes: number;
  normalDecimalHours: number;
}

export function getRecordPayroll(r: AttendanceRecord): RecordPayrollBreakdown {
  const isSun = r.isSunday ?? isSundayISO(r.date);
  if (!r.outTime || r.netMinutes === null) {
    return {
      isSunday: isSun,
      presentCount: 0,
      overtimeMinutes: 0,
      overtimeDecimalHours: 0,
      thikadaMinutes: Math.max(0, Math.round(r.thikadaMinutes ?? 0)),
      thikadaDecimalHours: Number((Math.max(0, r.thikadaMinutes ?? 0) / 60).toFixed(2)),
      grossNormalMinutes: 0,
      normalMinutes: 0,
      normalDecimalHours: 0,
    };
  }

  const presentCount =
    typeof r.presentCount === 'number'
      ? r.presentCount
      : !isSun && r.netMinutes >= STANDARD_SHIFT_MINUTES
      ? 1
      : 0;

  const overtimeMinutes =
    typeof r.overtimeMinutes === 'number'
      ? r.overtimeMinutes
      : isSun
      ? r.netMinutes
      : Math.max(0, r.netMinutes - STANDARD_SHIFT_MINUTES);

  const grossNormalMinutes = isSun
    ? r.netMinutes
    : r.netMinutes >= STANDARD_SHIFT_MINUTES
    ? r.netMinutes - STANDARD_SHIFT_MINUTES
    : r.netMinutes;

  const thikadaMinutes = Math.max(0, Math.round(r.thikadaMinutes ?? 0));
  const normalMinutes =
    typeof r.normalMinutes === 'number'
      ? r.normalMinutes
      : Math.max(0, grossNormalMinutes - thikadaMinutes);

  return {
    isSunday: isSun,
    presentCount,
    overtimeMinutes,
    overtimeDecimalHours: Number((overtimeMinutes / 60).toFixed(2)),
    thikadaMinutes,
    thikadaDecimalHours: Number((thikadaMinutes / 60).toFixed(2)),
    grossNormalMinutes,
    normalMinutes,
    normalDecimalHours: Number((normalMinutes / 60).toFixed(2)),
  };
}

export function formatMonthLabel(yearMonth: string): string {
  const [yStr, mStr] = yearMonth.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  if (!y || !m || m < 1 || m > 12) return yearMonth;
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

export function getMonthDays(
  yearMonth: string
): Array<{ date: string; dayShort: string; isSunday: boolean }> {
  const [yStr, mStr] = yearMonth.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  if (!y || !m || m < 1 || m > 12) return [];
  const totalDays = new Date(y, m, 0).getDate();
  const days: Array<{ date: string; dayShort: string; isSunday: boolean }> = [];
  for (let d = 1; d <= totalDays; d += 1) {
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    days.push({
      date,
      dayShort: getDayNameShort(date),
      isSunday: isSundayISO(date),
    });
  }
  return days;
}

export function formatDisplayDate(dateIso: string): string {
  if (!dateIso) return '—';
  const [y, m, d] = dateIso.split('-').map(Number);
  if (!y || !m || !d) return dateIso;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function getStatusLabel(status: AttendanceStatus | 'not_in'): string {
  switch (status) {
    case 'on_duty':
      return 'On Duty';
    case 'completed':
      return 'Done';
    case 'short_shift':
      return 'Short Shift';
    case 'not_in':
      return 'Not In';
  }
}

export function getEmployeeSheetTabName(empCode: string, name: string): string {
  const raw = `${empCode} - ${name}`;
  const sanitized = raw.replace(/[:\\/?*[\]]/g, '-').trim();
  return sanitized.slice(0, 85) || 'Employee';
}

export function downloadCSV(filename: string, headers: string[], rows: (string | number)[][]): void {
  const escapeCell = (val: string | number): string => {
    const str = String(val ?? '');
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const csv = [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function buildStarterEmployees(): Employee[] {
  return [
    { id: 'emp-101', empCode: 'EMP-001', name: 'Rajesh Kumar', department: 'Production', companyCategory: DEFAULT_COMPANY_CATEGORY, breakMinutes: 30, active: true },
    { id: 'emp-102', empCode: 'EMP-002', name: 'Anita Sharma', department: 'Quality', companyCategory: DEFAULT_COMPANY_CATEGORY, breakMinutes: 30, active: true },
    { id: 'emp-103', empCode: 'EMP-003', name: 'Vikram Patel', department: 'Dispatch', companyCategory: DEFAULT_COMPANY_CATEGORY, breakMinutes: 30, active: true },
    { id: 'emp-104', empCode: 'EMP-004', name: 'Meena Verma', department: 'Packaging', companyCategory: DEFAULT_COMPANY_CATEGORY, breakMinutes: 30, active: true },
    { id: 'emp-105', empCode: 'EMP-005', name: 'Suresh Nair', department: 'Maintenance', companyCategory: DEFAULT_COMPANY_CATEGORY, breakMinutes: 30, active: true },
  ];
}

export function sortRecordsNewestFirst(records: AttendanceRecord[]): AttendanceRecord[] {
  return [...records].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return b.inTime.localeCompare(a.inTime);
  });
}

