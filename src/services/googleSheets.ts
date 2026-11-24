import { AttendanceRecord, DriveSpreadsheetItem, Employee, SheetConfig } from '../types/attendance';
import {
  calculateShiftMetrics,
  formatDisplayTime,
  formatMonthLabel,
  getDayNameShort,
  getEmployeeSheetTabName,
  getRecordPayroll,
  isSundayISO,
  parseDisplayTimeToHHMM,
} from '../utils/time';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';

export const MASTER_TAB_NAME = 'Master Attendance';
export const EMPLOYEES_TAB_NAME = 'Employees';

const MASTER_HEADERS = [
  'Date',
  'Day',
  'Employee ID',
  'Name',
  'In Time',
  'Out Time',
  'Away (mins)',
  'Working Hours',
  'Present (P)',
  'Overtime (hrs)',
  'Normal Hours (H)',
];

const EMPLOYEES_HEADERS = [
  'Employee ID',
  'Name',
  'Department',
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
    `${DRIVE_BASE}?q=${q}&fields=${fields}&orderBy=modifiedTime desc&pageSize=25`,
    token
  );
  return data.files ?? [];
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

function buildMasterRows(records: AttendanceRecord[]): (string | number)[][] {
  const sorted = [...records].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return b.inTime.localeCompare(a.inTime);
  });

  return [
    MASTER_HEADERS,
    ...sorted.map((r) => {
      const p = getRecordPayroll(r);
      const hasOut = Boolean(r.outTime && r.netMinutes !== null);
      return [
        r.date,
        getDayNameShort(r.date),
        r.empCode,
        r.empName,
        formatDisplayTime(r.inTime),
        r.outTime ? formatDisplayTime(r.outTime) : '',
        Math.round((r.pausedTotalSeconds ?? 0) / 60),
        r.netDecimalHours !== null ? r.netDecimalHours : '',
        hasOut ? p.presentCount : '',
        hasOut ? p.overtimeDecimalHours : '',
        hasOut ? Number((p.grossNormalMinutes / 60).toFixed(2)) : '',
      ];
    }),
  ];
}

function buildEmployeesRows(employees: Employee[]): (string | number)[][] {
  return [
    EMPLOYEES_HEADERS,
    ...employees.map((e) => [
      e.empCode,
      e.name,
      e.department,
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

  const bannerRow1: (string | number)[] = [
    'Employee',
    `${employee.empCode} - ${employee.name}`,
    'Period',
    periodLabel,
    'Shift Rule',
    '8h = 1 P | <8h & OT = H',
    'Sunday Rule',
    '100% OT -> H',
    '',
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
    '',
  ];

  const dataRows = empRecords.map((r) => {
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
    ]);
    rows.push([
      'Less: Theka Work (H)',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      `=-F2`,
    ]);
    rows.push([
      'NET PAYABLE (After Theka)',
      '',
      '',
      '',
      '',
      `=F${totalRowIdx}`,
      `=G${totalRowIdx}`,
      `=H${totalRowIdx}`,
      `=MAX(0, I${totalRowIdx}-F2)`,
    ]);
  }

  return rows;
}

async function formatSheetHeaders(
  token: string,
  spreadsheetId: string,
  sheetMeta: Array<{ sheetId: number; title: string; dataRowCount?: number }>
): Promise<void> {
  const requests: unknown[] = [];

  for (const s of sheetMeta) {
    const isIndividual = s.title !== MASTER_TAB_NAME && s.title !== EMPLOYEES_TAB_NAME;
    const headerRowIndex = isIndividual ? 3 : 0;
    const freezeCount = isIndividual ? 4 : 1;
    const colCount = isIndividual ? 9 : s.title === MASTER_TAB_NAME ? 11 : 5;

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

    if (isIndividual) {
      requests.push({
        repeatCell: {
          range: {
            sheetId: s.sheetId,
            startRowIndex: 0,
            endRowIndex: 2,
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

      if (typeof s.dataRowCount === 'number' && s.dataRowCount > 0) {
        const bodyStart = 4;
        const totalRowIdx = 4 + s.dataRowCount;
        const thekaRowIdx = totalRowIdx + 1;
        const netPayableRowIdx = totalRowIdx + 2;

        // Reset data area formatting cleanly so updated row counts don't inherit old footer tints
        requests.push({
          repeatCell: {
            range: {
              sheetId: s.sheetId,
              startRowIndex: bodyStart,
              endRowIndex: netPayableRowIdx + 15,
              startColumnIndex: 0,
              endColumnIndex: 9,
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

        // TOTAL (Before Theka) row
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
              endColumnIndex: 9,
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
              endColumnIndex: 9,
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
  records: AttendanceRecord[]
): Promise<SheetConfig> {
  const initialSheets = [
    { properties: { title: MASTER_TAB_NAME, gridProperties: { frozenRowCount: 1 } } },
    { properties: { title: EMPLOYEES_TAB_NAME, gridProperties: { frozenRowCount: 1 } } },
    ...employees.map((e) => ({
      properties: {
        title: getEmployeeSheetTabName(e.empCode, e.name),
        gridProperties: { frozenRowCount: 4 },
      },
    })),
  ];

  const created = await apiFetch<SpreadsheetMetadataResponse>(SHEETS_BASE, token, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: initialSheets,
    }),
  });

  const valueRanges = [
    {
      range: `'${MASTER_TAB_NAME}'!A1`,
      values: buildMasterRows(records),
    },
    {
      range: `'${EMPLOYEES_TAB_NAME}'!A1`,
      values: buildEmployeesRows(employees),
    },
    ...employees.map((e) => ({
      range: `'${getEmployeeSheetTabName(e.empCode, e.name)}'!A1`,
      values: buildIndividualEmployeeRows(e, records),
    })),
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

  const empRowCountByTab = new Map(
    employees.map((e) => [
      getEmployeeSheetTabName(e.empCode, e.name),
      records.filter((r) => r.empId === e.id || r.empCode === e.empCode).length,
    ])
  );

  await formatSheetHeaders(
    token,
    created.spreadsheetId,
    created.sheets.map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      dataRowCount: empRowCountByTab.get(s.properties.title),
    }))
  );

  return {
    spreadsheetId: created.spreadsheetId,
    spreadsheetTitle: created.properties.title,
    spreadsheetUrl: created.spreadsheetUrl,
    lastSyncedAt: new Date().toISOString(),
    tabNames: created.sheets.map((s) => s.properties.title),
  };
}

export async function syncFullWorkbook(
  token: string,
  spreadsheetId: string,
  employees: Employee[],
  records: AttendanceRecord[]
): Promise<SheetConfig> {
  let meta = await getSpreadsheetMetadata(token, spreadsheetId);
  const existingTitles = new Set(meta.sheets.map((s) => s.properties.title));

  const requiredTabs = [
    MASTER_TAB_NAME,
    EMPLOYEES_TAB_NAME,
    ...employees.map((e) => getEmployeeSheetTabName(e.empCode, e.name)),
  ];

  const missingTabs = requiredTabs.filter((t) => !existingTitles.has(t));
  if (missingTabs.length > 0) {
    await apiFetch(`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, token, {
      method: 'POST',
      body: JSON.stringify({
        requests: missingTabs.map((t) => ({
          addSheet: {
            properties: {
              title: t,
              gridProperties: {
                frozenRowCount: t === MASTER_TAB_NAME || t === EMPLOYEES_TAB_NAME ? 1 : 4,
              },
            },
          },
        })),
      }),
    });
    meta = await getSpreadsheetMetadata(token, spreadsheetId);
  }

  await apiFetch(
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        ranges: requiredTabs.map((t) => `'${t}'!A1:L5000`),
      }),
    }
  );

  const valueRanges = [
    { range: `'${MASTER_TAB_NAME}'!A1`, values: buildMasterRows(records) },
    { range: `'${EMPLOYEES_TAB_NAME}'!A1`, values: buildEmployeesRows(employees) },
    ...employees.map((e) => ({
      range: `'${getEmployeeSheetTabName(e.empCode, e.name)}'!A1`,
      values: buildIndividualEmployeeRows(e, records),
    })),
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

  const empRowCountByTab = new Map(
    employees.map((e) => [
      getEmployeeSheetTabName(e.empCode, e.name),
      records.filter((r) => r.empId === e.id || r.empCode === e.empCode).length,
    ])
  );
  const allManagedMeta = meta.sheets
    .filter((s) => requiredTabs.includes(s.properties.title))
    .map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      dataRowCount: empRowCountByTab.get(s.properties.title),
    }));
  if (allManagedMeta.length > 0) {
    await formatSheetHeaders(token, spreadsheetId, allManagedMeta);
  }

  return {
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
  employee: Employee,
  employees: Employee[],
  records: AttendanceRecord[]
): Promise<SheetConfig> {
  let meta = await getSpreadsheetMetadata(token, spreadsheetId);
  const existingTitles = new Set(meta.sheets.map((s) => s.properties.title));
  const empTab = getEmployeeSheetTabName(employee.empCode, employee.name);

  const neededTabs = [MASTER_TAB_NAME, EMPLOYEES_TAB_NAME, empTab];
  const missingTabs = neededTabs.filter((t) => !existingTitles.has(t));

  if (missingTabs.length > 0) {
    await apiFetch(`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, token, {
      method: 'POST',
      body: JSON.stringify({
        requests: missingTabs.map((t) => ({
          addSheet: {
            properties: {
              title: t,
              gridProperties: {
                frozenRowCount: t === MASTER_TAB_NAME || t === EMPLOYEES_TAB_NAME ? 1 : 4,
              },
            },
          },
        })),
      }),
    });
    meta = await getSpreadsheetMetadata(token, spreadsheetId);
  }

  await apiFetch(
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        ranges: neededTabs.map((t) => `'${t}'!A1:L5000`),
      }),
    }
  );

  await apiFetch(
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `'${MASTER_TAB_NAME}'!A1`, values: buildMasterRows(records) },
          { range: `'${EMPLOYEES_TAB_NAME}'!A1`, values: buildEmployeesRows(employees) },
          { range: `'${empTab}'!A1`, values: buildIndividualEmployeeRows(employee, records) },
        ],
      }),
    }
  );

  const empRowCount = records.filter(
    (r) => r.empId === employee.id || r.empCode === employee.empCode
  ).length;
  const tabsToFormat = meta.sheets
    .filter((s) => neededTabs.includes(s.properties.title))
    .map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      dataRowCount: s.properties.title === empTab ? empRowCount : undefined,
    }));
  if (tabsToFormat.length > 0) {
    await formatSheetHeaders(token, spreadsheetId, tabsToFormat);
  }

  return {
    spreadsheetId: meta.spreadsheetId,
    spreadsheetTitle: meta.properties.title,
    spreadsheetUrl: meta.spreadsheetUrl,
    lastSyncedAt: new Date().toISOString(),
    tabNames: meta.sheets.map((s) => s.properties.title),
  };
}

export async function createOrUpdateStandaloneEmployeeSheet(
  token: string,
  employee: Employee,
  records: AttendanceRecord[],
  monthFilter?: string
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const tabTitle = 'Attendance';
  const monthTabTitle = monthFilter ? formatMonthLabel(monthFilter) : null;
  const allEmpRecordsCount = records.filter(
    (r) => r.empId === employee.id || r.empCode === employee.empCode
  ).length;
  const monthEmpRecordsCount = monthFilter
    ? records.filter(
        (r) =>
          (r.empId === employee.id || r.empCode === employee.empCode) &&
          r.date.startsWith(monthFilter)
      ).length
    : 0;

  if (employee.individualSheetId) {
    try {
      let meta = await getSpreadsheetMetadata(token, employee.individualSheetId);
      const firstTab = meta.sheets[0]?.properties.title ?? tabTitle;
      const existingTitles = new Set(meta.sheets.map((s) => s.properties.title));

      if (monthTabTitle && !existingTitles.has(monthTabTitle)) {
        await apiFetch(
          `${SHEETS_BASE}/${encodeURIComponent(meta.spreadsheetId)}:batchUpdate`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({
              requests: [
                {
                  addSheet: {
                    properties: {
                      title: monthTabTitle,
                      gridProperties: { frozenRowCount: 4 },
                    },
                  },
                },
              ],
            }),
          }
        );
        meta = await getSpreadsheetMetadata(token, meta.spreadsheetId);
      }

      const firstTabIsMonth = Boolean(monthTabTitle && firstTab === monthTabTitle);
      const rangesToClear = [`'${firstTab}'!A1:I5000`];
      const dataUpdates = [
        {
          range: `'${firstTab}'!A1`,
          values: buildIndividualEmployeeRows(
            employee,
            records,
            firstTabIsMonth ? monthFilter : undefined
          ),
        },
      ];

      if (monthTabTitle && monthTabTitle !== firstTab) {
        rangesToClear.push(`'${monthTabTitle}'!A1:I5000`);
        dataUpdates.push({
          range: `'${monthTabTitle}'!A1`,
          values: buildIndividualEmployeeRows(employee, records, monthFilter),
        });
      }

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

      const tabsToFormat = meta.sheets
        .filter(
          (s) =>
            s.properties.title === firstTab ||
            (monthTabTitle && s.properties.title === monthTabTitle)
        )
        .map((s) => ({
          sheetId: s.properties.sheetId,
          title: s.properties.title,
          dataRowCount:
            monthTabTitle && s.properties.title === monthTabTitle
              ? monthEmpRecordsCount
              : allEmpRecordsCount,
        }));
      await formatSheetHeaders(token, meta.spreadsheetId, tabsToFormat);

      return { spreadsheetId: meta.spreadsheetId, spreadsheetUrl: meta.spreadsheetUrl };
    } catch {
      // Fall through and recreate if missing
    }
  }

  const initialSheets = [
    { properties: { title: tabTitle, gridProperties: { frozenRowCount: 4 } } },
    ...(monthTabTitle
      ? [{ properties: { title: monthTabTitle, gridProperties: { frozenRowCount: 4 } } }]
      : []),
  ];

  const created = await apiFetch<SpreadsheetMetadataResponse>(SHEETS_BASE, token, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: `${employee.empCode} - ${employee.name} Attendance` },
      sheets: initialSheets,
    }),
  });

  const dataUpdates = [
    {
      range: `'${tabTitle}'!A1`,
      values: buildIndividualEmployeeRows(employee, records),
    },
    ...(monthTabTitle
      ? [
          {
            range: `'${monthTabTitle}'!A1`,
            values: buildIndividualEmployeeRows(employee, records, monthFilter),
          },
        ]
      : []),
  ];

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

  await formatSheetHeaders(
    token,
    created.spreadsheetId,
    created.sheets.map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      dataRowCount:
        monthTabTitle && s.properties.title === monthTabTitle
          ? monthEmpRecordsCount
          : allEmpRecordsCount,
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
  const targetSheet =
    meta.sheets.find((s) => /attendance/i.test(s.properties.title)) ?? meta.sheets[0];
  if (!targetSheet) {
    throw new Error('This Google Spreadsheet has no readable tabs.');
  }

  const tabTitle = targetSheet.properties.title;
  const range = encodeURIComponent(`'${tabTitle}'!A1:L5000`);
  const res = await apiFetch<{ values?: string[][] }>(
    `${SHEETS_BASE}/${encodeURIComponent(meta.spreadsheetId)}/values/${range}`,
    token
  );
  const rows = res.values ?? [];

  // Detect column indices from header row if present, else default cleanly
  let dateCol = 0;
  let inCol = 1;
  let outCol = 2;
  let awayCol = -1;
  let thikadaCol = -1;
  let startRow = 0;

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
      break;
    }
  }

  const imported: AttendanceRecord[] = [];
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

    if (outTime) {
      const calc = calculateShiftMetrics(
        inTime,
        outTime,
        employee.breakMinutes || 30,
        dateIso,
        awayMinutes,
        thikadaMinutes
      );
      imported.push({
        id: `${dateIso}_${employee.id}`,
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
      imported.push({
        id: `${dateIso}_${employee.id}`,
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

  return {
    spreadsheetId: meta.spreadsheetId,
    spreadsheetUrl: meta.spreadsheetUrl,
    spreadsheetTitle: meta.properties.title,
    records: imported,
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
    rangesToFetch.push(`'${EMPLOYEES_TAB_NAME}'!A2:E2000`);
  }
  if (tabNames.includes(MASTER_TAB_NAME)) {
    rangesToFetch.push(`'${MASTER_TAB_NAME}'!A1:L5000`);
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
        for (const row of rows) {
          if (!row[0] && !row[1]) continue;
          const empCode = String(row[0] || '').trim();
          const sheetUrl = row[4] ? String(row[4]).trim() : undefined;
          employees.push({
            id: `emp-${empCode.toLowerCase().replace(/[^a-z0-9_-]/g, '') || Date.now()}`,
            empCode,
            name: String(row[1] || '').trim(),
            department: String(row[2] || 'General').trim(),
            breakMinutes: 30,
            active: String(row[3] || 'Active').toLowerCase() !== 'inactive',
            individualSheetId: sheetUrl ? extractSpreadsheetId(sheetUrl) : undefined,
            individualSheetUrl: sheetUrl,
          });
        }
      } else if (vr.range.includes(MASTER_TAB_NAME)) {
        const header = (rows[0] ?? []).map((c) => String(c || '').trim().toLowerCase());
        const hasDayCol = header.includes('day');
        const thikadaCol = header.findIndex((c) => c.includes('thikada'));
        for (const row of rows.slice(1)) {
          const date = normalizeDateToISO(row[0]);
          const empCode = String((hasDayCol ? row[2] : row[1]) || '').trim();
          const empName = String((hasDayCol ? row[3] : row[2]) || '').trim();
          if (!date || !empCode) continue;

          const inTime =
            parseDisplayTimeToHHMM(hasDayCol ? row[4] : row[3]) || '09:00';
          const outTime = parseDisplayTimeToHHMM(hasDayCol ? row[5] : row[4]);
          const awayMins =
            hasDayCol && !Number.isNaN(Number(row[6])) ? Math.max(0, Number(row[6])) : 0;
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

