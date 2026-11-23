import React, { useMemo, useState } from 'react';
import {
  Download,
  ExternalLink,
  FileSpreadsheet,
  RefreshCw,
  UserCheck,
} from 'lucide-react';
import { AttendanceRecord, Employee, SheetConfig } from '../types/attendance';
import {
  downloadCSV,
  formatDisplayTime,
  formatDurationHM,
  getEmployeeSheetTabName,
} from '../utils/time';
import { StatusLabel } from './StatusLabel';

interface IndividualEmployeeViewProps {
  employees: Employee[];
  records: AttendanceRecord[];
  sheetConfig: SheetConfig | null;
  isGoogleAuthed: boolean;
  onRequestSyncEmployeeTab: (employee: Employee) => void;
  onRequestStandaloneSheet: (employee: Employee) => void;
}

export const IndividualEmployeeView: React.FC<IndividualEmployeeViewProps> = ({
  employees,
  records,
  sheetConfig,
  isGoogleAuthed,
  onRequestSyncEmployeeTab,
  onRequestStandaloneSheet,
}) => {
  const [selectedEmpId, setSelectedEmpId] = useState<string>(employees[0]?.id ?? '');
  const [monthFilter, setMonthFilter] = useState<string>('all');

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
    let breakDeducted = 0;
    let net = 0;
    let completed = 0;
    const uniqueDays = new Set<string>();

    for (const r of empRecords) {
      uniqueDays.add(r.date);
      if (r.outTime && r.netMinutes !== null) {
        breakDeducted += r.breakMinutes;
        net += r.netMinutes;
        completed += 1;
      }
    }

    return {
      daysWorked: uniqueDays.size,
      breakDeducted,
      net,
      netDecimal: Number((net / 60).toFixed(2)),
      avgNet: completed > 0 ? Math.round(net / completed) : 0,
    };
  }, [empRecords]);

  const handleExportEmployeeCSV = () => {
    if (!selectedEmployee) return;
    downloadCSV(
      `${selectedEmployee.empCode}-${selectedEmployee.name.replace(/\s+/g, '-')}.csv`,
      ['Date', 'In Time', 'Out Time', 'Working Hours'],
      empRecords.map((r) => [
        r.date,
        formatDisplayTime(r.inTime),
        r.outTime ? formatDisplayTime(r.outTime) : '',
        r.netDecimalHours !== null ? r.netDecimalHours : '',
      ])
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
                30-minute break auto-deducted · Master Sheet Tab: {tabName}
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

          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
            <div className="text-xs text-slate-600">
              {sheetConfig
                ? `Synced inside Master Sheet tab: ${tabName}`
                : 'Connect a Master Google Sheet in Google Sheets Sync to sync tabs.'}
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
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
                  className="inline-flex items-center gap-1.5 rounded-lg border border-teal-700 bg-teal-50 px-3.5 py-2 text-xs font-medium text-teal-800 hover:bg-teal-100 whitespace-nowrap shrink-0"
                >
                  <span>Open Sheet</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
            <div className="text-xs font-medium text-slate-500">Days Worked</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {summary.daysWorked}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
            <div className="text-xs font-medium text-slate-500">Break Deducted</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold text-amber-700 tabular-nums">
              {formatDurationHM(summary.breakDeducted)}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
            <div className="text-xs font-medium text-slate-500">Total Working Hours</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold text-teal-800 tabular-nums">
              {summary.netDecimal.toFixed(2)}h
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
          <div className="border-b border-slate-200 px-6 py-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Individual Attendance Sheet
            </h3>
          </div>

          {empRecords.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-slate-500">
              No attendance entries recorded for {selectedEmployee.name} yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                    <th className="px-6 py-3 whitespace-nowrap">Date</th>
                    <th className="px-4 py-3 whitespace-nowrap">In Time</th>
                    <th className="px-4 py-3 whitespace-nowrap">Out Time</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Working Hours (-30m)</th>
                    <th className="px-6 py-3 text-right whitespace-nowrap">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {empRecords.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50/80">
                      <td className="px-6 py-3 font-mono text-xs text-slate-800 tabular-nums whitespace-nowrap">
                        {r.date}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-900 tabular-nums whitespace-nowrap">
                        {formatDisplayTime(r.inTime)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-900 tabular-nums whitespace-nowrap">
                        {r.outTime ? formatDisplayTime(r.outTime) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                        {r.netMinutes !== null
                          ? `${formatDurationHM(r.netMinutes)} · ${r.netDecimalHours?.toFixed(2)}h`
                          : '—'}
                      </td>
                      <td className="px-6 py-3 text-right whitespace-nowrap">
                        <StatusLabel status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
