import { AttendanceRecord, DriveSpreadsheetItem, Employee, SheetConfig } from '../types/attendance';
import {
  formatDisplayTime,
  getEmployeeSheetTabName,
  parseDisplayTimeToHHMM,
} from '../utils/time';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';

export const MASTER_TAB_NAME = 'Master Attendance';
export const EMPLOYEES_TAB_NAME = 'Employees';

const MASTER_HEADERS = [
  'Date',
  'Employee ID',
  'Name',
  'In Time',
  'Out Time',
  'Working Hours',
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
  'In Time',
  'Out Time',
  'Working Hours',
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
      r.date,
      r.empCode,
      r.empName,
      formatDisplayTime(r.inTime),
      r.outTime ? formatDisplayTime(r.outTime) : '',
      r.netDecimalHours !== null ? r.netDecimalHours : '',
    ]),
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
    'Employee',
    `${employee.empCode} - ${employee.name}`,
    'Break Policy',
    '30 mins auto-deducted',
  ];

  const bannerRow2: (string | number)[] = [
    'Total Days',
    '=COUNTA(A5:A2000)',
    'Total Working Hours',
    '=SUM(D5:D2000)',
  ];

  const dataRows = empRecords.map((r) => [
    r.date,
    formatDisplayTime(r.inTime),
    r.outTime ? formatDisplayTime(r.outTime) : '',
    r.netDecimalHours !== null ? r.netDecimalHours : '',
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
    const headerRowIndex = isIndividual ? 3 : 0;
    const freezeCount = isIndividual ? 4 : 1;
    const colCount = isIndividual ? 4 : s.title === MASTER_TAB_NAME ? 6 : 5;

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
            endColumnIndex: 4,
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
        ranges: requiredTabs.map((t) => `'${t}'!A1:F5000`),
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
        ranges: neededTabs.map((t) => `'${t}'!A1:F5000`),
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
  const tabTitle = 'Attendance';

  if (employee.individualSheetId) {
    try {
      const meta = await getSpreadsheetMetadata(token, employee.individualSheetId);
      const firstTab = meta.sheets[0]?.properties.title ?? tabTitle;
      await apiFetch(
        `${SHEETS_BASE}/${encodeURIComponent(meta.spreadsheetId)}/values:batchClear`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ ranges: [`'${firstTab}'!A1:D5000`] }),
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
      return { spreadsheetId: meta.spreadsheetId, spreadsheetUrl: meta.spreadsheetUrl };
    } catch {
      // Fall through and recreate if missing
    }
  }

  const created = await apiFetch<SpreadsheetMetadataResponse>(SHEETS_BASE, token, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: `${employee.empCode} - ${employee.name} Attendance` },
      sheets: [{ properties: { title: tabTitle, gridProperties: { frozenRowCount: 4 } } }],
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
  await formatSheetHeaders(token, created.spreadsheetId, [
    { sheetId: firstSheetId, title: tabTitle },
  ]);

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
    rangesToFetch.push(`'${EMPLOYEES_TAB_NAME}'!A2:E2000`);
  }
  if (tabNames.includes(MASTER_TAB_NAME)) {
    rangesToFetch.push(`'${MASTER_TAB_NAME}'!A2:F5000`);
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
        for (const row of rows) {
          const date = String(row[0] || '').trim();
          const empCode = String(row[1] || '').trim();
          const empName = String(row[2] || '').trim();
          if (!date || !empCode) continue;

          const inTime = parseDisplayTimeToHHMM(row[3]) || '09:00';
          const outTime = parseDisplayTimeToHHMM(row[4]);
          const netDec =
            row[5] !== undefined && row[5] !== '' && !Number.isNaN(Number(row[5]))
              ? Number(row[5])
              : null;
          const netMinutes = netDec !== null ? Math.round(netDec * 60) : null;
          const grossMinutes = netMinutes !== null ? netMinutes + 30 : null;
          const matchedEmp = employees.find((e) => e.empCode === empCode);

          records.push({
            id: `att-${date}-${empCode}-${inTime.replace(':', '')}`,
            date,
            empId: matchedEmp?.id || `emp-${empCode.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`,
            empCode,
            empName: empName || matchedEmp?.name || '',
            inTime,
            outTime,
            grossMinutes,
            breakMinutes: 30,
            netMinutes,
            netDecimalHours: netDec,
            status: !outTime
              ? 'on_duty'
              : netMinutes !== null && netMinutes < 240
              ? 'short_shift'
              : 'completed',
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

