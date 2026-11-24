import { AttendanceRecord, DriveSpreadsheetItem, Employee, SheetConfig } from '../types/attendance';
import {
  calculateShiftMetrics,
  formatDisplayTime,
  getDayNameShort,
  getEmployeeSheetTabName,
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
  'Overtime Hours',
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
  'Overtime Hours',
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

function getRecordOvertimeDecimal(r: AttendanceRecord): number | '' {
  if (typeof r.overtimeDecimalHours === 'number') return r.overtimeDecimalHours;
  if (r.netMinutes === null) return '';
  const isSun = r.isSunday ?? isSundayISO(r.date);
  const otMins = isSun ? r.netMinutes : Math.max(0, r.netMinutes - 480);
  return Number((otMins / 60).toFixed(2));
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
      getDayNameShort(r.date),
      r.empCode,
      r.empName,
      formatDisplayTime(r.inTime),
      r.outTime ? formatDisplayTime(r.outTime) : '',
      Math.round((r.pausedTotalSeconds ?? 0) / 60),
      r.netDecimalHours !== null ? r.netDecimalHours : '',
      getRecordOvertimeDecimal(r),
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

  const lastDataRow = empRecords.length > 0 ? 4 + empRecords.length : 5;

  const bannerRow1: (string | number)[] = [
    'Employee',
    `${employee.empCode} - ${employee.name}`,
    'Standard Shift',
    '8h (+30m break)',
    'Sunday Rule',
    '100% Overtime',
    '',
  ];

  const bannerRow2: (string | number)[] = [
    'Present Days',
    `=COUNTA(A5:A${lastDataRow})`,
    'Total Working Hours',
    `=SUM(F5:F${lastDataRow})`,
    'Total Overtime Hours',
    `=SUM(G5:G${lastDataRow})`,
    '',
  ];

  const dataRows = empRecords.map((r) => [
    r.date,
    getDayNameShort(r.date),
    formatDisplayTime(r.inTime),
    r.outTime ? formatDisplayTime(r.outTime) : '',
    Math.round((r.pausedTotalSeconds ?? 0) / 60),
    r.netDecimalHours !== null ? r.netDecimalHours : '',
    getRecordOvertimeDecimal(r),
  ]);

  const rows: (string | number)[][] = [
    bannerRow1,
    bannerRow2,
    [],
    INDIVIDUAL_HEADERS,
    ...dataRows,
  ];

  if (empRecords.length > 0) {
    rows.push([
      'TOTAL',
      `=COUNTA(A5:A${lastDataRow}) & " Days"`,
      '',
      '',
      `=SUM(E5:E${lastDataRow})`,
      `=SUM(F5:F${lastDataRow})`,
      `=SUM(G5:G${lastDataRow})`,
    ]);
  }

  return rows;
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
    const colCount = isIndividual ? 7 : s.title === MASTER_TAB_NAME ? 9 : 5;

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
            endColumnIndex: 7,
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
        ranges: requiredTabs.map((t) => `'${t}'!A1:I5000`),
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
        ranges: neededTabs.map((t) => `'${t}'!A1:I5000`),
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
          body: JSON.stringify({ ranges: [`'${firstTab}'!A1:G5000`] }),
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
  const range = encodeURIComponent(`'${tabTitle}'!A1:I5000`);
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

    if (outTime) {
      const calc = calculateShiftMetrics(
        inTime,
        outTime,
        employee.breakMinutes || 30,
        dateIso,
        awayMinutes
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
    rangesToFetch.push(`'${MASTER_TAB_NAME}'!A1:I5000`);
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
        const isNineCol = header.includes('day') || header.includes('overtime hours');
        for (const row of rows.slice(1)) {
          const date = normalizeDateToISO(row[0]);
          const empCode = String((isNineCol ? row[2] : row[1]) || '').trim();
          const empName = String((isNineCol ? row[3] : row[2]) || '').trim();
          if (!date || !empCode) continue;

          const inTime =
            parseDisplayTimeToHHMM(isNineCol ? row[4] : row[3]) || '09:00';
          const outTime = parseDisplayTimeToHHMM(isNineCol ? row[5] : row[4]);
          const awayMins = isNineCol && !Number.isNaN(Number(row[6])) ? Math.max(0, Number(row[6])) : 0;
          const matchedEmp = employees.find((e) => e.empCode === empCode);
          const empId =
            matchedEmp?.id || `emp-${empCode.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;

          if (outTime) {
            const calc = calculateShiftMetrics(inTime, outTime, 30, date, awayMins);
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

