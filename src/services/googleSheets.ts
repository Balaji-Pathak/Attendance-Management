import { AttendanceRecord, DriveSpreadsheetItem, Employee, SheetConfig } from '../types/attendance';
import { formatDurationClock, getEmployeeSheetTabName } from '../utils/time';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';

export const MASTER_TAB_NAME = 'Master Attendance';
export const EMPLOYEES_TAB_NAME = 'Employees';

const MASTER_HEADERS = [
  'Record ID',
  'Date',
  'Employee ID',
  'Employee Name',
  'Department',
  'In Time',
  'Out Time',
  'Gross Duration (mins)',
  'Break Deducted (mins)',
  'Net Working Hours',
  'Net Hours (Decimal)',
  'Status',
  'Marked By',
  'Notes',
];

const EMPLOYEES_HEADERS = [
  'Record Key',
  'Employee ID',
  'Full Name',
  'Department',
  'Role',
  'Shift Start',
  'Shift End',
  'Break Deduction (mins)',
  'Active',
  'Individual Sheet ID',
  'Individual Sheet URL',
];

const INDIVIDUAL_HEADERS = [
  'Date',
  'In Time',
  'Out Time',
  'Gross Duration (mins)',
  'Break Deducted (mins)',
  'Net Working Hours',
  'Net Hours (Decimal)',
  'Status',
  'Marked By',
  'Notes',
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
    ...sorted.map((r) => [
      r.id,
      r.date,
      r.empCode,
      r.empName,
      r.department,
      r.inTime,
      r.outTime ?? '',
      r.grossMinutes ?? '',
      r.outTime ? r.breakMinutes : '',
      r.netMinutes !== null ? formatDurationClock(r.netMinutes) : '',
      r.netDecimalHours !== null ? r.netDecimalHours : '',
      r.status === 'on_duty'
        ? 'On Duty'
        : r.status === 'short_shift'
        ? 'Short Shift'
        : 'Completed',
      r.markedBy,
      r.notes,
    ]),
  ];
}

function buildEmployeesRows(employees: Employee[]): (string | number)[][] {
  return [
    EMPLOYEES_HEADERS,
    ...employees.map((e) => [
      e.id,
      e.empCode,
      e.name,
      e.department,
      e.role,
      e.shiftStart,
      e.shiftEnd,
      e.breakMinutes,
      e.active ? 'Active' : 'Inactive',
      e.individualSheetId ?? '',
      e.individualSheetUrl ?? '',
    ]),
  ];
}

function buildIndividualEmployeeRows(
  employee: Employee,
  records: AttendanceRecord[]
): (string | number)[][] {
  const empRecords = records
    .filter((r) => r.empId === employee.id || r.empCode === employee.empCode)
    .sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return b.inTime.localeCompare(a.inTime);
    });

  const bannerRow1: (string | number)[] = [
    'Employee Sheet',
    `${employee.empCode} - ${employee.name}`,
    `Department: ${employee.department}`,
    `Role: ${employee.role}`,
    `Shift: ${employee.shiftStart} - ${employee.shiftEnd}`,
    `Break Policy: ${employee.breakMinutes} min deducted`,
  ];

  const bannerRow2: (string | number)[] = [
    'Summary',
    'Total Shifts:',
    '=COUNTA(A5:A2000)',
    'Total Break (mins):',
    '=SUM(E5:E2000)',
    'Total Net Hours:',
    '=SUM(G5:G2000)',
  ];

  const dataRows = empRecords.map((r) => [
    r.date,
    r.inTime,
    r.outTime ?? '',
    r.grossMinutes ?? '',
    r.outTime ? r.breakMinutes : '',
    r.netMinutes !== null ? formatDurationClock(r.netMinutes) : '',
    r.netDecimalHours !== null ? r.netDecimalHours : '',
    r.status === 'on_duty'
      ? 'On Duty'
      : r.status === 'short_shift'
      ? 'Short Shift'
      : 'Completed',
    r.markedBy,
    r.notes,
  ]);

  return [bannerRow1, bannerRow2, [], INDIVIDUAL_HEADERS, ...dataRows];
}

async function formatSheetHeaders(
  token: string,
  spreadsheetId: string,
  sheetMeta: Array<{ sheetId: number; title: string }>
): Promise<void> {
  const requests: unknown[] = [];

  for (const s of sheetMeta) {
    const isIndividual = s.title !== MASTER_TAB_NAME && s.title !== EMPLOYEES_TAB_NAME;
    const headerRowIndex = isIndividual ? 3 : 0; // 0-indexed row 4 for individual sheets, row 1 for master/employees
    const freezeCount = isIndividual ? 4 : 1;

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
          endColumnIndex: 14,
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

  await formatSheetHeaders(
    token,
    created.spreadsheetId,
    created.sheets.map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title }))
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
    const addRequests = missingTabs.map((t) => ({
      addSheet: {
        properties: {
          title: t,
          gridProperties: {
            frozenRowCount: t === MASTER_TAB_NAME || t === EMPLOYEES_TAB_NAME ? 1 : 4,
          },
        },
      },
    }));

    await apiFetch(`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, token, {
      method: 'POST',
      body: JSON.stringify({ requests: addRequests }),
    });

    meta = await getSpreadsheetMetadata(token, spreadsheetId);
  }

  // Clear existing ranges in tabs we are overwriting to prevent stale trailing rows
  const clearRanges = requiredTabs.map((t) => `'${t}'!A1:N5000`);
  await apiFetch(
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ ranges: clearRanges }),
    }
  );

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

  // Format newly added sheets (or reformat safely)
  if (missingTabs.length > 0) {
    const addedMeta = meta.sheets
      .filter((s) => missingTabs.includes(s.properties.title))
      .map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title }));
    await formatSheetHeaders(token, spreadsheetId, addedMeta);
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
    const addedMeta = meta.sheets
      .filter((s) => missingTabs.includes(s.properties.title))
      .map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title }));
    await formatSheetHeaders(token, spreadsheetId, addedMeta);
  }

  await apiFetch(
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        ranges: neededTabs.map((t) => `'${t}'!A1:N5000`),
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
  records: AttendanceRecord[]
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const tabTitle = 'Attendance Ledger';

  if (employee.individualSheetId) {
    try {
      const meta = await getSpreadsheetMetadata(token, employee.individualSheetId);
      const firstTab = meta.sheets[0]?.properties.title ?? tabTitle;
      await apiFetch(
        `${SHEETS_BASE}/${encodeURIComponent(meta.spreadsheetId)}/values:batchClear`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ ranges: [`'${firstTab}'!A1:N5000`] }),
        }
      );
      await apiFetch(
        `${SHEETS_BASE}/${encodeURIComponent(meta.spreadsheetId)}/values:batchUpdate`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            valueInputOption: 'USER_ENTERED',
            data: [
              {
                range: `'${firstTab}'!A1`,
                values: buildIndividualEmployeeRows(employee, records),
              },
            ],
          }),
        }
      );
      return {
        spreadsheetId: meta.spreadsheetId,
        spreadsheetUrl: meta.spreadsheetUrl,
      };
    } catch {
      // If deleted in Drive, fall through and create a fresh file
    }
  }

  const created = await apiFetch<SpreadsheetMetadataResponse>(SHEETS_BASE, token, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: `Attendance Sheet - ${employee.empCode} ${employee.name}` },
      sheets: [
        {
          properties: {
            title: tabTitle,
            gridProperties: { frozenRowCount: 4 },
          },
        },
      ],
    }),
  });

  await apiFetch(
    `${SHEETS_BASE}/${encodeURIComponent(created.spreadsheetId)}/values:batchUpdate`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: [
          {
            range: `'${tabTitle}'!A1`,
            values: buildIndividualEmployeeRows(employee, records),
          },
        ],
      }),
    }
  );

  const firstSheetId = created.sheets[0]?.properties.sheetId ?? 0;
  await apiFetch(`${SHEETS_BASE}/${encodeURIComponent(created.spreadsheetId)}:batchUpdate`, token, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: firstSheetId,
              startRowIndex: 3,
              endRowIndex: 4,
              startColumnIndex: 0,
              endColumnIndex: 10,
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
        },
        {
          repeatCell: {
            range: {
              sheetId: firstSheetId,
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
        },
      ],
    }),
  });

  return {
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl: created.spreadsheetUrl,
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
    rangesToFetch.push(`'${EMPLOYEES_TAB_NAME}'!A2:K2000`);
  }
  if (tabNames.includes(MASTER_TAB_NAME)) {
    rangesToFetch.push(`'${MASTER_TAB_NAME}'!A2:N5000`);
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
          if (!row[1] && !row[2]) continue;
          employees.push({
            id: row[0] || `emp-${row[1]}`,
            empCode: row[1] || '',
            name: row[2] || '',
            department: row[3] || 'General',
            role: row[4] || 'Staff',
            shiftStart: row[5] || '09:00',
            shiftEnd: row[6] || '18:00',
            breakMinutes: Number(row[7]) || 30,
            active: (row[8] || 'Active').toLowerCase() !== 'inactive',
            individualSheetId: row[9] || undefined,
            individualSheetUrl: row[10] || undefined,
          });
        }
      } else if (vr.range.includes(MASTER_TAB_NAME)) {
        for (const row of rows) {
          if (!row[1] || !row[2]) continue;
          const outTime = row[6] ? String(row[6]).trim() : null;
          const grossMins = row[7] !== undefined && row[7] !== '' ? Number(row[7]) : null;
          const breakMins = row[8] !== undefined && row[8] !== '' ? Number(row[8]) : 30;
          const netDec = row[10] !== undefined && row[10] !== '' ? Number(row[10]) : null;
          const netMins =
            grossMins !== null && outTime ? Math.max(0, grossMins - breakMins) : null;
          const statusLabel = (row[11] || '').toLowerCase();
          const status =
            !outTime || statusLabel === 'on duty'
              ? 'on_duty'
              : statusLabel === 'short shift'
              ? 'short_shift'
              : 'completed';

          const matchedEmp = employees.find((e) => e.empCode === row[2]);

          records.push({
            id: row[0] || `rec-${row[1]}-${row[2]}-${row[5]}`,
            date: row[1],
            empId: matchedEmp?.id || `emp-${row[2]}`,
            empCode: row[2],
            empName: row[3] || matchedEmp?.name || '',
            department: row[4] || matchedEmp?.department || '',
            inTime: row[5] || '09:00',
            outTime,
            grossMinutes: grossMins,
            breakMinutes: breakMins,
            netMinutes: netMins,
            netDecimalHours: netDec,
            status,
            markedBy: row[12] || 'Gate Guard',
            notes: row[13] || '',
            syncedToSheet: true,
            updatedAt: new Date().toISOString(),
          });
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
