import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  Edit3,
  ExternalLink,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import {
  COMPANY_CATEGORIES,
  CompanyCategory,
  DEFAULT_COMPANY_CATEGORY,
  Employee,
} from '../types/attendance';
import {
  formatHourlyRateINR,
  getEmployeeHourlyRate,
  normalizeCompanyCategory,
} from '../utils/time';

interface EmployeesViewProps {
  employees: Employee[];
  hasConnectedSheets?: boolean;
  isSyncing?: boolean;
  onSaveEmployee: (employee: Employee, isNew: boolean) => Promise<void>;
  onToggleActive: (employee: Employee) => Promise<void>;
  onDeleteEmployee: (employee: Employee) => void;
  onLoadStarterRoster: () => Promise<void>;
  onRequestUpdateAllSheets?: () => void;
}

export const EmployeesView: React.FC<EmployeesViewProps> = ({
  employees,
  hasConnectedSheets = false,
  isSyncing = false,
  onSaveEmployee,
  onToggleActive,
  onDeleteEmployee,
  onLoadStarterRoster,
  onRequestUpdateAllSheets,
}) => {
  const [modalEmp, setModalEmp] = useState<{
    isNew: boolean;
    data: Employee;
  } | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<'all' | CompanyCategory>('all');
  const [rateInput, setRateInput] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [tableAlert, setTableAlert] = useState<string | null>(null);

  const categoryCounts = useMemo(() => {
    let permanent = 0;
    let temporary = 0;
    for (const emp of employees) {
      if (normalizeCompanyCategory(emp.companyCategory) === 'Sukhsa Export Temporary') {
        temporary += 1;
      } else {
        permanent += 1;
      }
    }
    return { total: employees.length, permanent, temporary };
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    if (categoryFilter === 'all') return employees;
    return employees.filter(
      (emp) => normalizeCompanyCategory(emp.companyCategory) === categoryFilter
    );
  }, [employees, categoryFilter]);

  const empCodeValidation = useMemo(() => {
    if (!modalEmp) {
      return {
        activeConflict: undefined as Employee | undefined,
        inactiveMatch: undefined as Employee | undefined,
      };
    }
    const entered = modalEmp.data.empCode.trim().toLowerCase();
    if (!entered) {
      return { activeConflict: undefined, inactiveMatch: undefined };
    }
    const activeConflict = employees.find(
      (e) =>
        e.id !== modalEmp.data.id &&
        e.active &&
        e.empCode.trim().toLowerCase() === entered
    );
    const inactiveMatch = !activeConflict
      ? employees.find(
          (e) =>
            e.id !== modalEmp.data.id &&
            !e.active &&
            e.empCode.trim().toLowerCase() === entered
        )
      : undefined;
    return { activeConflict, inactiveMatch };
  }, [modalEmp, employees]);

  const openNewModal = () => {
    const existingLower = new Set(
      employees.map((e) => e.empCode.trim().toLowerCase())
    );
    let nextNum = employees.length + 1;
    let code = `EMP-${String(nextNum).padStart(3, '0')}`;
    while (existingLower.has(code.toLowerCase())) {
      nextNum += 1;
      code = `EMP-${String(nextNum).padStart(3, '0')}`;
    }

    setFormError(null);
    setTableAlert(null);
    setRateInput('');
    setModalEmp({
      isNew: true,
      data: {
        id: `emp-${Date.now()}`,
        empCode: code,
        name: '',
        department: 'Production',
        companyCategory:
          categoryFilter !== 'all' ? categoryFilter : DEFAULT_COMPANY_CATEGORY,
        breakMinutes: 30,
        hourlyRate: 0,
        active: true,
      },
    });
  };

  const openEditModal = (emp: Employee) => {
    setFormError(null);
    setTableAlert(null);
    const existingRate = getEmployeeHourlyRate(emp);
    setRateInput(existingRate > 0 ? String(existingRate) : '');
    setModalEmp({
      isNew: false,
      data: {
        ...emp,
        companyCategory: normalizeCompanyCategory(emp.companyCategory),
        hourlyRate: existingRate,
      },
    });
  };

  const handleToggleActiveClick = async (emp: Employee) => {
    setTableAlert(null);
    if (!emp.active) {
      const entered = emp.empCode.trim().toLowerCase();
      const activeConflict = employees.find(
        (e) =>
          e.id !== emp.id &&
          e.active &&
          e.empCode.trim().toLowerCase() === entered
      );
      if (activeConflict) {
        setTableAlert(
          `Cannot activate ${emp.name}: Employee ID "${emp.empCode}" is currently assigned to active employee ${activeConflict.name}. Edit ${emp.name}'s Employee ID first.`
        );
        return;
      }
    }
    try {
      await onToggleActive(emp);
    } catch (err) {
      setTableAlert((err as Error)?.message || 'Could not update employee status.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalEmp) return;

    const trimmedCode = modalEmp.data.empCode.trim();
    if (!trimmedCode) {
      setFormError('Employee ID is required.');
      return;
    }

    if (empCodeValidation.activeConflict) {
      setFormError(
        `Employee ID "${trimmedCode}" is already assigned to active employee ${empCodeValidation.activeConflict.name}. You can only reuse an ID if that employee is Inactive.`
      );
      return;
    }

    const cleanRateInput = rateInput.trim();
    const parsedRate = Number(cleanRateInput);
    if (cleanRateInput !== '') {
      if (Number.isNaN(parsedRate) || parsedRate < 0) {
        setFormError('Hourly rate must be 0 or a positive number.');
        return;
      }
      const decimalPart = cleanRateInput.split('.')[1];
      if (decimalPart && decimalPart.length > 5) {
        setFormError('Hourly rate can have at most 5 digits after the decimal point.');
        return;
      }
    }
    const cleanRate =
      cleanRateInput !== '' && parsedRate > 0
        ? Math.min(1000000, Number(parsedRate.toFixed(5)))
        : 0;

    setFormError(null);
    setSaving(true);
    try {
      await onSaveEmployee(
        {
          ...modalEmp.data,
          empCode: trimmedCode,
          name: modalEmp.data.name.trim(),
          department: modalEmp.data.department.trim() || 'General',
          companyCategory: normalizeCompanyCategory(modalEmp.data.companyCategory),
          breakMinutes: 30,
          hourlyRate: cleanRate,
        },
        modalEmp.isNew
      );
      setModalEmp(null);
    } catch (err) {
      setFormError((err as Error)?.message || 'Could not save employee.');
    } finally {
      setSaving(false);
    }
  };

  const liveConflictMessage = empCodeValidation.activeConflict
    ? `Employee ID "${modalEmp?.data.empCode.trim()}" is already used by active employee ${empCodeValidation.activeConflict.name}. You can only reuse an ID when that employee is Inactive.`
    : null;
  const activeAlertText = formError || liveConflictMessage;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Employees</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Active employees appear immediately on the Guard Gate Desk and sync to Google Sheets with their company category.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {hasConnectedSheets && onRequestUpdateAllSheets && (
              <button
                type="button"
                onClick={onRequestUpdateAllSheets}
                disabled={isSyncing}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                <span>{isSyncing ? 'Updating Sheets...' : 'Update All Sheets'}</span>
              </button>
            )}
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

        {tableAlert && (
          <div className="mx-6 my-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-800">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
              <span>{tableAlert}</span>
            </div>
            <button
              type="button"
              onClick={() => setTableAlert(null)}
              className="rounded p-1 text-red-600 hover:bg-red-100"
              aria-label="Dismiss alert"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {employees.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/70 px-6 py-3">
            <span className="text-xs font-medium text-slate-500 mr-1">Company List:</span>
            <button
              type="button"
              onClick={() => setCategoryFilter('all')}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                categoryFilter === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
              }`}
            >
              All ({categoryCounts.total})
            </button>
            {COMPANY_CATEGORIES.map((category) => {
              const count =
                category === 'Sukhsa Export Permanent'
                  ? categoryCounts.permanent
                  : categoryCounts.temporary;
              const isSelected = categoryFilter === category;
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setCategoryFilter(category)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    isSelected
                      ? 'bg-slate-900 text-white'
                      : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {category} ({count})
                </button>
              );
            })}
          </div>
        )}

        {employees.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-base font-semibold text-slate-900">No employees added yet</p>
            <p className="mt-1 text-sm text-slate-500">
              Add your staff members so they appear on the Guard Gate Desk.
            </p>
          </div>
        ) : filteredEmployees.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-base font-semibold text-slate-900">
              No employees in {categoryFilter}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Click Add Employee to add staff under {categoryFilter}.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                  <th className="px-6 py-3 whitespace-nowrap">Employee ID</th>
                  <th className="px-4 py-3 whitespace-nowrap">Name</th>
                  <th className="px-4 py-3 whitespace-nowrap">Company Category</th>
                  <th className="px-4 py-3 whitespace-nowrap">Department</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Hourly Rate</th>
                  <th className="px-4 py-3 whitespace-nowrap">Individual Sheet</th>
                  <th className="px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="px-6 py-3 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredEmployees.map((emp) => {
                  const category = normalizeCompanyCategory(emp.companyCategory);
                  const isTemp = category === 'Sukhsa Export Temporary';
                  const rate = getEmployeeHourlyRate(emp);
                  return (
                    <tr key={emp.id} className="hover:bg-slate-50/80">
                      <td className="px-6 py-3.5 font-mono text-xs font-medium text-slate-800 tabular-nums whitespace-nowrap">
                        {emp.empCode}
                      </td>
                      <td className="px-4 py-3.5 font-medium text-slate-900 whitespace-nowrap">
                        {emp.name}
                      </td>
                      <td className="px-4 py-3.5 text-xs whitespace-nowrap">
                        <span
                          className={`font-medium ${
                            isTemp ? 'text-amber-800' : 'text-teal-800'
                          }`}
                        >
                          {category}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-600">
                        {emp.department}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs font-medium tabular-nums whitespace-nowrap">
                        {rate > 0 ? (
                          <span className="text-slate-900">{formatHourlyRateINR(rate)}/hr</span>
                        ) : (
                          <span className="text-slate-400">Not set</span>
                        )}
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
                            onClick={() => handleToggleActiveClick(emp)}
                            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            {emp.active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteEmployee(emp)}
                            className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                            aria-label={`Delete ${emp.name}`}
                            title="Delete employee permanently"
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
                {modalEmp.isNew ? 'Add Employee' : 'Edit Employee'}
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
              {activeAlertText && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-800"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 text-red-600 mt-0.5" />
                  <span>{activeAlertText}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700">Employee ID</label>
                <input
                  type="text"
                  required
                  value={modalEmp.data.empCode}
                  onChange={(e) => {
                    setFormError(null);
                    setModalEmp({
                      ...modalEmp,
                      data: { ...modalEmp.data, empCode: e.target.value },
                    });
                  }}
                  aria-invalid={Boolean(empCodeValidation.activeConflict)}
                  className={`mt-1.5 w-full rounded-lg border px-3 py-2 font-mono text-sm focus:outline-none ${
                    empCodeValidation.activeConflict
                      ? 'border-red-400 bg-red-50/40 text-red-900 focus:border-red-600'
                      : 'border-slate-300 focus:border-teal-700'
                  }`}
                />
                {empCodeValidation.inactiveMatch && (
                  <p className="mt-1.5 text-[11px] font-medium text-amber-800">
                    Previously used by inactive employee {empCodeValidation.inactiveMatch.name} — allowed to reuse.
                  </p>
                )}
              </div>

              <div>
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

              <div>
                <label
                  htmlFor="employee-company-category"
                  className="block text-xs font-medium text-slate-700"
                >
                  Company List Category
                </label>
                <select
                  id="employee-company-category"
                  required
                  value={normalizeCompanyCategory(modalEmp.data.companyCategory)}
                  onChange={(e) =>
                    setModalEmp({
                      ...modalEmp,
                      data: {
                        ...modalEmp.data,
                        companyCategory: normalizeCompanyCategory(e.target.value),
                      },
                    })
                  }
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                >
                  {COMPANY_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                    placeholder="e.g., Production"
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label
                    htmlFor="employee-hourly-rate"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Per Hour Rate (₹ / hr)
                  </label>
                  <input
                    id="employee-hourly-rate"
                    type="number"
                    min={0}
                    max={1000000}
                    step="0.00001"
                    value={rateInput}
                    onChange={(e) => {
                      setFormError(null);
                      setRateInput(e.target.value);
                    }}
                    placeholder="e.g., 75 or 75.12345"
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm tabular-nums focus:border-teal-700 focus:outline-none"
                  />
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
                Pay calculation: (Total Working Hours − Theka Work) × Per Hour Rate. Break (30m) is deducted only for 4.5h+ shifts.
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
                <div>
                  {!modalEmp.isNew && (
                    <button
                      type="button"
                      onClick={() => {
                        const target = modalEmp.data;
                        setModalEmp(null);
                        onDeleteEmployee(target);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete</span>
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setModalEmp(null)}
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving || Boolean(empCodeValidation.activeConflict)}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
                  >
                    {saving ? 'Saving...' : modalEmp.isNew ? 'Add Employee' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
