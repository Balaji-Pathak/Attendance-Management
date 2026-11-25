import React, { useMemo, useState } from 'react';
import { Download, Edit3, RefreshCw, Search, Trash2, X } from 'lucide-react';
import {
  AttendanceRecord,
  CategorySheetConfigs,
  COMPANY_CATEGORIES,
  CompanyCategory,
  DEFAULT_COMPANY_CATEGORY,
  Employee,
} from '../types/attendance';
import {
  calculateShiftMetrics,
  downloadCSV,
  formatDisplayDate,
  formatDisplayTime,
  formatDurationHM,
  formatMonthLabel,
  getCurrentYearMonth,
  getDayNameShort,
  getRecordPayroll,
  normalizeCompanyCategory,
} from '../utils/time';
import { StatusLabel } from './StatusLabel';

interface MasterAttendanceViewProps {
  employees: Employee[];
  records: AttendanceRecord[];
  sheetConfigs: CategorySheetConfigs;
  onUpdateRecord: (updated: AttendanceRecord) => Promise<void>;
  onDeleteRecord: (record: AttendanceRecord) => void;
  onRequestSyncAll: (categoryFilter?: 'all' | CompanyCategory) => void;
}

export const MasterAttendanceView: React.FC<MasterAttendanceViewProps> = ({
  employees,
  records,
  sheetConfigs,
  onUpdateRecord,
  onDeleteRecord,
  onRequestSyncAll,
}) => {
  const currentYearMonth = getCurrentYearMonth();
  const [search, setSearch] = useState('');
  const [monthFilter, setMonthFilter] = useState<string>(() => getCurrentYearMonth());
  const [dateFilter, setDateFilter] = useState('');
  const [companyFilter, setCompanyFilter] = useState<'all' | CompanyCategory>('all');
  const [empFilter, setEmpFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [editing, setEditing] = useState<AttendanceRecord | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const empCategoryMap = useMemo(() => {
    const map = new Map<string, CompanyCategory>();
    for (const emp of employees) {
      const cat = normalizeCompanyCategory(emp.companyCategory);
      map.set(emp.id, cat);
      map.set(emp.empCode, cat);
    }
    return map;
  }, [employees]);

  const filterEmployeeOptions = useMemo(() => {
    if (companyFilter === 'all') return employees;
    return employees.filter(
      (e) => normalizeCompanyCategory(e.companyCategory) === companyFilter
    );
  }, [employees, companyFilter]);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...records]
      .filter((r) => {
        if (dateFilter) {
          if (r.date !== dateFilter) return false;
        } else if (monthFilter) {
          if (!r.date.startsWith(monthFilter)) return false;
        }
        const cat =
          empCategoryMap.get(r.empId) ??
          empCategoryMap.get(r.empCode) ??
          DEFAULT_COMPANY_CATEGORY;
        if (companyFilter !== 'all' && cat !== companyFilter) return false;
        if (empFilter !== 'all' && r.empId !== empFilter) return false;
        if (statusFilter !== 'all' && r.status !== statusFilter) return false;
        if (!q) return true;
        return (
          r.empCode.toLowerCase().includes(q) ||
          r.empName.toLowerCase().includes(q) ||
          cat.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return b.inTime.localeCompare(a.inTime);
      });
  }, [
    records,
    monthFilter,
    dateFilter,
    companyFilter,
    empFilter,
    statusFilter,
    search,
    empCategoryMap,
  ]);

  const totals = useMemo(() => {
    let totalPresent = 0;
    let totalNet = 0;
    let totalNormal = 0;
    let totalThikada = 0;
    let pendingSync = 0;

    for (const r of filteredRecords) {
      if (!r.syncedToSheet) pendingSync += 1;
      if (r.outTime && r.netMinutes !== null) {
        totalNet += r.netMinutes;
        const p = getRecordPayroll(r);
        totalPresent += p.presentCount;
        totalNormal += p.normalMinutes;
        totalThikada += p.thikadaMinutes;
      }
    }

    return {
      entries: filteredRecords.length,
      totalPresent,
      totalNet,
      totalNetDecimal: Number((totalNet / 60).toFixed(2)),
      totalNormal,
      totalNormalDecimal: Number((totalNormal / 60).toFixed(2)),
      totalThikadaDecimal: Number((totalThikada / 60).toFixed(2)),
      pendingSync,
    };
  }, [filteredRecords]);

  const handleExportCSV = () => {
    const scopeSlug = dateFilter || monthFilter || 'all-months';
    downloadCSV(
      `master-attendance-${scopeSlug}.csv`,
      [
        'Date',
        'Day',
        'Employee ID',
        'Name',
        'Company Category',
        'In Time',
        'Out Time',
        'Away (mins)',
        'Working Hours',
        'Present (P)',
        'Overtime (hrs)',
        'Normal Hours (H)',
      ],
      filteredRecords.map((r) => {
        const p = getRecordPayroll(r);
        const hasOut = Boolean(r.outTime && r.netMinutes !== null);
        const companyCategory =
          empCategoryMap.get(r.empId) ??
          empCategoryMap.get(r.empCode) ??
          DEFAULT_COMPANY_CATEGORY;
        return [
          r.date,
          getDayNameShort(r.date),
          r.empCode,
          r.empName,
          companyCategory,
          formatDisplayTime(r.inTime),
          r.outTime ? formatDisplayTime(r.outTime) : '',
          Math.round((r.pausedTotalSeconds ?? 0) / 60),
          r.netDecimalHours !== null ? r.netDecimalHours : '',
          hasOut ? p.presentCount : '',
          hasOut ? p.overtimeDecimalHours : '',
          hasOut ? Number((p.grossNormalMinutes / 60).toFixed(2)) : '',
        ];
      })
    );
  };

  const handleEditSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setSavingEdit(true);
    try {
      await onUpdateRecord(editing);
      setEditing(null);
    } finally {
      setSavingEdit(false);
    }
  };

  const editPreview = useMemo(() => {
    if (!editing || !editing.outTime) return null;
    return calculateShiftMetrics(
      editing.inTime,
      editing.outTime,
      editing.breakMinutes,
      editing.date,
      Math.round((editing.pausedTotalSeconds ?? 0) / 60)
    );
  }, [editing]);

  return (
    <div className="space-y-6">
      {/* Summary Strip */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Present Days (P)</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {totals.totalPresent}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Total Working Hours</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-teal-800 tabular-nums">
            {totals.totalNetDecimal.toFixed(2)}h
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Normal Hours (H)</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-amber-700 tabular-nums">
            {totals.totalNormalDecimal.toFixed(2)}h
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Pending Sheet Sync</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {totals.pendingSync}
          </div>
        </div>
      </section>

      {/* Filters & Table */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or ID..."
                className="w-52 rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:bg-white focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="month"
                value={monthFilter}
                onChange={(e) => {
                  const val = e.target.value;
                  setMonthFilter(val);
                  if (dateFilter && val && !dateFilter.startsWith(val)) {
                    setDateFilter('');
                  }
                }}
                aria-label="Filter by month"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-800 focus:border-teal-700 focus:outline-none tabular-nums"
              />
              {monthFilter !== currentYearMonth && (
                <button
                  type="button"
                  onClick={() => {
                    setMonthFilter(currentYearMonth);
                    setDateFilter('');
                  }}
                  className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
                >
                  This Month
                </button>
              )}
              {monthFilter !== '' && (
                <button
                  type="button"
                  onClick={() => {
                    setMonthFilter('');
                    setDateFilter('');
                  }}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline whitespace-nowrap"
                >
                  All Months
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFilter}
                onChange={(e) => {
                  const val = e.target.value;
                  setDateFilter(val);
                  if (val) {
                    setMonthFilter(val.slice(0, 7));
                  }
                }}
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
            </div>

            <select
              value={companyFilter}
              onChange={(e) => {
                setCompanyFilter(e.target.value as 'all' | CompanyCategory);
                setEmpFilter('all');
              }}
              aria-label="Filter by company category"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-teal-700 focus:outline-none"
            >
              <option value="all">All Companies</option>
              {COMPANY_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>

            <select
              value={empFilter}
              onChange={(e) => setEmpFilter(e.target.value)}
              aria-label="Filter by employee"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-teal-700 focus:outline-none"
            >
              <option value="all">All Employees</option>
              {filterEmployeeOptions.map((e) => (
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
              <option value="completed">Done</option>
              <option value="short_shift">Short Shift</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleExportCSV}
              disabled={filteredRecords.length === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export CSV</span>
            </button>
            {((companyFilter === 'all' &&
              (sheetConfigs['Sukhsa Export Permanent'] ||
                sheetConfigs['Sukhsa Export Temporary'])) ||
              (companyFilter !== 'all' && sheetConfigs[companyFilter])) && (
              <button
                type="button"
                onClick={() => onRequestSyncAll(companyFilter)}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Sync to Google Sheet</span>
              </button>
            )}
          </div>
        </div>

        {filteredRecords.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-base font-semibold text-slate-900">
              {dateFilter
                ? `No attendance logs for ${formatDisplayDate(dateFilter)}`
                : monthFilter
                ? `No attendance logs for ${formatMonthLabel(monthFilter)}`
                : 'No attendance logs yet'}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {dateFilter || monthFilter
                ? 'Entries marked on the Guard Gate Desk for this period will appear here, or pick another month above.'
                : 'Entries marked on the Guard Gate Desk appear here automatically.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                  <th className="px-6 py-3 whitespace-nowrap">Date</th>
                  <th className="px-4 py-3 whitespace-nowrap">Employee ID</th>
                  <th className="px-4 py-3 whitespace-nowrap">Name</th>
                  <th className="px-4 py-3 whitespace-nowrap">Company</th>
                  <th className="px-4 py-3 whitespace-nowrap">In Time</th>
                  <th className="px-4 py-3 whitespace-nowrap">Out Time</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Away</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Working Hours</th>
                  <th className="px-4 py-3 text-center whitespace-nowrap">P</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Normal (H)</th>
                  <th className="px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="px-6 py-3 text-right whitespace-nowrap">Admin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredRecords.map((rec) => {
                  const p = getRecordPayroll(rec);
                  const awayMins = Math.round((rec.pausedTotalSeconds ?? 0) / 60);
                  const hasOut = Boolean(rec.outTime && rec.netMinutes !== null);
                  const dayNormalHrs = Number((p.grossNormalMinutes / 60).toFixed(2));
                  const companyCategory =
                    empCategoryMap.get(rec.empId) ??
                    empCategoryMap.get(rec.empCode) ??
                    DEFAULT_COMPANY_CATEGORY;

                  return (
                    <tr key={rec.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-6 py-3.5 font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                        <span>{rec.date}</span>
                        <span
                          className={`ml-2 font-sans font-medium ${
                            p.isSunday ? 'text-amber-700' : 'text-slate-400'
                          }`}
                        >
                          {getDayNameShort(rec.date)}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs font-medium text-slate-700 tabular-nums whitespace-nowrap">
                        {rec.empCode}
                      </td>
                      <td className="px-4 py-3.5 font-medium text-slate-900 whitespace-nowrap">
                        {rec.empName}
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-600 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${
                            companyCategory === 'Sukhsa Export Permanent'
                              ? 'bg-teal-50 text-teal-800'
                              : 'bg-amber-50 text-amber-800'
                          }`}
                        >
                          {companyCategory}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs text-slate-900 tabular-nums whitespace-nowrap">
                        {formatDisplayTime(rec.inTime)}
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs text-slate-900 tabular-nums whitespace-nowrap">
                        {rec.outTime ? formatDisplayTime(rec.outTime) : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                        {awayMins > 0 ? `${awayMins}m` : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                        {rec.netMinutes !== null
                          ? `${formatDurationHM(rec.netMinutes)} · ${rec.netDecimalHours?.toFixed(2)}h`
                          : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-center font-mono text-xs font-semibold tabular-nums whitespace-nowrap">
                        {hasOut ? (
                          <span className={p.presentCount === 1 ? 'text-teal-800' : 'text-slate-400'}>
                            {p.presentCount === 1 ? 'P (1)' : '0'}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs font-semibold tabular-nums whitespace-nowrap">
                        {hasOut && dayNormalHrs > 0 ? (
                          <span className="text-amber-700">{dayNormalHrs.toFixed(2)}h</span>
                        ) : (
                          <span className="text-slate-400">0.00h</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <StatusLabel status={rec.status} />
                      </td>
                      <td className="px-6 py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              const empBreakPolicy =
                                rec.breakMinutes > 0
                                  ? rec.breakMinutes
                                  : employees.find((e) => e.id === rec.empId)?.breakMinutes ?? 30;
                              setEditing({ ...rec, breakMinutes: empBreakPolicy });
                            }}
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Admin Edit Correction Modal */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Admin Time Correction</h3>
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
              <div className="grid grid-cols-3 gap-3">
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
                  <label className="block text-xs font-medium text-slate-700">Lunch (mins)</label>
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
                <div>
                  <label className="block text-xs font-medium text-slate-700">Away (mins)</label>
                  <input
                    type="number"
                    min={0}
                    max={600}
                    value={Math.round((editing.pausedTotalSeconds ?? 0) / 60)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        pausedTotalSeconds: Math.max(0, Number(e.target.value) || 0) * 60,
                      })
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
                <div className="rounded-lg border border-teal-200 bg-teal-50/70 px-4 py-2.5 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-700">
                      {editPreview.breakDeductedMinutes > 0
                        ? `Working (${editPreview.breakDeductedMinutes}m break deducted)`
                        : 'Working (No break < 4.5h)'}
                    </span>
                    <span className="font-mono font-semibold text-teal-900 tabular-nums">
                      {editPreview.netDecimalHours.toFixed(2)}h · P = {editPreview.presentCount}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-700">
                      {editPreview.isSunday
                        ? 'Sunday (100% OT -> H)'
                        : editPreview.netMinutes < 480
                        ? '<8h Shift -> Normal Hours (H)'
                        : 'Overtime (>8h) -> Normal Hours (H)'}
                    </span>
                    <span className="font-mono font-semibold text-amber-800 tabular-nums">
                      H: {editPreview.normalDecimalHours.toFixed(2)}h
                    </span>
                  </div>
                </div>
              )}

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
