import {
  AttendanceRecord,
  CompanyCategory,
  DriveSpreadsheetItem,
  Employee,
  SheetConfig,
} from '../types/attendance';
import {
  calculateShiftMetrics,
  formatDisplayTime,
  formatMonthLabel,
  getDayNameShort,
  getEmployeeHourlyRate,
  getEmployeeSheetTabName,
  getRecordPayroll,
  isSundayISO,
  normalizeCompanyCategory,
  parseDisplayTimeToHHMM,
} from '../utils/time';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';

export const MASTER_TAB_NAME = 'Master Attendance';
export const EMPLOYEES_TAB_NAME = 'Employees';

const MONTHLY_SUMMARY_HEADERS = [
  'Employee ID',
  'Employee Name',
  'Department',
  'Hourly Rate',
  'Working Hours',
  'Present (P)',
  'Theka Work (H)',
  'Normal Hours (H)',
  'Net Payable',
];

const EMPLOYEES_HEADERS = [
  'Employee ID',
  'Name',
  'Company Category',
  'Department',
  'Hourly Rate',
  'Status',
  'Individual Sheet Link',
];

const INDIVIDUAL_HEADERS = [
  'Date',
  'Day',
  'In Time',
  'Out Time',
  'Away (mins)',
  'Working Hours',
  'Present (P)',
  'Overtime (hrs)',
  'Normal Hours (H)',
  'Payable Amount',
];

async function apiFetch<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `Google API error (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody?.error?.message) {
        message = errBody.error.message;
      }
    } catch {
      // Ignore parse error
    }
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }

  return res.json() as Promise<T>;
}

export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) return match[1];
  return trimmed;
}

export async function listAppSpreadsheets(token: string): Promise<DriveSpreadsheetItem[]> {
  const q = encodeURIComponent(
    "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
  );
  const fields = encodeURIComponent('files(id,name,modifiedTime,webViewLink)');
  const data = await apiFetch<{ files?: DriveSpreadsheetItem[] }>(
    `${DRIVE_BASE}?q=${q}&fields=${fields}&orderBy=modifiedTime desc&pageSize=30`,
    token
  );
  return data.files ?? [];
}

export async function trashSpreadsheet(
  token: string,
  spreadsheetId: string
): Promise<{ trashed: boolean; reason?: string }> {
  try {
    await apiFetch(`${DRIVE_BASE}/${encodeURIComponent(spreadsheetId)}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ trashed: true }),
    });
    return { trashed: true };
  } catch (err) {
    const errorObj = err as Error & { status?: number };
    if (errorObj?.status === 401) {
      throw err;
    }
    return {
      trashed: false,
      reason:
        errorObj?.message ||
        'Could not delete file in Google Drive (only the file owner can move it to Trash).',
    };
  }
}

function filterByCompanyCategory(
  employees: Employee[],
  records: AttendanceRecord[],
  companyCategory?: CompanyCategory
): { employees: Employee[]; records: AttendanceRecord[]; otherTabNames: Set<string> } {
  if (!companyCategory) {
    return { employees, records, otherTabNames: new Set() };
  }
  const catEmployees = employees.filter(
    (e) => normalizeCompanyCategory(e.companyCategory) === companyCategory
  );
  const empIds = new Set(catEmployees.map((e) => e.id));
  const empCodes = new Set(catEmployees.map((e) => e.empCode));
  const catRecords = records.filter(
    (r) => empIds.has(r.empId) || empCodes.has(r.empCode)
  );
  const otherTabNames = new Set(
    employees
      .filter((e) => normalizeCompanyCategory(e.companyCategory) !== companyCategory)
      .map((e) => getEmployeeSheetTabName(e.empCode, e.name))
  );
  return { employees: catEmployees, records: catRecords, otherTabNames };
}

interface SpreadsheetMetadataResponse {
  spreadsheetId: string;
  spreadsheetUrl: string;
  properties: { title: string };
  sheets: Array<{
    properties: {
      sheetId: number;
      title: string;
      index: number;
    };
  }>;
}

export async function getSpreadsheetMetadata(
  token: string,
  spreadsheetId: string
): Promise<SpreadsheetMetadataResponse> {
  const fields = encodeURIComponent(
    'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title,index)'
  );
  return apiFetch<SpreadsheetMetadataResponse>(
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}?fields=${fields}`,
    token
  );
}

function getCategoryMonthsToSync(
  employees: Employee[],
  records: AttendanceRecord[]
): Array<{ ym: string; title: string }> {
  const monthSet = new Set<string>();
  for (const r of records) {
    if (r.date && /^\d{4}-\d{2}/.test(r.date)) {
      monthSet.add(r.date.slice(0, 7));
    }
  }
  for (const emp of employees) {
    for (const [ym, mins] of Object.entries(emp.monthlyThikadaMinutes ?? {})) {
      if (/^\d{4}-\d{2}$/.test(ym) && typeof mins === 'number' && mins > 0) {
        monthSet.add(ym);
      }
    }
  }
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  monthSet.add(currentYm);

  return Array.from(monthSet)
    .sort((a, b) => b.localeCompare(a))
    .map((ym) => ({ ym, title: formatMonthLabel(ym) }));
}

function buildMegaMonthlySummaryRows(
  yearMonth: string,
  employees: Employee[],
  records: AttendanceRecord[],
  companyCategory?: CompanyCategory
): { rows: (string | number)[][]; employeeRowCount: number } {
  const monthRecs = records.filter((r) => r.date.startsWith(yearMonth));

  const summaryEmployees = employees
    .filter((emp) => {
      if (emp.active) return true;
      const hasRecs = monthRecs.some(
        (r) => r.empId === emp.id || r.empCode === emp.empCode
      );
      const hasTheka = (emp.monthlyThikadaMinutes?.[yearMonth] ?? 0) > 0;
      return hasRecs || hasTheka;
    })
    .sort((a, b) => a.empCode.localeCompare(b.empCode));

  const empRowCount = summaryEmployees.length;
  const lastDataRow = empRowCount > 0 ? 3 + empRowCount : 4;
  const totalRowIdx = 4 + empRowCount;

  const bannerRow: (string | number)[] = [
    'Company',
    companyCategory ?? 'All Companies',
    'Month',
    formatMonthLabel(yearMonth),
    'Employees',
    empRowCount > 0 ? `=COUNTA(A4:A${lastDataRow})` : 0,
    'Total Net Payable',
    empRowCount > 0 ? `=I${totalRowIdx}` : 0,
    'Payable = (Working - Theka) × Rate',
  ];

  const dataRows: (string | number)[][] = summaryEmployees.map((emp, idx) => {
    const empMonthRecs = monthRecs.filter(
      (r) => r.empId === emp.id || r.empCode === emp.empCode
    );

    let netMinutes = 0;
    let presentCount = 0;
    let grossNormalMinutes = 0;

    for (const r of empMonthRecs) {
      if (r.outTime && r.netMinutes !== null) {
        netMinutes += r.netMinutes;
        const p = getRecordPayroll(r);
        presentCount += p.presentCount;
        grossNormalMinutes += p.grossNormalMinutes;
      }
    }

    const thekaMinutes = emp.monthlyThikadaMinutes?.[yearMonth] ?? 0;
    const netNormalMinutes = Math.max(0, grossNormalMinutes - thekaMinutes);
    const workingDecimal = Number((netMinutes / 60).toFixed(2));
    const thekaDecimal = Number((thekaMinutes / 60).toFixed(2));
    const netNormalDecimal = Number((netNormalMinutes / 60).toFixed(2));
    const rate = getEmployeeHourlyRate(emp);
    const rowNum = 4 + idx;

    return [
      emp.empCode,
      emp.name,
      emp.department || 'General',
      rate,
      workingDecimal,
      presentCount,
      thekaDecimal,
      netNormalDecimal,
      `=MAX(0, E${rowNum}-G${rowNum})*D${rowNum}`,
    ];
  });

  const rows: (string | number)[][] = [
    bannerRow,
    [],
    MONTHLY_SUMMARY_HEADERS,
    ...dataRows,
  ];

  if (empRowCount > 0) {
    rows.push([
      'TOTAL',
      `=COUNTA(A4:A${lastDataRow}) & " Staff"`,
      '',
      '',
      `=SUM(E4:E${lastDataRow})`,
      `=SUM(F4:F${lastDataRow})`,
      `=SUM(G4:G${lastDataRow})`,
      `=SUM(H4:H${lastDataRow})`,
      `=SUM(I4:I${lastDataRow})`,
    ]);
  }

  return { rows, employeeRowCount: empRowCount };
}

function buildEmployeesRows(employees: Employee[]): (string | number)[][] {
  return [
    EMPLOYEES_HEADERS,
    ...employees.map((e) => [
      e.empCode,
      e.name,
      normalizeCompanyCategory(e.companyCategory),
      e.department,
      getEmployeeHourlyRate(e),
      e.active ? 'Active' : 'Inactive',
      e.individualSheetUrl ?? '',
    ]),
  ];
}

function getMonthlyThekaDecimal(employee: Employee, monthFilter?: string): number {
  const map = employee.monthlyThikadaMinutes ?? {};
  if (monthFilter) {
    return Number(((map[monthFilter] ?? 0) / 60).toFixed(2));
  }
  const totalMins = Object.values(map).reduce(
    (sum, v) => sum + (typeof v === 'number' && v > 0 ? v : 0),
    0
  );
  return Number((totalMins / 60).toFixed(2));
}

function buildIndividualEmployeeRows(
  employee: Employee,
  records: AttendanceRecord[],
  monthFilter?: string
): (string | number)[][] {
  const empRecords = records
    .filter(
      (r) =>
        (r.empId === employee.id || r.empCode === employee.empCode) &&
        (!monthFilter || r.date.startsWith(monthFilter))
    )
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.inTime.localeCompare(b.inTime);
    });

  const lastDataRow = empRecords.length > 0 ? 4 + empRecords.length : 5;
  const monthlyThekaDec = getMonthlyThekaDecimal(employee, monthFilter);
  const periodLabel = monthFilter ? formatMonthLabel(monthFilter) : 'All Months';
  const empRate = getEmployeeHourlyRate(employee);

  const bannerRow1: (string | number)[] = [
    'Company',
    normalizeCompanyCategory(employee.companyCategory),
    'Employee',
    `${employee.empCode} - ${employee.name}`,
    'Period',
    periodLabel,
    'Hourly Rate',
    empRate,
    'Shift Rule',
    '8h=1 P | <8h/OT/Sun=H',
  ];

  const bannerRow2: (string | number)[] = [
    'Present (P)',
    `=SUM(G5:G${lastDataRow})`,
    'Total Working (H)',
    `=SUM(F5:F${lastDataRow})`,
    'Theka Work (H)',
    monthlyThekaDec,
    'Net Normal (H)',
    `=MAX(0, SUM(I5:I${lastDataRow})-F2)`,
    'Net Payable',
    '=MAX(0, D2-F2)*H1',
  ];

  const dataRows = empRecords.map((r, idx) => {
    const p = getRecordPayroll(r);
    const hasOut = Boolean(r.outTime && r.netMinutes !== null);
    const rowNum = 5 + idx;
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
      hasOut ? `=F${rowNum}*$H$1` : '',
    ];
  });

  const rows: (string | number)[][] = [
    bannerRow1,
    bannerRow2,
    [],
    INDIVIDUAL_HEADERS,
    ...dataRows,
  ];

  if (empRecords.length > 0) {
    const totalRowIdx = lastDataRow + 1;
    rows.push([
      'TOTAL (Before Theka)',
      `=COUNTA(A5:A${lastDataRow}) & " Days"`,
      '',
      '',
      `=SUM(E5:E${lastDataRow})`,
      `=SUM(F5:F${lastDataRow})`,
      `=SUM(G5:G${lastDataRow})`,
      `=SUM(H5:H${lastDataRow})`,
      `=SUM(I5:I${lastDataRow})`,
      `=SUM(J5:J${lastDataRow})`,
    ]);
    rows.push([
      'Less: Theka Work (H)',
      '',
      '',
      '',
      '',
      `=-F2`,
      '',
      '',
      `=-F2`,
      `=-F2*$H$1`,
    ]);
    rows.push([
      'NET PAYABLE (After Theka)',
      '',
      '',
      '',
      '',
      `=MAX(0, F${totalRowIdx}-F2)`,
      `=G${totalRowIdx}`,
      `=H${totalRowIdx}`,
      `=MAX(0, I${totalRowIdx}-F2)`,
      `=MAX(0, F${totalRowIdx}-F2)*$H$1`,
    ]);
  }

  return rows;
}

async function formatSheetHeaders(
  token: string,
  spreadsheetId: string,
  sheetMeta: Array<{
    sheetId: number;
    title: string;
    dataRowCount?: number;
    kind?: 'employees' | 'mega_month' | 'individual';
  }>
): Promise<void> {
  const requests: unknown[] = [];

  for (const s of sheetMeta) {
    const kind =
      s.kind ??
      (s.title === EMPLOYEES_TAB_NAME ? 'employees' : 'individual');
    const headerRowIndex =
      kind === 'individual' ? 3 : kind === 'mega_month' ? 2 : 0;
    const freezeCount =
      kind === 'individual' ? 4 : kind === 'mega_month' ? 3 : 1;
    const colCount =
      kind === 'individual' ? 10 : kind === 'mega_month' ? 9 : 7;

    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId: s.sheetId,
          gridProperties: { frozenRowCount: freezeCount },
        },
        fields: 'gridProperties.frozenRowCount',
      },
    });

    requests.push({
      repeatCell: {
        range: {
          sheetId: s.sheetId,
          startRowIndex: headerRowIndex,
          endRowIndex: headerRowIndex + 1,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.06, green: 0.09, blue: 0.16 },
            textFormat: {
              foregroundColor: { red: 1, green: 1, blue: 1 },
              bold: true,
              fontSize: 10,
            },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    });

    if (kind === 'employees') {
      requests.push({
        repeatCell: {
          range: {
            sheetId: s.sheetId,
            startRowIndex: 1,
            endRowIndex: 500,
            startColumnIndex: 4,
            endColumnIndex: 5,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'NUMBER', pattern: '#,##0.00###' },
            },
          },
          fields: 'userEnteredFormat.numberFormat',
        },
      });
    } else if (kind === 'mega_month') {
      // Banner Row 1
      requests.push({
        repeatCell: {
          range: {
            sheetId: s.sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 9,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.94, green: 0.97, blue: 0.97 },
              textFormat: { bold: true, fontSize: 10 },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });

      // Highlight H1 (Total Net Payable)
      requests.push({
        repeatCell: {
          range: {
            sheetId: s.sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 7,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.90, green: 0.98, blue: 0.94 },
              textFormat: {
                foregroundColor: { red: 0.04, green: 0.42, blue: 0.28 },
                bold: true,
                fontSize: 10,
              },
              numberFormat: { type: 'NUMBER', pattern: '#,##0.00' },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,numberFormat)',
        },
      });

      const bodyStart = 3;
      const rowCount = s.dataRowCount ?? 0;
      const totalRowIdx = bodyStart + rowCount;

      // Reset body & leftover column styling
      requests.push({
        repeatCell: {
          range: {
            sheetId: s.sheetId,
            startRowIndex: bodyStart,
            endRowIndex: totalRowIdx + 20,
            startColumnIndex: 0,
            endColumnIndex: 14,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1, green: 1, blue: 1 },
              textFormat: {
                foregroundColor: { red: 0.06, green: 0.09, blue: 0.16 },
                bold: false,
                fontSize: 10,
              },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });

      if (rowCount > 0) {
        // Hourly Rate (Col D) up to 5 decimals
        requests.push({
          repeatCell: {
            range: {
              sheetId: s.sheetId,
              startRowIndex: bodyStart,
              endRowIndex: totalRowIdx,
              startColumnIndex: 3,
              endColumnIndex: 4,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'NUMBER', pattern: '#,##0.00###' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        });
        // Working Hours (E), Theka (G), Normal (H)
        requests.push({
          repeatCell: {
            range: {
              sheetId: s.sheetId,
              startRowIndex: bodyStart,
              endRowIndex: totalRowIdx + 1,
              startColumnIndex: 4,
              endColumnIndex: 5,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'NUMBER', pattern: '0.00' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        });
        requests.push({
          repeatCell: {
            range: {
              sheetId: s.sheetId,
              startRowIndex: bodyStart,
              endRowIndex: totalRowIdx + 1,
              startColumnIndex: 6,
              endColumnIndex: 8,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'NUMBER', pattern: '0.00' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        });
        // Net Payable (Col I)
        requests.push({
          repeatCell: {
            range: {
              sheetId: s.sheetId,
              startRowIndex: bodyStart,
              endRowIndex: totalRowIdx + 1,
              startColumnIndex: 8,
              endColumnIndex: 9,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'NUMBER', pattern: '#,##0.00' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        });
        // TOTAL row
        requests.push({
          repeatCell: {
            range: {
              sheetId: s.sheetId,
              startRowIndex: totalRowIdx,
              endRowIndex: totalRowIdx + 1,
              startColumnIndex: 0,
              endColumnIndex: 9,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.90, green: 0.98, blue: 0.94 },
                textFormat: {
                  foregroundColor: { red: 0.04, green: 0.42, blue: 0.28 },
                  bold: true,
                  fontSize: 10,
                },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        });
      }
    } else if (kind === 'individual') {
      requests.push({
        repeatCell: {
          range: {
            sheetId: s.sheetId,
            startRowIndex: 0,
            endRowIndex: 2,
            startColumnIndex: 0,
            endColumnIndex: 10,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.94, green: 0.97, blue: 0.97 },
              textFormat: { bold: true, fontSize: 10 },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });

      // Format H1 (Hourly Rate) cleanly up to 5 decimal digits
      requests.push({
        repeatCell: {
          range: {
            sheetId: s.sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 7,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'NUMBER', pattern: '#,##0.00###' },
            },
          },
          fields: 'userEnteredFormat.numberFormat',
        },
      });

      // Highlight F2 (Theka Work) and H2 (Net Normal H) in banner
      requests.push({
        repeatCell: {
          range: {
            sheetId: s.sheetId,
            startRowIndex: 1,
            endRowIndex: 2,
            startColumnIndex: 5,
            endColumnIndex: 6,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.99, green: 0.95, blue: 0.95 },
              textFormat: {
                foregroundColor: { red: 0.72, green: 0.11, blue: 0.11 },
                bold: true,
                fontSize: 10,
              },
              numberFormat: { type: 'NUMBER', pattern: '0.00' },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,numberFormat)',
        },
      });

      requests.push({
        repeatCell: {
          range: {
            sheetId: s.sheetId,
            startRowIndex: 1,
            endRowIndex: 2,
            startColumnIndex: 7,
            endColumnIndex: 8,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1, green: 0.97, blue: 0.88 },
              textFormat: {
                foregroundColor: { red: 0.71, green: 0.33, blue: 0.04 },
                bold: true,
                fontSize: 10,
              },
              numberFormat: { type: 'NUMBER', pattern: '0.00' },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,numberFormat)',
        },
      });

      // Highlight J2 (Net Payable = (Total Working - Theka) * Hourly Rate) in banner
      requests.push({
        repeatCell: {
          range: {
            sheetId: s.sheetId,
            startRowIndex: 1,
            endRowIndex: 2,
            startColumnIndex: 9,
            endColumnIndex: 10,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.90, green: 0.98, blue: 0.94 },
              textFormat: {
                foregroundColor: { red: 0.04, green: 0.42, blue: 0.28 },
                bold: true,
                fontSize: 10,
              },
              numberFormat: { type: 'NUMBER', pattern: '#,##0.00' },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,numberFormat)',
        },
      });

      if (typeof s.dataRowCount === 'number' && s.dataRowCount >= 0) {
        const bodyStart = 4;
        const totalRowIdx = 4 + s.dataRowCount;
        const thekaRowIdx = totalRowIdx + 1;
        const netPayableRowIdx = totalRowIdx + 2;

        // Reset data area formatting cleanly (including any leftover columns K-N)
        requests.push({
          repeatCell: {
            range: {
              sheetId: s.sheetId,
              startRowIndex: bodyStart,
              endRowIndex: netPayableRowIdx + 20,
              startColumnIndex: 0,
              endColumnIndex: 14,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 1, green: 1, blue: 1 },
                textFormat: {
                  foregroundColor: { red: 0.06, green: 0.09, blue: 0.16 },
                  bold: false,
                  fontSize: 10,
                },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        });

        if (s.dataRowCount > 0) {
          // Format Payable Amount column (Col J) across data & summary rows
          requests.push({
            repeatCell: {
              range: {
                sheetId: s.sheetId,
                startRowIndex: bodyStart,
                endRowIndex: netPayableRowIdx + 1,
                startColumnIndex: 9,
                endColumnIndex: 10,
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'NUMBER', pattern: '#,##0.00' },
                },
              },
              fields: 'userEnteredFormat.numberFormat',
            },
          });

          // TOTAL (Before Theka) row
          requests.push({
            repeatCell: {
              range: {
                sheetId: s.sheetId,
                startRowIndex: totalRowIdx,
                endRowIndex: totalRowIdx + 1,
                startColumnIndex: 0,
                endColumnIndex: 10,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.96, green: 0.97, blue: 0.98 },
                  textFormat: { bold: true, fontSize: 10 },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          });

          // Less: Theka Work (H) row
          requests.push({
            repeatCell: {
              range: {
                sheetId: s.sheetId,
                startRowIndex: thekaRowIdx,
                endRowIndex: thekaRowIdx + 1,
                startColumnIndex: 0,
                endColumnIndex: 10,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 1, green: 0.96, blue: 0.96 },
                  textFormat: {
                    foregroundColor: { red: 0.72, green: 0.11, blue: 0.11 },
                    bold: true,
                    fontSize: 10,
                  },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          });

          // NET PAYABLE (After Theka) row
          requests.push({
            repeatCell: {
              range: {
                sheetId: s.sheetId,
                startRowIndex: netPayableRowIdx,
                endRowIndex: netPayableRowIdx + 1,
                startColumnIndex: 0,
                endColumnIndex: 10,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 1, green: 0.96, blue: 0.85 },
                  textFormat: {
                    foregroundColor: { red: 0.57, green: 0.25, blue: 0.05 },
                    bold: true,
                    fontSize: 10,
                  },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          });
        }
      }
    }
  }

  if (requests.length > 0) {
    await apiFetch(`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, token, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }
}

export async function createMasterSpreadsheet(
  token: string,
  title: string,
  employees: Employee[],
  records: AttendanceRecord[],
  companyCategory?: CompanyCategory
): Promise<SheetConfig> {
  const scoped = filterByCompanyCategory(employees, records, companyCategory);
  const scopedEmps = scoped.employees;
  const scopedRecs = scoped.records;
  const monthTabs = getCategoryMonthsToSync(scopedEmps, scopedRecs);

  const initialSheets = [
    ...monthTabs.map((m) => ({
      properties: { title: m.title, gridProperties: { frozenRowCount: 3 } },
    })),
    { properties: { title: EMPLOYEES_TAB_NAME, gridProperties: { frozenRowCount: 1 } } },
  ];

  const created = await apiFetch<SpreadsheetMetadataResponse>(SHEETS_BASE, token, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: initialSheets,
    }),
  });

  const builtMonths = monthTabs.map((m) => ({
    title: m.title,
    ...buildMegaMonthlySummaryRows(m.ym, scopedEmps, scopedRecs, companyCategory),
  }));

  const valueRanges = [
    ...builtMonths.map((m) => ({
      range: `'${m.title}'!A1`,
      values: m.rows,
    })),
    {
      range: `'${EMPLOYEES_TAB_NAME}'!A1`,
      values: buildEmployeesRows(scopedEmps),
    },
  ];

  await apiFetch(
    `${SHEETS_BASE}/${encodeURIComponent(created.spreadsheetId)}/values:batchUpdate`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: valueRanges,
      }),
    }
  );

  const rowCountByTitle = new Map(builtMonths.map((m) => [m.title, m.employeeRowCount]));
  await formatSheetHeaders(
    token,
    created.spreadsheetId,
    created.sheets.map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      kind: s.properties.title === EMPLOYEES_TAB_NAME ? 'employees' : 'mega_month',
      dataRowCount: rowCountByTitle.get(s.properties.title),
    }))
  );

  return {
    companyCategory,
    spreadsheetId: created.spreadsheetId,
    spreadsheetTitle: created.properties.title,
    spreadsheetUrl: created.spreadsheetUrl,
    lastSyncedAt: new Date().toISOString(),
    tabNames: created.sheets.map((s) => s.properties.title),
  };
}

const MONTH_LABEL_REGEX =
  /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/;

export async function syncFullWorkbook(
  token: string,
  spreadsheetId: string,
  employees: Employee[],
  records: AttendanceRecord[],
  companyCategory?: CompanyCategory,
  extraTabsToRemove: string[] = []
): Promise<SheetConfig> {
  const scoped = filterByCompanyCategory(employees, records, companyCategory);
  const scopedEmps = scoped.employees;
  const scopedRecs = scoped.records;

  let meta = await getSpreadsheetMetadata(token, spreadsheetId);
  const existingTitles = new Set(meta.sheets.map((s) => s.properties.title));

  const monthTabs = getCategoryMonthsToSync(scopedEmps, scopedRecs);
  const requiredTabs = [...monthTabs.map((m) => m.title), EMPLOYEES_TAB_NAME];
  const requiredSet = new Set(requiredTabs);
  const extraRemoveSet = new Set(extraTabsToRemove);
  const currentCatEmpTabs = new Set(
    scopedEmps.map((e) => getEmployeeSheetTabName(e.empCode, e.name))
  );

  const missingTabs = requiredTabs.filter((t) => !existingTitles.has(t));
  // Clean up legacy Master Attendance tab, old individual employee tabs in the Mega sheet, or empty old tabs
  const staleTabs = meta.sheets.filter((s) => {
    const t = s.properties.title;
    if (requiredSet.has(t)) return false;
    return (
      t === MASTER_TAB_NAME ||
      LEGACY_GENERIC_TABS.has(t) ||
      scoped.otherTabNames.has(t) ||
      currentCatEmpTabs.has(t) ||
      extraRemoveSet.has(t) ||
      MONTH_LABEL_REGEX.test(t) ||
      /^[A-Za-z0-9]+-[A-Za-z0-9_-]*\s+-\s+/.test(t)
    );
  });

  if (missingTabs.length > 0 || staleTabs.length > 0) {
    const tabRequests: unknown[] = [
      ...missingTabs.map((t) => ({
        addSheet: {
          properties: {
            title: t,
            gridProperties: {
              frozenRowCount: t === EMPLOYEES_TAB_NAME ? 1 : 3,
            },
          },
        },
      })),
    ];

    const remainingCount = meta.sheets.length + missingTabs.length - staleTabs.length;
    if (remainingCount >= 1) {
      for (const s of staleTabs) {
        tabRequests.push({
          deleteSheet: { sheetId: s.properties.sheetId },
        });
      }
    }

    if (tabRequests.length > 0) {
      await apiFetch(`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, token, {
        method: 'POST',
        body: JSON.stringify({ requests: tabRequests }),
      });
      meta = await getSpreadsheetMetadata(token, spreadsheetId);
    }
  }

  // Order tabs cleanly: newest Month Summary tabs first, then Employees tab
  const orderRequests: unknown[] = [];
  requiredTabs.forEach((title, idx) => {
    const sheet = meta.sheets.find((s) => s.properties.title === title);
    if (sheet && sheet.properties.index !== idx) {
      orderRequests.push({
        updateSheetProperties: {
          properties: { sheetId: sheet.properties.sheetId, index: idx },
          fields: 'index',
        },
      });
    }
  });
  if (orderRequests.length > 0) {
    await apiFetch(`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, token, {
      method: 'POST',
      body: JSON.stringify({ requests: orderRequests }),
    });
    meta = await getSpreadsheetMetadata(token, spreadsheetId);
  }

  await apiFetch(
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        ranges: requiredTabs.map((t) => `'${t}'!A1:Z5000`),
      }),
    }
  );

  const builtMonths = monthTabs.map((m) => ({
    title: m.title,
    ...buildMegaMonthlySummaryRows(m.ym, scopedEmps, scopedRecs, companyCategory),
  }));

  const valueRanges = [
    ...builtMonths.map((m) => ({
      range: `'${m.title}'!A1`,
      values: m.rows,
    })),
    { range: `'${EMPLOYEES_TAB_NAME}'!A1`, values: buildEmployeesRows(scopedEmps) },
  ];

  await apiFetch(
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: valueRanges,
      }),
    }
  );

  const rowCountByTitle = new Map(builtMonths.map((m) => [m.title, m.employeeRowCount]));
  const allManagedMeta = meta.sheets
    .filter((s) => requiredSet.has(s.properties.title))
    .map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      kind: (s.properties.title === EMPLOYEES_TAB_NAME
        ? 'employees'
        : 'mega_month') as 'employees' | 'mega_month',
      dataRowCount: rowCountByTitle.get(s.properties.title),
    }));
  if (allManagedMeta.length > 0) {
    await formatSheetHeaders(token, spreadsheetId, allManagedMeta);
  }

  return {
    companyCategory,
    spreadsheetId: meta.spreadsheetId,
    spreadsheetTitle: meta.properties.title,
    spreadsheetUrl: meta.spreadsheetUrl,
    lastSyncedAt: new Date().toISOString(),
    tabNames: meta.sheets.map((s) => s.properties.title),
  };
}

export async function syncEmployeeAndMasterTabs(
  token: string,
  spreadsheetId: string,
  _employee: Employee,
  employees: Employee[],
  records: AttendanceRecord[],
  companyCategory?: CompanyCategory
): Promise<SheetConfig> {
  return syncFullWorkbook(token, spreadsheetId, employees, records, companyCategory);
}

const LEGACY_GENERIC_TABS = new Set(['Attendance', 'Sheet1', 'Sheet 1']);

export async function createOrUpdateStandaloneEmployeeSheet(
  token: string,
  employee: Employee,
  records: AttendanceRecord[],
  monthFilter?: string
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const empRecords = records.filter(
    (r) => r.empId === employee.id || r.empCode === employee.empCode
  );

  const monthSet = new Set<string>();
  for (const r of empRecords) {
    if (r.date && /^\d{4}-\d{2}/.test(r.date)) {
      monthSet.add(r.date.slice(0, 7));
    }
  }
  for (const ym of Object.keys(employee.monthlyThikadaMinutes ?? {})) {
    if (/^\d{4}-\d{2}$/.test(ym) && (employee.monthlyThikadaMinutes?.[ym] ?? 0) > 0) {
      monthSet.add(ym);
    }
  }
  if (monthFilter && /^\d{4}-\d{2}$/.test(monthFilter)) {
    monthSet.add(monthFilter);
  }
  if (monthSet.size === 0) {
    const now = new Date();
    monthSet.add(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  }

  // Newest month first so the active/current month is always the opening tab
  const monthsToSync = Array.from(monthSet).sort((a, b) => b.localeCompare(a));
  const monthTabs = monthsToSync.map((ym) => ({
    ym,
    title: formatMonthLabel(ym),
    rowCount: empRecords.filter((r) => r.date.startsWith(ym)).length,
  }));

  if (employee.individualSheetId) {
    try {
      let meta = await getSpreadsheetMetadata(token, employee.individualSheetId);
      const existingByTitle = new Map(
        meta.sheets.map((s) => [s.properties.title, s.properties.sheetId])
      );

      // Migrate legacy generic tabs ("Attendance", "Sheet1") cleanly to month-specific tabs
      const renameTarget = monthTabs.find((t) => !existingByTitle.has(t.title));
      const legacyTab = meta.sheets.find((s) => LEGACY_GENERIC_TABS.has(s.properties.title));
      const structureRequests: unknown[] = [];

      let renamedLegacyId: number | null = null;
      if (legacyTab && renameTarget) {
        structureRequests.push({
          updateSheetProperties: {
            properties: {
              sheetId: legacyTab.properties.sheetId,
              title: renameTarget.title,
              gridProperties: { frozenRowCount: 4 },
            },
            fields: 'title,gridProperties.frozenRowCount',
          },
        });
        renamedLegacyId = legacyTab.properties.sheetId;
        existingByTitle.delete(legacyTab.properties.title);
        existingByTitle.set(renameTarget.title, legacyTab.properties.sheetId);
      }

      const missingTabs = monthTabs.filter((t) => !existingByTitle.has(t.title));
      for (const t of missingTabs) {
        structureRequests.push({
          addSheet: {
            properties: {
              title: t.title,
              gridProperties: { frozenRowCount: 4 },
            },
          },
        });
      }

      // Remove any remaining legacy mixed tabs or now-empty monthly tabs once monthly tabs exist
      const activeMonthTitles = new Set(monthTabs.map((t) => t.title));
      const leftoverLegacy = meta.sheets.filter(
        (s) =>
          (LEGACY_GENERIC_TABS.has(s.properties.title) ||
            (MONTH_LABEL_REGEX.test(s.properties.title) &&
              !activeMonthTitles.has(s.properties.title))) &&
          s.properties.sheetId !== renamedLegacyId
      );
      const projectedSheetCount =
        meta.sheets.length + missingTabs.length - leftoverLegacy.length;
      if (projectedSheetCount >= 1) {
        for (const s of leftoverLegacy) {
          structureRequests.push({
            deleteSheet: { sheetId: s.properties.sheetId },
          });
        }
      }

      if (structureRequests.length > 0) {
        await apiFetch(
          `${SHEETS_BASE}/${encodeURIComponent(meta.spreadsheetId)}:batchUpdate`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({ requests: structureRequests }),
          }
        );
        meta = await getSpreadsheetMetadata(token, meta.spreadsheetId);
      }

      // Order monthly tabs newest-first (Index 0 = newest month)
      const orderRequests: unknown[] = [];
      monthTabs.forEach((t, idx) => {
        const sheet = meta.sheets.find((s) => s.properties.title === t.title);
        if (sheet && sheet.properties.index !== idx) {
          orderRequests.push({
            updateSheetProperties: {
              properties: {
                sheetId: sheet.properties.sheetId,
                index: idx,
              },
              fields: 'index',
            },
          });
        }
      });
      if (orderRequests.length > 0) {
        await apiFetch(
          `${SHEETS_BASE}/${encodeURIComponent(meta.spreadsheetId)}:batchUpdate`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({ requests: orderRequests }),
          }
        );
        meta = await getSpreadsheetMetadata(token, meta.spreadsheetId);
      }

      const rangesToClear = monthTabs.map((t) => `'${t.title}'!A1:Z5000`);
      const dataUpdates = monthTabs.map((t) => ({
        range: `'${t.title}'!A1`,
        values: buildIndividualEmployeeRows(employee, records, t.ym),
      }));

      await apiFetch(
        `${SHEETS_BASE}/${encodeURIComponent(meta.spreadsheetId)}/values:batchClear`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ ranges: rangesToClear }),
        }
      );
      await apiFetch(
        `${SHEETS_BASE}/${encodeURIComponent(meta.spreadsheetId)}/values:batchUpdate`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            valueInputOption: 'USER_ENTERED',
            data: dataUpdates,
          }),
        }
      );

      const rowCountByTitle = new Map(monthTabs.map((t) => [t.title, t.rowCount]));
      const tabsToFormat = meta.sheets
        .filter((s) => rowCountByTitle.has(s.properties.title))
        .map((s) => ({
          sheetId: s.properties.sheetId,
          title: s.properties.title,
          dataRowCount: rowCountByTitle.get(s.properties.title) ?? 0,
        }));
      await formatSheetHeaders(token, meta.spreadsheetId, tabsToFormat);

      return { spreadsheetId: meta.spreadsheetId, spreadsheetUrl: meta.spreadsheetUrl };
    } catch {
      // Fall through and recreate if missing
    }
  }

  const initialSheets = monthTabs.map((t) => ({
    properties: { title: t.title, gridProperties: { frozenRowCount: 4 } },
  }));

  const created = await apiFetch<SpreadsheetMetadataResponse>(SHEETS_BASE, token, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: `${employee.empCode} - ${employee.name} Attendance` },
      sheets: initialSheets,
    }),
  });

  const dataUpdates = monthTabs.map((t) => ({
    range: `'${t.title}'!A1`,
    values: buildIndividualEmployeeRows(employee, records, t.ym),
  }));

  await apiFetch(
    `${SHEETS_BASE}/${encodeURIComponent(created.spreadsheetId)}/values:batchUpdate`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: dataUpdates,
      }),
    }
  );

  const rowCountByTitle = new Map(monthTabs.map((t) => [t.title, t.rowCount]));
  await formatSheetHeaders(
    token,
    created.spreadsheetId,
    created.sheets.map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      dataRowCount: rowCountByTitle.get(s.properties.title) ?? 0,
    }))
  );

  return {
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl: created.spreadsheetUrl,
  };
}

export function normalizeDateToISO(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || /^total/i.test(trimmed) || /^date$/i.test(trimmed)) return null;

  const isoMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const dmyMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const first = Number(dmyMatch[1]);
    const second = Number(dmyMatch[2]);
    const y = Number(dmyMatch[3]);
    // Prefer DD/MM/YYYY if first > 12 or standard DMY, else fallback
    const d = first > 12 || second <= 12 ? first : second;
    const m = first > 12 || second <= 12 ? second : first;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = parsed.getMonth() + 1;
    const d = parsed.getDate();
    if (y >= 2000 && y <= 2100) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

export async function importEmployeeGoogleSheet(
  token: string,
  spreadsheetIdOrUrl: string,
  employee: Employee
): Promise<{
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
  records: AttendanceRecord[];
}> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl);
  const meta = await getSpreadsheetMetadata(token, spreadsheetId);
  if (!meta.sheets || meta.sheets.length === 0) {
    throw new Error('This Google Spreadsheet has no readable tabs.');
  }

  const rangesQuery = meta.sheets
    .map((s) => `ranges=${encodeURIComponent(`'${s.properties.title}'!A1:L5000`)}`)
    .join('&');
  const batch = await apiFetch<{
    valueRanges?: Array<{ range: string; values?: string[][] }>;
  }>(
    `${SHEETS_BASE}/${encodeURIComponent(meta.spreadsheetId)}/values:batchGet?${rangesQuery}`,
    token
  );

  const importedById = new Map<string, AttendanceRecord>();

  for (const vr of batch.valueRanges ?? []) {
    const rows = vr.values ?? [];
    if (rows.length === 0) continue;

    let dateCol = 0;
    let inCol = 1;
    let outCol = 2;
    let awayCol = -1;
    let thikadaCol = -1;
    let startRow = 0;
    let matchedHeader = false;

    for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
      const row = rows[i].map((c) => String(c || '').trim().toLowerCase());
      const foundDate = row.findIndex((c) => c === 'date' || c.includes('date'));
      const foundIn = row.findIndex(
        (c) => c === 'in' || c === 'in time' || c === 'check in' || c === 'checkin'
      );
      const foundOut = row.findIndex(
        (c) => c === 'out' || c === 'out time' || c === 'check out' || c === 'checkout'
      );
      if (foundDate !== -1 && (foundIn !== -1 || foundOut !== -1)) {
        dateCol = foundDate;
        inCol = foundIn !== -1 ? foundIn : foundDate + 1;
        outCol = foundOut !== -1 ? foundOut : inCol + 1;
        awayCol = row.findIndex((c) => c.includes('away') || c.includes('pause'));
        thikadaCol = row.findIndex((c) => c.includes('thikada') || c.includes('hikada'));
        startRow = i + 1;
        matchedHeader = true;
        break;
      }
    }

    // If a workbook has multiple tabs, skip non-attendance tabs without a header unless it's the only tab
    if (!matchedHeader && meta.sheets.length > 1) continue;

    for (let i = startRow; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const dateIso = normalizeDateToISO(row[dateCol]);
      if (!dateIso) continue;

      const inTime = parseDisplayTimeToHHMM(row[inCol]);
      const outTime = parseDisplayTimeToHHMM(row[outCol]);
      if (!inTime) continue;

      const awayMinsRaw = awayCol !== -1 ? Number(row[awayCol]) : 0;
      const awayMinutes =
        !Number.isNaN(awayMinsRaw) && awayMinsRaw > 0 ? Math.round(awayMinsRaw) : 0;
      const pausedTotalSeconds = awayMinutes * 60;

      const thikadaHrsRaw = thikadaCol !== -1 ? Number(row[thikadaCol]) : 0;
      const thikadaMinutes =
        !Number.isNaN(thikadaHrsRaw) && thikadaHrsRaw > 0
          ? Math.round(thikadaHrsRaw * 60)
          : 0;

      const recordId = `${dateIso}_${employee.id}`;
      if (outTime) {
        const calc = calculateShiftMetrics(
          inTime,
          outTime,
          employee.breakMinutes || 30,
          dateIso,
          awayMinutes,
          thikadaMinutes
        );
        importedById.set(recordId, {
          id: recordId,
          date: dateIso,
          empId: employee.id,
          empCode: employee.empCode,
          empName: employee.name,
          inTime,
          outTime,
          startedAtMs: null,
          isPaused: false,
          pausedAtMs: null,
          pausedTotalSeconds,
          grossMinutes: calc.grossMinutes,
          breakMinutes: calc.breakDeductedMinutes,
          netMinutes: calc.netMinutes,
          netDecimalHours: calc.netDecimalHours,
          overtimeMinutes: calc.overtimeMinutes,
          overtimeDecimalHours: calc.overtimeDecimalHours,
          presentCount: calc.presentCount,
          thikadaMinutes: calc.thikadaMinutes,
          normalMinutes: calc.normalMinutes,
          normalDecimalHours: calc.normalDecimalHours,
          isSunday: calc.isSunday,
          status: calc.status,
          syncedToSheet: true,
          updatedAt: new Date().toISOString(),
        });
      } else {
        importedById.set(recordId, {
          id: recordId,
          date: dateIso,
          empId: employee.id,
          empCode: employee.empCode,
          empName: employee.name,
          inTime,
          outTime: null,
          startedAtMs: null,
          isPaused: false,
          pausedAtMs: null,
          pausedTotalSeconds,
          grossMinutes: null,
          breakMinutes: employee.breakMinutes || 30,
          netMinutes: null,
          netDecimalHours: null,
          overtimeMinutes: null,
          overtimeDecimalHours: null,
          presentCount: null,
          thikadaMinutes,
          normalMinutes: null,
          normalDecimalHours: null,
          isSunday: isSundayISO(dateIso),
          status: 'on_duty',
          syncedToSheet: true,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  return {
    spreadsheetId: meta.spreadsheetId,
    spreadsheetUrl: meta.spreadsheetUrl,
    spreadsheetTitle: meta.properties.title,
    records: Array.from(importedById.values()),
  };
}

export async function loadWorkbookData(
  token: string,
  spreadsheetId: string
): Promise<{
  config: SheetConfig;
  employees: Employee[];
  records: AttendanceRecord[];
}> {
  const meta = await getSpreadsheetMetadata(token, spreadsheetId);
  const tabNames = meta.sheets.map((s) => s.properties.title);

  const rangesToFetch: string[] = [];
  if (tabNames.includes(EMPLOYEES_TAB_NAME)) {
    rangesToFetch.push(`'${EMPLOYEES_TAB_NAME}'!A1:G2000`);
  }
  if (tabNames.includes(MASTER_TAB_NAME)) {
    rangesToFetch.push(`'${MASTER_TAB_NAME}'!A1:O5000`);
  }

  const employees: Employee[] = [];
  const records: AttendanceRecord[] = [];

  if (rangesToFetch.length > 0) {
    const query = rangesToFetch.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
    const batch = await apiFetch<{
      valueRanges?: Array<{ range: string; values?: string[][] }>;
    }>(`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${query}`, token);

    for (const vr of batch.valueRanges ?? []) {
      const rows = vr.values ?? [];
      if (vr.range.includes(EMPLOYEES_TAB_NAME)) {
        const empHeader = (rows[0] ?? []).map((c) => String(c || '').trim().toLowerCase());
        const hasHeader = empHeader.some((c) => c.includes('employee id') || c === 'name');
        const hasCompanyCol = empHeader.some((c) => c.includes('company'));
        const rateIdx = empHeader.findIndex((c) => c.includes('rate'));
        const statusIdx = empHeader.findIndex((c) => c === 'status');
        const linkIdx = empHeader.findIndex((c) => c.includes('link') || c.includes('sheet'));
        const deptIdx = empHeader.findIndex((c) => c.includes('department'));
        const dataRows = hasHeader ? rows.slice(1) : rows;
        for (const row of dataRows) {
          if (!row[0] && !row[1]) continue;
          const empCode = String(row[0] || '').trim();
          const name = String(row[1] || '').trim();
          const companyCategory = hasCompanyCol
            ? normalizeCompanyCategory(row[2])
            : normalizeCompanyCategory(undefined);
          const department = String(
            (deptIdx !== -1 ? row[deptIdx] : hasCompanyCol ? row[3] : row[2]) || 'General'
          ).trim();
          const rateRaw = rateIdx !== -1 ? Number(row[rateIdx]) : 0;
          const hourlyRate =
            !Number.isNaN(rateRaw) && rateRaw > 0 ? Number(rateRaw.toFixed(5)) : 0;
          const activeRaw = String(
            (statusIdx !== -1 ? row[statusIdx] : hasCompanyCol ? row[4] : row[3]) || 'Active'
          ).toLowerCase();
          const sheetUrlRaw =
            linkIdx !== -1 ? row[linkIdx] : hasCompanyCol ? row[5] : row[4];
          const sheetUrl = sheetUrlRaw ? String(sheetUrlRaw).trim() : undefined;
          employees.push({
            id: `emp-${empCode.toLowerCase().replace(/[^a-z0-9_-]/g, '') || Date.now()}`,
            empCode,
            name,
            department,
            companyCategory,
            breakMinutes: 30,
            hourlyRate,
            active: activeRaw !== 'inactive',
            individualSheetId: sheetUrl ? extractSpreadsheetId(sheetUrl) : undefined,
            individualSheetUrl: sheetUrl,
          });
        }
      } else if (vr.range.includes(MASTER_TAB_NAME)) {
        const header = (rows[0] ?? []).map((c) => String(c || '').trim().toLowerCase());
        const hasDayCol = header.includes('day');
        const hasCompanyCol = header.some((c) => c.includes('company'));
        const inIdx = header.findIndex((c) => c === 'in time' || c === 'in');
        const outIdx = header.findIndex((c) => c === 'out time' || c === 'out');
        const awayIdx = header.findIndex((c) => c.includes('away'));
        const thikadaCol = header.findIndex((c) => c.includes('thikada'));

        const defaultInIdx = hasCompanyCol ? 5 : hasDayCol ? 4 : 3;
        const defaultOutIdx = hasCompanyCol ? 6 : hasDayCol ? 5 : 4;
        const defaultAwayIdx = hasCompanyCol ? 7 : hasDayCol ? 6 : -1;

        for (const row of rows.slice(1)) {
          const date = normalizeDateToISO(row[0]);
          const empCode = String((hasDayCol ? row[2] : row[1]) || '').trim();
          const empName = String((hasDayCol ? row[3] : row[2]) || '').trim();
          if (!date || !empCode) continue;

          const inTime =
            parseDisplayTimeToHHMM(row[inIdx !== -1 ? inIdx : defaultInIdx]) || '09:00';
          const outTime = parseDisplayTimeToHHMM(row[outIdx !== -1 ? outIdx : defaultOutIdx]);
          const awayColIndex = awayIdx !== -1 ? awayIdx : defaultAwayIdx;
          const awayMins =
            awayColIndex !== -1 && !Number.isNaN(Number(row[awayColIndex]))
              ? Math.max(0, Number(row[awayColIndex]))
              : 0;
          const thikadaHrs =
            thikadaCol !== -1 && !Number.isNaN(Number(row[thikadaCol]))
              ? Math.max(0, Number(row[thikadaCol]))
              : 0;
          const thikadaMinutes = Math.round(thikadaHrs * 60);
          const matchedEmp = employees.find((e) => e.empCode === empCode);
          const empId =
            matchedEmp?.id || `emp-${empCode.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;

          if (outTime) {
            const calc = calculateShiftMetrics(inTime, outTime, 30, date, awayMins, thikadaMinutes);
            records.push({
              id: `${date}_${empId}`,
              date,
              empId,
              empCode,
              empName: empName || matchedEmp?.name || '',
              inTime,
              outTime,
              startedAtMs: null,
              isPaused: false,
              pausedAtMs: null,
              pausedTotalSeconds: awayMins * 60,
              grossMinutes: calc.grossMinutes,
              breakMinutes: calc.breakDeductedMinutes,
              netMinutes: calc.netMinutes,
              netDecimalHours: calc.netDecimalHours,
              overtimeMinutes: calc.overtimeMinutes,
              overtimeDecimalHours: calc.overtimeDecimalHours,
              presentCount: calc.presentCount,
              thikadaMinutes: calc.thikadaMinutes,
              normalMinutes: calc.normalMinutes,
              normalDecimalHours: calc.normalDecimalHours,
              isSunday: calc.isSunday,
              status: calc.status,
              syncedToSheet: true,
              updatedAt: new Date().toISOString(),
            });
          } else {
            records.push({
              id: `${date}_${empId}`,
              date,
              empId,
              empCode,
              empName: empName || matchedEmp?.name || '',
              inTime,
              outTime: null,
              startedAtMs: null,
              isPaused: false,
              pausedAtMs: null,
              pausedTotalSeconds: awayMins * 60,
              grossMinutes: null,
              breakMinutes: 30,
              netMinutes: null,
              netDecimalHours: null,
              overtimeMinutes: null,
              overtimeDecimalHours: null,
              presentCount: null,
              thikadaMinutes,
              normalMinutes: null,
              normalDecimalHours: null,
              isSunday: isSundayISO(date),
              status: 'on_duty',
              syncedToSheet: true,
              updatedAt: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  return {
    config: {
      spreadsheetId: meta.spreadsheetId,
      spreadsheetTitle: meta.properties.title,
      spreadsheetUrl: meta.spreadsheetUrl,
      lastSyncedAt: new Date().toISOString(),
      tabNames,
    },
    employees,
    records,
  };
}

interface DrivePermissionItem {
  id: string;
  emailAddress?: string;
  role?: string;
}

export async function shareSpreadsheetWithEmails(
  token: string,
  spreadsheetId: string,
  emails: string[],
  excludeEmail?: string | null
): Promise<{ shared: string[]; failed: string[] }> {
  const excluded = excludeEmail?.trim().toLowerCase() ?? '';
  const targets = Array.from(
    new Set(
      emails
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && e !== excluded)
    )
  );
  if (targets.length === 0) {
    return { shared: [], failed: [] };
  }

  const alreadyWriter = new Set<string>();
  try {
    const perms = await apiFetch<{ permissions?: DrivePermissionItem[] }>(
      `${DRIVE_BASE}/${encodeURIComponent(spreadsheetId)}/permissions?fields=permissions(id,emailAddress,role)`,
      token
    );
    for (const p of perms.permissions ?? []) {
      if (
        p.emailAddress &&
        (p.role === 'owner' || p.role === 'writer' || p.role === 'fileOrganizer')
      ) {
        alreadyWriter.add(p.emailAddress.trim().toLowerCase());
      }
    }
  } catch {
    // Ignore read errors and attempt permission creation directly
  }

  const shared: string[] = [];
  const failed: string[] = [];

  for (const email of targets) {
    if (alreadyWriter.has(email)) continue;
    try {
      await apiFetch(
        `${DRIVE_BASE}/${encodeURIComponent(spreadsheetId)}/permissions?sendNotificationEmail=false`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'user',
            role: 'writer',
            emailAddress: email,
          }),
        }
      );
      shared.push(email);
    } catch {
      failed.push(email);
    }
  }

  return { shared, failed };
}

export async function revokeSpreadsheetAccess(
  token: string,
  spreadsheetId: string,
  email: string
): Promise<void> {
  const target = email.trim().toLowerCase();
  if (!target) return;
  try {
    const perms = await apiFetch<{ permissions?: DrivePermissionItem[] }>(
      `${DRIVE_BASE}/${encodeURIComponent(spreadsheetId)}/permissions?fields=permissions(id,emailAddress,role)`,
      token
    );
    const match = (perms.permissions ?? []).find(
      (p) => p.emailAddress?.trim().toLowerCase() === target && p.role !== 'owner'
    );
    if (match) {
      await fetch(
        `${DRIVE_BASE}/${encodeURIComponent(spreadsheetId)}/permissions/${encodeURIComponent(match.id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
    }
  } catch {
    // Non-fatal if caller is not the Drive file owner
  }
}

