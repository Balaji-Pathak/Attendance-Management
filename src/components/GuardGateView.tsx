import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Lock,
  LogIn,
  LogOut,
  Pause,
  Play,
  Search,
  Timer,
  X,
} from 'lucide-react';
import { AttendanceRecord, GateEmployeeView } from '../types/attendance';
import {
  calculateMetricsFromWorkedMinutes,
  computeLiveElapsedSeconds,
  formatDisplayDate,
  formatDisplayTime,
  formatDurationHM,
  formatHMS,
  getCurrentHHMM,
  isSundayISO,
} from '../utils/time';
import { StatusLabel } from './StatusLabel';

interface GuardGateViewProps {
  employees: GateEmployeeView[];
  todayRecords: AttendanceRecord[];
  serverDate: string;
  onMarkIn: (empId: string) => Promise<void>;
  onPauseTiming: (recordId: string) => Promise<void>;
  onResumeTiming: (recordId: string) => Promise<void>;
  onMarkOut: (recordId: string) => Promise<void>;
  onOpenAdminGate: () => void;
}

type GateFilter = 'all' | 'not_in' | 'on_duty' | 'completed';

interface PendingGateAction {
  mode: 'in' | 'out';
  employee: GateEmployeeView;
  record?: AttendanceRecord;
}

export const GuardGateView: React.FC<GuardGateViewProps> = ({
  employees,
  todayRecords,
  serverDate,
  onMarkIn,
  onPauseTiming,
  onResumeTiming,
  onMarkOut,
  onOpenAdminGate,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<GateFilter>('all');
  const [nowTime, setNowTime] = useState<Date>(() => new Date());
  const [pendingAction, setPendingAction] = useState<PendingGateAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyRecordId, setBusyRecordId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNowTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const recordByEmp = useMemo(() => {
    const map = new Map<string, AttendanceRecord>();
    for (const r of todayRecords) {
      map.set(r.empId, r);
    }
    return map;
  }, [todayRecords]);

  const stats = useMemo(() => {
    let onDuty = 0;
    let completed = 0;
    let notIn = 0;

    for (const emp of employees) {
      const rec = recordByEmp.get(emp.id);
      if (!rec) notIn += 1;
      else if (rec.status === 'on_duty') onDuty += 1;
      else completed += 1;
    }

    return {
      total: employees.length,
      onDuty,
      completed,
      notIn,
    };
  }, [employees, recordByEmp]);

  const filteredEmployees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return employees.filter((emp) => {
      const rec = recordByEmp.get(emp.id);
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
  }, [employees, recordByEmp, filter, searchQuery]);

  const nowMs = nowTime.getTime();
  const liveNowHHMM = useMemo(() => getCurrentHHMM(), [nowTime]);

  const checkoutPreview = useMemo(() => {
    if (!pendingAction || pendingAction.mode !== 'out' || !pendingAction.record) {
      return null;
    }
    const rec = pendingAction.record;
    const workedSec = computeLiveElapsedSeconds(rec, nowMs);
    const activePauseSec =
      rec.isPaused && typeof rec.pausedAtMs === 'number'
        ? Math.max(0, Math.floor((nowMs - rec.pausedAtMs) / 1000))
        : 0;
    const totalAwayMinutes = Math.round(((rec.pausedTotalSeconds ?? 0) + activePauseSec) / 60);
    const calc = calculateMetricsFromWorkedMinutes(
      Math.round(workedSec / 60),
      rec.breakMinutes ?? 30,
      rec.date
    );
    return { ...calc, totalAwayMinutes };
  }, [pendingAction, nowMs]);

  const handleTogglePause = async (rec: AttendanceRecord) => {
    if (busyRecordId) return;
    setBusyRecordId(rec.id);
    try {
      if (rec.isPaused) {
        await onResumeTiming(rec.id);
      } else {
        await onPauseTiming(rec.id);
      }
    } finally {
      setBusyRecordId(null);
    }
  };

  const handleConfirm = async () => {
    if (!pendingAction) return;
    setSubmitting(true);
    try {
      if (pendingAction.mode === 'in') {
        await onMarkIn(pendingAction.employee.id);
      } else if (pendingAction.record) {
        await onMarkOut(pendingAction.record.id);
      }
      setPendingAction(null);
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

  const isTodaySunday = isSundayISO(serverDate);

  return (
    <div className="space-y-5">
      {/* Live Clock Header Card */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500">
              {formatDisplayDate(serverDate)} · Live Gate Clock
              {isTodaySunday ? ' · Sunday (All Hours = Overtime)' : ''}
            </p>
            <div className="mt-1 font-mono text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900 tabular-nums">
              {liveClockStr}
            </div>
          </div>

          <div className="text-xs text-slate-600 sm:text-right space-y-1">
            <div className="font-medium text-slate-900">
              8h Shift · 30m Lunch Break Deducted Only for 4.5h+ Shifts
            </div>
            <div>Use Stop Timing when staff step out for tea or errands</div>
          </div>
        </div>
      </section>

      {/* 4-Column Summary Strip */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs font-medium text-slate-500">Total Staff</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {stats.total}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs font-medium text-slate-500">Not In</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-700 tabular-nums">
            {stats.notIn}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs font-medium text-slate-500">On Duty</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-emerald-700 tabular-nums">
            {stats.onDuty}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs font-medium text-slate-500">Done Today</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-teal-800 tabular-nums">
            {stats.completed}
          </div>
        </div>
      </section>

      {/* Guard Staff List */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name or EMP ID..."
              className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:bg-white focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                { id: 'all', label: `All (${stats.total})` },
                { id: 'not_in', label: `Not In (${stats.notIn})` },
                { id: 'on_duty', label: `On Duty (${stats.onDuty})` },
                { id: 'completed', label: `Done (${stats.completed})` },
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

        {employees.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-base font-semibold text-slate-900">
              No employees in roster yet
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500">
              Admin needs to add employees in the protected Admin Panel before guard check-in can begin.
            </p>
            <button
              type="button"
              onClick={onOpenAdminGate}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 whitespace-nowrap"
            >
              <Lock className="h-4 w-4" />
              <span>Unlock Admin to Add Staff</span>
            </button>
          </div>
        ) : filteredEmployees.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-500">
            No employees match this filter.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredEmployees.map((emp) => {
              const rec = recordByEmp.get(emp.id);
              const status = !rec ? 'not_in' : rec.status;
              const isLive = rec?.status === 'on_duty';
              const elapsedSec = isLive && rec ? computeLiveElapsedSeconds(rec, nowMs) : 0;
              const activePauseSec =
                isLive && rec?.isPaused && typeof rec.pausedAtMs === 'number'
                  ? Math.max(0, Math.floor((nowMs - rec.pausedAtMs) / 1000))
                  : 0;
              const totalAwaySec = (rec?.pausedTotalSeconds ?? 0) + activePauseSec;

              return (
                <div
                  key={emp.id}
                  className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 hover:bg-slate-50/70 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="font-mono text-xs font-semibold text-slate-500 tabular-nums">
                        {emp.empCode}
                      </span>
                      <span className="text-base font-semibold text-slate-900">
                        {emp.name}
                      </span>
                      <span className="text-xs text-slate-500">
                        · {emp.department}
                      </span>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                      <StatusLabel status={status} />
                      {rec && (
                        <>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="font-mono tabular-nums">
                            In: <strong className="text-slate-900">{formatDisplayTime(rec.inTime)}</strong>
                          </span>
                        </>
                      )}

                      {isLive && rec && (
                        <>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span
                            className={`inline-flex items-center gap-1.5 font-mono font-semibold tabular-nums ${
                              rec.isPaused ? 'text-amber-700' : 'text-emerald-700'
                            }`}
                          >
                            <Timer className="h-3.5 w-3.5" />
                            <span>
                              {rec.isPaused
                                ? `Paused · ${formatHMS(elapsedSec)}`
                                : formatHMS(elapsedSec)}
                            </span>
                          </span>
                          {totalAwaySec >= 60 && (
                            <>
                              <span aria-hidden="true" className="text-slate-300">
                                ·
                              </span>
                              <span className="font-mono text-amber-700 tabular-nums">
                                Away: {Math.round(totalAwaySec / 60)}m
                              </span>
                            </>
                          )}
                        </>
                      )}

                      {rec?.outTime && (
                        <>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="font-mono tabular-nums">
                            Out: <strong className="text-slate-900">{formatDisplayTime(rec.outTime)}</strong>
                          </span>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="font-mono font-semibold text-teal-800 tabular-nums">
                            {formatDurationHM(rec.netMinutes)} ({rec.netDecimalHours?.toFixed(2)}h)
                          </span>
                          {(rec.overtimeMinutes ?? 0) > 0 && (
                            <>
                              <span aria-hidden="true" className="text-slate-300">
                                ·
                              </span>
                              <span className="font-mono font-semibold text-amber-700 tabular-nums">
                                OT: {(rec.overtimeDecimalHours ?? 0).toFixed(2)}h
                              </span>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {!rec ? (
                      <button
                        type="button"
                        onClick={() => setPendingAction({ mode: 'in', employee: emp })}
                        className="inline-flex w-full sm:w-auto min-h-[44px] items-center justify-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800 active:scale-[0.99] transition-all whitespace-nowrap shrink-0"
                      >
                        <LogIn className="h-4 w-4" />
                        <span>Mark IN</span>
                      </button>
                    ) : rec.status === 'on_duty' ? (
                      <>
                        <button
                          type="button"
                          disabled={busyRecordId === rec.id}
                          onClick={() => handleTogglePause(rec)}
                          className={`inline-flex flex-1 sm:flex-initial min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all whitespace-nowrap shrink-0 disabled:opacity-60 ${
                            rec.isPaused
                              ? 'bg-slate-900 text-white hover:bg-slate-800'
                              : 'border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                          }`}
                        >
                          {rec.isPaused ? (
                            <>
                              <Play className="h-4 w-4" />
                              <span>Start Timing</span>
                            </>
                          ) : (
                            <>
                              <Pause className="h-4 w-4" />
                              <span>Stop Timing</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setPendingAction({ mode: 'out', employee: emp, record: rec })
                          }
                          className="inline-flex flex-1 sm:flex-initial min-h-[44px] items-center justify-center gap-2 rounded-lg bg-teal-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-teal-800 active:scale-[0.99] transition-all whitespace-nowrap shrink-0"
                        >
                          <LogOut className="h-4 w-4" />
                          <span>Mark OUT</span>
                        </button>
                      </>
                    ) : (
                      <div className="inline-flex min-h-[44px] items-center gap-1.5 px-3 text-xs font-medium text-teal-800 whitespace-nowrap">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>Shift Recorded</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Strict Live-Time 1-Tap Confirmation Modal */}
      {pendingAction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="guard-confirm-title"
        >
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h3 id="guard-confirm-title" className="text-base font-semibold text-slate-900">
                {pendingAction.mode === 'in' ? 'Confirm Check-In' : 'Confirm Check-Out'}
              </h3>
              <button
                type="button"
                onClick={() => setPendingAction(null)}
                disabled={submitting}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Cancel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div>
                <div className="font-mono text-xs text-slate-500">
                  {pendingAction.employee.empCode}
                </div>
                <div className="mt-0.5 text-lg font-bold text-slate-900">
                  {pendingAction.employee.name}
                </div>
              </div>

              {pendingAction.mode === 'in' ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-600">Current Time</span>
                  <span className="font-mono text-base font-semibold text-slate-900 tabular-nums">
                    {formatDisplayTime(liveNowHHMM)}
                  </span>
                </div>
              ) : (
                <div className="rounded-lg border border-teal-200 bg-teal-50/60 px-4 py-3 space-y-2 text-xs">
                  <div className="flex items-center justify-between text-slate-700">
                    <span>In Time</span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatDisplayTime(pendingAction.record?.inTime ?? null)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-700">
                    <span>Out Time (Now)</span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatDisplayTime(liveNowHHMM)}
                    </span>
                  </div>
                  {checkoutPreview && (
                    <>
                      {checkoutPreview.totalAwayMinutes > 0 && (
                        <div className="flex items-center justify-between text-slate-700">
                          <span>Away / Paused Time</span>
                          <span className="font-mono font-medium text-amber-800 tabular-nums">
                            -{checkoutPreview.totalAwayMinutes} min
                          </span>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-slate-700">
                        <span>Lunch Break</span>
                        <span className="font-mono font-medium text-amber-800 tabular-nums">
                          {checkoutPreview.breakDeductedMinutes > 0
                            ? `-${checkoutPreview.breakDeductedMinutes} min`
                            : '0 min (< 4.5h)'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between border-t border-teal-200 pt-2 text-sm font-semibold text-teal-900">
                        <span>Working Hours</span>
                        <span className="font-mono tabular-nums">
                          {formatDurationHM(checkoutPreview.netMinutes)} ({checkoutPreview.netDecimalHours.toFixed(2)}h)
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs font-semibold text-amber-800">
                        <span>
                          {checkoutPreview.isSunday ? 'Sunday Overtime (100%)' : 'Overtime (>8h)'}
                        </span>
                        <span className="font-mono tabular-nums">
                          {formatDurationHM(checkoutPreview.overtimeMinutes)} ({checkoutPreview.overtimeDecimalHours.toFixed(2)}h)
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setPendingAction(null)}
                  disabled={submitting}
                  className="min-h-[44px] rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={submitting}
                  className={`min-h-[44px] flex-1 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
                    pendingAction.mode === 'in'
                      ? 'bg-slate-900 hover:bg-slate-800'
                      : 'bg-teal-700 hover:bg-teal-800'
                  }`}
                >
                  {submitting
                    ? 'Marking...'
                    : pendingAction.mode === 'in'
                    ? 'Confirm IN'
                    : 'Confirm OUT'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

