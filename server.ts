import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_FILE = path.resolve(DATA_DIR, 'gatelog.json');
const FIREBASE_CONFIG_FILE = path.resolve(process.cwd(), 'firebase-applet-config.json');

// Session signing secret: use env var if provided, else secure random 32-byte key in memory
const SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
    ? process.env.SESSION_SECRET
    : crypto.randomBytes(32).toString('hex');

interface StoredEmployee {
  id: string;
  empCode: string;
  name: string;
  department: string;
  breakMinutes: number;
  active: boolean;
  individualSheetId?: string;
  individualSheetUrl?: string;
}

interface StoredRecord {
  id: string;
  date: string;
  empId: string;
  empCode: string;
  empName: string;
  inTime: string;
  outTime: string | null;
  grossMinutes: number | null;
  breakMinutes: number;
  netMinutes: number | null;
  netDecimalHours: number | null;
  status: 'on_duty' | 'completed' | 'short_shift';
  syncedToSheet: boolean;
  updatedAt: string;
}

interface StoredSheetConfig {
  spreadsheetId: string;
  spreadsheetTitle: string;
  spreadsheetUrl: string;
  lastSyncedAt: string | null;
  tabNames: string[];
}

interface StoreState {
  adminEmail: string | null;
  adminPasswordHash: string | null; // format: "saltHex:hashHex"
  sheetConfig: StoredSheetConfig | null;
  employees: StoredEmployee[];
  records: StoredRecord[];
}

function getFirebaseApiKey(): string | null {
  try {
    if (!fs.existsSync(FIREBASE_CONFIG_FILE)) return null;
    const raw = fs.readFileSync(FIREBASE_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { apiKey?: string };
    return parsed.apiKey || null;
  } catch {
    return null;
  }
}

function readStore(): StoreState {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      return {
        adminEmail: null,
        adminPasswordHash: null,
        sheetConfig: null,
        employees: [],
        records: [],
      };
    }
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoreState>;
    return {
      adminEmail: parsed.adminEmail ?? null,
      adminPasswordHash: parsed.adminPasswordHash ?? null,
      sheetConfig: parsed.sheetConfig ?? null,
      employees: Array.isArray(parsed.employees) ? parsed.employees : [],
      records: Array.isArray(parsed.records) ? parsed.records : [],
    };
  } catch {
    return {
      adminEmail: null,
      adminPasswordHash: null,
      sheetConfig: null,
      employees: [],
      records: [],
    };
  }
}

function writeStore(state: StoreState): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmpFile, STORE_FILE);
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(derived, expectedBuf);
}

function constantTimeStringMatch(a: string, b: string): boolean {
  const aHash = crypto.createHash('sha256').update(a).digest();
  const bHash = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

function issueAdminToken(subject: string): string {
  const payload = {
    sub: subject,
    role: 'admin',
    exp: Date.now() + 24 * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyAdminToken(token: string): { sub: string; role: string; exp: number } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8')) as {
      sub: string;
      role: string;
      exp: number;
    };
    if (payload.role !== 'admin' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function validateTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).format(new Date());
    return tz.trim();
  } catch {
    return 'UTC';
  }
}

function getServerLocalDateAndTime(timeZone: string): { date: string; time: string } {
  const now = new Date();
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const date = dateFmt.format(now);
  let time = timeFmt.format(now);
  if (time.startsWith('24:')) {
    time = `00:${time.slice(3)}`;
  }
  return { date, time };
}

function parseMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function computeShiftMetrics(inTime: string, outTime: string, breakMins = 30) {
  const inM = parseMinutes(inTime);
  let outM = parseMinutes(outTime);
  if (outM < inM) outM += 24 * 60;
  const grossMinutes = Math.max(0, outM - inM);
  const safeBreak = Math.max(0, Math.min(180, breakMins));
  const breakDeducted = grossMinutes >= safeBreak ? safeBreak : grossMinutes;
  const netMinutes = Math.max(0, grossMinutes - breakDeducted);
  const netDecimalHours = Number((netMinutes / 60).toFixed(2));
  const status: 'completed' | 'short_shift' = netMinutes < 240 ? 'short_shift' : 'completed';
  return {
    grossMinutes,
    breakMinutes: breakDeducted,
    netMinutes,
    netDecimalHours,
    status,
  };
}

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Admin authorization required.' });
    return;
  }
  const token = header.slice(7).trim();
  const payload = verifyAdminToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Admin session expired or invalid.' });
    return;
  }
  next();
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ============================================================================
  // PUBLIC GATE ROUTES (Guard Uncle — No login required, strict live clock only)
  // ============================================================================
  app.get('/api/gate/status', (req, res) => {
    const tz = validateTimeZone(req.query.tz);
    const { date, time } = getServerLocalDateAndTime(tz);
    const store = readStore();

    const activeEmployees = store.employees
      .filter((e) => e.active)
      .map((e) => ({
        id: e.id,
        empCode: e.empCode,
        name: e.name,
        department: e.department,
      }));

    const todayRecords = store.records.filter((r) => r.date === date);

    res.json({
      serverDate: date,
      serverTime: time,
      employees: activeEmployees,
      todayRecords,
    });
  });

  app.post('/api/gate/mark-in', (req, res) => {
    const { empId, tz } = req.body as { empId?: unknown; tz?: unknown };
    if (!isValidId(empId)) {
      res.status(400).json({ error: 'Invalid employee identifier.' });
      return;
    }

    const safeTz = validateTimeZone(tz);
    const { date, time } = getServerLocalDateAndTime(safeTz);
    const store = readStore();

    const employee = store.employees.find((e) => e.id === empId && e.active);
    if (!employee) {
      res.status(404).json({ error: 'Active employee not found.' });
      return;
    }

    const existingToday = store.records.find(
      (r) => r.empId === employee.id && r.date === date
    );
    if (existingToday) {
      res.status(409).json({
        error:
          existingToday.status === 'on_duty'
            ? `${employee.name} is already marked IN today.`
            : `${employee.name} has already completed today's shift.`,
      });
      return;
    }

    const record: StoredRecord = {
      id: `att-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
      date,
      empId: employee.id,
      empCode: employee.empCode,
      empName: employee.name,
      inTime: time,
      outTime: null,
      grossMinutes: null,
      breakMinutes: employee.breakMinutes ?? 30,
      netMinutes: null,
      netDecimalHours: null,
      status: 'on_duty',
      syncedToSheet: false,
      updatedAt: new Date().toISOString(),
    };

    store.records.unshift(record);
    writeStore(store);

    res.status(201).json({ record, serverTime: time, serverDate: date });
  });

  app.post('/api/gate/mark-out', (req, res) => {
    const { recordId, tz } = req.body as { recordId?: unknown; tz?: unknown };
    if (!isValidId(recordId)) {
      res.status(400).json({ error: 'Invalid attendance record identifier.' });
      return;
    }

    const safeTz = validateTimeZone(tz);
    const { date, time } = getServerLocalDateAndTime(safeTz);
    const store = readStore();

    const idx = store.records.findIndex((r) => r.id === recordId);
    if (idx === -1) {
      res.status(404).json({ error: 'Attendance record not found.' });
      return;
    }

    const existing = store.records[idx];
    if (existing.outTime !== null || existing.status !== 'on_duty') {
      res.status(409).json({ error: 'Employee is already marked OUT for this shift.' });
      return;
    }

    const employee = store.employees.find((e) => e.id === existing.empId);
    const breakPolicy = employee?.breakMinutes ?? existing.breakMinutes ?? 30;
    const calc = computeShiftMetrics(existing.inTime, time, breakPolicy);

    const updated: StoredRecord = {
      ...existing,
      outTime: time,
      grossMinutes: calc.grossMinutes,
      breakMinutes: calc.breakMinutes,
      netMinutes: calc.netMinutes,
      netDecimalHours: calc.netDecimalHours,
      status: calc.status,
      syncedToSheet: false,
      updatedAt: new Date().toISOString(),
    };

    store.records[idx] = updated;
    writeStore(store);

    res.json({ record: updated, serverTime: time, serverDate: date });
  });

  // ============================================================================
  // ADMIN AUTH ROUTES
  // ============================================================================
  app.get('/api/admin/auth-status', (_req, res) => {
    const store = readStore();
    const envPasscode = process.env.ADMIN_PASSCODE?.trim() ?? '';
    res.json({
      hasEnvPasscode: envPasscode.length > 0,
      isAdminClaimed: Boolean(store.adminPasswordHash),
      adminEmail: store.adminEmail,
    });
  });

  app.post('/api/admin/setup-password', (req, res) => {
    const { password } = req.body as { password?: unknown };
    if (typeof password !== 'string' || password.trim().length < 4 || password.length > 100) {
      res.status(400).json({ error: 'Admin password must be between 4 and 100 characters.' });
      return;
    }

    const envPasscode = process.env.ADMIN_PASSCODE?.trim() ?? '';
    const store = readStore();

    if (envPasscode.length > 0 || store.adminPasswordHash) {
      res.status(409).json({ error: 'Admin password is already configured.' });
      return;
    }

    store.adminPasswordHash = hashPassword(password.trim());
    writeStore(store);

    const token = issueAdminToken('admin-password');
    res.json({ token });
  });

  app.post('/api/admin/login-password', (req, res) => {
    const { password } = req.body as { password?: unknown };
    if (typeof password !== 'string' || !password.trim()) {
      res.status(400).json({ error: 'Password is required.' });
      return;
    }

    const envPasscode = process.env.ADMIN_PASSCODE?.trim() ?? '';
    const store = readStore();

    if (envPasscode.length > 0) {
      if (!constantTimeStringMatch(password.trim(), envPasscode)) {
        res.status(401).json({ error: 'Incorrect admin password.' });
        return;
      }
      res.json({ token: issueAdminToken('admin-env') });
      return;
    }

    if (!store.adminPasswordHash) {
      res.status(400).json({ error: 'Admin password has not been set up yet.' });
      return;
    }

    if (!verifyPasswordHash(password.trim(), store.adminPasswordHash)) {
      res.status(401).json({ error: 'Incorrect admin password.' });
      return;
    }

    res.json({ token: issueAdminToken('admin-local') });
  });

  app.post('/api/admin/google-login', async (req, res) => {
    const { idToken } = req.body as { idToken?: unknown };
    if (typeof idToken !== 'string' || !idToken.trim()) {
      res.status(400).json({ error: 'Missing Google ID token.' });
      return;
    }

    const apiKey = getFirebaseApiKey();
    if (!apiKey) {
      res.status(500).json({ error: 'Firebase configuration missing on server.' });
      return;
    }

    try {
      const verifyRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: idToken.trim() }),
        }
      );

      if (!verifyRes.ok) {
        res.status(401).json({ error: 'Google token verification failed.' });
        return;
      }

      const body = (await verifyRes.json()) as {
        users?: Array<{ email?: string; emailVerified?: boolean }>;
      };
      const verifiedUser = body.users?.[0];
      if (!verifiedUser?.email || !verifiedUser.emailVerified) {
        res.status(401).json({ error: 'Verified Google email required for Admin access.' });
        return;
      }

      const email = verifiedUser.email.toLowerCase();
      const store = readStore();

      // Lock workspace to the first Admin email who signs in (or env ADMIN_EMAIL if set)
      const envAdminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
      const allowedEmail = envAdminEmail || store.adminEmail;

      if (allowedEmail && allowedEmail !== email) {
        res.status(403).json({
          error: `This workspace is locked to Admin (${allowedEmail}).`,
        });
        return;
      }

      if (!store.adminEmail) {
        store.adminEmail = email;
        writeStore(store);
      }

      const token = issueAdminToken(email);
      res.json({ token, adminEmail: email });
    } catch {
      res.status(500).json({ error: 'Failed to verify Google Admin session.' });
    }
  });

  app.post('/api/admin/change-password', requireAdmin, (req, res) => {
    const { newPassword } = req.body as { newPassword?: unknown };
    if (typeof newPassword !== 'string' || newPassword.trim().length < 4 || newPassword.length > 100) {
      res.status(400).json({ error: 'New password must be 4–100 characters.' });
      return;
    }
    const store = readStore();
    store.adminPasswordHash = hashPassword(newPassword.trim());
    writeStore(store);
    res.json({ ok: true });
  });

  // ============================================================================
  // PROTECTED ADMIN DATA ROUTES
  // ============================================================================
  app.get('/api/admin/state', requireAdmin, (_req, res) => {
    const store = readStore();
    res.json({
      employees: store.employees,
      records: store.records,
      sheetConfig: store.sheetConfig,
      adminEmail: store.adminEmail,
    });
  });

  app.post('/api/admin/employees', requireAdmin, (req, res) => {
    const body = req.body as Partial<StoredEmployee>;
    if (
      typeof body.empCode !== 'string' ||
      !body.empCode.trim() ||
      typeof body.name !== 'string' ||
      !body.name.trim()
    ) {
      res.status(400).json({ error: 'Employee ID and Name are required.' });
      return;
    }

    const store = readStore();
    const id = isValidId(body.id) ? body.id : `emp-${Date.now()}`;
    const existingIdx = store.employees.findIndex((e) => e.id === id);

    const emp: StoredEmployee = {
      id,
      empCode: body.empCode.trim().slice(0, 30),
      name: body.name.trim().slice(0, 80),
      department:
        typeof body.department === 'string' && body.department.trim()
          ? body.department.trim().slice(0, 60)
          : 'General',
      breakMinutes:
        typeof body.breakMinutes === 'number' && body.breakMinutes >= 0 && body.breakMinutes <= 180
          ? body.breakMinutes
          : 30,
      active: body.active !== false,
      individualSheetId:
        typeof body.individualSheetId === 'string' ? body.individualSheetId : undefined,
      individualSheetUrl:
        typeof body.individualSheetUrl === 'string' ? body.individualSheetUrl : undefined,
    };

    if (existingIdx >= 0) {
      store.employees[existingIdx] = emp;
    } else {
      store.employees.push(emp);
    }

    writeStore(store);
    res.json({ employee: emp, employees: store.employees });
  });

  app.post('/api/admin/employees/starter', requireAdmin, (_req, res) => {
    const store = readStore();
    if (store.employees.length > 0) {
      res.json({ employees: store.employees });
      return;
    }
    store.employees = [
      { id: 'emp-101', empCode: 'EMP-001', name: 'Rajesh Kumar', department: 'Production', breakMinutes: 30, active: true },
      { id: 'emp-102', empCode: 'EMP-002', name: 'Anita Sharma', department: 'Quality', breakMinutes: 30, active: true },
      { id: 'emp-103', empCode: 'EMP-003', name: 'Vikram Patel', department: 'Dispatch', breakMinutes: 30, active: true },
      { id: 'emp-104', empCode: 'EMP-004', name: 'Meena Verma', department: 'Packaging', breakMinutes: 30, active: true },
      { id: 'emp-105', empCode: 'EMP-005', name: 'Suresh Nair', department: 'Maintenance', breakMinutes: 30, active: true },
    ];
    writeStore(store);
    res.json({ employees: store.employees });
  });

  app.put('/api/admin/records/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) {
      res.status(400).json({ error: 'Invalid record ID.' });
      return;
    }

    const body = req.body as Partial<StoredRecord>;
    const store = readStore();
    const idx = store.records.findIndex((r) => r.id === id);
    if (idx === -1) {
      res.status(404).json({ error: 'Attendance record not found.' });
      return;
    }

    const prev = store.records[idx];
    const date =
      typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : prev.date;
    const inTime =
      typeof body.inTime === 'string' && /^\d{2}:\d{2}$/.test(body.inTime)
        ? body.inTime
        : prev.inTime;
    const outTime =
      body.outTime === null || body.outTime === ''
        ? null
        : typeof body.outTime === 'string' && /^\d{2}:\d{2}$/.test(body.outTime)
        ? body.outTime
        : prev.outTime;
    const breakMinutes =
      typeof body.breakMinutes === 'number' && body.breakMinutes >= 0 && body.breakMinutes <= 180
        ? body.breakMinutes
        : prev.breakMinutes;

    let updated: StoredRecord;
    if (outTime) {
      const calc = computeShiftMetrics(inTime, outTime, breakMinutes);
      updated = {
        ...prev,
        date,
        inTime,
        outTime,
        grossMinutes: calc.grossMinutes,
        breakMinutes: calc.breakMinutes,
        netMinutes: calc.netMinutes,
        netDecimalHours: calc.netDecimalHours,
        status: calc.status,
        syncedToSheet: false,
        updatedAt: new Date().toISOString(),
      };
    } else {
      updated = {
        ...prev,
        date,
        inTime,
        outTime: null,
        grossMinutes: null,
        breakMinutes,
        netMinutes: null,
        netDecimalHours: null,
        status: 'on_duty',
        syncedToSheet: false,
        updatedAt: new Date().toISOString(),
      };
    }

    store.records[idx] = updated;
    writeStore(store);
    res.json({ record: updated });
  });

  app.delete('/api/admin/records/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) {
      res.status(400).json({ error: 'Invalid record ID.' });
      return;
    }
    const store = readStore();
    store.records = store.records.filter((r) => r.id !== id);
    writeStore(store);
    res.json({ ok: true });
  });

  app.post('/api/admin/sheet-config', requireAdmin, (req, res) => {
    const { sheetConfig, markSynced } = req.body as {
      sheetConfig?: StoredSheetConfig | null;
      markSynced?: boolean;
    };
    const store = readStore();
    store.sheetConfig = sheetConfig ?? null;
    if (markSynced) {
      store.records = store.records.map((r) => ({ ...r, syncedToSheet: true }));
    }
    writeStore(store);
    res.json({ sheetConfig: store.sheetConfig });
  });

  app.post('/api/admin/import-from-sheet', requireAdmin, (req, res) => {
    const { employees, records, sheetConfig } = req.body as {
      employees?: StoredEmployee[];
      records?: StoredRecord[];
      sheetConfig?: StoredSheetConfig;
    };
    const store = readStore();
    if (Array.isArray(employees)) store.employees = employees;
    if (Array.isArray(records)) store.records = records;
    if (sheetConfig) store.sheetConfig = sheetConfig;
    writeStore(store);
    res.json({ ok: true });
  });

  // ============================================================================
  // VITE / STATIC SERVING
  // ============================================================================
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GateLog server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
