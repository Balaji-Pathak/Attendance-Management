import React, { useMemo, useState } from 'react';
import { Download, Edit3, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { AttendanceRecord, Employee, SheetConfig } from '../types/attendance';
import {
  calculateShiftMetrics,
  downloadCSV,
  formatDisplayDate,
  formatDisplayTime,
  formatDurationClock,
  formatDurationHM,
} from '../utils/time';
import { StatusLabel } from './StatusLabel';

interface MasterAttendanceViewProps {
  employees: Employee[];
  records: AttendanceRecord[];
  sheetConfig: SheetConfig | null;
  onUpdateRecord: (updated: AttendanceRecord) => Promise<void>;
  onDeleteRecord: (record: AttendanceRecord) => void;
  onRequestSyncAll: () => void;
}

export const MasterAttendanceView: React.FC<MasterAttendanceViewProps> = ({
  employees,
  records,
  sheetConfig,
  onUpdateRecord,
  onDeleteRecord,
  onRequestSyncAll,
}) => {
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [empFilter, setEmpFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [editing, setEditing] = useState<AttendanceRecord | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...records]
      .filter((r) => {
        if (dateFilter && r.date !== dateFilter) return false;
        if (empFilter !== 'all' && r.empId !== empFilter) return false;
        if (statusFilter !== 'all' && r.status !== statusFilter) return false;
        if (!q) return true;
        return (
          r.empCode.toLowerCase().includes(q) ||
          r.empName.toLowerCase().includes(q) ||
          r.department.toLowerCase().includes(q) ||
          r.notes.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return b.inTime.localeCompare(a.inTime);
      });
  }, [records, dateFilter, empFilter, statusFilter, search]);

  const totals = useMemo(() => {
    let totalGross = 0;
    let totalBreak = 0;
    let totalNet = 0;
    let completedCount = 0;

    for (const r of filteredRecords) {
      if (r.outTime && r.grossMinutes !== null && r.netMinutes !== null) {
        totalGross += r.grossMinutes;
        totalBreak += r.breakMinutes;
        totalNet += r.netMinutes;
        completedCount += 1;
      }
    }

    return {
      entries: filteredRecords.length,
      completedCount,
      totalGross,
      totalBreak,
      totalNet,
    };
  }, [filteredRecords]);

  const handleExportCSV = () => {
    downloadCSV(
      `master-attendance${dateFilter ? `-${dateFilter}` : ''}.csv`,
      [
        'Date',
        'Employee ID',
        'Employee Name',
        'Department',
        'In Time',
        'Out Time',
        'Gross (mins)',
        'Break Deducted (mins)',
        'Net Hours (HH:MM)',
        'Net Decimal',
        'Status',
        'Marked By',
        'Notes',
      ],
      filteredRecords.map((r) => [
        r.date,
        r.empCode,
        r.empName,
        r.department,
        r.inTime,
        r.outTime ?? '',
        r.grossMinutes ?? '',
        r.outTime ? r.breakMinutes : '',
        r.netMinutes !== null ? formatDurationClock(r.netMinutes) : '',
        r.netDecimalHours ?? '',
        r.status,
        r.markedBy,
        r.notes,
      ])
    );
  };

  const handleEditSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setSavingEdit(true);
    try {
      let nextRecord = { ...editing, updatedAt: new Date().toISOString(), syncedToSheet: false };
      if (editing.outTime) {
        const calc = calculateShiftMetrics(
          editing.inTime,
          editing.outTime,
          editing.breakMinutes
        );
        nextRecord = {
          ...nextRecord,
          grossMinutes: calc.grossMinutes,
          breakMinutes: calc.breakDeductedMinutes,
          netMinutes: calc.netMinutes,
          netDecimalHours: calc.netDecimalHours,
          status: calc.status,
        };
      } else {
        nextRecord = {
          ...nextRecord,
          outTime: null,
          grossMinutes: null,
          netMinutes: null,
          netDecimalHours: null,
          status: 'on_duty',
        };
      }
      await onUpdateRecord(nextRecord);
      setEditing(null);
    } finally {
      setSavingEdit(false);
    }
  };

  const editPreview = useMemo(() => {
    if (!editing || !editing.outTime) return null;
    return calculateShiftMetrics(editing.inTime, editing.outTime, editing.breakMinutes);
  }, [editing]);

  return (
    <div className="space-y-6">
      {/* Summary Strip */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Filtered Entries</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {totals.entries}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Total Gross Hours</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {formatDurationHM(totals.totalGross)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Total Break Deducted</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-amber-700 tabular-nums">
            {formatDurationHM(totals.totalBreak)}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Total Net Working Hours</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-teal-800 tabular-nums">
            {formatDurationHM(totals.totalNet)}
          </div>
        </div>
      </section>

      {/* Filters & Actions */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, ID, notes..."
                className="w-56 rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:bg-white focus:outline-none"
              />
            </div>

            <input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              aria-label="Filter by date"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-800 focus:border-teal-700 focus:outline-none tabular-nums"
            />
            {dateFilter && (
              <button
                type="button"
                onClick={() => setDateFilter('')}
                className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
              >
                All Dates
              </button>
            )}

            <select
              value={empFilter}
              onChange={(e) => setEmpFilter(e.target.value)}
              aria-label="Filter by employee"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-teal-700 focus:outline-none"
            >
              <option value="all">All Employees</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.empCode} · {e.name}
                </option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter by status"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-teal-700 focus:outline-none"
            >
              <option value="all">All Statuses</option>
              <option value="on_duty">On Duty</option>
              <option value="completed">Completed</option>
              <option value="short_shift">Short Shift</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleExportCSV}
              disabled={filteredRecords.length === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export CSV</span>
            </button>
            {sheetConfig && (
              <button
                type="button"
                onClick={onRequestSyncAll}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Sync Master & Employee Tabs</span>
              </button>
            )}
          </div>
        </div>

        {filteredRecords.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-base font-semibold text-slate-900">
              No attendance logs found
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Guard check-ins and check-outs will appear here automatically with calculated net working hours.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                  <th className="px-6 py-3 whitespace-nowrap">Date</th>
                  <th className="px-4 py-3 whitespace-nowrap">Employee</th>
                  <th className="px-4 py-3 whitespace-nowrap">In Time</th>
                  <th className="px-4 py-3 whitespace-nowrap">Out Time</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Gross</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Break</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Net Hours</th>
                  <th className="px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="px-4 py-3 whitespace-nowrap">Guard / Notes</th>
                  <th className="px-6 py-3 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredRecords.map((rec) => (
                  <tr key={rec.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-6 py-3.5 font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                      {rec.date}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-medium text-slate-900">{rec.empName}</div>
                      <div className="text-xs text-slate-500">
                        {rec.empCode} · {rec.department}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-slate-900 tabular-nums whitespace-nowrap">
                      {formatDisplayTime(rec.inTime)}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-slate-900 tabular-nums whitespace-nowrap">
                      {rec.outTime ? formatDisplayTime(rec.outTime) : '—'}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                      {formatDurationHM(rec.grossMinutes)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-xs text-amber-700 tabular-nums whitespace-nowrap">
                      {rec.outTime ? `-${rec.breakMinutes}m` : '—'}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-xs font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      {rec.netMinutes !== null
                        ? `${formatDurationHM(rec.netMinutes)} · ${rec.netDecimalHours?.toFixed(2)}h`
                        : '—'}
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <StatusLabel status={rec.status} />
                    </td>
                    <td className="px-4 py-3.5 text-xs text-slate-600 max-w-[200px] truncate">
                      <span>{rec.markedBy}</span>
                      {rec.notes && <span className="text-slate-400"> · {rec.notes}</span>}
                    </td>
                    <td className="px-6 py-3.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing({ ...rec })}
                          className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          aria-label={`Edit attendance for ${rec.empName}`}
                        >
                          <Edit3 className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteRecord(rec)}
                          className="rounded-md p-2 text-slate-500 hover:bg-red-50 hover:text-red-700"
                          aria-label={`Delete attendance for ${rec.empName}`}
                        >
                          <Trash2 className="h-4 w-4" />
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

      {/* Edit Attendance Record Modal */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Edit Attendance Entry</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {editing.empCode} · {editing.empName} · {formatDisplayDate(editing.date)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleEditSave} className="space-y-4 px-6 py-5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Date</label>
                  <input
                    type="date"
                    required
                    value={editing.date}
                    onChange={(e) => setEditing({ ...editing, date: e.target.value })}
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Break (mins)</label>
                  <input
                    type="number"
                    min={0}
                    max={180}
                    value={editing.breakMinutes}
                    onChange={(e) =>
                      setEditing({ ...editing, breakMinutes: Number(e.target.value) || 0 })
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700">In Time</label>
                  <input
                    type="time"
                    required
                    value={editing.inTime}
                    onChange={(e) => setEditing({ ...editing, inTime: e.target.value })}
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    Out Time (blank = On Duty)
                  </label>
                  <input
                    type="time"
                    value={editing.outTime ?? ''}
                    onChange={(e) =>
                      setEditing({ ...editing, outTime: e.target.value || null })
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums"
                  />
                </div>
              </div>

              {editPreview && (
                <div className="rounded-lg border border-teal-200 bg-teal-50/70 px-4 py-2.5 text-xs flex items-center justify-between">
                  <span className="text-slate-700">
                    Gross {formatDurationHM(editPreview.grossMinutes)} − {editPreview.breakDeductedMinutes}m break
                  </span>
                  <span className="font-mono font-semibold text-teal-900 tabular-nums">
                    Net: {formatDurationHM(editPreview.netMinutes)}
                  </span>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700">Notes</label>
                <input
                  type="text"
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                  className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                >
                  {savingEdit ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
