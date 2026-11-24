import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarPlus,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FolderInput,
  RefreshCw,
  UserCheck,
  X,
} from 'lucide-react';
import { AttendanceRecord, Employee, SheetConfig } from '../types/attendance';
import {
  calculateShiftMetrics,
  downloadCSV,
  formatDisplayTime,
  formatDurationHM,
  getDayNameShort,
  getEmployeeSheetTabName,
  getMonthDays,
  isSundayISO,
} from '../utils/time';
import { StatusLabel } from './StatusLabel';

interface IndividualEmployeeViewProps {
  employees: Employee[];
  records: AttendanceRecord[];
  sheetConfig: SheetConfig | null;
  isGoogleAuthed: boolean;
  onRequestSyncEmployeeTab: (employee: Employee) => void;
  onRequestStandaloneSheet: (employee: Employee) => void;
  onImportEmployeeSheet: (employee: Employee, sheetUrlOrId: string) => Promise<void>;
  onSaveEmployeeMonthRecords: (
    employee: Employee,
    monthRecords: AttendanceRecord[],
    syncToStandaloneSheet: boolean
  ) => Promise<void>;
}

interface MonthBuilderRow {
  date: string;
  dayShort: string;
  isSunday: boolean;
  present: boolean;
  inTime: string;
  outTime: string;
  awayMinutes: number;
}

function getPreviousYearMonth(): string {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}

export const IndividualEmployeeView: React.FC<IndividualEmployeeViewProps> = ({
  employees,
  records,
  sheetConfig,
  isGoogleAuthed,
  onRequestSyncEmployeeTab,
  onRequestStandaloneSheet,
  onImportEmployeeSheet,
  onSaveEmployeeMonthRecords,
}) => {
  const [selectedEmpId, setSelectedEmpId] = useState<string>(employees[0]?.id ?? '');
  const [monthFilter, setMonthFilter] = useState<string>('all');

  // Import existing Google Sheet UI state
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [importSheetInput, setImportSheetInput] = useState('');
  const [isImportingSheet, setIsImportingSheet] = useState(false);

  // Previous Month Bulk Builder Modal state
  const [showMonthBuilder, setShowMonthBuilder] = useState(false);
  const [builderMonth, setBuilderMonth] = useState<string>(() => getPreviousYearMonth());
  const [defaultInTime, setDefaultInTime] = useState('09:00');
  const [defaultOutTime, setDefaultOutTime] = useState('17:30');
  const [defaultAwayMins, setDefaultAwayMins] = useState(0);
  const [includeSundays, setIncludeSundays] = useState(false);
  const [builderRows, setBuilderRows] = useState<MonthBuilderRow[]>([]);
  const [syncBuilderToSheet, setSyncBuilderToSheet] = useState(true);
  const [isSavingMonth, setIsSavingMonth] = useState(false);

  const selectedEmployee = useMemo(() => {
    return employees.find((e) => e.id === selectedEmpId) ?? employees[0] ?? null;
  }, [employees, selectedEmpId]);

  const monthOptions = useMemo(() => {
    const months = new Set<string>();
    for (const r of records) {
      if (r.date && r.date.length >= 7) {
        months.add(r.date.slice(0, 7));
      }
    }
    return Array.from(months).sort((a, b) => b.localeCompare(a));
  }, [records]);

  const empRecords = useMemo(() => {
    if (!selectedEmployee) return [];
    return records
      .filter(
        (r) =>
          (r.empId === selectedEmployee.id || r.empCode === selectedEmployee.empCode) &&
          (monthFilter === 'all' || r.date.startsWith(monthFilter))
      )
      .sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return b.inTime.localeCompare(a.inTime);
      });
  }, [records, selectedEmployee, monthFilter]);

  const summary = useMemo(() => {
    let totalAwayMins = 0;
    let net = 0;
    let overtimeMinutes = 0;
    let completed = 0;
    const uniqueDays = new Set<string>();

    for (const r of empRecords) {
      uniqueDays.add(r.date);
      totalAwayMins += Math.round((r.pausedTotalSeconds ?? 0) / 60);
      if (r.outTime && r.netMinutes !== null) {
        net += r.netMinutes;
        const isSun = r.isSunday ?? isSundayISO(r.date);
        const otMins =
          typeof r.overtimeMinutes === 'number'
            ? r.overtimeMinutes
            : isSun
            ? r.netMinutes
            : Math.max(0, r.netMinutes - 480);
        overtimeMinutes += otMins;
        completed += 1;
      }
    }

    return {
      daysWorked: uniqueDays.size,
      totalAwayMins,
      net,
      netDecimal: Number((net / 60).toFixed(2)),
      overtimeMinutes,
      overtimeDecimal: Number((overtimeMinutes / 60).toFixed(2)),
      avgNet: completed > 0 ? Math.round(net / completed) : 0,
    };
  }, [empRecords]);

  // Populate builder rows whenever modal opens or selected employee/month changes
  useEffect(() => {
    if (!showMonthBuilder || !selectedEmployee) return;
    const days = getMonthDays(builderMonth);
    const existingByDate = new Map<string, AttendanceRecord>();
    for (const r of records) {
      if (
        (r.empId === selectedEmployee.id || r.empCode === selectedEmployee.empCode) &&
        r.date.startsWith(builderMonth)
      ) {
        existingByDate.set(r.date, r);
      }
    }

    setBuilderRows(
      days.map((d) => {
        const existing = existingByDate.get(d.date);
        if (existing) {
          return {
            date: d.date,
            dayShort: d.dayShort,
            isSunday: d.isSunday,
            present: true,
            inTime: existing.inTime,
            outTime: existing.outTime || defaultOutTime,
            awayMinutes: Math.round((existing.pausedTotalSeconds ?? 0) / 60),
          };
        }
        return {
          date: d.date,
          dayShort: d.dayShort,
          isSunday: d.isSunday,
          present: d.isSunday ? includeSundays : true,
          inTime: defaultInTime,
          outTime: defaultOutTime,
          awayMinutes: defaultAwayMins,
        };
      })
    );
  }, [showMonthBuilder, builderMonth, selectedEmployee?.id]);

  const handleApplyDefaultsToMonth = () => {
    setBuilderRows((prev) =>
      prev.map((row) => ({
        ...row,
        present: row.isSunday ? includeSundays : true,
        inTime: defaultInTime,
        outTime: defaultOutTime,
        awayMinutes: defaultAwayMins,
      }))
    );
  };

  const builderTotals = useMemo(() => {
    if (!selectedEmployee) {
      return { presentDays: 0, netMinutes: 0, overtimeMinutes: 0 };
    }
    const breakMins = selectedEmployee.breakMinutes || 30;
    let presentDays = 0;
    let netMinutes = 0;
    let overtimeMinutes = 0;

    for (const row of builderRows) {
      if (!row.present || !row.inTime || !row.outTime) continue;
      const calc = calculateShiftMetrics(
        row.inTime,
        row.outTime,
        breakMins,
        row.date,
        row.awayMinutes
      );
      presentDays += 1;
      netMinutes += calc.netMinutes;
      overtimeMinutes += calc.overtimeMinutes;
    }
    return { presentDays, netMinutes, overtimeMinutes };
  }, [builderRows, selectedEmployee]);

  const handleSaveBuilderMonth = async () => {
    if (!selectedEmployee) return;
    const breakMins = selectedEmployee.breakMinutes || 30;
    const builtRecords: AttendanceRecord[] = [];

    for (const row of builderRows) {
      if (!row.present || !row.inTime || !row.outTime) continue;
      const calc = calculateShiftMetrics(
        row.inTime,
        row.outTime,
        breakMins,
        row.date,
        row.awayMinutes
      );
      builtRecords.push({
        id: `${row.date}_${selectedEmployee.id}`,
        date: row.date,
        empId: selectedEmployee.id,
        empCode: selectedEmployee.empCode,
        empName: selectedEmployee.name,
        inTime: row.inTime,
        outTime: row.outTime,
        startedAtMs: null,
        isPaused: false,
        pausedAtMs: null,
        pausedTotalSeconds: Math.max(0, Math.round(row.awayMinutes)) * 60,
        grossMinutes: calc.grossMinutes,
        breakMinutes: calc.breakDeductedMinutes,
        netMinutes: calc.netMinutes,
        netDecimalHours: calc.netDecimalHours,
        overtimeMinutes: calc.overtimeMinutes,
        overtimeDecimalHours: calc.overtimeDecimalHours,
        isSunday: calc.isSunday,
        status: calc.status,
        syncedToSheet: false,
        updatedAt: new Date().toISOString(),
      });
    }

    if (builtRecords.length === 0) return;

    setIsSavingMonth(true);
    try {
      await onSaveEmployeeMonthRecords(
        selectedEmployee,
        builtRecords,
        isGoogleAuthed && syncBuilderToSheet
      );
      setMonthFilter(builderMonth);
      setShowMonthBuilder(false);
    } finally {
      setIsSavingMonth(false);
    }
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmployee || !importSheetInput.trim()) return;
    setIsImportingSheet(true);
    try {
      await onImportEmployeeSheet(selectedEmployee, importSheetInput.trim());
      setShowImportPanel(false);
      setImportSheetInput('');
    } finally {
      setIsImportingSheet(false);
    }
  };

  const handleExportEmployeeCSV = () => {
    if (!selectedEmployee) return;
    downloadCSV(
      `${selectedEmployee.empCode}-${selectedEmployee.name.replace(/\s+/g, '-')}.csv`,
      ['Date', 'Day', 'In Time', 'Out Time', 'Away (mins)', 'Working Hours', 'Overtime Hours'],
      empRecords.map((r) => {
        const isSun = r.isSunday ?? isSundayISO(r.date);
        const otDec =
          typeof r.overtimeDecimalHours === 'number'
            ? r.overtimeDecimalHours
            : r.netMinutes !== null
            ? Number(((isSun ? r.netMinutes : Math.max(0, r.netMinutes - 480)) / 60).toFixed(2))
            : '';
        return [
          r.date,
          getDayNameShort(r.date),
          formatDisplayTime(r.inTime),
          r.outTime ? formatDisplayTime(r.outTime) : '',
          Math.round((r.pausedTotalSeconds ?? 0) / 60),
          r.netDecimalHours !== null ? r.netDecimalHours : '',
          otDec,
        ];
      })
    );
  };

  if (employees.length === 0 || !selectedEmployee) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-6 py-14 text-center">
        <p className="text-base font-semibold text-slate-900">No employees available</p>
        <p className="mt-1 text-sm text-slate-500">
          Add employees in the Employees tab to view individual attendance sheets.
        </p>
      </div>
    );
  }

  const tabName = getEmployeeSheetTabName(selectedEmployee.empCode, selectedEmployee.name);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
      <aside className="lg:col-span-4 xl:col-span-3 rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-900">Select Employee Sheet</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {employees.length} employee{employees.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="divide-y divide-slate-100 max-h-[540px] overflow-y-auto">
          {employees.map((emp) => {
            const isSelected = emp.id === selectedEmployee.id;
            const count = records.filter(
              (r) => r.empId === emp.id || r.empCode === emp.empCode
            ).length;

            return (
              <button
                key={emp.id}
                type="button"
                onClick={() => setSelectedEmpId(emp.id)}
                className={`w-full px-5 py-3.5 text-left transition-colors flex items-center justify-between gap-3 ${
                  isSelected
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-900 hover:bg-slate-50'
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{emp.name}</div>
                  <div
                    className={`truncate text-xs ${
                      isSelected ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    {emp.empCode} · {emp.department}
                  </div>
                </div>
                <span
                  className={`font-mono text-xs tabular-nums shrink-0 ${
                    isSelected ? 'text-teal-300' : 'text-slate-400'
                  }`}
                >
                  {count}d
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="lg:col-span-8 xl:col-span-9 space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <UserCheck className="h-3.5 w-3.5 text-teal-700" />
                <span>{selectedEmployee.empCode}</span>
                <span aria-hidden="true">·</span>
                <span>{selectedEmployee.department}</span>
              </div>
              <h2 className="mt-1 text-xl font-bold text-slate-900">
                {selectedEmployee.name}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                8h standard shift (+30m break) · &gt;8h &amp; Sunday 100% counted as Overtime
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <select
                value={monthFilter}
                onChange={(e) => setMonthFilter(e.target.value)}
                aria-label="Filter by month"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-800 focus:border-teal-700 focus:outline-none"
              >
                <option value="all">All Months</option>
                {monthOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={handleExportEmployeeCSV}
                disabled={empRecords.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Export CSV</span>
              </button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <div className="text-xs text-slate-600">
              {sheetConfig
                ? `Master Sheet tab: ${tabName}`
                : 'Connect a Master Google Sheet in Google Sheets Sync to sync tabs.'}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowMonthBuilder(true);
                  setShowImportPanel(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-teal-700 bg-teal-50 px-3.5 py-2 text-xs font-medium text-teal-900 hover:bg-teal-100 whitespace-nowrap shrink-0"
              >
                <CalendarPlus className="h-3.5 w-3.5" />
                <span>Build Month History</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowImportPanel((v) => !v);
                  if (!importSheetInput && selectedEmployee.individualSheetUrl) {
                    setImportSheetInput(selectedEmployee.individualSheetUrl);
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <FolderInput className="h-3.5 w-3.5" />
                <span>Import Google Sheet</span>
              </button>

              {sheetConfig && (
                <button
                  type="button"
                  onClick={() => onRequestSyncEmployeeTab(selectedEmployee)}
                  disabled={!isGoogleAuthed}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Sync Master Tab</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => onRequestStandaloneSheet(selectedEmployee)}
                disabled={!isGoogleAuthed}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-300 whitespace-nowrap shrink-0"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                <span>
                  {selectedEmployee.individualSheetId
                    ? 'Update Individual Sheet'
                    : 'Create Individual Google Sheet'}
                </span>
              </button>

              {selectedEmployee.individualSheetUrl && (
                <a
                  href={selectedEmployee.individualSheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-teal-700 bg-white px-3.5 py-2 text-xs font-medium text-teal-800 hover:bg-teal-50 whitespace-nowrap shrink-0"
                >
                  <span>Open Sheet</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          </div>

          {showImportPanel && (
            <form
              onSubmit={handleImportSubmit}
              className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold text-slate-900">
                    Import Existing Google Sheet for {selectedEmployee.name}
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-600">
                    Paste a Google Sheet URL or ID containing Date, In Time, and Out Time columns.
                    GateLog will extract entries, deduct 30m break, calculate overtime (&gt;8h &amp;
                    Sundays 100%), and save to history.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowImportPanel(false)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                  aria-label="Close import panel"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={importSheetInput}
                  onChange={(e) => setImportSheetInput(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  required
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!isGoogleAuthed || isImportingSheet || !importSheetInput.trim()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-300 whitespace-nowrap shrink-0"
                >
                  <FolderInput className="h-3.5 w-3.5" />
                  <span>{isImportingSheet ? 'Importing...' : 'Extract & Import Sheet'}</span>
                </button>
              </div>
              {!isGoogleAuthed && (
                <p className="text-xs text-amber-800">
                  Connect Google Sheets in the Google Sheets Sync tab first to read external
                  spreadsheets.
                </p>
              )}
            </form>
          )}
        </section>

        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
            <div className="text-xs font-medium text-slate-500">Present Days</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {summary.daysWorked}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
            <div className="text-xs font-medium text-slate-500">Total Working Hours</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold text-teal-800 tabular-nums">
              {summary.netDecimal.toFixed(2)}h
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
            <div className="text-xs font-medium text-slate-500">Total Overtime Hours</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold text-amber-700 tabular-nums">
              {summary.overtimeDecimal.toFixed(2)}h
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
            <div className="text-xs font-medium text-slate-500">Avg / Shift</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {formatDurationHM(summary.avgNet)}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Individual Attendance Sheet
            </h3>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              {empRecords.length} {empRecords.length === 1 ? 'entry' : 'entries'}
            </span>
          </div>

          {empRecords.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-slate-500">
              No attendance entries recorded for {selectedEmployee.name} yet. Use{' '}
              <span className="font-medium text-slate-700">Build Month History</span> or{' '}
              <span className="font-medium text-slate-700">Import Google Sheet</span> to add past
              months.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                    <th className="px-6 py-3 whitespace-nowrap">Date</th>
                    <th className="px-4 py-3 whitespace-nowrap">Day</th>
                    <th className="px-4 py-3 whitespace-nowrap">In Time</th>
                    <th className="px-4 py-3 whitespace-nowrap">Out Time</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Away</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Working (-30m)</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Overtime</th>
                    <th className="px-6 py-3 text-right whitespace-nowrap">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {empRecords.map((r) => {
                    const dayShort = getDayNameShort(r.date);
                    const isSun = r.isSunday ?? isSundayISO(r.date);
                    const awayMins = Math.round((r.pausedTotalSeconds ?? 0) / 60);
                    const otMins =
                      typeof r.overtimeMinutes === 'number'
                        ? r.overtimeMinutes
                        : r.netMinutes !== null
                        ? isSun
                          ? r.netMinutes
                          : Math.max(0, r.netMinutes - 480)
                        : null;
                    const otDec =
                      typeof r.overtimeDecimalHours === 'number'
                        ? r.overtimeDecimalHours
                        : otMins !== null
                        ? Number((otMins / 60).toFixed(2))
                        : null;

                    return (
                      <tr key={r.id} className="hover:bg-slate-50/80">
                        <td className="px-6 py-3 font-mono text-xs text-slate-800 tabular-nums whitespace-nowrap">
                          {r.date}
                        </td>
                        <td className="px-4 py-3 text-xs whitespace-nowrap">
                          <span
                            className={
                              isSun
                                ? 'font-semibold text-amber-700'
                                : 'text-slate-600'
                            }
                          >
                            {dayShort}
                            {isSun ? ' · OT' : ''}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-900 tabular-nums whitespace-nowrap">
                          {formatDisplayTime(r.inTime)}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-900 tabular-nums whitespace-nowrap">
                          {r.outTime ? formatDisplayTime(r.outTime) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                          {awayMins > 0 ? `${awayMins}m` : '0m'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                          {r.netMinutes !== null
                            ? `${formatDurationHM(r.netMinutes)} · ${r.netDecimalHours?.toFixed(2)}h`
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs font-semibold tabular-nums whitespace-nowrap">
                          {otMins !== null && otMins > 0 ? (
                            <span className="text-amber-700">
                              +{formatDurationHM(otMins)} · {otDec?.toFixed(2)}h
                            </span>
                          ) : (
                            <span className="text-slate-400">0.00h</span>
                          )}
                        </td>
                        <td className="px-6 py-3 text-right whitespace-nowrap">
                          <StatusLabel status={r.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-mono text-xs font-semibold text-slate-900">
                    <td className="px-6 py-3 whitespace-nowrap">TOTAL</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                      {summary.daysWorked} Days
                    </td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-slate-600">
                      {summary.totalAwayMins}m
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-teal-800">
                      {formatDurationHM(summary.net)} · {summary.netDecimal.toFixed(2)}h
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap text-amber-700">
                      {formatDurationHM(summary.overtimeMinutes)} ·{' '}
                      {summary.overtimeDecimal.toFixed(2)}h
                    </td>
                    <td className="px-6 py-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Previous Month Bulk Builder Modal */}
      {showMonthBuilder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="month-builder-title"
        >
          <div className="flex max-h-[92vh] w-full max-w-4xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 id="month-builder-title" className="text-base font-semibold text-slate-900">
                  Build Monthly Attendance — {selectedEmployee.name} ({selectedEmployee.empCode})
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Select a month, review daily check-in/out timings, and save directly to employee
                  history. Sunday working hours count 100% toward Overtime.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowMonthBuilder(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close builder"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-6 items-end">
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Month
                  </label>
                  <input
                    type="month"
                    value={builderMonth}
                    onChange={(e) => setBuilderMonth(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Default In
                  </label>
                  <input
                    type="time"
                    value={defaultInTime}
                    onChange={(e) => setDefaultInTime(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Default Out
                  </label>
                  <input
                    type="time"
                    value={defaultOutTime}
                    onChange={(e) => setDefaultOutTime(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Away (mins)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={600}
                    value={defaultAwayMins}
                    onChange={(e) =>
                      setDefaultAwayMins(Math.max(0, Math.round(Number(e.target.value) || 0)))
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-2 pb-1.5">
                  <input
                    id="include-sundays-checkbox"
                    type="checkbox"
                    checked={includeSundays}
                    onChange={(e) => setIncludeSundays(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                  />
                  <label
                    htmlFor="include-sundays-checkbox"
                    className="text-xs font-medium text-slate-700 select-none"
                  >
                    Include Sundays
                  </label>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={handleApplyDefaultsToMonth}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-100 whitespace-nowrap"
                  >
                    Apply Defaults
                  </button>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-3">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-white border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Date</th>
                    <th className="py-2 px-2 font-medium">Day</th>
                    <th className="py-2 px-2 font-medium text-center">Present</th>
                    <th className="py-2 px-2 font-medium">In Time</th>
                    <th className="py-2 px-2 font-medium">Out Time</th>
                    <th className="py-2 px-2 font-medium">Away (m)</th>
                    <th className="py-2 px-2 font-medium text-right">Working</th>
                    <th className="py-2 pl-2 font-medium text-right">Overtime</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {builderRows.map((row, idx) => {
                    const calc =
                      row.present && row.inTime && row.outTime
                        ? calculateShiftMetrics(
                            row.inTime,
                            row.outTime,
                            selectedEmployee.breakMinutes || 30,
                            row.date,
                            row.awayMinutes
                          )
                        : null;

                    return (
                      <tr
                        key={row.date}
                        className={row.isSunday ? 'bg-amber-50/40' : undefined}
                      >
                        <td className="py-2 pr-3 font-mono text-slate-800 tabular-nums whitespace-nowrap">
                          {row.date}
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap">
                          <span
                            className={
                              row.isSunday
                                ? 'font-semibold text-amber-700'
                                : 'text-slate-600'
                            }
                          >
                            {row.dayShort}
                            {row.isSunday ? ' (100% OT)' : ''}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-center">
                          <input
                            type="checkbox"
                            checked={row.present}
                            aria-label={`Present on ${row.date}`}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setBuilderRows((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, present: checked } : r))
                              );
                            }}
                            className="h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                          />
                        </td>
                        <td className="py-2 px-2">
                          <input
                            type="time"
                            value={row.inTime}
                            disabled={!row.present}
                            onChange={(e) => {
                              const val = e.target.value;
                              setBuilderRows((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, inTime: val } : r))
                              );
                            }}
                            className="rounded border border-slate-200 bg-white px-2 py-1 font-mono text-xs text-slate-900 disabled:bg-slate-100 disabled:text-slate-400"
                          />
                        </td>
                        <td className="py-2 px-2">
                          <input
                            type="time"
                            value={row.outTime}
                            disabled={!row.present}
                            onChange={(e) => {
                              const val = e.target.value;
                              setBuilderRows((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, outTime: val } : r))
                              );
                            }}
                            className="rounded border border-slate-200 bg-white px-2 py-1 font-mono text-xs text-slate-900 disabled:bg-slate-100 disabled:text-slate-400"
                          />
                        </td>
                        <td className="py-2 px-2">
                          <input
                            type="number"
                            min={0}
                            max={600}
                            value={row.awayMinutes}
                            disabled={!row.present}
                            onChange={(e) => {
                              const val = Math.max(0, Math.round(Number(e.target.value) || 0));
                              setBuilderRows((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, awayMinutes: val } : r))
                              );
                            }}
                            className="w-16 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-xs text-slate-900 disabled:bg-slate-100 disabled:text-slate-400"
                          />
                        </td>
                        <td className="py-2 px-2 text-right font-mono font-medium text-slate-900 tabular-nums whitespace-nowrap">
                          {calc ? `${calc.netDecimalHours.toFixed(2)}h` : 'Off'}
                        </td>
                        <td className="py-2 pl-2 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                          {calc && calc.overtimeMinutes > 0 ? (
                            <span className="text-amber-700">
                              +{calc.overtimeDecimalHours.toFixed(2)}h
                            </span>
                          ) : (
                            <span className="text-slate-400">0.00h</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="border-t border-slate-200 bg-slate-50 px-6 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <div>
                  <span className="text-slate-500">Present Days: </span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {builderTotals.presentDays}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Working: </span>
                  <span className="font-mono font-semibold text-teal-800 tabular-nums">
                    {(builderTotals.netMinutes / 60).toFixed(2)}h
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Overtime: </span>
                  <span className="font-mono font-semibold text-amber-700 tabular-nums">
                    {(builderTotals.overtimeMinutes / 60).toFixed(2)}h
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={isGoogleAuthed && syncBuilderToSheet}
                    disabled={!isGoogleAuthed}
                    onChange={(e) => setSyncBuilderToSheet(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                  />
                  <span>
                    {isGoogleAuthed
                      ? 'Also update Google Sheet'
                      : 'Connect Google Sheets to sync'}
                  </span>
                </label>

                <button
                  type="button"
                  onClick={() => setShowMonthBuilder(false)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveBuilderMonth}
                  disabled={isSavingMonth || builderTotals.presentDays === 0}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-300 whitespace-nowrap"
                >
                  {isSavingMonth
                    ? 'Saving...'
                    : `Save ${builderTotals.presentDays} Day(s) to History`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
