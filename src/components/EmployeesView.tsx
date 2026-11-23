import React, { useState } from 'react';
import { Edit3, ExternalLink, Plus, UserPlus, X } from 'lucide-react';
import { Employee } from '../types/attendance';

interface EmployeesViewProps {
  employees: Employee[];
  onSaveEmployee: (employee: Employee, isNew: boolean) => Promise<void>;
  onToggleActive: (employee: Employee) => Promise<void>;
  onLoadStarterRoster: () => void;
}

export const EmployeesView: React.FC<EmployeesViewProps> = ({
  employees,
  onSaveEmployee,
  onToggleActive,
  onLoadStarterRoster,
}) => {
  const [modalEmp, setModalEmp] = useState<{
    isNew: boolean;
    data: Employee;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const openNewModal = () => {
    const nextNum = employees.length + 1;
    const code = `EMP-${String(nextNum).padStart(3, '0')}`;
    setModalEmp({
      isNew: true,
      data: {
        id: `emp-${Date.now()}`,
        empCode: code,
        name: '',
        department: 'Production Floor',
        role: 'Staff',
        shiftStart: '09:00',
        shiftEnd: '18:00',
        breakMinutes: 30,
        active: true,
      },
    });
  };

  const openEditModal = (emp: Employee) => {
    setModalEmp({
      isNew: false,
      data: { ...emp },
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalEmp) return;
    setSaving(true);
    try {
      await onSaveEmployee(
        {
          ...modalEmp.data,
          empCode: modalEmp.data.empCode.trim(),
          name: modalEmp.data.name.trim(),
          department: modalEmp.data.department.trim() || 'General',
          role: modalEmp.data.role.trim() || 'Staff',
        },
        modalEmp.isNew
      );
      setModalEmp(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Employee Directory</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Each active employee automatically gets an individual attendance tab inside your Master Google Sheet.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {employees.length === 0 && (
              <button
                type="button"
                onClick={onLoadStarterRoster}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Load Starter Roster</span>
              </button>
            )}
            <button
              type="button"
              onClick={openNewModal}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <UserPlus className="h-3.5 w-3.5" />
              <span>Add Employee</span>
            </button>
          </div>
        </div>

        {employees.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-base font-semibold text-slate-900">No employees added yet</p>
            <p className="mt-1 text-sm text-slate-500">
              Add employees with their shift timings and 30-minute break policy to begin gate tracking.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                  <th className="px-6 py-3 whitespace-nowrap">Emp ID</th>
                  <th className="px-4 py-3 whitespace-nowrap">Full Name</th>
                  <th className="px-4 py-3 whitespace-nowrap">Department & Role</th>
                  <th className="px-4 py-3 whitespace-nowrap">Shift Hours</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Break Deduction</th>
                  <th className="px-4 py-3 whitespace-nowrap">Dedicated Sheet</th>
                  <th className="px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="px-6 py-3 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {employees.map((emp) => (
                  <tr key={emp.id} className="hover:bg-slate-50/80">
                    <td className="px-6 py-3.5 font-mono text-xs font-medium text-slate-800 tabular-nums whitespace-nowrap">
                      {emp.empCode}
                    </td>
                    <td className="px-4 py-3.5 font-medium text-slate-900 whitespace-nowrap">
                      {emp.name}
                    </td>
                    <td className="px-4 py-3.5 text-xs text-slate-600">
                      {emp.department} · {emp.role}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                      {emp.shiftStart} – {emp.shiftEnd}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                      {emp.breakMinutes} min
                    </td>
                    <td className="px-4 py-3.5 text-xs whitespace-nowrap">
                      {emp.individualSheetUrl ? (
                        <a
                          href={emp.individualSheetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline"
                        >
                          <span>Open File</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-slate-400">Master Workbook Tab</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-xs font-medium whitespace-nowrap">
                      <span className={emp.active ? 'text-emerald-700' : 'text-slate-400'}>
                        {emp.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openEditModal(emp)}
                          className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          aria-label={`Edit ${emp.name}`}
                        >
                          <Edit3 className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleActive(emp)}
                          className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          {emp.active ? 'Deactivate' : 'Activate'}
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

      {/* Add/Edit Employee Modal */}
      {modalEmp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h3 className="text-base font-semibold text-slate-900">
                {modalEmp.isNew ? 'Add New Employee' : 'Edit Employee'}
              </h3>
              <button
                type="button"
                onClick={() => setModalEmp(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Emp ID</label>
                  <input
                    type="text"
                    required
                    value={modalEmp.data.empCode}
                    onChange={(e) =>
                      setModalEmp({
                        ...modalEmp,
                        data: { ...modalEmp.data, empCode: e.target.value },
                      })
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-700">Full Name</label>
                  <input
                    type="text"
                    required
                    value={modalEmp.data.name}
                    onChange={(e) =>
                      setModalEmp({
                        ...modalEmp,
                        data: { ...modalEmp.data, name: e.target.value },
                      })
                    }
                    placeholder="e.g., Rajesh Kumar"
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Department</label>
                  <input
                    type="text"
                    value={modalEmp.data.department}
                    onChange={(e) =>
                      setModalEmp({
                        ...modalEmp,
                        data: { ...modalEmp.data, department: e.target.value },
                      })
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Role</label>
                  <input
                    type="text"
                    value={modalEmp.data.role}
                    onChange={(e) =>
                      setModalEmp({
                        ...modalEmp,
                        data: { ...modalEmp.data, role: e.target.value },
                      })
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Shift Start</label>
                  <input
                    type="time"
                    value={modalEmp.data.shiftStart}
                    onChange={(e) =>
                      setModalEmp({
                        ...modalEmp,
                        data: { ...modalEmp.data, shiftStart: e.target.value },
                      })
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Shift End</label>
                  <input
                    type="time"
                    value={modalEmp.data.shiftEnd}
                    onChange={(e) =>
                      setModalEmp({
                        ...modalEmp,
                        data: { ...modalEmp.data, shiftEnd: e.target.value },
                      })
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Break (min)</label>
                  <input
                    type="number"
                    min={0}
                    max={180}
                    value={modalEmp.data.breakMinutes}
                    onChange={(e) =>
                      setModalEmp({
                        ...modalEmp,
                        data: {
                          ...modalEmp.data,
                          breakMinutes: Number(e.target.value) || 0,
                        },
                      })
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setModalEmp(null)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                >
                  {saving ? 'Saving...' : modalEmp.isNew ? 'Add Employee' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
