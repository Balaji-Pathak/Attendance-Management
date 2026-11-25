import React, { useMemo, useState } from 'react';
import { Edit3, ExternalLink, Plus, UserPlus, X } from 'lucide-react';
import {
  COMPANY_CATEGORIES,
  CompanyCategory,
  DEFAULT_COMPANY_CATEGORY,
  Employee,
} from '../types/attendance';
import { normalizeCompanyCategory } from '../utils/time';

interface EmployeesViewProps {
  employees: Employee[];
  onSaveEmployee: (employee: Employee, isNew: boolean) => Promise<void>;
  onToggleActive: (employee: Employee) => Promise<void>;
  onLoadStarterRoster: () => Promise<void>;
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
  const [categoryFilter, setCategoryFilter] = useState<'all' | CompanyCategory>('all');
  const [saving, setSaving] = useState(false);

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

  const openNewModal = () => {
    const nextNum = employees.length + 1;
    const code = `EMP-${String(nextNum).padStart(3, '0')}`;
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
        active: true,
      },
    });
  };

  const openEditModal = (emp: Employee) => {
    setModalEmp({
      isNew: false,
      data: {
        ...emp,
        companyCategory: normalizeCompanyCategory(emp.companyCategory),
      },
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
          companyCategory: normalizeCompanyCategory(modalEmp.data.companyCategory),
          breakMinutes: 30,
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
            <h2 className="text-base font-semibold text-slate-900">Employees</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Active employees appear immediately on the Guard Gate Desk and sync to Google Sheets with their company category.
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
                  <th className="px-4 py-3 whitespace-nowrap">Individual Sheet</th>
                  <th className="px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="px-6 py-3 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredEmployees.map((emp) => {
                  const category = normalizeCompanyCategory(emp.companyCategory);
                  const isTemp = category === 'Sukhsa Export Temporary';
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
              <div>
                <label className="block text-xs font-medium text-slate-700">Employee ID</label>
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

              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
                Break policy: 30 minutes automatically deducted only when working hours are 4.5 hours or more.
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
