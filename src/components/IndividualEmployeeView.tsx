import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarPlus,
  Check,
  Download,
  Edit3,
  ExternalLink,
  FileSpreadsheet,
  FolderInput,
  History,
  RefreshCw,
  UserCheck,
  X,
} from 'lucide-react';
import { AttendanceRecord, Employee, SheetConfig } from '../types/attendance';
import {
  calculateShiftMetrics,
  downloadCSV,
  formatDisplayTime,
  formatMonthLabel,
  getCurrentYearMonth,
  getDayNameShort,
  getEmployeeSheetTabName,
  getMonthDays,
  getRecordPayroll,
} from '../utils/time';
import { StatusLabel } from './StatusLabel';

interface IndividualEmployeeViewProps {
  employees: Employee[];
  records: AttendanceRecord[];
  sheetConfig: SheetConfig | null;
  isGoogleAuthed: boolean;
  isSyncing?: boolean;
  onRequestSyncEmployeeTab: (employee: Employee) => void;
  onRequestStandaloneSheet: (employee: Employee, monthFilter?: string) => void;
  onImportEmployeeSheet: (employee: Employee, sheetUrlOrId: string) => Promise<void>;
  onSaveEmployeeMonthRecords: (
    employee: Employee,
    monthRecords: AttendanceRecord[],
    syncToStandaloneSheet: boolean,
    monthFilter?: string
  ) => Promise<void>;
  onUpdateSingleRecord: (updated: AttendanceRecord) => Promise<void>;
  onSaveMonthlyThikada: (
    employee: Employee,
    yearMonth: string,
    thikadaMinutes: number
  ) => Promise<{ sheetUpdated: boolean }>;
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
  isSyncing = false,
  onRequestSyncEmployeeTab,
  onRequestStandaloneSheet,
  onImportEmployeeSheet,
  onSaveEmployeeMonthRecords,
  onUpdateSingleRecord,
  onSaveMonthlyThikada,
}) => {
  const currentYearMonth = getCurrentYearMonth();
  const [selectedEmpId, setSelectedEmpId] = useState<string>(employees[0]?.id ?? '');
  const [overviewMonth, setOverviewMonth] = useState<string>(() => getCurrentYearMonth());

  // Import existing Google Sheet UI state
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [importSheetInput, setImportSheetInput] = useState('');
  const [isImportingSheet, setIsImportingSheet] = useState(false);

  // History Attendance Modal state
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [historyMonth, setHistoryMonth] = useState<string>(() => getCurrentYearMonth());
  const [monthlyThekaHoursInput, setMonthlyThekaHoursInput] = useState<string>('0');
  const [savingMonthlyTheka, setSavingMonthlyTheka] = useState(false);
  const [thekaFeedback, setThekaFeedback] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<AttendanceRecord | null>(null);
  const [savingRowEdit, setSavingRowEdit] = useState(false);

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

  const allEmployeeRecords = useMemo(() => {
    if (!selectedEmployee) return [];
    return records
      .filter((r) => r.empId === selectedEmployee.id || r.empCode === selectedEmployee.empCode)
      .sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return b.inTime.localeCompare(a.inTime);
      });
  }, [records, selectedEmployee]);

  // Group saved records by YYYY-MM for clean Overview rows
  const savedMonthSummaries = useMemo(() => {
    if (!selectedEmployee) return [];
    const byMonth = new Map<string, AttendanceRecord[]>();
    for (const r of allEmployeeRecords) {
      const ym = r.date.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      const list = byMonth.get(ym) ?? [];
      list.push(r);
      byMonth.set(ym, list);
    }

    const months = Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a));
    return months.map((ym) => {
      const list = byMonth.get(ym) ?? [];
      let netMinutes = 0;
      let presentCount = 0;
      let overtimeMinutes = 0;
      let grossNormalMinutes = 0;

      for (const r of list) {
        if (r.outTime && r.netMinutes !== null) {
          netMinutes += r.netMinutes;
          const p = getRecordPayroll(r);
          presentCount += p.presentCount;
          overtimeMinutes += p.overtimeMinutes;
          grossNormalMinutes += p.grossNormalMinutes;
        }
      }

      const monthThekaMinutes = selectedEmployee.monthlyThikadaMinutes?.[ym] ?? 0;
      const netNormalMinutes = Math.max(0, grossNormalMinutes - monthThekaMinutes);

      return {
        yearMonth: ym,
        label: formatMonthLabel(ym),
        entries: list.length,
        presentCount,
        netMinutes,
        netDecimal: Number((netMinutes / 60).toFixed(2)),
        overtimeDecimal: Number((overtimeMinutes / 60).toFixed(2)),
        thekaDecimal: Number((monthThekaMinutes / 60).toFixed(2)),
        netNormalMinutes,
        netNormalDecimal: Number((netNormalMinutes / 60).toFixed(2)),
      };
    });
  }, [allEmployeeRecords, selectedEmployee]);

  const overallSummary = useMemo(() => {
    if (!overviewMonth) {
      let presentCount = 0;
      let netMinutes = 0;
      let totalThekaMinutes = 0;
      let netNormalMinutes = 0;

      for (const m of savedMonthSummaries) {
        presentCount += m.presentCount;
        netMinutes += m.netMinutes;
        totalThekaMinutes += Math.round(m.thekaDecimal * 60);
        netNormalMinutes += m.netNormalMinutes;
      }

      return {
        presentCount,
        netDecimal: Number((netMinutes / 60).toFixed(2)),
        thekaDecimal: Number((totalThekaMinutes / 60).toFixed(2)),
        netNormalDecimal: Number((netNormalMinutes / 60).toFixed(2)),
        monthsCount: savedMonthSummaries.length,
      };
    }

    const matched = savedMonthSummaries.find((m) => m.yearMonth === overviewMonth);
    if (matched) {
      return {
        presentCount: matched.presentCount,
        netDecimal: matched.netDecimal,
        thekaDecimal: matched.thekaDecimal,
        netNormalDecimal: matched.netNormalDecimal,
        monthsCount: 1,
      };
    }

    const monthThekaMinutes = selectedEmployee?.monthlyThikadaMinutes?.[overviewMonth] ?? 0;
    return {
      presentCount: 0,
      netDecimal: 0,
      thekaDecimal: Number((monthThekaMinutes / 60).toFixed(2)),
      netNormalDecimal: 0,
      monthsCount: 0,
    };
  }, [savedMonthSummaries, overviewMonth, selectedEmployee]);

  // History Attendance modal records for selected historyMonth
  const historyMonthRecords = useMemo(() => {
    if (!selectedEmployee || !historyMonth) return [];
    return allEmployeeRecords
      .filter((r) => r.date.startsWith(historyMonth))
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.inTime.localeCompare(b.inTime);
      });
  }, [allEmployeeRecords, selectedEmployee, historyMonth]);

  const historyTotals = useMemo(() => {
    let totalAwayMins = 0;
    let netMinutes = 0;
    let presentCount = 0;
    let overtimeMinutes = 0;
    let grossNormalMinutes = 0;

    for (const r of historyMonthRecords) {
      totalAwayMins += Math.round((r.pausedTotalSeconds ?? 0) / 60);
      if (r.outTime && r.netMinutes !== null) {
        netMinutes += r.netMinutes;
        const p = getRecordPayroll(r);
        presentCount += p.presentCount;
        overtimeMinutes += p.overtimeMinutes;
        grossNormalMinutes += p.grossNormalMinutes;
      }
    }

    const monthlyThekaMinutes = selectedEmployee?.monthlyThikadaMinutes?.[historyMonth] ?? 0;
    const finalNetNormalMinutes = Math.max(0, grossNormalMinutes - monthlyThekaMinutes);

    return {
      entries: historyMonthRecords.length,
      totalAwayMins,
      netMinutes,
      netDecimal: Number((netMinutes / 60).toFixed(2)),
      presentCount,
      overtimeMinutes,
      overtimeDecimal: Number((overtimeMinutes / 60).toFixed(2)),
      monthlyThekaMinutes,
      monthlyThekaDecimal: Number((monthlyThekaMinutes / 60).toFixed(2)),
      grossNormalDecimal: Number((grossNormalMinutes / 60).toFixed(2)),
      finalNetNormalMinutes,
      finalNetNormalDecimal: Number((finalNetNormalMinutes / 60).toFixed(2)),
    };
  }, [historyMonthRecords, selectedEmployee, historyMonth]);

  // Sync monthly Theka input whenever history modal month/employee changes
  useEffect(() => {
    if (!selectedEmployee) return;
    const mins = selectedEmployee.monthlyThikadaMinutes?.[historyMonth] ?? 0;
    setMonthlyThekaHoursInput(String(Number((mins / 60).toFixed(2))));
    setThekaFeedback(null);
    setEditingRow(null);
  }, [selectedEmployee?.id, historyMonth, showHistoryModal]);

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

  const handleOpenHistoryModal = (targetMonth?: string) => {
    const fallbackMonth =
      targetMonth || overviewMonth || savedMonthSummaries[0]?.yearMonth || currentYearMonth;
    setHistoryMonth(fallbackMonth);
    setShowHistoryModal(true);
    setShowImportPanel(false);
  };

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
      return {
        selectedDays: 0,
        presentCount: 0,
        netMinutes: 0,
        normalMinutes: 0,
      };
    }
    const breakMins = selectedEmployee.breakMinutes || 30;
    let selectedDays = 0;
    let presentCount = 0;
    let netMinutes = 0;
    let normalMinutes = 0;

    for (const row of builderRows) {
      if (!row.present || !row.inTime || !row.outTime) continue;
      const calc = calculateShiftMetrics(
        row.inTime,
        row.outTime,
        breakMins,
        row.date,
        row.awayMinutes
      );
      selectedDays += 1;
      presentCount += calc.presentCount;
      netMinutes += calc.netMinutes;
      normalMinutes += calc.normalMinutes;
    }
    return { selectedDays, presentCount, netMinutes, normalMinutes };
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
        presentCount: calc.presentCount,
        thikadaMinutes: 0,
        normalMinutes: calc.normalMinutes,
        normalDecimalHours: calc.normalDecimalHours,
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
        syncBuilderToSheet,
        builderMonth
      );
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

  const handleSaveRowEdit = async () => {
    if (!editingRow) return;
    setSavingRowEdit(true);
    try {
      await onUpdateSingleRecord({
        ...editingRow,
        breakMinutes: selectedEmployee?.breakMinutes || 30,
        thikadaMinutes: 0,
      });
      setEditingRow(null);
    } finally {
      setSavingRowEdit(false);
    }
  };

  const handleSaveMonthlyThekaClick = async () => {
    if (!selectedEmployee || !historyMonth) return;
    const hrs = Math.max(0, Number(monthlyThekaHoursInput) || 0);
    const mins = Math.round(hrs * 60);
    setSavingMonthlyTheka(true);
    setThekaFeedback(null);
    try {
      const res = await onSaveMonthlyThikada(selectedEmployee, historyMonth, mins);
      const nextNetH = Math.max(0, historyTotals.grossNormalDecimal - mins / 60);
      setThekaFeedback(
        res.sheetUpdated
          ? `Applied ${(mins / 60).toFixed(2)}h Theka · Net Normal Working (H): ${nextNetH.toFixed(2)}h · Google Sheet updated.`
          : `Applied ${(mins / 60).toFixed(2)}h Theka · Net Normal Working (H): ${nextNetH.toFixed(2)}h · Click Update Google Sheet below to sync.`
      );
    } finally {
      setSavingMonthlyTheka(false);
    }
  };

  const handleExportMonthCSV = (month: string, rows: AttendanceRecord[]) => {
    if (!selectedEmployee) return;
    const csvRows: (string | number)[][] = rows.map((r) => {
      const p = getRecordPayroll(r);
      const hasOut = Boolean(r.outTime && r.netMinutes !== null);
      return [
        r.date,
        getDayNameShort(r.date),
        formatDisplayTime(r.inTime),
        r.outTime ? formatDisplayTime(r.outTime) : '',
        Math.round((r.pausedTotalSeconds ?? 0) / 60),
        r.netDecimalHours !== null ? r.netDecimalHours : '',
        hasOut ? p.presentCount : '',
        hasOut ? p.overtimeDecimalHours : '',
        hasOut ? Number((p.grossNormalMinutes / 60).toFixed(2)) : '',
      ];
    });

    csvRows.push([
      'TOTAL (Before Theka)',
      `${historyTotals.entries} Days`,
      '',
      '',
      historyTotals.totalAwayMins,
      historyTotals.netDecimal,
      historyTotals.presentCount,
      historyTotals.overtimeDecimal,
      historyTotals.grossNormalDecimal,
    ]);
    csvRows.push([
      'Less: Theka Work (H)',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      -historyTotals.monthlyThekaDecimal,
    ]);
    csvRows.push([
      'NET PAYABLE',
      '',
      '',
      '',
      '',
      historyTotals.netDecimal,
      historyTotals.presentCount,
      historyTotals.overtimeDecimal,
      historyTotals.finalNetNormalDecimal,
    ]);

    downloadCSV(
      `${selectedEmployee.empCode}-${selectedEmployee.name.replace(/\s+/g, '-')}-${month}.csv`,
      [
        'Date',
        'Day',
        'In Time',
        'Out Time',
        'Away (mins)',
        'Working Hours',
        'Present (P)',
        'Overtime (hrs)',
        'Normal Hours (H)',
      ],
      csvRows
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
            {employees.length} employee{employees.length === 1 ? '' : 's'} ·{' '}
            {overviewMonth ? formatMonthLabel(overviewMonth) : 'All Months'}
          </p>
        </div>
        <div className="divide-y divide-slate-100 max-h-[540px] overflow-y-auto">
          {employees.map((emp) => {
            const isSelected = emp.id === selectedEmployee.id;
            const count = records.filter(
              (r) =>
                (r.empId === emp.id || r.empCode === emp.empCode) &&
                (!overviewMonth || r.date.startsWith(overviewMonth))
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
                8h+ Mon–Sat = 1 Present (P) · &lt;8h, Overtime (&gt;8h) &amp; Sunday = Normal Hours
                (H) · Month-end Theka deducted from H
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleOpenHistoryModal()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800 whitespace-nowrap shrink-0"
              >
                <History className="h-3.5 w-3.5" />
                <span>History Attendance</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowMonthBuilder(true);
                  setShowImportPanel(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <CalendarPlus className="h-3.5 w-3.5" />
                <span>Build Month History</span>
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
                  disabled={isSyncing}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Sync Master Tab</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => onRequestStandaloneSheet(selectedEmployee)}
                disabled={isSyncing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-400 whitespace-nowrap shrink-0"
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
                    GateLog extracts Present (P) for 8h+ shifts, routes &lt;8h &amp; overtime/Sunday
                    hours into Normal Hours (H), and saves to history.
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
                  disabled={isImportingSheet || !importSheetInput.trim()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-300 whitespace-nowrap shrink-0"
                >
                  <FolderInput className="h-3.5 w-3.5" />
                  <span>{isImportingSheet ? 'Importing...' : 'Extract & Import Sheet'}</span>
                </button>
              </div>
              {!isGoogleAuthed && (
                <p className="text-xs text-slate-500">
                  Clicking Extract &amp; Import Sheet will prompt for Google Drive read access if not yet connected in this session.
                </p>
              )}
            </form>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3">
            <div className="text-xs font-semibold text-slate-800">
              {overviewMonth
                ? `${formatMonthLabel(overviewMonth)} Summary`
                : 'All Saved Months Summary'}
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <label
                htmlFor="employee-overview-month"
                className="text-xs font-medium text-slate-500"
              >
                Month:
              </label>
              <input
                id="employee-overview-month"
                type="month"
                value={overviewMonth}
                onChange={(e) => setOverviewMonth(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none tabular-nums"
              />
              {overviewMonth !== currentYearMonth && (
                <button
                  type="button"
                  onClick={() => setOverviewMonth(currentYearMonth)}
                  className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
                >
                  This Month
                </button>
              )}
              {overviewMonth !== '' && (
                <button
                  type="button"
                  onClick={() => setOverviewMonth('')}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline whitespace-nowrap"
                >
                  All Months
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
              <div className="text-xs font-medium text-slate-500">Present (P)</div>
              <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
                {overallSummary.presentCount}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
              <div className="text-xs font-medium text-slate-500">Net Normal Hours (H)</div>
              <div className="mt-1.5 font-mono text-2xl font-semibold text-amber-700 tabular-nums">
                {overallSummary.netNormalDecimal.toFixed(2)}h
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
              <div className="text-xs font-medium text-slate-500">Theka Deducted</div>
              <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-700 tabular-nums">
                {overallSummary.thekaDecimal.toFixed(2)}h
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
              <div className="text-xs font-medium text-slate-500">Total Working Hours</div>
              <div className="mt-1.5 font-mono text-2xl font-semibold text-teal-800 tabular-nums">
                {overallSummary.netDecimal.toFixed(2)}h
              </div>
            </div>
          </div>
        </section>

        {/* Clean Monthly Overview (Daily records open via History Attendance button) */}
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Saved Monthly Summaries</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Click <span className="font-medium text-slate-700">History Attendance</span> to
                inspect any month&apos;s day-by-day sheet, deduct month-end Theka working hours, or
                export to Google Sheets.
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleOpenHistoryModal()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-teal-700 bg-teal-50 px-3.5 py-2 text-xs font-medium text-teal-900 hover:bg-teal-100 whitespace-nowrap"
            >
              <History className="h-3.5 w-3.5" />
              <span>Open History Attendance</span>
            </button>
          </div>

          {savedMonthSummaries.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-slate-500">
              No attendance history saved for {selectedEmployee.name} yet. Click{' '}
              <span className="font-medium text-slate-700">Build Month History</span> or{' '}
              <span className="font-medium text-slate-700">Import Google Sheet</span> to add
              monthly records.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                    <th className="px-6 py-3 whitespace-nowrap">Month</th>
                    <th className="px-4 py-3 text-center whitespace-nowrap">Present (P)</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Working Hours</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Overtime</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Theka Deducted</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Net Normal (H)</th>
                    <th className="px-6 py-3 text-right whitespace-nowrap">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {savedMonthSummaries.map((m) => (
                    <tr key={m.yearMonth} className="hover:bg-slate-50/80">
                      <td className="px-6 py-3.5 font-medium text-slate-900 whitespace-nowrap">
                        <div>{m.label}</div>
                        <div className="text-[11px] font-mono text-slate-400">
                          {m.yearMonth} · {m.entries} entries
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-center font-mono text-xs font-semibold text-teal-800 tabular-nums whitespace-nowrap">
                        {m.presentCount} P
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs text-slate-800 tabular-nums whitespace-nowrap">
                        {m.netDecimal.toFixed(2)}h
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                        {m.overtimeDecimal.toFixed(2)}h
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                        {m.thekaDecimal > 0 ? `-${m.thekaDecimal.toFixed(2)}h` : '0.00h'}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs font-semibold text-amber-700 tabular-nums whitespace-nowrap">
                        {m.netNormalDecimal.toFixed(2)}h
                      </td>
                      <td className="px-6 py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleOpenHistoryModal(m.yearMonth)}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-100"
                          >
                            <History className="h-3.5 w-3.5" />
                            <span>View History</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onRequestStandaloneSheet(selectedEmployee, m.yearMonth)
                            }
                            disabled={isSyncing}
                            className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-400"
                          >
                            <FileSpreadsheet className="h-3.5 w-3.5" />
                            <span>{selectedEmployee.individualSheetId ? 'Update Sheet' : 'Sheet'}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* History Attendance Modal */}
      {showHistoryModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="history-attendance-title"
        >
          <div className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
              <div>
                <h3
                  id="history-attendance-title"
                  className="text-base font-semibold text-slate-900"
                >
                  History Attendance — {selectedEmployee.name} ({selectedEmployee.empCode})
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Select a month to view records, deduct month-end Theka working hours, or create
                  this month&apos;s Google Sheet.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowHistoryModal(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close history modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Month Selection Bar */}
            <div className="border-b border-slate-200 bg-slate-50 px-6 py-3.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <label
                  htmlFor="history-month-picker"
                  className="text-xs font-medium text-slate-700"
                >
                  Select Month:
                </label>
                <input
                  id="history-month-picker"
                  type="month"
                  value={historyMonth}
                  onChange={(e) => setHistoryMonth(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
                />
                {savedMonthSummaries.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {savedMonthSummaries.map((m) => (
                      <button
                        key={m.yearMonth}
                        type="button"
                        onClick={() => setHistoryMonth(m.yearMonth)}
                        className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-medium transition-colors ${
                          historyMonth === m.yearMonth
                            ? 'bg-slate-900 text-white'
                            : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {m.yearMonth}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="text-xs font-medium text-slate-600">
                {formatMonthLabel(historyMonth)}
              </div>
            </div>

            {historyMonthRecords.length === 0 ? (
              <div className="flex-1 px-6 py-16 text-center">
                <p className="text-base font-semibold text-slate-900">
                  No attendance data found for {formatMonthLabel(historyMonth)}
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  Select another month above or build {formatMonthLabel(historyMonth)} attendance for{' '}
                  {selectedEmployee.name}.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setBuilderMonth(historyMonth);
                    setShowHistoryModal(false);
                    setShowMonthBuilder(true);
                  }}
                  className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
                >
                  <CalendarPlus className="h-3.5 w-3.5" />
                  <span>Build {formatMonthLabel(historyMonth)} History</span>
                </button>
              </div>
            ) : (
              <>
                {/* Monthly Summary + Month-End Theka Deduction Control */}
                <div className="border-b border-slate-200 bg-white px-6 py-4 grid grid-cols-1 gap-4 md:grid-cols-12 items-center">
                  <div className="md:col-span-7 grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <div className="text-slate-500">Present (P)</div>
                      <div className="mt-0.5 font-mono text-base font-semibold text-slate-900 tabular-nums">
                        {historyTotals.presentCount}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <div className="text-slate-500">Hours Before Theka</div>
                      <div className="mt-0.5 font-mono text-base font-semibold text-slate-800 tabular-nums">
                        {historyTotals.grossNormalDecimal.toFixed(2)}h
                      </div>
                    </div>
                    <div className="rounded-lg border border-red-200 bg-red-50/50 px-3 py-2">
                      <div className="text-red-800">Theka Working Time</div>
                      <div className="mt-0.5 font-mono text-base font-semibold text-red-700 tabular-nums">
                        -{historyTotals.monthlyThekaDecimal.toFixed(2)}h
                      </div>
                    </div>
                    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                      <div className="text-amber-900 font-semibold">Normal Working (H)</div>
                      <div className="mt-0.5 font-mono text-base font-bold text-amber-800 tabular-nums">
                        {historyTotals.finalNetNormalDecimal.toFixed(2)}h
                      </div>
                    </div>
                  </div>

                  <div className="md:col-span-5 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="text-[11px] font-semibold text-slate-800">
                      Month-End Theka Working Hours (Deducted from Normal H)
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        max={744}
                        step={0.25}
                        value={monthlyThekaHoursInput}
                        onChange={(e) => {
                          setMonthlyThekaHoursInput(e.target.value);
                          setThekaFeedback(null);
                        }}
                        aria-label="Month-end Theka working hours deduction"
                        className="w-28 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-teal-700 focus:outline-none tabular-nums"
                      />
                      <span className="text-xs text-slate-500">hrs</span>
                      <button
                        type="button"
                        onClick={handleSaveMonthlyThekaClick}
                        disabled={savingMonthlyTheka || isSyncing}
                        className="ml-auto rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-400 whitespace-nowrap"
                      >
                        {savingMonthlyTheka ? 'Applying...' : 'Apply Theka'}
                      </button>
                    </div>
                    {thekaFeedback && (
                      <div className="mt-2 text-[11px] font-medium text-teal-800">
                        {thekaFeedback}
                      </div>
                    )}
                  </div>
                </div>

                {/* Day-by-Day Monthly Table (Clean, without daily Theka clutter) */}
                <div className="flex-1 overflow-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-500 z-10">
                      <tr>
                        <th className="px-4 py-2.5 font-medium whitespace-nowrap">Date</th>
                        <th className="px-3 py-2.5 font-medium whitespace-nowrap">Day</th>
                        <th className="px-3 py-2.5 font-medium whitespace-nowrap">In Time</th>
                        <th className="px-3 py-2.5 font-medium whitespace-nowrap">Out Time</th>
                        <th className="px-3 py-2.5 font-medium text-right whitespace-nowrap">
                          Away
                        </th>
                        <th className="px-3 py-2.5 font-medium text-right whitespace-nowrap">
                          Working
                        </th>
                        <th className="px-3 py-2.5 font-medium text-center whitespace-nowrap">P</th>
                        <th className="px-3 py-2.5 font-medium text-right whitespace-nowrap">OT</th>
                        <th className="px-3 py-2.5 font-medium text-right whitespace-nowrap">
                          Normal (H)
                        </th>
                        <th className="px-3 py-2.5 font-medium whitespace-nowrap">Status</th>
                        <th className="px-4 py-2.5 font-medium text-right whitespace-nowrap">
                          Edit
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {historyMonthRecords.map((r) => {
                        const isEditingThis = editingRow?.id === r.id;
                        const activeRow = isEditingThis && editingRow ? editingRow : r;
                        const dayShort = getDayNameShort(r.date);
                        const awayMins = Math.round((activeRow.pausedTotalSeconds ?? 0) / 60);

                        const previewCalc =
                          isEditingThis && editingRow && editingRow.outTime
                            ? calculateShiftMetrics(
                                editingRow.inTime,
                                editingRow.outTime,
                                selectedEmployee.breakMinutes || 30,
                                editingRow.date,
                                awayMins
                              )
                            : null;

                        const p = getRecordPayroll(r);
                        const hasOut = Boolean(
                          activeRow.outTime && (previewCalc || r.netMinutes !== null)
                        );
                        const displayNet = previewCalc
                          ? previewCalc.netDecimalHours
                          : r.netDecimalHours;
                        const displayP = previewCalc ? previewCalc.presentCount : p.presentCount;
                        const displayOT = previewCalc
                          ? previewCalc.overtimeDecimalHours
                          : p.overtimeDecimalHours;
                        const displayNormal = previewCalc
                          ? previewCalc.normalDecimalHours
                          : Number((p.grossNormalMinutes / 60).toFixed(2));

                        return (
                          <tr
                            key={r.id}
                            className={
                              isEditingThis
                                ? 'bg-teal-50/50'
                                : p.isSunday
                                ? 'bg-amber-50/35 hover:bg-amber-50/60'
                                : 'hover:bg-slate-50/80'
                            }
                          >
                            <td className="px-4 py-2.5 font-mono text-slate-800 tabular-nums whitespace-nowrap">
                              {r.date}
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <span
                                className={
                                  p.isSunday ? 'font-semibold text-amber-700' : 'text-slate-600'
                                }
                              >
                                {dayShort}
                                {p.isSunday ? ' · OT' : ''}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 font-mono tabular-nums whitespace-nowrap">
                              {isEditingThis && editingRow ? (
                                <input
                                  type="time"
                                  value={editingRow.inTime}
                                  onChange={(e) =>
                                    setEditingRow({ ...editingRow, inTime: e.target.value })
                                  }
                                  className="rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-xs"
                                />
                              ) : (
                                formatDisplayTime(r.inTime)
                              )}
                            </td>
                            <td className="px-3 py-2.5 font-mono tabular-nums whitespace-nowrap">
                              {isEditingThis && editingRow ? (
                                <input
                                  type="time"
                                  value={editingRow.outTime ?? ''}
                                  onChange={(e) =>
                                    setEditingRow({
                                      ...editingRow,
                                      outTime: e.target.value || null,
                                    })
                                  }
                                  className="rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-xs"
                                />
                              ) : r.outTime ? (
                                formatDisplayTime(r.outTime)
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                              {isEditingThis && editingRow ? (
                                <input
                                  type="number"
                                  min={0}
                                  max={600}
                                  value={awayMins}
                                  onChange={(e) =>
                                    setEditingRow({
                                      ...editingRow,
                                      pausedTotalSeconds:
                                        Math.max(0, Math.round(Number(e.target.value) || 0)) * 60,
                                    })
                                  }
                                  className="w-14 rounded border border-slate-300 bg-white px-1.5 py-1 text-right font-mono text-xs"
                                />
                              ) : (
                                `${awayMins}m`
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                              {displayNet !== null ? `${displayNet.toFixed(2)}h` : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-center font-mono font-semibold tabular-nums whitespace-nowrap">
                              {hasOut ? (
                                <span
                                  className={displayP === 1 ? 'text-teal-800' : 'text-slate-400'}
                                >
                                  {displayP}
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-slate-700 tabular-nums whitespace-nowrap">
                              {hasOut ? `${displayOT.toFixed(2)}h` : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                              {hasOut && displayNormal > 0 ? (
                                <span className="text-amber-700">{displayNormal.toFixed(2)}h</span>
                              ) : (
                                <span className="text-slate-400">0.00h</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <StatusLabel status={previewCalc ? previewCalc.status : r.status} />
                            </td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              {isEditingThis ? (
                                <div className="inline-flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={handleSaveRowEdit}
                                    disabled={savingRowEdit}
                                    className="rounded bg-teal-700 p-1 text-white hover:bg-teal-800"
                                    aria-label="Save row changes"
                                  >
                                    <Check className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingRow(null)}
                                    className="rounded border border-slate-300 bg-white p-1 text-slate-600 hover:bg-slate-100"
                                    aria-label="Cancel row edit"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setEditingRow({ ...r })}
                                  className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                                  aria-label={`Edit ${r.date}`}
                                >
                                  <Edit3 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-slate-200 bg-slate-50 font-mono text-xs font-semibold text-slate-900">
                        <td className="px-4 py-2.5 whitespace-nowrap">TOTAL</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-slate-700">
                          {historyTotals.entries} Days
                        </td>
                        <td className="px-3 py-2.5" />
                        <td className="px-3 py-2.5" />
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-slate-600">
                          {historyTotals.totalAwayMins}m
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-teal-800">
                          {historyTotals.netDecimal.toFixed(2)}h
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums whitespace-nowrap text-teal-900">
                          {historyTotals.presentCount} P
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-slate-700">
                          {historyTotals.overtimeDecimal.toFixed(2)}h
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-slate-900">
                          {historyTotals.grossNormalDecimal.toFixed(2)}h
                        </td>
                        <td className="px-3 py-2.5" />
                        <td className="px-4 py-2.5" />
                      </tr>
                      <tr className="border-t border-slate-200 bg-white font-mono text-xs text-slate-700">
                        <td colSpan={8} className="px-4 py-2 text-right font-sans font-medium">
                          Less: Month-End Theka Working Hours
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-semibold text-red-700">
                          -{historyTotals.monthlyThekaDecimal.toFixed(2)}h
                        </td>
                        <td colSpan={2} />
                      </tr>
                      <tr className="border-t border-slate-300 bg-amber-50/70 font-mono text-xs font-bold text-slate-900">
                        <td colSpan={6} className="px-4 py-2.5 text-right font-sans">
                          FINAL NET PAYABLE (P &amp; H)
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums whitespace-nowrap text-teal-900">
                          {historyTotals.presentCount} P
                        </td>
                        <td className="px-3 py-2.5" />
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-amber-800">
                          {historyTotals.finalNetNormalDecimal.toFixed(2)}h
                        </td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Modal Footer Actions */}
                <div className="border-t border-slate-200 bg-slate-50 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => handleExportMonthCSV(historyMonth, historyMonthRecords)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Export {formatMonthLabel(historyMonth)} CSV</span>
                  </button>

                  <div className="flex flex-wrap items-center gap-2.5">
                    {selectedEmployee.individualSheetUrl && (
                      <a
                        href={selectedEmployee.individualSheetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-teal-700 bg-white px-3.5 py-2 text-xs font-medium text-teal-800 hover:bg-teal-50 whitespace-nowrap"
                      >
                        <span>Open Google Sheet</span>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}

                    <button
                      type="button"
                      onClick={() => onRequestStandaloneSheet(selectedEmployee, historyMonth)}
                      disabled={isSyncing}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-400 whitespace-nowrap"
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                      <span>
                        {isSyncing
                          ? 'Updating Google Sheet...'
                          : selectedEmployee.individualSheetId
                          ? `Update ${formatMonthLabel(historyMonth)} in Google Sheet`
                          : `Create ${formatMonthLabel(historyMonth)} in Google Sheet`}
                      </span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
                  8h+ Mon–Sat counts as 1 Present (P); &lt;8h, extra hours, and Sundays count in
                  Normal Hours (H). Month-end Theka deduction can be applied in History Attendance.
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
                    Sundays
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
                    <th className="py-2 px-2 font-medium text-center">P</th>
                    <th className="py-2 pl-2 font-medium text-right">Normal (H)</th>
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
                              row.isSunday ? 'font-semibold text-amber-700' : 'text-slate-600'
                            }
                          >
                            {row.dayShort}
                            {row.isSunday ? ' (OT -> H)' : ''}
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
                        <td className="py-2 px-2 text-center font-mono font-semibold tabular-nums whitespace-nowrap">
                          {calc ? (
                            <span
                              className={
                                calc.presentCount === 1 ? 'text-teal-800' : 'text-slate-400'
                              }
                            >
                              {calc.presentCount}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2 pl-2 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                          {calc && calc.normalMinutes > 0 ? (
                            <span className="text-amber-700">
                              {calc.normalDecimalHours.toFixed(2)}h
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
                  <span className="text-slate-500">Present (P): </span>
                  <span className="font-mono font-semibold text-teal-800 tabular-nums">
                    {builderTotals.presentCount}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Working: </span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {(builderTotals.netMinutes / 60).toFixed(2)}h
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Normal (H): </span>
                  <span className="font-mono font-semibold text-amber-700 tabular-nums">
                    {(builderTotals.normalMinutes / 60).toFixed(2)}h
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={syncBuilderToSheet}
                    onChange={(e) => setSyncBuilderToSheet(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700"
                  />
                  <span>Also create / update Google Sheet</span>
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
                  disabled={isSavingMonth || builderTotals.selectedDays === 0}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-300 whitespace-nowrap"
                >
                  {isSavingMonth
                    ? 'Saving...'
                    : `Save ${builderTotals.selectedDays} Day(s) to History`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
