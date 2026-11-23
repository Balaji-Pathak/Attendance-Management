import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Clock,
  LogIn,
  LogOut,
  Plus,
  Search,
  UserPlus,
  X,
} from 'lucide-react';
import { AttendanceRecord, Employee, SheetConfig } from '../types/attendance';
import {
  calculateShiftMetrics,
  formatDisplayDate,
  formatDisplayTime,
  formatDurationHM,
  getCurrentHHMM,
  getEmployeeSheetTabName,
  getTodayISO,
} from '../utils/time';
import { StatusLabel } from './StatusLabel';

interface GuardGateViewProps {
  employees: Employee[];
  records: AttendanceRecord[];
  sheetConfig: SheetConfig | null;
  isGoogleAuthed: boolean;
  guardName: string;
  onGuardNameChange: (name: string) => void;
  onMarkCheckIn: (params: {
    employee: Employee;
    date: string;
    inTime: string;
    markedBy: string;
    notes: string;
  }) => Promise<void>;
  onMarkCheckOut: (params: {
    record: AttendanceRecord;
    employee: Employee;
    outTime: string;
    breakMinutes: number;
    markedBy: string;
    notes: string;
  }) => Promise<void>;
  onNavigateToEmployees: () => void;
  onLoadStarterRoster: () => void;
}

type GateFilter = 'all' | 'not_in' | 'on_duty' | 'completed';

interface GateActionModalState {
  mode: 'in' | 'out';
  employee: Employee;
  existingRecord?: AttendanceRecord;
  timeValue: string;
  breakMinutes: number;
  notes: string;
}

export const GuardGateView: React.FC<GuardGateViewProps> = ({
  employees,
  records,
  sheetConfig,
  isGoogleAuthed,
  guardName,
  onGuardNameChange,
  onMarkCheckIn,
  onMarkCheckOut,
  onNavigateToEmployees,
  onLoadStarterRoster,
}) => {
  const [selectedDate, setSelectedDate] = useState<string>(getTodayISO());
  const [searchQuery, setSearchQuery] = useState('');
  const [quickCode, setQuickCode] = useState('');
  const [quickCodeError, setQuickCodeError] = useState<string | null>(null);
  const [filter, setFilter] = useState<GateFilter>('all');
  const [nowTime, setNowTime] = useState<Date>(() => new Date());
  const [modal, setModal] = useState<GateActionModalState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNowTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const activeEmployees = useMemo(
    () => employees.filter((e) => e.active),
    [employees]
  );

  // Map latest record per employee for the selectedDate
  const dayRecordByEmp = useMemo(() => {
    const map = new Map<string, AttendanceRecord>();
    const dayRecs = records
      .filter((r) => r.date === selectedDate)
      .sort((a, b) => a.inTime.localeCompare(b.inTime));
    for (const r of dayRecs) {
      map.set(r.empId, r);
    }
    return map;
  }, [records, selectedDate]);

  const stats = useMemo(() => {
    let onDuty = 0;
    let completed = 0;
    let notIn = 0;

    for (const emp of activeEmployees) {
      const rec = dayRecordByEmp.get(emp.id);
      if (!rec) {
        notIn += 1;
      } else if (rec.status === 'on_duty') {
        onDuty += 1;
      } else {
        completed += 1;
      }
    }
    return {
      total: activeEmployees.length,
      onDuty,
      completed,
      notIn,
    };
  }, [activeEmployees, dayRecordByEmp]);

  const filteredEmployees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return activeEmployees.filter((emp) => {
      const rec = dayRecordByEmp.get(emp.id);
      const state: GateFilter = !rec
        ? 'not_in'
        : rec.status === 'on_duty'
        ? 'on_duty'
        : 'completed';

      if (filter !== 'all' && state !== filter) return false;

      if (!q) return true;
      return (
        emp.empCode.toLowerCase().includes(q) ||
        emp.name.toLowerCase().includes(q) ||
        emp.department.toLowerCase().includes(q)
      );
    });
  }, [activeEmployees, dayRecordByEmp, filter, searchQuery]);

  const openMarkInModal = (emp: Employee) => {
    setModal({
      mode: 'in',
      employee: emp,
      timeValue: getCurrentHHMM(),
      breakMinutes: emp.breakMinutes ?? 30,
      notes: '',
    });
  };

  const openMarkOutModal = (emp: Employee, rec: AttendanceRecord) => {
    setModal({
      mode: 'out',
      employee: emp,
      existingRecord: rec,
      timeValue: getCurrentHHMM(),
      breakMinutes: rec.breakMinutes ?? emp.breakMinutes ?? 30,
      notes: rec.notes || '',
    });
  };

  const handleQuickLookup = (e: React.FormEvent) => {
    e.preventDefault();
    setQuickCodeError(null);
    const term = quickCode.trim().toLowerCase();
    if (!term) return;

    const match = activeEmployees.find(
      (emp) =>
        emp.empCode.toLowerCase() === term ||
        emp.empCode.toLowerCase().endsWith(term) ||
        emp.name.toLowerCase() === term
    );

    if (!match) {
      setQuickCodeError(`No active employee matched "${quickCode.trim()}".`);
      return;
    }

    const rec = dayRecordByEmp.get(match.id);
    setQuickCode('');
    if (!rec) {
      openMarkInModal(match);
    } else if (rec.status === 'on_duty') {
      openMarkOutModal(match, rec);
    } else {
      openMarkInModal(match);
    }
  };

  const liveCheckoutPreview = useMemo(() => {
    if (!modal || modal.mode !== 'out' || !modal.existingRecord || !modal.timeValue) {
      return null;
    }
    return calculateShiftMetrics(
      modal.existingRecord.inTime,
      modal.timeValue,
      modal.breakMinutes
    );
  }, [modal]);

  const handleModalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modal || !modal.timeValue) return;
    setSubmitting(true);
    try {
      if (modal.mode === 'in') {
        await onMarkCheckIn({
          employee: modal.employee,
          date: selectedDate,
          inTime: modal.timeValue,
          markedBy: guardName.trim() || 'Gate Guard',
          notes: modal.notes.trim(),
        });
      } else if (modal.existingRecord) {
        await onMarkCheckOut({
          record: modal.existingRecord,
          employee: modal.employee,
          outTime: modal.timeValue,
          breakMinutes: modal.breakMinutes,
          markedBy: guardName.trim() || 'Gate Guard',
          notes: modal.notes.trim(),
        });
      }
      setModal(null);
    } finally {
      setSubmitting(false);
    }
  };

  const liveClockStr = nowTime.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  return (
    <div className="space-y-6">
      {/* Gate Clock & Quick Badge Entry */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-stretch">
        <div className="lg:col-span-7 flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-slate-500">
                Gate Terminal · {formatDisplayDate(selectedDate)}
              </p>
              <div className="mt-2 font-mono text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900 tabular-nums">
                {liveClockStr}
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:items-end">
              <label className="text-xs font-medium text-slate-500" htmlFor="guard-name-input">
                Guard on Duty
              </label>
              <input
                id="guard-name-input"
                type="text"
                value={guardName}
                onChange={(e) => onGuardNameChange(e.target.value)}
                placeholder="Guard Uncle"
                className="w-44 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-900 focus:border-teal-700 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-4 text-xs text-slate-600">
            <span>Break Rule: 30 min auto-deducted on Check-Out</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>
              {sheetConfig
                ? `Google Sheet Connected: ${sheetConfig.spreadsheetTitle}`
                : isGoogleAuthed
                ? 'Signed in — connect or create a Google Sheet in Google Sheets Sync'
                : 'Local staging mode — sign in with Google to sync sheets'}
            </span>
          </div>
        </div>

        <div className="lg:col-span-5 flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Quick Mark by Employee ID
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Type an Employee ID (e.g. EMP-001) or exact name and press Enter to record In or Out time.
            </p>
          </div>

          <form onSubmit={handleQuickLookup} className="mt-4 space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={quickCode}
                onChange={(e) => {
                  setQuickCode(e.target.value);
                  setQuickCodeError(null);
                }}
                placeholder="Enter EMP-001 or name..."
                className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!quickCode.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300 transition-colors whitespace-nowrap shrink-0"
              >
                <span>Open</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
            {quickCodeError && (
              <p className="text-xs font-medium text-red-700">{quickCodeError}</p>
            )}
          </form>
        </div>
      </section>

      {/* 4-Column KPI Summary Strip */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Active Staff</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {stats.total}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">On Duty Now</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-emerald-700 tabular-nums">
            {stats.onDuty}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Completed Shifts</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-teal-800 tabular-nums">
            {stats.completed}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="text-xs font-medium text-slate-500">Not Checked In</div>
          <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-700 tabular-nums">
            {stats.notIn}
          </div>
        </div>
      </section>

      {/* Main Guard Attendance Register */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search employee or ID..."
                className="w-60 rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:bg-white focus:outline-none"
              />
            </div>

            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              aria-label="Attendance date"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-800 focus:border-teal-700 focus:outline-none tabular-nums"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                { id: 'all', label: `All (${stats.total})` },
                { id: 'not_in', label: `Not In (${stats.notIn})` },
                { id: 'on_duty', label: `On Duty (${stats.onDuty})` },
                { id: 'completed', label: `Completed (${stats.completed})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  filter === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {activeEmployees.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-base font-semibold text-slate-900">
              No active employees in directory yet
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500">
              Add your employees first so the gate guard can mark their daily check-in and check-out times.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={onNavigateToEmployees}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <UserPlus className="h-4 w-4" />
                <span>Add Employee</span>
              </button>
              <button
                type="button"
                onClick={onLoadStarterRoster}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="h-4 w-4" />
                <span>Load Starter Roster (5 Staff)</span>
              </button>
            </div>
          </div>
        ) : filteredEmployees.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-500">
            No employees match the current filter or search query.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                  <th className="px-6 py-3 whitespace-nowrap">Emp ID</th>
                  <th className="px-4 py-3 whitespace-nowrap">Employee</th>
                  <th className="px-4 py-3 whitespace-nowrap">Shift</th>
                  <th className="px-4 py-3 whitespace-nowrap">In Time</th>
                  <th className="px-4 py-3 whitespace-nowrap">Out Time</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Net Hours (-30m)</th>
                  <th className="px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="px-6 py-3 text-right whitespace-nowrap">Gate Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredEmployees.map((emp) => {
                  const rec = dayRecordByEmp.get(emp.id);
                  const status = !rec ? 'not_in' : rec.status;

                  return (
                    <tr
                      key={emp.id}
                      className="hover:bg-slate-50/80 transition-colors"
                    >
                      <td className="px-6 py-3.5 font-mono text-xs font-medium text-slate-700 tabular-nums whitespace-nowrap">
                        {emp.empCode}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="font-medium text-slate-900">{emp.name}</div>
                        <div className="text-xs text-slate-500">
                          {emp.department} · {emp.role}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                        {emp.shiftStart} – {emp.shiftEnd}
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs font-medium text-slate-900 tabular-nums whitespace-nowrap">
                        {rec ? formatDisplayTime(rec.inTime) : '—'}
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs font-medium text-slate-900 tabular-nums whitespace-nowrap">
                        {rec?.outTime ? formatDisplayTime(rec.outTime) : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                        {rec?.netMinutes !== null && rec?.netMinutes !== undefined
                          ? `${formatDurationHM(rec.netMinutes)} (${rec.netDecimalHours?.toFixed(2)}h)`
                          : '—'}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <StatusLabel status={status} />
                      </td>
                      <td className="px-6 py-3.5 text-right whitespace-nowrap">
                        {!rec ? (
                          <button
                            type="button"
                            onClick={() => openMarkInModal(emp)}
                            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                          >
                            <LogIn className="h-3.5 w-3.5" />
                            <span>Mark In</span>
                          </button>
                        ) : rec.status === 'on_duty' ? (
                          <button
                            type="button"
                            onClick={() => openMarkOutModal(emp, rec)}
                            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0"
                          >
                            <LogOut className="h-3.5 w-3.5" />
                            <span>Mark Out</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openMarkInModal(emp)}
                            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Clock className="h-3.5 w-3.5" />
                            <span>New Entry</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Check-In / Check-Out Confirmation Modal */}
      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="gate-modal-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 id="gate-modal-title" className="text-base font-semibold text-slate-900">
                  {modal.mode === 'in' ? 'Confirm Gate Check-In' : 'Confirm Gate Check-Out'}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {modal.employee.empCode} · {modal.employee.name} · {formatDisplayDate(selectedDate)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModal(null)}
                disabled={submitting}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close modal"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleModalSubmit} className="space-y-4 px-6 py-5">
              {modal.mode === 'out' && modal.existingRecord && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs">
                  <div className="flex items-center justify-between text-slate-600">
                    <span>Recorded Check-In Time</span>
                    <span className="font-mono font-semibold text-slate-900 tabular-nums">
                      {formatDisplayTime(modal.existingRecord.inTime)}
                    </span>
                  </div>
                </div>
              )}

              <div>
                <label
                  htmlFor="gate-time-input"
                  className="block text-xs font-medium text-slate-700"
                >
                  {modal.mode === 'in' ? 'Check-In Time' : 'Check-Out Time'}
                </label>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    id="gate-time-input"
                    type="time"
                    required
                    value={modal.timeValue}
                    onChange={(e) =>
                      setModal((prev) => (prev ? { ...prev, timeValue: e.target.value } : null))
                    }
                    className="flex-1 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-base font-medium text-slate-900 focus:border-teal-700 focus:outline-none tabular-nums"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setModal((prev) =>
                        prev ? { ...prev, timeValue: getCurrentHHMM() } : null
                      )
                    }
                    className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0"
                  >
                    Use Now
                  </button>
                </div>
              </div>

              {modal.mode === 'out' && (
                <>
                  <div>
                    <label
                      htmlFor="gate-break-input"
                      className="block text-xs font-medium text-slate-700"
                    >
                      Break Deduction (minutes)
                    </label>
                    <input
                      id="gate-break-input"
                      type="number"
                      min={0}
                      max={180}
                      value={modal.breakMinutes}
                      onChange={(e) =>
                        setModal((prev) =>
                          prev ? { ...prev, breakMinutes: Number(e.target.value) || 0 } : null
                        )
                      }
                      className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-teal-700 focus:outline-none tabular-nums"
                    />
                  </div>

                  {liveCheckoutPreview && (
                    <div className="rounded-lg border border-teal-200 bg-teal-50/70 px-4 py-3 space-y-1.5 text-xs">
                      <div className="flex items-center justify-between text-slate-700">
                        <span>Gross Duration</span>
                        <span className="font-mono font-medium tabular-nums">
                          {formatDurationHM(liveCheckoutPreview.grossMinutes)}
                          {liveCheckoutPreview.isOvernight ? ' (Overnight)' : ''}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-700">
                        <span>Break Deducted</span>
                        <span className="font-mono font-medium text-amber-800 tabular-nums">
                          -{liveCheckoutPreview.breakDeductedMinutes} min
                        </span>
                      </div>
                      <div className="flex items-center justify-between border-t border-teal-200 pt-1.5 text-sm font-semibold text-teal-900">
                        <span>Net Working Hours</span>
                        <span className="font-mono tabular-nums">
                          {formatDurationHM(liveCheckoutPreview.netMinutes)} ({liveCheckoutPreview.netDecimalHours.toFixed(2)} hrs)
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}

              <div>
                <label
                  htmlFor="gate-notes-input"
                  className="block text-xs font-medium text-slate-700"
                >
                  Gate Notes (optional)
                </label>
                <input
                  id="gate-notes-input"
                  type="text"
                  value={modal.notes}
                  onChange={(e) =>
                    setModal((prev) => (prev ? { ...prev, notes: e.target.value } : null))
                  }
                  placeholder="e.g., Late arrival informed, overtime approved"
                  className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                />
              </div>

              {sheetConfig && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
                  Confirming will update <span className="font-medium text-slate-900">Master Attendance</span> and{' '}
                  <span className="font-medium text-slate-900">
                    {getEmployeeSheetTabName(modal.employee.empCode, modal.employee.name)}
                  </span>{' '}
                  in Google Sheets.
                </div>
              )}

              <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setModal(null)}
                  disabled={submitting}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors whitespace-nowrap shrink-0 ${
                    modal.mode === 'in'
                      ? 'bg-slate-900 hover:bg-slate-800'
                      : 'bg-teal-700 hover:bg-teal-800'
                  }`}
                >
                  {submitting
                    ? 'Saving...'
                    : modal.mode === 'in'
                    ? sheetConfig
                      ? 'Confirm Check-In & Sync'
                      : 'Confirm Check-In'
                    : sheetConfig
                    ? 'Confirm Check-Out & Sync'
                    : 'Confirm Check-Out'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
