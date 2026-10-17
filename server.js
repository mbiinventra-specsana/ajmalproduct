// bill.mbiinventra.com — MbiInventra RCM Academy
// USA medical billing training simulator. Login only — no public registration;
// accounts are created by an administrator.
// DB: SQLite by default; MariaDB/MySQL via DB_ENGINE=mysql (+ DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME).
// Tables auto-create on boot (see lib/db.js).
require('./lib/env'); // FIRST: load NexPanel env file + normalize, before anything reads env
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const db = require('./lib/db');
const labData = require('./lib/lab-data');

const app = express();
app.set('trust proxy', 1); // behind NexPanel/nginx: lets req.secure reflect X-Forwarded-Proto
const PORT = process.env.PORT || 3000;
const ADMIN_PATH = (process.env.ADMIN_PATH || '/admin').replace(/\/$/, '') || '/admin';

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '256kb' }));
// gzip compression — must come before static + routes for max effect
app.use(require('compression')({ threshold: 1024 }));
app.use(session({
  name: 'bill.sid',
  secret: process.env.SESSION_SECRET || 'bill-dev-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12,
            secure: 'auto' }, // Secure only when actually on HTTPS; works on both
}));

// ---- active session tracking (throttled last_seen; powers admin session control) ----
app.use((req, res, next) => {
  if (req.session && req.session.userId && req.sessionID) {
    const now = Date.now();
    if (!req.session._ls || now - req.session._ls > 5 * 60 * 1000) {
      req.session._ls = now;
      db.run('UPDATE login_sessions SET last_seen = ?, ip = ? WHERE session_id = ?',
        [db.now(), req.ip || '', req.sessionID]).catch(() => {});
    }
  }
  next();
});
// ---- IP block enforcement (early; blocks everything except the notice itself) ----
const _ipBlockCache = new Map(); // ip -> {blocked, until}
app.use((req, res, next) => {
  const ip = req.ip || '';
  if (!ip) return next();
  const c = _ipBlockCache.get(ip), now = Date.now();
  const check = (blocked) => {
    if (!blocked) return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Access denied from this IP.', ipBlocked: true });
    return res.status(403).send('<!DOCTYPE html><html><head><title>403</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f2743;color:#fff"><div style="text-align:center"><h1>403 — Access denied</h1><p>Your IP address has been blocked by the administrator.</p></div></body></html>');
  };
  if (c && c.until > now) return check(c.blocked);
  db.get('SELECT id FROM ip_blocks WHERE ip = ?', [ip]).then(row => {
    _ipBlockCache.set(ip, { blocked: !!row, until: now + 60 * 1000 });
    check(!!row);
  }).catch(() => next());
});
function clearIpBlockCache(ip) { if (ip) _ipBlockCache.delete(ip); }
// prune dead session rows every 30 min (older than 24h)
setInterval(() => {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  db.run('DELETE FROM login_sessions WHERE last_seen < ?', [cutoff]).catch(() => {});
}, 30 * 60 * 1000);

// login rate limiter (in-memory)
const fails = new Map();
app.use('/api/login', (req, res, next) => {
  const f = fails.get(req.ip), now = Date.now();
  if (f && f.until > now) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  if (f && f.until <= now) fails.delete(req.ip);
  next();
});
function noteFail(req) {
  const f = fails.get(req.ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 8) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  fails.set(req.ip, f);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const stripQ = (q) => ({ id: q.id, qnum: q.qnum, prompt: q.prompt,
  options: JSON.parse(q.options), points: q.points, hint: q.hint });

async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please log in.' });
  const u = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!u) return res.status(401).json({ error: 'Please log in.' });
  req.user = u;
  // per-student feature gate (admin/instructor bypass; missing row = enabled)
  // item-level (menu:<key>) is checked first, then group-level (backward compat:
  // group OFF still disables everything in it)
  if (u.role === 'student') {
    const itemKey = menuItemForPath(req.path);
    const groupKey = featureForPath(req.path);
    if (itemKey || groupKey) {
      const rows = await db.all('SELECT feature, enabled FROM student_features WHERE user_id = ?', [u.id]);
      const off = new Set(rows.filter(r => !r.enabled).map(r => r.feature));
      let blocked = null;
      if (itemKey && off.has('menu:' + itemKey)) blocked = 'menu:' + itemKey;
      else if (groupKey && off.has(groupKey)) blocked = groupKey;
      if (blocked)
        return res.status(403).json({ error: 'This menu item is disabled for your account.', featureDisabled: blocked });
    }
  }
  next();
}
// student-side feature groups; used for per-student ON/OFF + sidebar filtering
const FEATURES = [
  ['workspace', 'Workspace', '🏠', 'Command Center, Work Queue'],
  ['patients', 'Patients', '🧑‍⚕️', 'Patients, Insurance, Eligibility'],
  ['billing', 'Billing', '🧾', 'Charge Entry, Claims'],
  ['revenue', 'Revenue Cycle', '💳', 'Payments, A/R, Denials, Reports'],
  ['training', 'Training', '🎯', 'Case Center, Assignments, Practice Lab, My Progress'],
  ['labs', 'Advanced Labs', '🧪', 'Scrubber, Denial Lab, Sprints, Quiz Arena'],
];
function featureForPath(p) {
  if (p === '/api/dashboard' || p.startsWith('/api/rcm/overview') || p.startsWith('/api/rcm/work-queue')) return 'workspace';
  if (p === '/api/patients' || p.startsWith('/api/rcm/patients') || p.startsWith('/api/rcm/insurance') || p.startsWith('/api/rcm/eligibility')) return 'patients';
  if (p.startsWith('/api/rcm/charges') || p.startsWith('/api/rcm/claims')) return 'billing';
  if (p.startsWith('/api/rcm/payments') || p.startsWith('/api/rcm/ar') || p.startsWith('/api/rcm/denials') || p.startsWith('/api/rcm/reports')) return 'revenue';
  if (p.startsWith('/api/cases') || p.startsWith('/api/attempts') || p.startsWith('/api/progress')) return 'training';
  if (p.startsWith('/api/labs/')) return 'labs';
  return null;
}
// per-menu-item catalog: [itemKey, label, groupKey, iconKey] — mirrors shell() nav in public/js/app.js
const MENU_ITEMS = [
  ['dashboard', 'Command Center', 'workspace', 'grid'],
  ['workqueue', 'Work Queue', 'workspace', 'inbox'],
  ['patients', 'Patients', 'patients', 'users'],
  ['insurance', 'Insurance', 'patients', 'shield'],
  ['eligibility', 'Eligibility', 'patients', 'check'],
  ['charges', 'Charge Entry', 'billing', 'receipt'],
  ['claims', 'Claims', 'billing', 'file'],
  ['payments', 'Payments', 'revenue', 'card'],
  ['ar', 'A/R Follow-up', 'revenue', 'trend'],
  ['denialsq', 'Denials', 'revenue', 'ban'],
  ['reports', 'Reports', 'revenue', 'chart'],
  ['training', 'Case Center', 'training', 'target'],
  ['assignments', 'Assignments', 'training', 'clip'],
  ['lab', 'Practice Lab', 'training', 'flask'],
  ['progress', 'My Progress', 'training', 'award'],
  ['scrubber', 'Claim Scrubber', 'labs', 'spark'],
  ['denials', 'Denial Crime-Scene', 'labs', 'search'],
  ['sprints', 'Coding Sprints', 'labs', 'zap'],
  ['quiz', 'Quiz Arena', 'labs', 'help'],
  ['era', 'ERA Posting Sim', 'labs', 'doc'],
  ['statements', 'Patient Statements', 'labs', 'receipt'],
  ['ub04', 'UB-04 Institutional', 'labs', 'building'],
  ['ncci', 'NCCI Checker', 'labs', 'link'],
  ['priorauth', 'Prior Auth Lab', 'labs', 'clip'],
  ['clearinghouse', 'Clearinghouse Sim', 'labs', 'send'],
  ['cred', 'Credentialing Tracker', 'labs', 'clip'],
];
const MENU_ITEM_KEYS = MENU_ITEMS.map(m => m[0]);
// per-function catalog: [fnKey, label] — actions inside pages, toggleable per student
// (DB key is 'fn:' + fnKey; missing row = enabled)
const FN_ITEMS = [
  ['claims-create', 'New Claim'],
  ['claims-validate', 'Run Scrubber'],
  ['claims-submit', 'Submit to Payer'],
  ['claims-appeal', 'Appeal Denial'],
  ['claims-correct', 'Correct & Rebill'],
  ['claims-writeoff', 'Write-off'],
  ['charges-add', 'Add Charge'],
  ['charges-delete', 'Delete Charge'],
  ['payments-post', 'Post Payment'],
  ['ar-note', 'Add Follow-up Note'],
  ['eligibility-verify', 'Run Verification'],
  ['insurance-add', 'Add Policy'],
  ['lab-run', 'Run Lab / Submit Quiz'],
];
const FN_KEYS = FN_ITEMS.map(f => f[0]);
// middleware: block students when fn:<key> is disabled (admin/instructor bypass)
// must run AFTER requireAuth (uses req.user)
function requireFn(key) {
  return ah(async (req, res, next) => {
    const u = req.user;
    if (u && u.role === 'student') {
      const row = await db.get('SELECT enabled FROM student_features WHERE user_id=? AND feature=?', [u.id, 'fn:' + key]);
      if (row && !row.enabled)
        return res.status(403).json({ error: 'This function is disabled for your account.', featureDisabled: 'fn:' + key });
    }
    next();
  });
}
// same, but picks the fn key from req.body.action (for denials resolve)
function requireFnAction(map) {
  return ah(async (req, res, next) => {
    const u = req.user;
    const key = map[(req.body && req.body.action) || ''];
    if (u && u.role === 'student' && key) {
      const row = await db.get('SELECT enabled FROM student_features WHERE user_id=? AND feature=?', [u.id, 'fn:' + key]);
      if (row && !row.enabled)
        return res.status(403).json({ error: 'This function is disabled for your account.', featureDisabled: 'fn:' + key });
    }
    next();
  });
}
// maps an API path to a single menu item key (null = ambiguous/shared → group fallback)
function menuItemForPath(p) {
  if (p === '/api/dashboard') return 'dashboard';
  if (p.startsWith('/api/rcm/work-queue')) return 'workqueue';
  if (p === '/api/patients' || p.startsWith('/api/rcm/patients')) return 'patients';
  if (p.startsWith('/api/rcm/insurance')) return 'insurance';
  if (p.startsWith('/api/rcm/eligibility')) return 'eligibility';
  if (p.startsWith('/api/rcm/charges')) return 'charges';
  if (p.startsWith('/api/rcm/claims')) return 'claims';
  if (p.startsWith('/api/rcm/payments')) return 'payments';
  if (p.startsWith('/api/rcm/ar')) return 'ar';
  if (p.startsWith('/api/rcm/denials')) return 'denialsq';
  if (p.startsWith('/api/rcm/reports')) return 'reports';
  if (p.startsWith('/api/cases') || p.startsWith('/api/attempts')) return 'training';
  if (p.startsWith('/api/progress')) return 'progress';
  if (p.startsWith('/api/labs/scrubber')) return 'scrubber';
  if (p.startsWith('/api/labs/denials')) return 'denials';
  if (p.startsWith('/api/labs/sprints')) return 'sprints';
  if (p.startsWith('/api/labs/quiz')) return 'quiz';
  if (p.startsWith('/api/labs/era')) return 'era';
  if (p.startsWith('/api/labs/priorauth')) return 'priorauth';
  if (p.startsWith('/api/labs/clearinghouse')) return 'clearinghouse';
  if (p.startsWith('/api/labs/statements')) return 'statements';
  if (p.startsWith('/api/labs/ub04')) return 'ub04';
  if (p.startsWith('/api/labs/ncci')) return 'ncci';
  if (p.startsWith('/api/labs/cred')) return 'cred';
  return null;
}
async function requireAdmin(req, res, next) {
  const u = req.session.userId && await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  req.adminUser = u;
  next();
}
async function userStats(userId) {
  const done = await db.get(
    `SELECT COUNT(DISTINCT case_id) AS c, COALESCE(SUM(score),0) AS pts
     FROM attempts WHERE user_id = ? AND status = 'completed'`, [userId]);
  const att = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(AVG(100.0*score/NULLIF(max_score,0)),0) AS acc
     FROM attempts WHERE user_id = ? AND status = 'completed'`, [userId]);
  const total = (await db.get('SELECT COUNT(*) AS n FROM cases WHERE active = 1')).n;
  const points = Number(done.pts) || 0;
  const best = await db.get(
    `SELECT COALESCE(MAX(100.0*score/NULLIF(max_score,0)),0) AS b FROM attempts WHERE user_id = ? AND status = 'completed'`, [userId]);
  return { points, level: db.levelFor(points),
    casesCompleted: done.c || 0, totalCases: total,
    accuracy: Math.round((att.acc || 0) * 10) / 10, attempts: att.n || 0,
    bestScore: Math.round(best.b || 0) };
}
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next); // async handler

// ---- activity logging (fire-and-forget; never blocks the request) ----
function logActivity(userId, action, detail, req) {
  db.run(
    'INSERT INTO activity_logs (user_id, action, detail, ip, user_agent, created_at) VALUES (?,?,?,?,?,?)',
    [userId || null, String(action).slice(0, 64), String(detail || '').slice(0, 500),
     (req && req.ip || '').slice(0, 64), (req && req.get && req.get('User-Agent') || '').slice(0, 500), db.now()]
  ).catch(() => {});
}

// ---------- pages ----------
// Cache-busting: every deploy gets a fresh version so browsers never serve stale JS/CSS
const APP_V = Date.now().toString(36);
// MySQL returns DATETIME as JS Date objects, SQLite as strings — handle both
const parseDbTs = (v) => {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v).replace(' ', 'T') + 'Z').getTime();
  return isNaN(t) ? 0 : t;
};
// Tiny in-memory cache for heavy admin read APIs (per-key TTL). Cleared on relevant writes.
const _apiCache = new Map();
const cached = (key, ttlMs, fn) => async (req, res) => {
  const uid = req.session ? (req.session.userId || '') : '';
  const ck = key + ':' + (req.query.days || '') + ':' + uid;
  const hit = _apiCache.get(ck);
  if (hit && Date.now() - hit.t < ttlMs) return res.json(hit.d);
  const data = await fn(req);
  _apiCache.set(ck, { t: Date.now(), d: data });
  res.json(data);
};
const bustAdminCache = () => { for (const k of _apiCache.keys()) _apiCache.delete(k); };
const send = (f) => (req, res) => {
  const fp = path.join(__dirname, 'public', f);
  if (!f.endsWith('.html')) return res.sendFile(fp);
  try {
    let html = fs.readFileSync(fp, 'utf8');
    html = html.replaceAll('/js/app.js', `/js/app.js?v=${APP_V}`).replaceAll('/css/app.css', `/css/app.css?v=${APP_V}`);
    res.type('html').send(html);
  } catch { res.sendFile(fp); }
};
app.get('/', send('index.html'));
app.get('/login', send('login.html'));
// student portal: /stu is the student side entry (dashboard)
app.get('/stu', (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');
  send('dashboard.html')(req, res, next);
});
app.get('/stu/', (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');
  send('dashboard.html')(req, res, next);
});
app.get('/dashboard', send('dashboard.html'));
app.get('/training', send('training.html'));
app.get('/play', send('play.html'));
app.get('/progress', send('progress.html'));
app.get('/lab', send('lab.html'));
// advanced labs (real-software replica training)
app.get('/labs/scrubber', send('labs/scrubber.html'));
app.get('/labs/denials', send('labs/denials.html'));
app.get('/labs/sprints', send('labs/sprints.html'));
app.get('/labs/quiz', send('labs/quiz.html'));
app.get('/labs/era', send('labs/era-posting.html'));
app.get('/labs/priorauth', send('labs/priorauth.html'));
app.get('/labs/clearinghouse', send('labs/clearinghouse.html'));
app.get('/labs/ub04', send('labs/ub04.html'));
app.get('/labs/ncci', send('labs/ncci.html'));
app.get('/labs/statements', send('labs/statements.html'));
app.get('/labs/credentialing', send('labs/credentialing.html'));
app.get('/work-queue', send('work-queue.html'));
app.get('/patients', send('patients.html'));
app.get('/insurance', send('insurance.html'));
app.get('/eligibility', send('eligibility.html'));
app.get('/charges', send('charges.html'));
app.get('/claims', send('claims.html'));
app.get('/payments', send('payments.html'));
app.get('/ar', send('ar.html'));
app.get('/denials', send('denials.html'));
app.get('/reports', send('reports.html'));
app.get('/assignments', send('assignments.html'));
// owner entry: fully separate path — serves the owner login when logged out,
// the panel when logged in as admin. Never linked from the user side.
async function ownerPage(req, res, next) {
  try {
    const u = req.session.userId ? await db.get('SELECT role FROM users WHERE id=?', [req.session.userId]) : null;
    if (u && u.role === 'admin') return send('owner.html')(req, res, next);
    return send('owner-login.html')(req, res, next);
  } catch (e) { next(e); }
}
app.get('/owner', ownerPage);
app.get('/owner/', ownerPage);
app.get('/owner/:section(analytics|accounts|announce|sessions|system|menus|activity)', ownerPage);
app.get(ADMIN_PATH, send('admin.html'));
app.get(ADMIN_PATH + '/', send('admin.html'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
// NOTE: intentionally NO /register route anywhere.

// ---------- auth API (login only) ----------
app.post('/api/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const emailInput = typeof email === 'string' ? email.trim().toLowerCase() : '';
  // accept both "admin" and "admin@local" (older installs used the @local suffix;
  // browsers may autofill either one)
  const candidates = [...new Set([emailInput,
    emailInput.includes('@') ? emailInput.replace(/@local$/, '') : emailInput + '@local'])];
  let u = null;
  for (const c of candidates) {
    if (!c) continue;
    u = await db.get('SELECT * FROM users WHERE email = ?', [c]);
    if (u) break;
  }
  const ok = u && db.verifyPassword(password || '', u.pass_hash);
  if (!ok) { noteFail(req); logActivity(u ? u.id : null, 'login_failed', 'email=' + emailInput, req); return res.status(401).json({ error: 'Invalid email or password.' }); }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error.' });
    req.session.userId = u.id;
    const done = () => res.json({ ok: true, user: pub(u) });
    (async () => {
      try {
        const sid = req.sessionID;
        // single-device enforcement (per-student toggle)
        const sd = await db.get("SELECT enabled FROM student_features WHERE user_id=? AND feature='single_device'", [u.id]);
        if (sd && sd.enabled) {
          const others = await db.all('SELECT session_id FROM login_sessions WHERE user_id=? AND session_id<>?', [u.id, sid]);
          for (const o of others) await new Promise(r => req.sessionStore.destroy(o.session_id, r));
          await db.run('DELETE FROM login_sessions WHERE user_id=? AND session_id<>?', [u.id, sid]);
        }
        await db.run('INSERT INTO login_sessions (session_id, user_id, ip, user_agent, created_at, last_seen) VALUES (?,?,?,?,?,?)',
          [sid, u.id, req.ip || '', (req.get('User-Agent') || '').slice(0, 200), db.now(), db.now()]);
      } catch {}
      try { await db.run('UPDATE users SET last_login = ? WHERE id = ?', [db.now(), u.id]); } catch {}
      logActivity(u.id, 'login', 'role=' + u.role, req);
      done();
    })();
  });
}));
app.post('/api/logout', (req, res) => {
  const sid = req.sessionID, uid = req.session.userId;
  logActivity(uid, 'logout', '', req);
  req.session.destroy(() => {
    if (sid) db.run('DELETE FROM login_sessions WHERE session_id = ?', [sid]).catch(() => {});
    res.json({ ok: true });
  });
});
app.get('/api/me', ah(async (req, res) => {
  const u = req.session.userId && await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!u) return res.status(401).json({ error: 'Not logged in.' });
  const feats = await db.all('SELECT feature, enabled FROM student_features WHERE user_id = ?', [u.id]);
  res.json({ user: { ...pub(u), disabledFeatures: feats.filter(f => !f.enabled).map(f => f.feature) } });
}));

// ---------- student API ----------
app.get('/api/dashboard', requireAuth, ah(cached('stu-dash', 30000, async (req) => {
  const u = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  const recent = await db.all(
    `SELECT a.id, a.score, a.max_score, a.completed_at, c.code, c.title
     FROM attempts a JOIN cases c ON c.id = a.case_id
     WHERE a.user_id = ? AND a.status = 'completed'
     ORDER BY a.completed_at DESC LIMIT 5`, [u.id]);
  return { user: pub(u), stats: await userStats(u.id), recent };
})));

app.get('/api/cases', requireAuth, ah(cached('stu-cases', 300000, async (req) => {
  const cases = await db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM questions q WHERE q.case_id = c.id) AS qcount
     FROM cases c WHERE c.active = 1 AND c.code NOT LIKE 'QUIZ-%' ORDER BY c.sort`);
  const prog = await db.all(
    `SELECT case_id, COUNT(*) AS attempts, MAX(score) AS best, SUM(status='completed') AS done
     FROM attempts WHERE user_id = ? GROUP BY case_id`, [req.session.userId]);
  const pm = Object.fromEntries(prog.map(p => [p.case_id, p]));
  return { cases: cases.map(c => ({
    id: c.id, code: c.code, title: c.title, description: c.description,
    difficulty: c.difficulty, category: c.category, points: c.points,
    questions: c.qcount, attempts: pm[c.id]?.attempts || 0,
    best: pm[c.id]?.best ?? null, completed: (pm[c.id]?.done || 0) > 0,
  })) };
})));

app.get('/api/cases/:id', requireAuth, ah(async (req, res) => {
  const c = await db.get('SELECT * FROM cases WHERE id = ? AND active = 1', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  const qs = await db.all('SELECT * FROM questions WHERE case_id = ? ORDER BY qnum', [c.id]);
  let documents = [], timeline = [];
  try { documents = JSON.parse(c.documents || '[]'); } catch (e) {}
  try { timeline = JSON.parse(c.timeline || '[]'); } catch (e) {}
  res.json({ id: c.id, code: c.code, title: c.title, description: c.description,
    difficulty: c.difficulty, category: c.category, points: c.points,
    documents, timeline,
    questions: qs.map(stripQ) });
}));

// ================= GUIDED CASE MODE =================
// Step-kind: info | pick | action | quiz | note
const GUIDED_STEPS = {
'CASE-001': [
 { id:'brief', t:'Morning huddle briefing', kind:'info', pts:5,
   d:'The front desk hands you today\u2019s arrival slip. Before the visit, you must verify the patient has active coverage \u2014 an ineligible claim will be denied as CO-16 and the practice eats the cost. You will use your real workspace data.' },
 { id:'pick-pt', t:'Select the patient', kind:'pick', pts:10,
   d:'Choose the patient from your workspace whose coverage you will verify.',
   src:'/api/rcm/patients', rkey:'patients', label:['name','code'], val:'code', ctx:'patient_code', ctx2:['patient_name','name'] },
 { id:'pick-ins', t:'Select their insurance', kind:'pick', pts:10,
   d:'Pick the active policy for this patient. In the real world, always verify the policy that will be billed.',
   src:'/api/rcm/insurance', rkey:'insurance', label:['payer','member_id'], val:'payer', ctx:'payer', filter:{ field:'patient_code', from:'patient_code' } },
 { id:'verify', t:'Run the 270/271 eligibility check', kind:'action', pts:15,
   d:'Send the 270 eligibility inquiry to the payer and read the 271 response.',
   api:'/api/rcm/eligibility/verify', method:'POST',
   body:{ patient_code:'{patient_code}', payer:'{payer}', service:'Office Visit' },
   expect:'id', save:{ check_id:'id' } },
 { id:'interpret', t:'Interpret the 271 response', kind:'quiz', pts:10,
   d:'Your check is complete. Based on the coverage, copay and deductible shown:',
   q:'The 271 shows coverage ACTIVE, $25 copay, $1,000 deductible remaining. What do you tell the front desk?',
   options:['Collect the $25 copay at check-in; the deductible applies to today\u2019s charges','Bill the patient the full visit amount today','Skip it \u2014 insurance covers everything','Reschedule the patient until the deductible is met'], answer:0 },
],
'CASE-002': [
 { id:'brief', t:'Encounter briefing', kind:'info', pts:5,
   d:'Established patient, 45, office visit: Type 2 diabetes follow-up and hypertension check. Provider spent 30 minutes, performed a level-3 evaluation and ordered an A1C lab (CPT 83036). Code it cleanly \u2014 wrong codes mean denials.' },
 { id:'dx', t:'Pick the primary diagnosis', kind:'quiz', pts:10,
   q:'What is the correct primary ICD-10-CM code for this visit?',
   options:['E11.65 \u2014 Type 2 diabetes with hyperglycemia','E11.9 \u2014 Type 2 diabetes without complications','I10 \u2014 Essential hypertension','Z00.00 \u2014 Routine general exam'], answer:1 },
 { id:'cpt', t:'Pick the procedure code', kind:'quiz', pts:10,
   q:'What CPT best fits a 30-minute established-patient office visit?',
   options:['99202 \u2014 new patient, straightforward','99213 \u2014 established, low complexity','99214 \u2014 established, moderate complexity','99490 \u2014 chronic care management'], answer:1 },
 { id:'necessity', t:'Check medical necessity', kind:'quiz', pts:15,
   q:'Does E11.9 support medical necessity for the A1C lab (83036)?',
   options:['Yes \u2014 a diabetes diagnosis justifies A1C monitoring','No \u2014 labs never need a diagnosis code','Only when paired with the hypertension code','Only for new patients'], answer:0 },
 { id:'rationale', t:'Document your rationale', kind:'note', pts:10, min:20,
   d:'Write 1\u20132 sentences linking diagnosis to procedure \u2014 this is what an auditor looks for.',
   ph:'E.g. E11.9 supports 99213 and 83036 because\u2026' },
],
'CASE-003': [
 { id:'pick-pt', t:'Select the patient', kind:'pick', pts:10,
   d:'Choose who today\u2019s charge is for.',
   src:'/api/rcm/patients', rkey:'patients', label:['name','code'], val:'code', ctx:'patient_code', ctx2:['patient_name','name'] },
 { id:'charge', t:'Enter the charge', kind:'action', pts:15,
   d:'Enter today\u2019s encounter charge exactly as documented: CPT 99213, ICD-10 E11.9, $180.00.',
   api:'/api/rcm/charges', method:'POST', form:['dos','cpt','icd','amount'],
   body:{ patient_code:'{patient_code}', dos:'{dos}', cpt:'{cpt}', icd:'{icd}', amount:'{amount}' },
   expect:'id', save:{ charge_id:'id' } },
 { id:'claim', t:'Create the claim', kind:'action', pts:15,
   d:'Build the CMS-1500 from your charge. The claim pulls diagnosis and procedure from the charge you just entered.',
   api:'/api/rcm/claims', method:'POST', body:{ charge_id:'{charge_id}' },
   expect:'claim_no', save:{ claim_id:'id', claim_no:'claim_no' } },
 { id:'clean', t:'What makes it clean?', kind:'quiz', pts:10,
   q:'Your claim is in DRAFT. What makes it \u201cclean\u201d before submission?',
   options:['Matching patient demographics, valid codes, and an active payer policy','Submitting it as fast as possible','Leaving the diagnosis blank so the payer decides','Faxing it instead of electronic filing'], answer:0 },
],
'CASE-004': [
 { id:'pick-claim', t:'Select a draft claim', kind:'pick', pts:10,
   d:'Pick a DRAFT claim from your work queue to scrub.',
   src:'/api/rcm/claims', rkey:'claims', label:['claim_no','payer'], val:'id', ctx:'claim_id',
   filterStatus:'DRAFT' },
 { id:'scrub', t:'Run the claim scrubber', kind:'action', pts:15,
   d:'Run all 13 validation rules against the claim \u2014 the same checks the payer\u2019s system runs.',
   api:'/api/rcm/claims/{claim_id}/validate', method:'POST', body:{}, expect:'ok', save:{} },
 { id:'fix', t:'Handle the scrubber flags', kind:'quiz', pts:15,
   q:'The scrubber flags CO-16: \u201cClaim lacks information.\u201d What is the correct fix?',
   options:['Correct the missing/invalid data and rebill \u2014 never resubmit unchanged','Resubmit the identical claim immediately','Write the balance off to bad debt','Appeal with a redetermination letter'], answer:0 },
 { id:'submit', t:'Submit to the payer', kind:'action', pts:10,
   d:'The claim is clean. Transmit the 837P to the payer.',
   api:'/api/rcm/claims/{claim_id}/submit', method:'POST', body:{}, expect:'status', save:{ claim_status:'status' } },
],
'CASE-005': [
 { id:'pick-claim', t:'Select a submitted claim', kind:'pick', pts:10,
   d:'Pick a SUBMITTED claim that is waiting on payer response.',
   src:'/api/rcm/claims', rkey:'claims', label:['claim_no','payer'], val:'id', ctx:'claim_id',
   filterStatus:'SUBMITTED' },
 { id:'era', t:'Read the ERA', kind:'info', pts:5,
   d:'The 835 remittance arrived: payer allowed $150.00 of the $180.00 billed, paid $120.00, applied a $30 contractual adjustment, and assigned $30 patient responsibility. Post exactly what the ERA says \u2014 never post from memory.' },
 { id:'post', t:'Post the payment', kind:'action', pts:15,
   d:'Post the ERA: paid 120, adjustment 30, patient responsibility 30.',
   api:'/api/rcm/payments', method:'POST',
   body:{ claim_id:'{claim_id}', paid:'{paid}', adjustment:'{adjustment}', patient_resp:'{patient_resp}' },
   form:['paid','adjustment','patient_resp'], expect:'ok', save:{} },
 { id:'balance', t:'Reconcile the balance', kind:'quiz', pts:10,
   q:'Billed $180, allowed $150, paid $120, adjustment $30. What is the correct patient balance?',
   options:['$30 \u2014 the patient-responsibility portion of the allowed amount','$60 \u2014 billed minus paid','$0 \u2014 the claim is fully resolved',' $150 \u2014 the full allowed amount'], answer:0 },
],
'CASE-006': [
 { id:'pick-denial', t:'Select the denial', kind:'pick', pts:10,
   d:'Open your denial work queue and pick a denied claim to work.',
   src:'/api/rcm/denials', rkey:'denials', label:['claim_no','payer'], val:'id', ctx:'claim_id' },
 { id:'review', t:'Review the claim', kind:'info', pts:5,
   d:'Read the denial reason on the remittance. Note the CARC code, the billed vs allowed amounts, and the date of service. A denial is a question \u2014 your job is to find the answer before you act.' },
 { id:'root', t:'Identify the root cause', kind:'quiz', pts:15,
   q:'The remittance shows CO-97: \u201cthe benefit for this service is included in the payment for another procedure.\u201d What happened?',
   options:['Unbundling \u2014 two codes were billed that the payer considers one service','The patient\u2019s coverage lapsed','The claim was filed past the timely-filing limit','The diagnosis does not support the procedure'], answer:0 },
 { id:'action', t:'Choose the corrective action', kind:'quiz', pts:10,
   q:'For this CO-97 unbundling denial, what is the correct next step?',
   options:['Correct the claim (use the proper bundled code or modifier) and rebill','Appeal immediately without changing anything','Write it off \u2014 denials can\u2019t be fixed','Rebill the identical claim next week'], answer:0 },
 { id:'doc', t:'Document the resolution', kind:'note', pts:10, min:20,
   d:'Write the resolution note an auditor would want to see: root cause, action taken, expected outcome.',
   ph:'E.g. CO-97 unbundling \u2014 corrected with modifier 25 and rebilled\u2026' },
 { id:'resolve', t:'Resolve the denial', kind:'action', pts:10,
   d:'Execute your corrective action in the system.',
   api:'/api/rcm/denials/{claim_id}/resolve', method:'POST',
   body:{ action:'correct', note:'{note}' }, expect:'ok', save:{} },
],
'CASE-007': [
 { id:'ar', t:'Review the A/R aging', kind:'info', pts:10,
   d:'Open your A/R aging buckets: 0\u201330, 31\u201360, 61\u201390, 90+ days. Money sitting in 90+ is the practice\u2019s cash bleeding out \u2014 that bucket is your priority.' },
 { id:'prioritize', t:'Prioritize the work', kind:'quiz', pts:10,
   q:'You have claims in every bucket. Which do you work first?',
   options:['90+ days \u2014 oldest dollars closest to timely-filing and write-off risk','0\u201330 days \u2014 they are the newest','Whichever payer you like most','Alphabetical by patient name'], answer:0 },
 { id:'pick-claim2', t:'Select the claim to follow up', kind:'pick', pts:0,
   d:'Choose any open claim for your follow-up note.',
   src:'/api/rcm/claims', rkey:'claims', label:['claim_no','payer'], val:'id', ctx:'claim_id' },
 { id:'followup', t:'Log a follow-up', kind:'action', pts:15,
   d:'Pick a claim and log a payer follow-up: who you called, what they said, next step date.',
   api:'/api/rcm/ar/note', method:'POST', form:['note'],
   body:{ claim_id:'{claim_id}', note:'{note}', kind:'followup' }, expect:'ok', save:{} },
 { id:'dso', t:'Know your KPIs', kind:'quiz', pts:15,
   q:'Accounts receivable is $90,000 and average daily charges are $3,000. What is Days in A/R (DSO)?',
   options:['30 days \u2014 healthy','90 days \u2014 critical','3 days \u2014 excellent','300 days'], answer:0 },
],
'CASE-008': [
 { id:'demo', t:'Review demographics', kind:'pick', pts:10,
   d:'Step 1 of 8 \u2014 Start with the patient. Confirm name, DOB and contact \u2014 demographics errors are the #1 cause of front-end denials.',
   src:'/api/rcm/patients', rkey:'patients', label:['name','code'], val:'code', ctx:'patient_code', ctx2:['patient_name','name'] },
 { id:'pick-ins8', t:'Select payer for the visit', kind:'pick', pts:0,
   d:'Which payer will be billed for this visit?',
   src:'/api/rcm/insurance', rkey:'insurance', label:['payer','member_id'], val:'payer', ctx:'payer8',
   filter:{ field:'patient_code', from:'patient_code' } },
 { id:'elig', t:'Verify eligibility', kind:'action', pts:10,
   d:'Step 2 of 8 \u2014 Run the 270/271 check before any charge exists.',
   api:'/api/rcm/eligibility/verify', method:'POST',
   body:{ patient_code:'{patient_code}', payer:'{payer8}', service:'Office Visit' }, expect:'id', save:{} },
 { id:'charge8', t:'Enter the charge', kind:'action', pts:10,
   d:'Step 3 of 8 \u2014 Enter the visit charge: CPT 99213, E11.9, $180.',
   api:'/api/rcm/charges', method:'POST', form:['dos'],
   body:{ patient_code:'{patient_code}', dos:'{dos}', cpt:'99213', icd:'E11.9', amount:180 },
   expect:'id', save:{ charge_id:'id' } },
 { id:'claim8', t:'Create + validate the claim', kind:'action', pts:15,
   d:'Step 4 of 8 \u2014 Build the claim, then immediately run the scrubber.',
   api:'/api/rcm/claims', method:'POST', body:{ charge_id:'{charge_id}' },
   expect:'claim_no', save:{ claim_id:'id' } },
 { id:'submit8', t:'Submit the claim', kind:'action', pts:10,
   d:'Step 5 of 8 \u2014 Transmit the clean 837P.',
   api:'/api/rcm/claims/{claim_id}/submit', method:'POST', body:{}, expect:'status', save:{} },
 { id:'payer', t:'Review the payer response', kind:'quiz', pts:10,
   d:'Step 6 of 8 \u2014 The 835 arrives.',
   q:'ERA: allowed $150, paid $120, adjustment $30, patient responsibility $30. What do you post?',
   options:['Exactly the ERA amounts \u2014 $120 paid, $30 adjustment, $30 patient','The billed amount of $180 as paid','Only the $120 and ignore the rest','$150 as paid in full'], answer:0 },
 { id:'post8', t:'Post the payment', kind:'action', pts:15,
   d:'Step 7 of 8 \u2014 Post the ERA to the claim.',
   api:'/api/rcm/payments', method:'POST', form:['paid','adjustment','patient_resp'],
   body:{ claim_id:'{claim_id}', paid:'{paid}', adjustment:'{adjustment}', patient_resp:'{patient_resp}' },
   expect:'ok', save:{} },
 { id:'ar8', t:'Resolve the A/R', kind:'note', pts:20, min:20,
   d:'Step 8 of 8 \u2014 $30 patient balance remains. Write the follow-up plan: when and how will you collect it?',
   ph:'E.g. Send statement in 7 days, call on day 21, offer payment plan\u2026' },
],
'CASE-009': [
 { id:'brief', t:'Registration desk briefing', kind:'info', pts:5,
   d:'A new patient walks in for their first visit. Your job: register them with complete, accurate demographics. Incomplete registration causes eligibility failures and denied claims downstream.' },
 { id:'register', t:'Register the new patient', kind:'action', pts:20,
   d:'Enter the patient\u2019s demographics exactly as shown on their photo ID.',
   api:'/api/rcm/patients', method:'POST', form:['name','dob','gender','phone','email','address'],
   body:{ name:'{name}', dob:'{dob}', gender:'{gender}', phone:'{phone}', email:'{email}', address:'{address}' },
   expect:'code', save:{ patient_code:'code' } },
 { id:'complete', t:'What makes it complete?', kind:'quiz', pts:15,
   q:'Which fields are REQUIRED for a complete registration?',
   options:['Full name, date of birth, and phone','Just the first name','Email address only','Insurance card number only'], answer:0 },
 { id:'dup', t:'Avoid duplicate records', kind:'quiz', pts:10,
   q:'Before creating a new patient record, you should\u2026',
   options:['Search existing records to avoid creating a duplicate','Always create a fresh record \u2014 duplicates are harmless','Skip the search to save time','Ask the patient to use a nickname'], answer:0 },
],
'CASE-010': [
 { id:'brief', t:'Insurance desk briefing', kind:'info', pts:5,
   d:'A patient hands you their insurance card. Before the visit, verify the plan is active and read the benefits. Billing an inactive plan guarantees a denial.' },
 { id:'pick-pt', t:'Select the patient', kind:'pick', pts:10,
   d:'Choose the patient whose insurance you will verify.',
   src:'/api/rcm/patients', rkey:'patients', label:['name','code'], val:'code', ctx:'patient_code', ctx2:['patient_name','name'] },
 { id:'pick-ins', t:'Review their insurance', kind:'pick', pts:10,
   d:'Select the policy to verify. Check the effective date, member ID and plan type \u2014 this mirrors reading a real insurance card.',
   src:'/api/rcm/insurance', rkey:'insurance', label:['payer','member_id'], val:'payer', ctx:'payer', filter:{ field:'patient_code', from:'patient_code' } },
 { id:'determine', t:'Determine coverage status', kind:'quiz', pts:15,
   d:'The policy shows status ACTIVE, effective 01/01/2026, $25 copay.',
   q:'What do you tell the front desk?',
   options:['Plan is active \u2014 collect the $25 copay at check-in','Plan is inactive \u2014 turn the patient away','Skip verification \u2014 the card looked fine','Bill without checking the effective date'], answer:0 },
 { id:'inactive', t:'Handle inactive coverage', kind:'quiz', pts:10,
   q:'If the 271 eligibility response shows INACTIVE, what is the correct action?',
   options:['Inform the patient and offer self-pay options or reschedule','Bill it anyway and hope for the best','Change the status to active in the system','Ignore it \u2014 insurance cards never lie'], answer:0 },
],
'CASE-011': [
 { id:'brief', t:'Billing office briefing', kind:'info', pts:5,
   d:'The encounter is coded and the charge is complete. Your job: build the professional CMS-1500 claim from the charge \u2014 the bridge from clinical documentation to billing.' },
 { id:'pick-charge', t:'Select the completed charge', kind:'pick', pts:10,
   d:'Pick a READY charge (completed, not yet linked to a claim). One charge becomes one claim \u2014 never double-bill.',
   src:'/api/rcm/charges', rkey:'charges', label:['cpt','patient_code'], val:'id', ctx:'charge_id',
   filterStatus:'READY' },
 { id:'create', t:'Create the claim', kind:'action', pts:20,
   d:'Build the CMS-1500 from your charge. The claim pulls diagnosis and procedure codes from the charge you selected.',
   api:'/api/rcm/claims', method:'POST', body:{ charge_id:'{charge_id}' },
   expect:'claim_no', save:{ claim_id:'id', claim_no:'claim_no' } },
 { id:'clean', t:'What makes it clean?', kind:'quiz', pts:15,
   q:'Your claim is in DRAFT. What must be true before submission?',
   options:['Matching demographics, valid codes, and an active payer policy','Submit it as fast as possible','Leave the diagnosis blank so the payer decides','Fax it instead of filing electronically'], answer:0 },
],
'CASE-012': [
 { id:'brief', t:'Clearinghouse briefing', kind:'info', pts:5,
   d:'The claim is built. Before it reaches the payer, it must pass the scrubber \u2014 the same 13 validation rules the payer\u2019s system will run. A dirty claim submitted is a denial earned.' },
 { id:'pick-claim', t:'Select a draft claim', kind:'pick', pts:10,
   d:'Pick a DRAFT claim to validate and submit.',
   src:'/api/rcm/claims', rkey:'claims', label:['claim_no','payer'], val:'id', ctx:'claim_id',
   filterStatus:'DRAFT' },
 { id:'scrub', t:'Run the claim scrubber', kind:'action', pts:15,
   d:'Run all 13 validation rules against the claim. Fix any flags before submitting.',
   api:'/api/rcm/claims/{claim_id}/validate', method:'POST', body:{}, expect:'ok', save:{} },
 { id:'submit', t:'Submit to the payer', kind:'action', pts:10,
   d:'Transmit the clean 837P to the payer and read the adjudication.',
   api:'/api/rcm/claims/{claim_id}/submit', method:'POST', body:{}, expect:'status', save:{ claim_status:'status' } },
 { id:'result', t:'Read the adjudication', kind:'quiz', pts:10,
   q:'The payer returns PAID. What does this mean?',
   options:['The claim adjudicated \u2014 reconcile allowed, paid, adjustment and patient responsibility','The full billed amount was paid, nothing left to do','The patient owes nothing','No further action is ever needed'], answer:0 },
],
};

const GUIDED_PREREQ = {
  'CASE-001': [],
  'CASE-009': ['CASE-001'],
  'CASE-010': ['CASE-009'],
  'CASE-003': ['CASE-010'],
  'CASE-002': ['CASE-003'],
  'CASE-011': ['CASE-003'],
  'CASE-004': ['CASE-011'],
  'CASE-012': ['CASE-004'],
  'CASE-005': ['CASE-012'],
  'CASE-007': ['CASE-005'],
  'CASE-006': ['CASE-005'],
  'CASE-008': ['CASE-001','CASE-009','CASE-010','CASE-003','CASE-002','CASE-011','CASE-004','CASE-012','CASE-005','CASE-007','CASE-006'],
};

const JOURNEY_STAGES = [
  { id:'j1', title:'Patient & Insurance', desc:'Registration, verification and eligibility \u2014 where clean claims begin', cases:['CASE-001','CASE-009','CASE-010'] },
  { id:'j2', title:'Charge & Coding', desc:'Charge entry, coding, and building the claim', cases:['CASE-003','CASE-002','CASE-011'] },
  { id:'j3', title:'Claim Processing', desc:'Validation and submission \u2014 the payer\u2019s front door', cases:['CASE-004','CASE-012'] },
  { id:'j4', title:'Payments & A/R', desc:'Posting remits and working the aging buckets', cases:['CASE-005','CASE-007'] },
  { id:'j5', title:'Denial Management', desc:'Root-cause analysis and corrective action', cases:['CASE-006'] },
  { id:'j6', title:'Full-Cycle Capstone', desc:'Run the entire revenue cycle end to end', cases:['CASE-008'] },
];

function guidedPublicSteps(code) {
  return (GUIDED_STEPS[code] || []).map(s => {
    const o = { ...s };
    delete o.answer; // never leak answers
    return o;
  });
}

async function guidedDoneSet(uid) {
  const cases = await db.all('SELECT id, code FROM cases WHERE active=1');
  const codeById = Object.fromEntries(cases.map(c => [c.id, c.code]));
  const quizDone = new Set((await db.all(
    `SELECT DISTINCT case_id FROM attempts WHERE user_id=? AND status='completed'`, [uid]))
    .map(r => codeById[r.case_id]).filter(Boolean));
  const gruns = await db.all('SELECT case_id, status, points, step_idx FROM guided_runs WHERE user_id=?', [uid]);
  const gmap = {};
  for (const g of gruns) { const code = codeById[g.case_id]; if (code) gmap[code] = g; }
  const done = code => quizDone.has(code) || (gmap[code] && gmap[code].status === 'completed');
  return { cases, codeById, quizDone, gmap, done };
}

app.get('/api/guided/journey', requireAuth, ah(async (req, res) => {
  const { cases, quizDone, gmap, done } = await guidedDoneSet(req.session.userId);
  const perCase = {};
  for (const c of cases) {
    const code = c.code;
    const prereqs = GUIDED_PREREQ[code] || [];
    const missing = prereqs.filter(p => !done(p));
    perCase[code] = {
      quizDone: quizDone.has(code),
      guidedDone: !!(gmap[code] && gmap[code].status === 'completed'),
      guidedPoints: gmap[code] ? Number(gmap[code].points) : 0,
      guidedStep: gmap[code] ? Number(gmap[code].step_idx) : 0,
      guidedTotal: (GUIDED_STEPS[code] || []).length,
      locked: missing.length > 0,
      lockReason: missing.length ? 'Complete ' + missing.join(', ') + ' first' : null,
    };
  }
  const stages = JOURNEY_STAGES.map(st => {
    const nDone = st.cases.filter(done).length;
    return { ...st, total: st.cases.length, done: nDone, complete: nDone === st.cases.length };
  });
  res.json({ stages, cases: perCase });
}));

app.get('/api/guided/:caseId', requireAuth, ah(async (req, res) => {
  const c = await db.get('SELECT * FROM cases WHERE id=? AND active=1', [req.params.caseId]);
  if (!c || !GUIDED_STEPS[c.code]) return res.status(404).json({ error: 'No guided walkthrough for this case.' });
  const run = await db.get('SELECT status, step_idx, points FROM guided_runs WHERE user_id=? AND case_id=?',
    [req.session.userId, c.id]);
  res.json({
    case: { id: c.id, code: c.code, title: c.title, difficulty: c.difficulty },
    steps: guidedPublicSteps(c.code),
    run: run ? { status: run.status, step_idx: Number(run.step_idx), points: Number(run.points) } : null,
  });
}));

app.post('/api/guided/:caseId/start', requireAuth, ah(async (req, res) => {
  const uid = req.session.userId;
  const c = await db.get('SELECT * FROM cases WHERE id=? AND active=1', [req.params.caseId]);
  if (!c || !GUIDED_STEPS[c.code]) return res.status(404).json({ error: 'No guided walkthrough for this case.' });
  const { done } = await guidedDoneSet(uid);
  const missing = (GUIDED_PREREQ[c.code] || []).filter(p => !done(p));
  if (missing.length) return res.status(403).json({ error: 'Complete ' + missing.join(', ') + ' first.' });
  const ex = await db.get('SELECT id FROM guided_runs WHERE user_id=? AND case_id=?', [uid, c.id]);
  if (ex) await db.run(`UPDATE guided_runs SET status='started', step_idx=0, points=0, started_at=?, completed_at=NULL WHERE id=?`, [db.now(), ex.id]);
  else await db.run(`INSERT INTO guided_runs (user_id, case_id, status, step_idx, points, started_at) VALUES (?,?,?,?,?,?)`,
    [uid, c.id, 'started', 0, 0, db.now()]);
  bustAdminCache();
  res.json({ ok: true, steps: guidedPublicSteps(c.code) });
}));

app.post('/api/guided/:caseId/step/:idx', requireAuth, ah(async (req, res) => {
  const uid = req.session.userId;
  const c = await db.get('SELECT * FROM cases WHERE id=? AND active=1', [req.params.caseId]);
  if (!c || !GUIDED_STEPS[c.code]) return res.status(404).json({ error: 'No guided walkthrough for this case.' });
  const steps = GUIDED_STEPS[c.code];
  const idx = parseInt(req.params.idx, 10);
  const step = steps[idx];
  if (!step) return res.status(404).json({ error: 'Step not found.' });
  const run = await db.get('SELECT * FROM guided_runs WHERE user_id=? AND case_id=?', [uid, c.id]);
  if (!run) return res.status(400).json({ error: 'Start the walkthrough first.' });
  if (run.status === 'completed') return res.status(400).json({ error: 'Walkthrough already completed.' });
  if (idx !== Number(run.step_idx)) return res.status(400).json({ error: 'Steps must be completed in order.' });
  const b = req.body || {};
  let earned = 0;
  if (step.kind === 'quiz') {
    if (Number(b.chosen) === step.answer) earned = step.pts;
    else return res.json({ ok: false, msg: 'Not quite \u2014 review the step and try again.' });
  } else if (step.kind === 'note') {
    const t = String(b.text || '').trim();
    if (t.length >= (step.min || 20)) earned = step.pts;
    else return res.json({ ok: false, msg: 'Write at least ' + (step.min || 20) + ' characters.' });
  } else if (step.kind === 'pick') {
    if (!b.value && b.value !== 0) return res.json({ ok: false, msg: 'Please make a selection.' });
    earned = step.pts;
  } else if (step.kind === 'action') {
    const r = b.result;
    if (!r || (step.expect && r[step.expect] === undefined)) return res.json({ ok: false, msg: 'The action did not return the expected result \u2014 try again.' });
    earned = step.pts;
  } else { earned = step.pts; }
  const nidx = idx + 1;
  const doneAll = nidx >= steps.length;
  await db.run('UPDATE guided_runs SET step_idx=?, points=points+?, status=?, completed_at=? WHERE id=?',
    [nidx, earned, doneAll ? 'completed' : 'started', doneAll ? db.now() : null, run.id]);
  bustAdminCache();
  res.json({ ok: true, pointsEarned: earned, step_idx: nidx, done: doneAll, totalPoints: Number(run.points) + earned });
}));

app.post('/api/attempts', requireAuth, ah(async (req, res) => {
  const c = await db.get("SELECT * FROM cases WHERE id = ? AND active = 1 AND code NOT LIKE 'QUIZ-%'", [req.body?.caseId]);
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  const max = (await db.get('SELECT COALESCE(SUM(points),0) AS m FROM questions WHERE case_id = ?', [c.id])).m;
  await db.run(`UPDATE attempts SET status='abandoned' WHERE user_id=? AND case_id=? AND status='started'`,
    [req.session.userId, c.id]);
  const r = await db.run('INSERT INTO attempts (user_id, case_id, max_score, started_at) VALUES (?,?,?,?)',
    [req.session.userId, c.id, max, db.now()]);
  const qs = await db.all('SELECT * FROM questions WHERE case_id = ? ORDER BY qnum', [c.id]);
  res.json({ attemptId: r.id, questions: qs.map(stripQ), maxScore: max });
}));

app.post('/api/attempts/:id/answer', requireAuth, ah(async (req, res) => {
  const a = await db.get('SELECT * FROM attempts WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!a || a.status !== 'started') return res.status(404).json({ error: 'Attempt not found or finished.' });
  const q = await db.get('SELECT * FROM questions WHERE id = ? AND case_id = ?', [req.body?.questionId, a.case_id]);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  const chosen = Number(req.body?.chosen);
  if (![0, 1, 2, 3].includes(chosen)) return res.status(400).json({ error: 'Invalid choice.' });
  const dup = await db.get('SELECT id FROM answers WHERE attempt_id = ? AND question_id = ?', [a.id, q.id]);
  if (dup) return res.status(409).json({ error: 'Already answered.' });
  const correct = chosen === q.answer_idx ? 1 : 0;
  const earned = correct ? q.points : 0;
  await db.run('INSERT INTO answers (attempt_id, question_id, chosen_idx, correct, points_earned, answered_at) VALUES (?,?,?,?,?,?)',
    [a.id, q.id, chosen, correct, earned, db.now()]);
  await db.run('UPDATE attempts SET score = score + ? WHERE id = ?', [earned, a.id]);
  res.json({ correct: !!correct, correctIdx: q.answer_idx, explanation: q.explanation, pointsEarned: earned });
}));

app.post('/api/attempts/:id/finish', requireAuth, ah(async (req, res) => {
  const a = await db.get('SELECT * FROM attempts WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!a || a.status !== 'started') return res.status(404).json({ error: 'Attempt not found or finished.' });
  await db.run(`UPDATE attempts SET status='completed', completed_at=? WHERE id = ?`, [db.now(), a.id]);
  bustAdminCache(); // clear cached dashboard/cases so progress updates instantly
  const fin = await db.get('SELECT * FROM attempts WHERE id = ?', [a.id]);
  const stats = await userStats(req.session.userId);
  res.json({ score: fin.score, maxScore: fin.max_score,
    accuracy: fin.max_score ? Math.round(1000 * fin.score / fin.max_score) / 10 : 0,
    level: stats.level, points: stats.points });
}));

app.get('/api/progress', requireAuth, ah(async (req, res) => {
  const attempts = await db.all(
    `SELECT a.id, a.score, a.max_score, a.status, a.started_at, a.completed_at, c.code, c.title, c.difficulty
     FROM attempts a JOIN cases c ON c.id = a.case_id
     WHERE a.user_id = ? ORDER BY a.started_at DESC LIMIT 50`, [req.session.userId]);
  const perCase = await db.all(
    `SELECT c.code, c.title, COUNT(*) AS attempts, MAX(a.score) AS best, SUM(a.status='completed') AS done
     FROM attempts a JOIN cases c ON c.id = a.case_id
     WHERE a.user_id = ? GROUP BY c.id ORDER BY c.sort`, [req.session.userId]);
  res.json({ stats: await userStats(req.session.userId), attempts, perCase });
}));

app.get('/api/patients', requireAuth, ah(async (req, res) => {
  res.json({ fictional: true,
    patients: await db.all('SELECT code,name,dob,gender,phone,status FROM patients WHERE user_id = ? ORDER BY code', [req.session.userId]) });
}));

// ---------- labs API (student training: scrubber, denial lab, sprints, quiz) ----------
async function logLab(userId, labKey, score, maxScore, detail) {
  await db.run('INSERT INTO lab_runs (user_id, lab_key, score, max_score, detail) VALUES (?,?,?,?,?)',
    [userId, labKey, score, maxScore, JSON.stringify(detail || {})]);
}

app.get('/api/labs/scrub/meta', requireAuth, ah(async (req, res) => {
  const payers = Object.fromEntries(Object.entries(labData.PAYERS)
    .map(([k, v]) => [k, { name: v.name, note: v.note, timelyFilingDays: v.timelyFilingDays }]));
  res.json({ payers });
}));

app.post('/api/labs/scrub', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const r = labData.scrubClaim(req.body || {});
  await logLab(req.session.userId, 'scrubber', r.score, 100,
    { errors: r.errors.length, warnings: r.warnings.length, payer: req.body.payer });
  res.json(r);
}));

const stripDenial = (d) => ({
  id: d.id, title: d.title, difficulty: d.difficulty, payer: d.payer,
  carc: d.carc, carcLabel: d.carcLabel, rarc: d.rarc, rarcLabel: d.rarcLabel,
  billed: d.billed, paid: d.paid, snapshot: d.snapshot,
  diagnosisOptions: d.diagnosisOptions.map(o => o.t),
  fixOptions: d.fixOptions.map(o => o.t),
  decisionOptions: d.decisionOptions.map(o => o.t),
});

app.get('/api/labs/denials', requireAuth, ah(async (req, res) => {
  res.json({ fictional: true, scenarios: labData.DENIALS.map(stripDenial) });
}));

app.post('/api/labs/denials/grade', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const d = labData.DENIALS.find(x => x.id === req.body.scenarioId);
  if (!d) return res.status(404).json({ error: 'Scenario not found.' });
  const ci = (arr) => arr.findIndex(o => o.correct);
  const ok = {
    diagnosis: req.body.di === ci(d.diagnosisOptions),
    fix: req.body.fi === ci(d.fixOptions),
    decision: req.body.ci === ci(d.decisionOptions),
  };
  const score = (ok.diagnosis ? 40 : 0) + (ok.fix ? 35 : 0) + (ok.decision ? 25 : 0);
  await logLab(req.session.userId, 'denial', score, 100, { scenario: d.id });
  res.json({ score, max: 100, ok, explain: d.explain,
    correct: { di: ci(d.diagnosisOptions), fi: ci(d.fixOptions), ci: ci(d.decisionOptions) } });
}));

// ---------- ERA posting simulator ----------
const stripEra = (e) => ({
  id: e.id, title: e.title, difficulty: e.difficulty, payer: e.payer,
  checkNo: e.checkNo, payDate: e.payDate, payee: e.payee, npi: e.npi,
  patient: e.patient, claimNo: e.claimNo, dos: e.dos,
  lines: e.lines.map((l, i) => ({ i, cpt: l.cpt, desc: l.desc, billed: l.billed,
    allowed: l.allowed, paid: l.paid, carc: l.carc, carcLabel: l.carcLabel,
    rarc: l.rarc, rarcLabel: l.rarcLabel, prCode: l.prCode, prLabel: l.prLabel, prAmt: l.prAmt })),
});
app.get('/api/labs/era', requireAuth, ah(async (req, res) => {
  res.json({ fictional: true, actions: labData.ERA_ACTIONS, scenarios: labData.ERA.map(stripEra) });
}));
app.post('/api/labs/era/grade', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const e = labData.ERA.find(x => x.id === req.body.scenarioId);
  if (!e) return res.status(404).json({ error: 'Scenario not found.' });
  const answers = req.body.lines || [];
  const perLine = e.lines.map((l, i) => {
    const a = answers[i] || {};
    const adjOk = Math.abs(parseFloat(a.adj) - l.correctAdj) < 0.005;
    const balOk = Math.abs(parseFloat(a.bal) - l.correctPtBal) < 0.005;
    const actOk = a.action === l.correctAction;
    return { i, adjOk, balOk, actOk,
      correctAdj: l.correctAdj, correctPtBal: l.correctPtBal,
      correctAction: l.correctAction, why: l.why };
  });
  const pts = perLine.reduce((t, r) => t + (r.adjOk ? 35 : 0) + (r.balOk ? 35 : 0) + (r.actOk ? 30 : 0), 0);
  const max = e.lines.length * 100;
  const score = Math.round(100 * pts / max);
  await logLab(req.session.userId, 'era', score, 100, { scenario: e.id, lines: e.lines.length });
  res.json({ score, max: 100, perLine });
}));

// ---------- Prior Auth workflow lab ----------
const stripPA = (x) => ({
  id: x.id, title: x.title, difficulty: x.difficulty, payer: x.payer,
  snapshot: x.snapshot, clinical: x.clinical,
  steps: x.steps.map(st => ({ q: st.q, options: st.options, hint: st.hint })),
});
app.get('/api/labs/priorauth', requireAuth, ah(async (req, res) => {
  res.json({ fictional: true, scenarios: labData.PRIOR_AUTH.map(stripPA) });
}));
app.post('/api/labs/priorauth/grade', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const x = labData.PRIOR_AUTH.find(v => v.id === req.body.scenarioId);
  if (!x) return res.status(404).json({ error: 'Scenario not found.' });
  const answers = req.body.answers || [];
  const perStep = x.steps.map((st, i) => {
    const ok = Number(answers[i]) === st.answer;
    return { i, ok, correct: st.answer, explanation: st.explanation };
  });
  const pts = perStep.reduce((t, r, i) => t + (r.ok ? x.steps[i].points : 0), 0);
  const max = x.steps.reduce((t, st) => t + st.points, 0);
  const score = Math.round(100 * pts / max);
  await logLab(req.session.userId, 'priorauth', score, 100, { scenario: x.id });
  res.json({ score, max: 100, perStep });
}));

// ---------- Clearinghouse simulator ----------
const stripCH = (x) => ({
  id: x.id, title: x.title, difficulty: x.difficulty, payer: x.payer,
  claim: x.claim, ack277: x.ack277,
  steps: x.steps.map(st => ({ q: st.q, options: st.options, hint: st.hint })),
});
app.get('/api/labs/clearinghouse', requireAuth, ah(async (req, res) => {
  res.json({ fictional: true, scenarios: labData.CLEARINGHOUSE.map(stripCH) });
}));
app.post('/api/labs/clearinghouse/grade', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const x = labData.CLEARINGHOUSE.find(v => v.id === req.body.scenarioId);
  if (!x) return res.status(404).json({ error: 'Scenario not found.' });
  const answers = req.body.answers || [];
  const perStep = x.steps.map((st, i) => {
    const ok = Number(answers[i]) === st.answer;
    return { i, ok, correct: st.answer, explanation: st.explanation };
  });
  const pts = perStep.reduce((t, r, i) => t + (r.ok ? x.steps[i].points : 0), 0);
  const max = x.steps.reduce((t, st) => t + st.points, 0);
  const score = Math.round(100 * pts / max);
  await logLab(req.session.userId, 'clearinghouse', score, 100, { scenario: x.id });
  res.json({ score, max: 100, perStep });
}));

// ================= UB-04 INSTITUTIONAL LAB =================
const stripUb04 = (u) => ({
  id: u.id, title: u.title, difficulty: u.difficulty, setting: u.setting, explain: u.explain,
  fields: u.fields.map(f => ({ fl: f.fl, label: f.label, hint: f.hint, options: f.options })),
});
app.get('/api/labs/ub04', requireAuth, ah(async (req, res) => {
  res.json({ scenarios: labData.UB04.map(stripUb04) });
}));
app.post('/api/labs/ub04/grade', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const u = labData.UB04.find(x => x.id === req.body.scenarioId);
  if (!u) return res.status(404).json({ error: 'Scenario not found.' });
  const answers = req.body.answers || {};
  const perField = u.fields.map((f, i) => {
    const ok = String(answers[i] || '') === f.answer;
    return { i, ok, correct: f.answer, why: ok ? 'Field locators match the encounter.' : `FL-${f.fl} hint: ${f.hint}` };
  });
  const correct = perField.filter(x => x.ok).length;
  const score = Math.round(100 * correct / u.fields.length);
  await logLab(req.session.userId, 'ub04', score, 100, { scenario: u.id, fields: u.fields.length });
  res.json({ score, correct, total: u.fields.length, perField });
}));

// ================= NCCI CHECKER LAB =================
const stripNcci = (p) => ({ c1: p.c1, c2: p.c2, ind: p.ind });
const normNcciCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
app.get('/api/labs/ncci', requireAuth, ah(async (req, res) => {
  res.json({ pairs: labData.NCCI_PAIRS.map(stripNcci) });
}));
app.post('/api/labs/ncci/check', requireAuth, ah(async (req, res) => {
  const a = normNcciCode(req.body.c1), b = normNcciCode(req.body.c2);
  const p = labData.NCCI_PAIRS.find(x =>
    (normNcciCode(x.c1) === a && normNcciCode(x.c2) === b) ||
    (normNcciCode(x.c1) === b && normNcciCode(x.c2) === a));
  if (!p) return res.json({ found: false });
  res.json({ found: true, pair: { c1: p.c1, c2: p.c2, ind: p.ind, modifier: p.modifier, why: p.why } });
}));
app.post('/api/labs/ncci/quiz/grade', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const answers = req.body.answers || [];
  const perQ = answers.map(a => {
    const p = labData.NCCI_PAIRS.find(x =>
      (normNcciCode(x.c1) === normNcciCode(a.c1) && normNcciCode(x.c2) === normNcciCode(a.c2)) ||
      (normNcciCode(x.c1) === normNcciCode(a.c2) && normNcciCode(x.c2) === normNcciCode(a.c1)));
    if (!p) return { ok: false, correctV: null, why: 'Pair not in training set.', modifier: '—' };
    const correctV = p.ind === 0 ? 'never' : p.ind === 1 ? 'modifier' : 'fine';
    return { ok: a.v === correctV, correctV, why: p.why, modifier: p.modifier };
  });
  const correct = perQ.filter(x => x.ok).length;
  const score = perQ.length ? Math.round(100 * correct / perQ.length) : 0;
  await logLab(req.session.userId, 'ncci', score, 100, { questions: perQ.length });
  res.json({ score, correct, total: perQ.length, perQ });
}));


// ================= CREDENTIALING TRACKER LAB =================
const stripCred = (e) => ({
  id: e.id, title: e.title, difficulty: e.difficulty,
  provider: e.provider, specialty: e.specialty, situation: e.situation,
  steps: e.steps.map(t => ({ step: t.step, timeframe: t.timeframe, status: t.status, docs: t.docs })),
  decisions: e.decisions.map(d => ({ q: d.q, options: d.options, points: d.points, hint: d.hint || '' })),
});
app.get('/api/labs/cred', requireAuth, ah(async (req, res) => {
  res.json({ fictional: true, stepsInfo: labData.CRED_STEPS_INFO,
    scenarios: labData.CRED.map(stripCred) });
}));
app.post('/api/labs/cred/grade', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const e = labData.CRED.find(x => x.id === req.body.scenarioId);
  if (!e) return res.status(404).json({ error: 'Scenario not found.' });
  const answers = req.body.answers || [];
  let earned = 0, max = 0;
  const perDec = e.decisions.map((d, i) => {
    max += d.points;
    const ok = answers[i] === d.answer;
    if (ok) earned += d.points;
    return { i, ok, points: ok ? d.points : 0, explanation: d.explanation };
  });
  const score = max ? Math.round(100 * earned / max) : 0;
  await logLab(req.session.userId, 'cred', score, 100,
    { scenario: e.id, earned, max });
  res.json({ score, max: 100, perDec });
}));

// ================= PATIENT STATEMENTS + COLLECTIONS LAB =================
const stripStmt = (e) => ({
  id: e.id, title: e.title, difficulty: e.difficulty, patient: e.patient,
  dos: e.dos, cpt: e.cpt,
  eob: e.eob, statement: e.statement, cycle: e.cycle,
  tasks: e.tasks.map(t => ({ q: t.q })),
});
app.get('/api/labs/statements', requireAuth, ah(async (req, res) => {
  res.json({ fictional: true, actions: labData.STATEMENT_ACTIONS,
    fdcpa: labData.FDCPA_RULES,
    scenarios: labData.STATEMENTS.map(stripStmt) });
}));
app.post('/api/labs/statements/grade', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const e = labData.STATEMENTS.find(x => x.id === req.body.scenarioId);
  if (!e) return res.status(404).json({ error: 'Scenario not found.' });
  const answers = req.body.answers || [];
  const perTask = e.tasks.map((t, i) => {
    const a = answers[i];
    const num = parseFloat(a);
    const ok = !isNaN(num) && Math.abs(num - t.answer) < 0.01;
    return { i, ok, correct: t.answer, why: t.why };
  });
  const actOk = req.body.action === e.correctAction;
  const taskPts = perTask.reduce((t, r) => t + (r.ok ? 1 : 0), 0);
  const max = e.tasks.length + 1;
  const score = Math.round(100 * (taskPts + (actOk ? 1 : 0)) / max);
  await logLab(req.session.userId, 'statements', score, 100,
    { scenario: e.id, action: req.body.action, actionOk: actOk });
  res.json({ score, max: 100, perTask, actOk,
    correctAction: e.correctAction, why: e.why });
}));

const QUIZ_MODES = ['timed', 'weakest', 'missed', 'mix', 'sprint', 'cpc'];
app.get('/api/labs/quiz', requireAuth, ah(async (req, res) => {
  const mode = QUIZ_MODES.includes(req.query.mode) ? req.query.mode : 'mix';
  const n = Math.min(30, Math.max(5, parseInt(req.query.n, 10) || 15));
  const uid = req.session.userId;
  const RF = db.IS_MYSQL ? 'RAND()' : 'RANDOM()';
  let qs;
  if (mode === 'missed') {
    const runs = await db.all(`SELECT detail FROM lab_runs WHERE user_id = ? AND lab_key LIKE 'quiz-%' ORDER BY id DESC LIMIT 60`, [uid]);
    const seen = new Set();
    for (const r of runs) {
      try { (JSON.parse(r.detail || '{}').missed || []).forEach(id => seen.add(id)); } catch (e) {}
      if (seen.size >= n) break;
    }
    // also include wrong answers from the case player
    const caseWrong = await db.all(`SELECT DISTINCT q.id FROM answers a
      JOIN attempts at ON at.id = a.attempt_id JOIN questions q ON q.id = a.question_id
      WHERE at.user_id = ? AND a.correct = 0`, [uid]);
    caseWrong.forEach(r => seen.add(r.id));
    const ids = [...seen].slice(0, n);
    qs = ids.length ? await db.all(`SELECT q.id, q.qnum, q.prompt, q.options, q.hint, q.qtype, q.extra, c.code AS caseCode
      FROM questions q JOIN cases c ON c.id = q.case_id WHERE q.id IN (${ids.map(() => '?').join(',')})`, ids) : [];
  } else if (mode === 'weakest') {
    const prog = await db.all(`SELECT c.id, c.points,
        COALESCE(MAX(CASE WHEN at.status='completed' THEN at.score END), 0) AS best
      FROM cases c LEFT JOIN attempts at ON at.case_id = c.id AND at.user_id = ?
      WHERE c.active = 1 GROUP BY c.id`, [uid]);
    prog.sort((a, b) => (a.best / a.points) - (b.best / b.points));
    const ids = prog.slice(0, 2).map(p => p.id);
    qs = ids.length ? await db.all(`SELECT q.id, q.qnum, q.prompt, q.options, q.hint, q.qtype, q.extra, c.code AS caseCode
      FROM questions q JOIN cases c ON c.id = q.case_id WHERE q.case_id IN (${ids.map(() => '?').join(',')})
      ORDER BY ${RF} LIMIT ${n}`, ids) : [];
  } else {
    qs = await db.all(`SELECT q.id, q.qnum, q.prompt, q.options, q.hint, q.qtype, q.extra, c.code AS caseCode
      FROM questions q JOIN cases c ON c.id = q.case_id WHERE c.active = 1
      ORDER BY ${RF} LIMIT ${n}`);
  }
  if (!qs.length) return res.json({ mode, questions: [], note: 'No questions available for this mode yet.' });
  res.json({ mode, questions: qs.map(q => {
    let extra = {};
    try { extra = JSON.parse(q.extra || '{}'); } catch (e) {}
    return { id: q.id, caseCode: q.caseCode, qnum: q.qnum, prompt: q.prompt,
      options: JSON.parse(q.options || '[]'), hint: q.hint, qtype: q.qtype || 'mcq', extra };
  }) });
}));

// normalize a typed code for grading: uppercase, trim, collapse spaces, strip trailing periods
function normCode(v) { return String(v || '').toUpperCase().trim().replace(/\s+/g, '').replace(/\.+$/, ''); }
// partial credit: base code right but modifier wrong/laterality wrong -> half points
function gradeCodeEntry(expected, typed) {
  const e = normCode(expected), t = normCode(typed);
  if (!t) return { earned: 0, verdict: 'blank' };
  if (t === e) return { earned: 1, verdict: 'exact' };
  const base = c => c.split('-')[0];
  if (base(t) === base(e) && base(t).length >= 4) return { earned: 0.5, verdict: 'partial' };
  return { earned: 0, verdict: 'wrong' };
}
app.post('/api/labs/quiz/submit', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const mode = QUIZ_MODES.includes(req.body.mode) ? req.body.mode : 'mix';
  const answers = Array.isArray(req.body.answers) ? req.body.answers.slice(0, 30) : [];
  if (!answers.length) return res.status(400).json({ error: 'No answers submitted.' });
  const ids = answers.map(a => parseInt(a.questionId, 10)).filter(Number.isInteger);
  const rows = await db.all(`SELECT id, answer_idx, points, explanation, qtype, answer_text FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  let score = 0, max = 0;
  const feedback = answers.map(a => {
    const q = byId[a.questionId];
    if (!q) return null;
    max += q.points;
    if ((q.qtype || 'mcq') === 'code_entry') {
      const g = gradeCodeEntry(q.answer_text, a.text);
      const pts = Math.round(q.points * g.earned);
      score += pts;
      return { questionId: q.id, correct: g.earned === 1, partial: g.earned === 0.5,
        typed: String(a.text || '').slice(0, 40), expected: g.earned === 1 ? undefined : q.answer_text,
        explanation: q.explanation, pointsEarned: pts };
    }
    const correct = parseInt(a.chosen, 10) === q.answer_idx;
    if (correct) score += q.points;
    return { questionId: q.id, correct, explanation: q.explanation };
  }).filter(Boolean);
  if (!req.body.quiet) {
    const missedIds = feedback.filter(f => !f.correct).map(f => f.questionId);
    await logLab(req.session.userId, 'quiz-' + mode, score, max, { n: feedback.length, missed: missedIds });
  }
  res.json({ score, max, pct: max ? Math.round(100 * score / max) : 0, feedback });}));

app.get('/api/labs/bests', requireAuth, ah(async (req, res) => {
  const rows = await db.all(`SELECT lab_key, MAX(CAST(score AS FLOAT) / NULLIF(max_score, 0)) AS best
    FROM lab_runs WHERE user_id = ? GROUP BY lab_key`, [req.session.userId]);
  res.json({ bests: Object.fromEntries(rows.map(r => [r.lab_key, Math.round(100 * (r.best || 0))])) });
}));

// ---------- RCM workspace API (student: full claim lifecycle) ----------
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const snow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
function payerKey(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('medicare')) return 'medicare';
  if (n.includes('aetna')) return 'aetna';
  if (n.includes('united')) return 'uhc';
  return 'bcbs';
}
function adjudicate(claim) {
  // deterministic per claim id: ~28% deny, else pay at 70% allowed / 20% patient share
  const h = ((claim.id * 2654435761) >>> 0) % 100;
  if (h < 28) return { status: 'DENIED', denial_code: ['CO-16', 'CO-96', 'CO-97', 'CO-29'][h % 4] };
  const allowed = r2(claim.billed * 0.7), patient_resp = r2(allowed * 0.2), paid = r2(allowed - patient_resp);
  return { status: 'PAID', allowed, paid, adjustment: r2(claim.billed - allowed), patient_resp };
}
function ageDays(row) {
  const d = new Date(row.submitted_at || row.created_at);
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}
function ageBucket(days) { return days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '91+'; }

app.get('/api/rcm/patients', requireAuth, ah(async (req, res) => {
  res.json({ patients: await db.all('SELECT code, name, dob, gender, phone, email, address, status FROM patients WHERE user_id = ? ORDER BY code', [req.session.userId]) });
}));
// Add patient (duplicate detection: same name+DOB or same phone)
app.post('/api/rcm/patients', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  for (const f of ['name', 'dob', 'gender', 'phone'])
    if (!b[f] || !String(b[f]).trim()) throw Object.assign(new Error('Name, DOB, gender and phone are required.'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.dob)) throw Object.assign(new Error('DOB must be YYYY-MM-DD.'), { status: 400 });
  const dupes = await db.all(
    `SELECT code, name, dob, phone FROM patients WHERE user_id = ? AND ((LOWER(name) = LOWER(?) AND dob = ?) OR phone = ?)`,
    [req.session.userId, b.name.trim(), b.dob, b.phone.trim()]);
  if (dupes.length && !b.force)
    throw Object.assign(new Error('Possible duplicate patient found.'), { status: 409, duplicates: dupes });
  const maxRow = await db.get(
    `SELECT code FROM patients WHERE user_id = ? AND code LIKE 'PT-%' ORDER BY CAST(SUBSTR(code, 4) AS INTEGER) DESC LIMIT 1`,
    [req.session.userId]);
  let n = 10001;
  if (maxRow && /^PT-\d+$/.test(maxRow.code)) n = Math.max(n, parseInt(maxRow.code.slice(3), 10) + 1);
  // insert with retry: handles legacy global UNIQUE(code) on old installs
  // (new installs use composite UNIQUE(code, user_id), so per-user codes just work)
  let code = null;
  for (let tries = 0; tries < 50; tries++) {
    const tryCode = 'PT-' + (n + tries);
    try {
      await db.run(`INSERT INTO patients (code, name, dob, gender, phone, email, address, status, fictional, user_id)
        VALUES (?,?,?,?,?,?,?,'Active',1,?)`,
        [tryCode, b.name.trim(), b.dob, b.gender, b.phone.trim(), (b.email || '').trim(), (b.address || '').trim(), req.session.userId]);
      code = tryCode;
      break;
    } catch (e) {
      if (!/duplicate|unique/i.test(e.message || '')) throw e;
      // code collision (legacy schema) — try next number
    }
  }
  if (!code) throw Object.assign(new Error('Could not generate a unique patient code.'), { status: 500 });
  res.json({ code });
}));
// Edit patient
app.put('/api/rcm/patients/:code', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const p = await db.get('SELECT * FROM patients WHERE code = ? AND user_id = ?', [req.params.code, req.session.userId]);
  if (!p) throw Object.assign(new Error('Patient not found.'), { status: 404 });
  await db.run(`UPDATE patients SET phone = ?, email = ?, address = ?, status = ? WHERE code = ? AND user_id = ?`,
    [(b.phone ?? p.phone), (b.email ?? p.email ?? ''), (b.address ?? p.address ?? ''), (b.status || p.status), req.params.code, req.session.userId]);
  res.json({ ok: true });
}));
// Patient timeline: charges + claims + eligibility checks merged
app.get('/api/rcm/patients/:code/history', requireAuth, ah(async (req, res) => {
  const code = req.params.code, uid = req.session.userId;
  const owner = await db.get('SELECT 1 FROM patients WHERE code = ? AND user_id = ?', [code, uid]);
  if (!owner) throw Object.assign(new Error('Patient not found.'), { status: 404 });
  const charges = await db.all(`SELECT id, dos AS d, cpt, icd, amount, status FROM charges WHERE user_id = ? AND patient_code = ?`, [uid, code]);
  const claims = await db.all(`SELECT id, claim_no, dos AS d, payer, billed, status FROM claims WHERE user_id = ? AND patient_code = ?`, [uid, code]);
  const checks = await db.all(`SELECT id, payer, service, coverage, result, created_at AS d FROM eligibility_checks WHERE user_id = ? AND patient_code = ?`, [uid, code]);
  const ev = [
    ...charges.map(c => ({ t: 'charge', d: c.dos, ...c })),
    ...claims.map(c => ({ t: 'claim', d: c.dos, ...c })),
    ...checks.map(c => ({ t: 'eligibility', d: (c.d || '').slice(0, 10), ...c })),
  ].sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
  res.json({ events: ev.slice(0, 50) });
}));

app.get('/api/rcm/insurance', requireAuth, ah(async (req, res) => {
  const rows = await db.all(`SELECT * FROM insurance WHERE user_id IS NULL OR user_id = ? ORDER BY patient_code, id`, [req.session.userId]);
  res.json({ insurance: rows });
}));
app.post('/api/rcm/insurance', requireAuth, requireFn('insurance-add'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.patient_code || !b.payer || !b.member_id) throw Object.assign(new Error('Patient, payer and member ID are required.'), { status: 400 });
  const r = await db.run(`INSERT INTO insurance (user_id, patient_code, payer, member_id, plan, type, status, effective, copay, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [req.session.userId, b.patient_code, b.payer, b.member_id,
    b.plan || '', b.type || 'PPO', 'ACTIVE', b.effective || snow().slice(0, 10), r2(b.copay), snow()]);
  res.json({ id: r.id });
}));

app.put('/api/rcm/insurance/:id', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const r = await db.get('SELECT * FROM insurance WHERE id = ? AND (user_id IS NULL OR user_id = ?)',
    [req.params.id, req.session.userId]);
  if (!r) throw Object.assign(new Error('Insurance record not found.'), { status: 404 });
  const pri = ['primary', 'secondary', 'tertiary'].includes(b.priority) ? b.priority : r.priority;
  const st = ['ACTIVE', 'INACTIVE'].includes(String(b.status).toUpperCase()) ? String(b.status).toUpperCase() : r.status;
  await db.run(`UPDATE insurance SET payer = ?, member_id = ?, plan = ?, type = ?, status = ?, effective = ?, copay = ?, priority = ? WHERE id = ?`,
    [(b.payer ?? r.payer), (b.member_id ?? r.member_id), (b.plan ?? r.plan), (b.type ?? r.type),
     st, (b.effective ?? r.effective), r2(b.copay ?? r.copay), pri, req.params.id]);
  res.json({ ok: true });
}));
// ---- payer management ----
app.get('/api/rcm/payers', requireAuth, ah(async (req, res) => {
  const payers = await db.all('SELECT * FROM payers WHERE user_id = ? ORDER BY name', [req.session.userId]);
  const stats = await db.all(`SELECT payer, COUNT(DISTINCT patient_code) AS patients,
      COUNT(*) AS records, SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active
    FROM insurance WHERE user_id IS NULL OR user_id = ? GROUP BY payer`, [req.session.userId]);
  const sm = Object.fromEntries(stats.map(x => [x.payer, x]));
  res.json({ payers: payers.map(x => ({
    id: x.id, name: x.name, payer_id: x.payer_id, phone: x.phone, website: x.website,
    patients: Number(sm[x.name]?.patients || 0), records: Number(sm[x.name]?.records || 0),
    active: Number(sm[x.name]?.active || 0),
  })) });
}));
app.post('/api/rcm/payers', requireAuth, requireFn('insurance-add'), ah(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) throw Object.assign(new Error('Payer name is required.'), { status: 400 });
  const mine = await db.get('SELECT id FROM payers WHERE name = ? AND user_id = ?', [name, req.session.userId]);
  if (mine) throw Object.assign(new Error('A payer with this name already exists.'), { status: 409 });
  let r;
  try {
    r = await db.run('INSERT INTO payers (name, payer_id, phone, website, user_id, created_at) VALUES (?,?,?,?,?,?)',
      [name, b.payer_id || '', b.phone || '', b.website || '', req.session.userId, db.now()]);
  } catch (e) {
    if (/duplicate|unique/i.test(e.message || '')) throw Object.assign(new Error('A payer with this name already exists.'), { status: 409 });
    throw e;
  }
  res.json({ payer: { id: r.id, name, payer_id: b.payer_id || '', phone: b.phone || '', website: b.website || '' } });
}));
app.put('/api/rcm/payers/:id', requireAuth, requireFn('insurance-add'), ah(async (req, res) => {
  const b = req.body || {};
  const p = await db.get('SELECT * FROM payers WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!p) throw Object.assign(new Error('Payer not found.'), { status: 404 });
  const name = String(b.name || '').trim() || p.name;
  // scoped rename collision check
  if (name !== p.name) {
    const clash = await db.get('SELECT id FROM payers WHERE name = ? AND user_id = ? AND id <> ?', [name, req.session.userId, p.id]);
    if (clash) throw Object.assign(new Error('A payer with this name already exists.'), { status: 409 });
  }
  try {
    await db.run('UPDATE payers SET name = ?, phone = ?, website = ? WHERE id = ? AND user_id = ?',
      [name, b.phone ?? p.phone, b.website ?? p.website, req.params.id, req.session.userId]);
  } catch (e) {
    if (/duplicate|unique/i.test(e.message || '')) throw Object.assign(new Error('A payer with this name already exists.'), { status: 409 });
    throw e;
  }
  res.json({ payer: { id: p.id, name, payer_id: p.payer_id, phone: b.phone ?? p.phone, website: b.website ?? p.website } });
}));
app.get('/api/rcm/payers/:id', requireAuth, ah(async (req, res) => {
  const p = await db.get('SELECT * FROM payers WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!p) throw Object.assign(new Error('Payer not found.'), { status: 404 });
  const rows = await db.all(`SELECT i.patient_code, i.member_id, i.plan, i.type, i.status, i.priority,
      pt.name, pt.dob
    FROM insurance i LEFT JOIN patients pt ON pt.code = i.patient_code AND pt.user_id = i.user_id
    WHERE i.payer = ? AND i.user_id = ?
    ORDER BY i.patient_code`, [p.name, req.session.userId]);
  res.json({ payer: p, patients: rows });
}));
app.get('/api/rcm/eligibility', requireAuth, ah(async (req, res) => {
  res.json({ checks: await db.all('SELECT * FROM eligibility_checks WHERE user_id = ? ORDER BY id DESC LIMIT 100', [req.session.userId]) });
}));
app.post('/api/rcm/eligibility/verify', requireAuth, requireFn('eligibility-verify'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.patient_code || !b.payer) throw Object.assign(new Error('Patient and payer are required.'), { status: 400 });
  const cov = await db.get('SELECT * FROM insurance WHERE (user_id IS NULL OR user_id = ?) AND patient_code = ? AND payer = ? ORDER BY user_id DESC LIMIT 1',
    [req.session.userId, b.patient_code, b.payer]);
  const active = !!(cov && cov.status === 'ACTIVE');
  const copay = active ? r2(b.copay ?? cov.copay) : 0;
  const deductible = active ? r2(b.deductible ?? [500, 1000, 1500, 2000][String(cov.member_id).length % 4]) : 0;
  const result = active ? 'VERIFIED' : 'INACTIVE';
  const rc = b.response_code || '271';
  const r = await db.run(`INSERT INTO eligibility_checks
    (user_id, patient_code, payer, service, coverage, copay, deductible, result, created_at,
     response_code, plan_type, deductible_met, coinsurance, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.session.userId, b.patient_code, b.payer, b.service || 'Office Visit',
     active ? 'ACTIVE' : 'INACTIVE', copay, deductible, result, snow(),
     rc, (b.plan_type || cov?.plan || '').slice(0, 40),
     active ? r2(b.deductible_met ?? 0) : 0, active ? r2(b.coinsurance ?? 20) : 0,
     String(b.notes || '').slice(0, 500)]);
  res.json({ id: r.id, coverage: active ? 'ACTIVE' : 'INACTIVE', copay, deductible, result,
    response_code: rc, plan_type: b.plan_type || cov?.plan || '',
    deductible_met: active ? r2(b.deductible_met ?? 0) : 0, coinsurance: active ? r2(b.coinsurance ?? 20) : 0 });
}));

app.post('/api/rcm/eligibility/bulk', requireAuth, requireFn('eligibility-verify'), ah(async (req, res) => {
  const uid = req.session.userId;
  const covs = await db.all(`SELECT * FROM insurance WHERE (user_id IS NULL OR user_id = ?) AND status = 'ACTIVE' ORDER BY patient_code`,
    [uid]);
  const results = [];
  for (const cov of covs.slice(0, 25)) {
    const copay = r2(cov.copay);
    const deductible = r2([500, 1000, 1500, 2000][String(cov.member_id).length % 4]);
    const r = await db.run(`INSERT INTO eligibility_checks
      (user_id, patient_code, payer, service, coverage, copay, deductible, result, created_at,
       response_code, plan_type, deductible_met, coinsurance, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, cov.patient_code, cov.payer, 'Office Visit', 'ACTIVE', copay, deductible, 'VERIFIED', snow(),
       '271', (cov.plan || '').slice(0, 40), 0, 20, 'Bulk verification']);
    results.push({ id: r.id, patient_code: cov.patient_code, payer: cov.payer, result: 'VERIFIED', copay });
  }
  res.json({ verified: results.length, results });
}));
app.get('/api/rcm/charges', requireAuth, ah(async (req, res) => {
  res.json({ charges: await db.all('SELECT * FROM charges WHERE user_id = ? ORDER BY id DESC', [req.session.userId]) });
}));
app.post('/api/rcm/charges', requireAuth, requireFn('charges-add'), ah(async (req, res) => {
  const b = req.body || {};
  for (const f of ['patient_code', 'dos', 'cpt', 'icd', 'amount'])
    if (!b[f]) throw Object.assign(new Error('Patient, date of service, CPT, ICD and amount are required.'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.dos)) throw Object.assign(new Error('Date of service must be YYYY-MM-DD.'), { status: 400 });
  if (!(Number(b.amount) > 0)) throw Object.assign(new Error('Amount must be positive.'), { status: 400 });
  const r = await db.run(`INSERT INTO charges (user_id, patient_code, provider, dos, cpt, icd, modifier, units, amount, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,'READY',?)`, [req.session.userId, b.patient_code, b.provider || 'Dr. James Anderson',
    b.dos, b.cpt.trim(), b.icd.trim().toUpperCase(), (b.modifier || '').trim().toUpperCase(),
    Math.max(1, parseInt(b.units, 10) || 1), r2(b.amount), snow()]);
  res.json({ id: r.id });
}));

app.get('/api/rcm/claims', requireAuth, ah(async (req, res) => {
  res.json({ claims: await db.all('SELECT * FROM claims WHERE user_id = ? ORDER BY id DESC', [req.session.userId]) });
}));
app.post('/api/rcm/claims', requireAuth, requireFn('claims-create'), ah(async (req, res) => {
  const b = req.body || {};
  const ch = await db.get('SELECT * FROM charges WHERE id = ? AND user_id = ?', [b.charge_id, req.session.userId]);
  if (!ch) throw Object.assign(new Error('Charge not found.'), { status: 404 });
  if (ch.claim_id) throw Object.assign(new Error('This charge is already linked to a claim.'), { status: 409 });
  const ins = await db.get('SELECT * FROM insurance WHERE (user_id IS NULL OR user_id = ?) AND patient_code = ? ORDER BY user_id DESC LIMIT 1',
    [req.session.userId, ch.patient_code]);
  const payer = b.payer || (ins ? ins.payer : 'BlueCross BlueShield (Simulated)');
  const r = await db.run(`INSERT INTO claims (user_id, claim_no, patient_code, payer, cpt, icd, modifier, dos, billed, status, validation, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,'DRAFT','NOT_VALIDATED',?)`,
    [req.session.userId, 'PENDING', ch.patient_code, payer, ch.cpt, ch.icd, ch.modifier, ch.dos, ch.amount, snow()]);
  const claimNo = `CLM-${Date.now()}-${r.id}`;
  await db.run('UPDATE claims SET claim_no = ? WHERE id = ?', [claimNo, r.id]);
  await db.run('UPDATE charges SET claim_id = ?, status = ? WHERE id = ?', [r.id, 'LINKED', ch.id]);
  res.json({ id: r.id, claim_no: claimNo });
}));
app.post('/api/rcm/claims/:id/validate', requireAuth, requireFn('claims-validate'), ah(async (req, res) => {
  const c = await db.get('SELECT * FROM claims WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!c) throw Object.assign(new Error('Claim not found.'), { status: 404 });
  const r = labData.scrubClaim({
    patientId: c.patient_code, payer: payerKey(c.payer), dos: c.dos, pos: '11',
    npiR: '1234567890', npiB: '0987654321',
    icds: [c.icd],
    lines: [{ cpt: c.cpt, dx: [1], mod: c.modifier ? [c.modifier] : [], units: 1, charge: c.billed }]
  });
  const validation = r.errors.length ? 'FAILED' : 'PASSED';
  await db.run('UPDATE claims SET validation = ?, validated_at = ? WHERE id = ?', [validation, snow(), c.id]);
  res.json({ ok: true, validation, errors: r.errors, warnings: r.warnings, score: r.score });
}));
app.get('/api/rcm/claims/:id', requireAuth, ah(async (req, res) => {
  const c = await db.get('SELECT * FROM claims WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!c) throw Object.assign(new Error('Claim not found.'), { status: 404 });
  const charge = await db.get('SELECT * FROM charges WHERE claim_id = ? AND user_id = ?', [c.id, req.session.userId]);
  const pays = await db.all('SELECT * FROM payments WHERE claim_id = ? AND user_id = ? ORDER BY id DESC', [c.id, req.session.userId]);
  res.json({ claim: c, charge, payments: pays });
}));
app.post('/api/rcm/claims/:id/reset', requireAuth, requireFn('claims-create'), ah(async (req, res) => {
  const c = await db.get('SELECT * FROM claims WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!c) throw Object.assign(new Error('Claim not found.'), { status: 404 });
  if (!['DENIED', 'DRAFT'].includes(c.status)) throw Object.assign(new Error('Only denied or draft claims can be reset.'), { status: 409 });
  await db.run(`UPDATE claims SET status='DRAFT', validation='NOT_VALIDATED', validated_at=NULL, denial_code='' WHERE id = ?`, [c.id]);
  res.json({ ok: true, status: 'DRAFT' });
}));
app.post('/api/rcm/claims/:id/submit', requireAuth, requireFn('claims-submit'), ah(async (req, res) => {
  const c = await db.get('SELECT * FROM claims WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!c) throw Object.assign(new Error('Claim not found.'), { status: 404 });
  if (c.status !== 'DRAFT') throw Object.assign(new Error('Only draft claims can be submitted.'), { status: 409 });
  if (c.validation !== 'PASSED') throw Object.assign(new Error('Validate the claim first — only clean (PASSED) claims can be submitted.'), { status: 409 });
  const a = adjudicate(c), now = snow();
  await db.run(`UPDATE claims SET status = ?, denial_code = ?, allowed = ?, paid = ?, adjustment = ?,
    patient_resp = ?, submitted_at = ?, follow_up = 'NOT_STARTED' WHERE id = ?`,
    [a.status, a.denial_code || '', a.allowed || 0, a.paid || 0, a.adjustment || 0, a.patient_resp || 0, now, c.id]);
  res.json({ status: a.status, denial_code: a.denial_code || null, adjudication: a });
}));

app.get('/api/rcm/payments', requireAuth, ah(async (req, res) => {
  res.json({ payments: await db.all(`SELECT p.*, c.claim_no, c.payer, c.dos, c.billed AS c_billed, c.allowed AS c_allowed FROM payments p JOIN claims c ON c.id = p.claim_id
    WHERE p.user_id = ? ORDER BY p.id DESC`, [req.session.userId]) });
}));
app.post('/api/rcm/payments', requireAuth, requireFn('payments-post'), ah(async (req, res) => {
  const b = req.body || {};
  const c = await db.get('SELECT * FROM claims WHERE id = ? AND user_id = ?', [b.claim_id, req.session.userId]);
  if (!c) throw Object.assign(new Error('Claim not found.'), { status: 404 });
  if (!['SUBMITTED', 'PAID'].includes(c.status)) throw Object.assign(new Error('Payments can only be posted on submitted claims.'), { status: 409 });
  const paid = r2(b.paid), adj = r2(b.adjustment), pr = r2(b.patient_resp);
  if (paid < 0 || adj < 0 || pr < 0) throw Object.assign(new Error('Payment amounts cannot be negative.'), { status: 400 });
  if (r2(paid + pr) > r2(c.allowed || c.billed)) throw Object.assign(new Error('Paid + patient share cannot exceed the allowed/billed amount.'), { status: 400 });
  await db.run('INSERT INTO payments (user_id, claim_id, paid, adjustment, patient_resp, method, created_at) VALUES (?,?,?,?,?,?,?)',
    [req.session.userId, c.id, paid, adj, pr, b.method || 'ERA', snow()]);
  const bal = r2((c.allowed || c.billed) - paid - pr);
  await db.run('UPDATE claims SET paid = ?, adjustment = ?, patient_resp = ?, status = ? WHERE id = ?',
    [paid, adj, pr, bal <= 0 ? 'PAID' : 'SUBMITTED', c.id]);
  res.json({ ok: true, balance: bal });
}));

app.get('/api/rcm/ar', requireAuth, ah(async (req, res) => {
  const rows = await db.all(`SELECT * FROM claims WHERE user_id = ? AND status IN ('SUBMITTED','DENIED','APPEALED','PAID')
    AND (paid < allowed OR (allowed = 0 AND status != 'PAID') OR patient_resp > 0 OR status IN ('DENIED','APPEALED')) ORDER BY submitted_at DESC, id DESC`,
    [req.session.userId]);
  const open = rows.filter(c => c.status !== 'PAID' || c.patient_resp > 0);
  const withAge = open.map(c => ({ ...c, age: ageDays(c), bucket: ageBucket(ageDays(c)),
    balance: r2((c.status === 'PAID' ? c.patient_resp : (c.allowed || c.billed) - c.paid)) }));
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91+': 0 };
  let total = 0, patAR = 0;
  for (const c of withAge) { buckets[c.bucket]++; total += c.balance; if (c.patient_resp > 0) patAR += Math.min(c.balance, c.patient_resp); }
  const notes = await db.all('SELECT claim_id, COUNT(*) AS n FROM ar_notes WHERE user_id = ? GROUP BY claim_id', [req.session.userId]);
  const noteMap = Object.fromEntries(notes.map(n => [n.claim_id, n.n]));
  res.json({ rows: withAge.map(c => ({ ...c, notes: noteMap[c.id] || 0 })), buckets,
    total: r2(total), insuranceAR: r2(total - patAR), patientAR: r2(patAR), open: withAge.length });
}));
app.post('/api/rcm/ar/note', requireAuth, requireFn('ar-note'), ah(async (req, res) => {
  const b = req.body || {};
  const c = await db.get('SELECT id FROM claims WHERE id = ? AND user_id = ?', [b.claim_id, req.session.userId]);
  if (!c) throw Object.assign(new Error('Claim not found.'), { status: 404 });
  if (!String(b.note || '').trim()) throw Object.assign(new Error('Note cannot be empty.'), { status: 400 });
  let kind = ['note', 'followup', 'promise'].includes(b.kind) ? b.kind : 'note';
  const promiseAmt = r2(Math.max(0, Number(b.promise_amt) || 0));
  if (promiseAmt > 0 && kind !== 'promise') kind = 'promise';
  const status = String(b.status || '').slice(0, 40);
  const assigned = String(b.assigned_to || '').slice(0, 40);
  const nextDate = String(b.next_date || '').slice(0, 20);
  await db.run('INSERT INTO ar_notes (user_id, claim_id, note, kind, status, assigned_to, next_date, promise_amt, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.session.userId, c.id, String(b.note).trim().slice(0, 500), kind, status, assigned, nextDate, promiseAmt, snow()]);
  await db.run("UPDATE claims SET follow_up = 'IN_PROGRESS' WHERE id = ? AND follow_up = 'NOT_STARTED'", [c.id]);
  bustAdminCache();
  res.json({ ok: true });
}));
// follow-up timeline per account (newest first)
app.get('/api/rcm/ar/timeline', requireAuth, ah(async (req, res) => {
  const cid = Number(req.query.claim_id) || 0;
  const c = await db.get('SELECT * FROM claims WHERE id = ? AND user_id = ?', [cid, req.session.userId]);
  if (!c) throw Object.assign(new Error('Claim not found.'), { status: 404 });
  const notes = await db.all('SELECT * FROM ar_notes WHERE user_id = ? AND claim_id = ? ORDER BY id DESC', [req.session.userId, cid]);
  res.json({ claim: { id: c.id, claim_no: c.claim_no, patient_code: c.patient_code, payer: c.payer, billed: c.billed, balance: r2((c.status === 'PAID' ? c.patient_resp : (c.allowed || c.billed) - c.paid)), status: c.status, follow_up: c.follow_up, age: ageDays(c), bucket: ageBucket(ageDays(c)) }, notes });
}));
// collector stats for this student
app.get('/api/rcm/ar/collector', requireAuth, ah(async (req, res) => {
  const u = req.session.userId;
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const fu = await db.get(`SELECT COUNT(*) AS n FROM ar_notes WHERE user_id = ? AND kind = 'followup' AND created_at >= ?`, [u, weekAgo]);
  const pr = await db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(promise_amt),0) AS amt FROM ar_notes WHERE user_id = ? AND kind = 'promise'`, [u]);
  const accts = await db.get(`SELECT COUNT(DISTINCT claim_id) AS n FROM ar_notes WHERE user_id = ?`, [u]);
  res.json({ followups7d: fu.n, promises: pr.n, promisedAmt: r2(pr.amt), accountsWorked: accts.n });
}));

app.get('/api/rcm/denials', requireAuth, ah(async (req, res) => {
  const denials = await db.all(`SELECT * FROM claims WHERE user_id = ? AND status IN ('DENIED','APPEALED') ORDER BY id DESC`, [req.session.userId]);
  const wr = await db.all(`SELECT denial_code, COUNT(*) AS n, SUM(CASE WHEN outcome = 'WON' THEN 1 ELSE 0 END) AS won
    FROM denial_work WHERE user_id = ? AND denial_code != '' GROUP BY denial_code`, [req.session.userId]);
  const winRate = {};
  for (const r of wr) winRate[r.denial_code] = { total: r.n, won: r.won, pct: r.n ? Math.round(100 * r.won / r.n) : 0 };
  const res2 = await db.get(`SELECT COUNT(*) AS n FROM denial_work WHERE user_id = ? AND outcome IN ('WON','LOST','WRITTEN_OFF','CORRECTED')`, [req.session.userId]);
  res.json({ denials, winRate, resolved: res2.n });
}));
// denial investigation workbench (get/save)
app.get('/api/rcm/denials/:id/work', requireAuth, ah(async (req, res) => {
  const c = await db.get(`SELECT * FROM claims WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId]);
  if (!c) throw Object.assign(new Error('Denial not found.'), { status: 404 });
  const work = await db.get(`SELECT * FROM denial_work WHERE user_id = ? AND claim_id = ?`, [req.session.userId, c.id]);
  const notes = await db.all(`SELECT * FROM ar_notes WHERE user_id = ? AND claim_id = ? ORDER BY id DESC LIMIT 20`, [req.session.userId, c.id]);
  res.json({ claim: c, work: work || null, notes });
}));
app.post('/api/rcm/denials/:id/work', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const c = await db.get(`SELECT id, denial_code FROM claims WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId]);
  if (!c) throw Object.assign(new Error('Denial not found.'), { status: 404 });
  const rc = String(b.root_cause || '').slice(0, 60);
  const ca = String(b.corrective_action || '').slice(0, 1000);
  const as = String(b.appeal_status || '').slice(0, 40);
  const ad = String(b.appeal_date || '').slice(0, 20);
  const an = String(b.appeal_notes || '').slice(0, 1000);
  const rn = String(b.resolution_notes || '').slice(0, 1000);
  const now = snow();
  if (db.IS_MYSQL) {
    await db.run(`INSERT INTO denial_work (user_id, claim_id, denial_code, root_cause, corrective_action, appeal_status, appeal_date, appeal_notes, resolution_notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE denial_code=VALUES(denial_code), root_cause=VALUES(root_cause), corrective_action=VALUES(corrective_action),
      appeal_status=VALUES(appeal_status), appeal_date=VALUES(appeal_date), appeal_notes=VALUES(appeal_notes), resolution_notes=VALUES(resolution_notes)`,
      [req.session.userId, c.id, c.denial_code || '', rc, ca, as, ad, an, rn, now, now]);
  } else {
    await db.run(`INSERT INTO denial_work (user_id, claim_id, denial_code, root_cause, corrective_action, appeal_status, appeal_date, appeal_notes, resolution_notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, claim_id) DO UPDATE SET denial_code=excluded.denial_code, root_cause=excluded.root_cause, corrective_action=excluded.corrective_action,
      appeal_status=excluded.appeal_status, appeal_date=excluded.appeal_date, appeal_notes=excluded.appeal_notes, resolution_notes=excluded.resolution_notes, updated_at=excluded.updated_at`,
      [req.session.userId, c.id, c.denial_code || '', rc, ca, as, ad, an, rn, now, now]);
  }
  res.json({ ok: true });
}));
app.post('/api/rcm/denials/:id/resolve', requireAuth, requireFnAction({appeal:'claims-appeal',correct:'claims-correct',writeoff:'claims-writeoff'}), ah(async (req, res) => {
  const b = req.body || {};
  const c = await db.get('SELECT * FROM claims WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!c || !['DENIED', 'APPEALED'].includes(c.status)) throw Object.assign(new Error('Denial not found.'), { status: 404 });
  const action = b.action;
  if (!['appeal', 'correct', 'writeoff'].includes(action)) throw Object.assign(new Error('Unknown action.'), { status: 400 });
  const note = String(b.note || '').trim().slice(0, 500);
  if (note) await db.run('INSERT INTO ar_notes (user_id, claim_id, note, created_at) VALUES (?,?,?,?)',
    [req.session.userId, c.id, `[denial] ${note}`, snow()]);
  try {
    if (db.IS_MYSQL) await db.run(`INSERT INTO denial_work (user_id, claim_id, denial_code, outcome, created_at, updated_at) VALUES (?,?,?,'PENDING',?,?)
      ON DUPLICATE KEY UPDATE denial_code=VALUES(denial_code), outcome='PENDING'`, [req.session.userId, c.id, c.denial_code || '', snow(), snow()]);
    else await db.run(`INSERT INTO denial_work (user_id, claim_id, denial_code, outcome, created_at, updated_at) VALUES (?,?,?,'PENDING',?,?)
      ON CONFLICT(user_id, claim_id) DO UPDATE SET denial_code=excluded.denial_code, outcome='PENDING', updated_at=excluded.updated_at`,
      [req.session.userId, c.id, c.denial_code || '', snow(), snow()]);
  } catch {}
  if (action === 'appeal') {
    await db.run("UPDATE claims SET status = 'APPEALED', follow_up = 'IN_PROGRESS' WHERE id = ?", [c.id]);
    // deterministic appeal outcome
    const win = (((c.id * 40503) >>> 0) % 100) < 60;
    if (win) {
      const a = { status: 'PAID' };
      const allowed = r2(c.billed * 0.7), pr = r2(allowed * 0.2);
      await db.run(`UPDATE claims SET status='PAID', denial_code='', allowed=?, paid=?, adjustment=?, patient_resp=? WHERE id = ?`,
        [allowed, r2(allowed - pr), r2(c.billed - allowed), pr, c.id]);
      try { await db.run(`UPDATE denial_work SET outcome='WON' WHERE user_id=? AND claim_id=?`, [req.session.userId, c.id]); } catch {}
      return res.json({ ok: true, status: 'PAID', message: 'Appeal won — payer released payment.' });
    }
    return res.json({ ok: true, status: 'APPEALED', message: 'Appeal submitted — awaiting payer decision (still denied).' });
  }
  if (action === 'correct') {
    await db.run("UPDATE claims SET status='DRAFT', validation='NOT_VALIDATED', denial_code='', follow_up='NOT_STARTED' WHERE id = ?", [c.id]);
    try { await db.run(`UPDATE denial_work SET outcome='CORRECTED' WHERE user_id=? AND claim_id=?`, [req.session.userId, c.id]); } catch {}
    return res.json({ ok: true, status: 'DRAFT', message: 'Claim returned to draft — fix and re-validate.' });
  }
  await db.run("UPDATE claims SET status='WRITTEN_OFF' WHERE id = ?", [c.id]);
  try { await db.run(`UPDATE denial_work SET outcome='WRITTEN_OFF' WHERE user_id=? AND claim_id=?`, [req.session.userId, c.id]); } catch {}
  res.json({ ok: true, status: 'WRITTEN_OFF', message: 'Balance written off.' });
}));

app.get('/api/rcm/work-queue', requireAuth, ah(async (req, res) => {
  const u = req.session.userId, items = [];
  const claims = await db.all('SELECT * FROM claims WHERE user_id = ?', [u]);
  const charges = await db.all('SELECT * FROM charges WHERE user_id = ? AND claim_id IS NULL', [u]);
  // priority score = base weight x amount factor x aging factor x denial multiplier
  const scoreOf = (priority, amount, age, isDenial) => {
    const pw = { HIGH: 3, MEDIUM: 2, LOW: 1 }[priority] || 1;
    return Math.round(pw * (1 + Math.log10(Number(amount || 0) + 1)) * (1 + (age || 0) / 30) * (isDenial ? 1.5 : 1) * 10) / 10;
  };
  for (const c of claims) {
    const age = ageDays(c);
    if (c.status === 'DRAFT' && c.validation !== 'PASSED')
      items.push({ kind: 'claim', priority: 'HIGH', title: `Validate claim ${c.claim_no}`, sub: `${c.patient_code} • ${c.payer} • $${c.billed}`, amount: c.billed, action: 'Validate →', href: '/claims', score: scoreOf('HIGH', c.billed, age, false) });
    if (c.status === 'DRAFT' && c.validation === 'PASSED')
      items.push({ kind: 'claim', priority: 'MEDIUM', title: `Submit claim ${c.claim_no}`, sub: `${c.patient_code} • ${c.payer} • $${c.billed}`, amount: c.billed, action: 'Submit →', href: '/claims', score: scoreOf('MEDIUM', c.billed, age, false) });
    if (c.status === 'DENIED')
      items.push({ kind: 'denial', priority: 'HIGH', title: `Denial ${c.denial_code} — ${c.claim_no}`, sub: `${c.patient_code} • ${c.payer} • $${c.billed} • ${age}d old`, amount: c.billed, action: 'Work denial →', href: '/denials', score: scoreOf('HIGH', c.billed, age, true) });
    if (c.status === 'SUBMITTED') {
      const bal = r2((c.allowed || c.billed) - c.paid);
      if (bal > 0) items.push({ kind: 'ar', priority: age > 30 ? 'HIGH' : 'MEDIUM', title: `A/R follow-up — ${c.claim_no}`, sub: `${ageBucket(age)} days • balance $${bal}`, amount: bal, action: 'Work A/R →', href: '/ar', score: scoreOf(age > 30 ? 'HIGH' : 'MEDIUM', bal, age, false) });
      else items.push({ kind: 'payment', priority: 'LOW', title: `Post payment — ${c.claim_no}`, sub: `${c.patient_code} • billed $${c.billed}`, amount: c.billed, action: 'Post →', href: '/payments', score: scoreOf('LOW', c.billed, age, false) });
    }
  }
  for (const ch of charges)
    items.push({ kind: 'charge', priority: 'MEDIUM', title: `Create claim — ${ch.cpt} / ${ch.icd}`, sub: `${ch.patient_code} • DOS ${ch.dos} • $${ch.amount}`, amount: ch.amount, action: 'Create claim →', href: '/charges', score: scoreOf('MEDIUM', ch.amount, 0, false) });
  const prog = await db.all(`SELECT c.code, c.points, MAX(100.0*a.score/NULLIF(a.max_score,0)) AS best, COUNT(a.id) AS n FROM cases c
    LEFT JOIN attempts a ON a.case_id = c.id AND a.user_id = ? AND a.status = 'completed' GROUP BY c.id`, [u]);
  for (const p of prog)
    if (!p.n) items.push({ kind: 'case', priority: 'LOW', title: `Start training ${p.code}`, sub: 'Not attempted yet', amount: 0, action: 'Start →', href: '/training', score: scoreOf('LOW', 0, 0, false) });
    else if ((p.best || 0) < 70) items.push({ kind: 'case', priority: 'MEDIUM', title: `Improve ${p.code} (best ${Math.round(p.best)}%)`, sub: 'Below 70% mastery', amount: 0, action: 'Retry →', href: '/training', score: scoreOf('MEDIUM', 0, 0, false) });
  items.sort((a, b) => b.score - a.score);
  res.json({ items });
}));

app.get('/api/rcm/overview', requireAuth, ah(async (req, res) => {
  const u = req.session.userId;
  const cl = await db.all('SELECT status, billed, paid, allowed FROM claims WHERE user_id = ?', [u]);
  const open = cl.filter(c => ['SUBMITTED', 'DENIED', 'APPEALED'].includes(c.status));
  const outstanding = r2(open.reduce((s, c) => s + Math.max(0, (c.allowed || c.billed) - c.paid), 0));
  res.json({
    openTasks: open.length,
    highPriority: cl.filter(c => c.status === 'DENIED').length,
    outstanding,
    denials: cl.filter(c => ['DENIED', 'APPEALED'].includes(c.status)).length,
    totalClaims: cl.length,
    collected: r2(cl.reduce((s, c) => s + c.paid, 0)),
    denialRate: cl.length ? Math.round(100 * cl.filter(c => ['DENIED', 'APPEALED'].includes(c.status)).length / cl.length) : 0,
  });
}));

app.get('/api/rcm/reports', requireAuth, ah(cached('stu-reports', 60000, async (req) => {
  const u = req.session.userId;
  const days = Math.max(0, parseInt(req.query.days, 10) || 0);
  const since = days ? (db.IS_MYSQL ? `DATE_SUB(NOW(), INTERVAL ${days} DAY)` : `datetime('now', '-${days} days')`) : null;
  const attQ = `SELECT a.*, c.code, c.title FROM attempts a JOIN cases c ON c.id = a.case_id
    WHERE a.user_id = ? AND a.status = 'completed'` + (since ? ` AND a.completed_at >= ${since}` : '') + ` ORDER BY a.id DESC`;
  const att = await db.all(attQ, [u]);
  const labs = await db.all('SELECT lab_key, MAX(score) AS best, COUNT(*) AS n FROM lab_runs WHERE user_id = ? GROUP BY lab_key', [u]);
  const cl = await db.all('SELECT * FROM claims WHERE user_id = ?', [u]);
  const validated = cl.filter(c => ['PASSED', 'FAILED'].includes(c.validation));
  const open = cl.filter(c => ['SUBMITTED', 'DENIED', 'APPEALED'].includes(c.status));
  // per-payer performance
  const payerMap = {};
  for (const c of cl) {
    const p = payerMap[c.payer] || (payerMap[c.payer] = { payer: c.payer, claims: 0, billed: 0, collected: 0, denied: 0 });
    p.claims++; p.billed = r2(p.billed + c.billed); p.collected = r2(p.collected + c.paid);
    if (['DENIED', 'APPEALED'].includes(c.status)) p.denied++;
  }
  const payers = Object.values(payerMap).map(p => ({ ...p, denialRate: p.claims ? Math.round(100 * p.denied / p.claims) : 0 }))
    .sort((a, b) => b.billed - a.billed);
  return {
    training: {
      attempts: att.length,
      avgScore: att.length ? Math.round(att.reduce((s, a) => s + (a.score / Math.max(1, a.max_score)) * 100, 0) / att.length) : 0,
      bestScore: att.length ? Math.round(Math.max(...att.map(a => (a.score / Math.max(1, a.max_score)) * 100))) : 0,
      labs: labs.map(l => ({ lab: l.lab_key, best: l.best, runs: l.n })),
    },
    rcm: {
      totalClaims: cl.length, totalBilled: r2(cl.reduce((s, c) => s + c.billed, 0)),
      collected: r2(cl.reduce((s, c) => s + c.paid, 0)),
      adjustments: r2(cl.reduce((s, c) => s + c.adjustment, 0)),
      denialRate: cl.length ? Math.round(100 * cl.filter(c => ['DENIED', 'APPEALED'].includes(c.status)).length / cl.length) : 0,
      cleanClaimRate: validated.length ? Math.round(100 * validated.filter(c => c.validation === 'PASSED').length / validated.length) : 0,
      openAR: open.length,
      avgDaysAR: open.length ? Math.round(open.reduce((s, c) => s + ageDays(c), 0) / open.length) : 0,
    },
    payers,
    recent: att.slice(0, 25).map(a => ({ code: a.code, title: a.title, score: a.score, max: a.max_score, when: a.completed_at || a.started_at })),
  };
})));


// ---------- admin API ----------
// feature catalog for per-student ON/OFF (mirrored in owner.html manage modal)
app.get('/api/admin/features', requireAdmin, ah(async (req, res) => {
  res.json({ features: FEATURES.map(([key, label, icon, desc]) => ({ key, label, icon, desc })) });
}));
// per-menu-item catalog for the Menu Control page
app.get('/api/admin/menu-items', requireAdmin, ah(async (req, res) => {
  res.json({
    items: MENU_ITEMS.map(([key, label, group, icon]) => ({ key, label, group, icon })),
    functions: FN_ITEMS.map(([key, label]) => ({ key, label })),
  });
}));
// per-student menu-item + function states (resolved: group OFF also disables its items)
app.get('/api/admin/users/:id/menu-features', requireAdmin, ah(async (req, res) => {
  const u = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Not found.' });
  const rows = await db.all('SELECT feature, enabled FROM student_features WHERE user_id = ?', [u.id]);
  const off = new Set(rows.filter(r => !r.enabled).map(r => r.feature));
  res.json({
    items: MENU_ITEMS.map(([key, label, group, icon]) => ({
      key, label, group, icon, enabled: !(off.has('menu:' + key) || off.has(group)),
    })),
    functions: FN_ITEMS.map(([key, label]) => ({
      key, label, enabled: !off.has('fn:' + key),
    })),
  });
}));
// toggle one menu item OR function for a student (upsert; plain INSERT/UPDATE — both engines)
app.post('/api/admin/users/:id/menu-features', requireAdmin, ah(async (req, res) => {
  const u = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Not found.' });
  const key = String((req.body && req.body.key) || '');
  let dbKey;
  if (key.startsWith('fn:')) {
    if (!FN_KEYS.includes(key.slice(3))) return res.status(400).json({ error: 'Invalid function.' });
    dbKey = key;
  } else {
    if (!MENU_ITEM_KEYS.includes(key)) return res.status(400).json({ error: 'Invalid menu item.' });
    dbKey = 'menu:' + key;
  }
  const en = (req.body && req.body.enabled) ? 1 : 0;
  const has = await db.get('SELECT 1 FROM student_features WHERE user_id=? AND feature=?', [u.id, dbKey]);
  if (has) await db.run('UPDATE student_features SET enabled=? WHERE user_id=? AND feature=?', [en, u.id, dbKey]);
  else await db.run('INSERT INTO student_features (user_id, feature, enabled) VALUES (?,?,?)', [u.id, dbKey, en]);
  res.json({ ok: true, key, enabled: !!en });
}));
app.get('/api/admin/overview', requireAdmin, ah(cached('overview', 30000, async (req) => ({
    users: (await db.get('SELECT COUNT(*) AS n FROM users')).n,
    students: (await db.get("SELECT COUNT(*) AS n FROM users WHERE role='student'")).n,
    cases: (await db.get('SELECT COUNT(*) AS n FROM cases WHERE active=1')).n,
    questions: (await db.get('SELECT COUNT(*) AS n FROM questions')).n,
    attempts: (await db.get('SELECT COUNT(*) AS n FROM attempts')).n,
    recentUsers: await db.all('SELECT id,name,email,role,created_at,last_login FROM users ORDER BY id DESC LIMIT 8'),
  }))));
// System health: which DB is active, where the data lives, is the config safe?
// Returns presence flags only — never secret values.
// DANGER ZONE: wipe all student practice data, keep courses + users
app.post('/api/admin/reset-data', requireAdmin, ah(async (req, res) => {
  const tables = ['answers', 'attempts', 'guided_runs', 'lab_runs', 'denial_work', 'denials',
    'ar_notes', 'payments', 'claims', 'charges', 'eligibility_checks', 'insurance', 'payers', 'patients'];
  const wiped = {};
  for (const t of tables) {
    try {
      const exists = await db.get(
        db.IS_MYSQL
          ? 'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?'
          : "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [t]);
      if (exists) {
        const r = await db.run(`DELETE FROM ${t}`);
        wiped[t] = r.changes ?? 0;
      }
    } catch (e) { wiped[t] = 'error: ' + e.message; }
  }
  bustAdminCache();
  await logActivity(req, 'admin_reset_data', JSON.stringify(wiped));
  res.json({ ok: true, wiped });
}));

app.get('/api/admin/diagnostics', requireAdmin, ah(async (req, res) => {
  const fs = require('fs');
  const { sqliteCandidates, sqliteStudentCount } = require('./lib/migrate');
  const dotenvLoad = require('./lib/dotenv-load');
  const users = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
  const students = (await db.get("SELECT COUNT(*) AS n FROM users WHERE role='student'")).n;
  const out = {
    engine: db.ENGINE,
    dbUsers: users, dbStudents: students,
    dotenvFile: dotenvLoad.found || null,
    env: {
      DATA_DIR: !!process.env.DATA_DIR,
      DB_ENGINE: !!process.env.DB_ENGINE,
      DB_HOST: !!process.env.DB_HOST,
      DB_USER: !!process.env.DB_USER,
      DB_PASS: !!process.env.DB_PASS,
      DB_NAME: !!process.env.DB_NAME,
      SESSION_SECRET: !!process.env.SESSION_SECRET,
      ADMIN_PASS: !!process.env.ADMIN_PASS,
    },
    sqlite: { active: !db.IS_MYSQL, file: db.SQLITE_FILE, insideProject: false, exists: false, sizeKB: 0, students: 0 },
    migrationSources: [],
    warnings: [],
    uptimeMin: Math.round(process.uptime() / 60),
    dbSizeKB: 0,
  };
  if (db.IS_MYSQL) {
    try {
      const r = await db.get(
        `SELECT ROUND(SUM(data_length + index_length) / 1024) AS kb
         FROM information_schema.tables WHERE table_schema = DATABASE()`);
      out.dbSizeKB = Number(r.kb) || 0;
    } catch {}
  }
  if (!db.IS_MYSQL) {
    out.sqlite.exists = fs.existsSync(db.SQLITE_FILE);
    if (out.sqlite.exists) {
      out.sqlite.sizeKB = Math.round(fs.statSync(db.SQLITE_FILE).size / 1024);
      out.sqlite.students = sqliteStudentCount(db.SQLITE_FILE);
    }
    out.sqlite.insideProject = db.SQLITE_FILE.startsWith(path.resolve(__dirname) + path.sep);
    if (out.sqlite.insideProject)
      out.warnings.push('DATABASE IS INSIDE THE PROJECT DIR — redeploys will DELETE all users/data. Set DATA_DIR outside the project.');
  }
  for (const f of sqliteCandidates()) {
    if (f === db.SQLITE_FILE || !fs.existsSync(f)) continue;
    out.migrationSources.push({ file: f, students: sqliteStudentCount(f) });
  }
  res.json(out);
}));
app.get('/api/admin/users', requireAdmin, ah(async (req, res) => {
  const cutoff = db.IS_MYSQL ? 'DATE_SUB(NOW(), INTERVAL 15 MINUTE)' : `datetime('now', '-15 minutes')`;
  res.json({ users: await db.all(
    `SELECT u.id, u.name, u.email, u.role, u.created_at, u.last_login,
       COALESCE((SELECT SUM(a.score) FROM attempts a WHERE a.user_id = u.id), 0) AS points,
       (SELECT COUNT(DISTINCT CASE WHEN a2.status = 'completed' THEN a2.case_id END) FROM attempts a2 WHERE a2.user_id = u.id) AS cases_done,
       (SELECT MAX(ts) FROM (SELECT a3.started_at AS ts FROM attempts a3 WHERE a3.user_id = u.id
         UNION ALL SELECT l.created_at FROM lab_runs l WHERE l.user_id = u.id) t) AS last_active,
       EXISTS(SELECT 1 FROM login_sessions s WHERE s.user_id = u.id AND s.last_seen >= ${cutoff}) AS online
     FROM users u ORDER BY u.id`) });
}));
// ---- ULTRA accounts: bulk ops + CSV import ----
const _validIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(n => n > 0))].slice(0, 500);
app.post('/api/admin/users/bulk-features', requireAdmin, ah(async (req, res) => {
  const ids = _validIds(req.body && req.body.ids);
  const feature = String((req.body && req.body.feature) || '');
  const enabled = (req.body && req.body.enabled) ? 1 : 0;
  if (!FEATURES.map(f => f[0]).includes(feature)) return res.status(400).json({ error: 'Invalid feature.' });
  if (!ids.length) return res.status(400).json({ error: 'No users selected.' });
  let n = 0;
  for (const id of ids) {
    const has = await db.get('SELECT 1 FROM student_features WHERE user_id=? AND feature=?', [id, feature]);
    if (has) await db.run('UPDATE student_features SET enabled=? WHERE user_id=? AND feature=?', [enabled, id, feature]);
    else await db.run('INSERT INTO student_features (user_id, feature, enabled) VALUES (?,?,?)', [id, feature, enabled]);
    n++;
  }
  logActivity(req.adminUser.id, 'feature_toggled', `bulk n=${n} key=${String((req.body||{}).feature||'').slice(0,40)}`, req);
  res.json({ ok: true, updated: n });
}));
app.post('/api/admin/users/bulk-preset', requireAdmin, ah(async (req, res) => {
  const ids = _validIds(req.body && req.body.ids);
  const preset = String((req.body && req.body.preset) || '');
  const feats = preset === 'exam'
    ? { workspace: 0, patients: 0, billing: 0, revenue: 0, training: 1, labs: 0 }
    : preset === 'full'
    ? { workspace: 1, patients: 1, billing: 1, revenue: 1, training: 1, labs: 1 }
    : null;
  if (!feats) return res.status(400).json({ error: 'Invalid preset.' });
  if (!ids.length) return res.status(400).json({ error: 'No users selected.' });
  let n = 0;
  for (const id of ids) {
    for (const [k, en] of Object.entries(feats)) {
      const has = await db.get('SELECT 1 FROM student_features WHERE user_id=? AND feature=?', [id, k]);
      if (has) await db.run('UPDATE student_features SET enabled=? WHERE user_id=? AND feature=?', [en, id, k]);
      else await db.run('INSERT INTO student_features (user_id, feature, enabled) VALUES (?,?,?)', [id, k, en]);
    }
    n++;
  }
  logActivity(req.adminUser.id, 'feature_toggled', `bulk-preset n=${n} preset=${String((req.body||{}).preset||'').slice(0,20)}`, req);
  res.json({ ok: true, updated: n });
}));
app.post('/api/admin/users/bulk-delete', requireAdmin, ah(async (req, res) => {
  const ids = _validIds(req.body && req.body.ids).filter(id => id !== req.adminUser.id);
  if (!ids.length) return res.status(400).json({ error: 'No users selected (you cannot delete yourself).' });
  let n = 0;
  for (const id of ids) { await db.run('DELETE FROM users WHERE id = ?', [id]); n++; }
  logActivity(req.adminUser.id, 'user_deleted', 'bulk n=' + n, req);
  res.json({ ok: true, deleted: n });
}));
function _parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  const push = () => { row.push(cur); cur = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') push();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; push(); if (row.some(v => v.trim() !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  push(); if (row.some(v => v.trim() !== '')) rows.push(row);
  return rows;
}
app.post('/api/admin/users/import', requireAdmin, ah(async (req, res) => {
  const text = String((req.body && req.body.csv) || '').slice(0, 200000);
  if (!text.trim()) return res.status(400).json({ error: 'Empty CSV.' });
  const rows = _parseCSV(text);
  // drop header row if it looks like one
  if (rows.length && /name/i.test(rows[0][0] || '') && /email/i.test(rows[0][1] || '')) rows.shift();
  const created = [], errors = [];
  const roles = ['student', 'instructor', 'admin'];
  for (let i = 0; i < Math.min(rows.length, 500); i++) {
    const [name = '', email = '', password = '', roleRaw = ''] = rows[i].map(v => (v || '').trim());
    const role = roles.includes(roleRaw.toLowerCase()) ? roleRaw.toLowerCase() : 'student';
    const fail = (e) => { errors.push({ row: i + 1, email: email || '(blank)', error: e }); };
    if (!name) { fail('Name required.'); continue; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { fail('Invalid email.'); continue; }
    if (password.length < 6) { fail('Password must be 6+ chars.'); continue; }
    try {
      await db.run('INSERT INTO users (name,email,pass_hash,role,created_at) VALUES (?,?,?,?,?)',
        [name.slice(0, 80), email.toLowerCase().slice(0, 120), db.hashPassword(password), role, db.now()]);
      created.push({ name, email: email.toLowerCase() });
    } catch (e) { fail('Email already exists.'); }
  }
  res.json({ ok: true, created, errors, total: rows.length });
}));
app.get('/api/admin/attempts', requireAdmin, ah(async (req, res) => {
  res.json({ attempts: await db.all(
    `SELECT a.id, a.score, a.max_score, a.status, a.started_at, a.completed_at,
            u.name AS student, c.code, c.title
     FROM attempts a JOIN users u ON u.id = a.user_id JOIN cases c ON c.id = a.case_id
     ORDER BY a.started_at DESC LIMIT 25`) });
}));
app.get('/api/admin/cases', requireAdmin, ah(async (req, res) => {
  res.json({ cases: await db.all(
    `SELECT c.id, c.code, c.title, c.difficulty, c.category, c.points,
            (SELECT COUNT(*) FROM questions q WHERE q.case_id = c.id) AS qcount,
            (SELECT COUNT(*) FROM attempts a WHERE a.case_id = c.id AND a.status='completed') AS done
     FROM cases c ORDER BY c.sort`) });
}));
app.get('/api/admin/lab-runs', requireAdmin, ah(async (req, res) => {
  res.json({ runs: await db.all(
    `SELECT l.id, l.lab_key, l.score, l.max_score, l.created_at, u.name AS uname
     FROM lab_runs l JOIN users u ON u.id = l.user_id
     ORDER BY l.id DESC LIMIT 40`) });
}));
app.post('/api/admin/users', requireAdmin, ah(async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || password.length < 6)
    return res.status(400).json({ error: 'Name, valid email and 6+ char password required.' });
  if (!['student', 'instructor', 'admin'].includes(role))
    return res.status(400).json({ error: 'Invalid role.' });
  try {
    const r = await db.run('INSERT INTO users (name,email,pass_hash,role,created_at) VALUES (?,?,?,?,?)',
      [String(name).slice(0, 80), String(email).toLowerCase().trim().slice(0, 120),
       db.hashPassword(password), role, db.now()]);
    logActivity(req.adminUser.id, 'user_created', `id=${r.id} email=${String(email).toLowerCase().trim().slice(0, 120)} role=${role}`, req);
    res.json({ ok: true, id: r.id });
  } catch (e) {
    console.error('[admin] create user failed:', e.message);
    if (/duplicate|unique|already exists/i.test(e.message))
      return res.status(409).json({ error: 'Email already exists.' });
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
}));
app.delete('/api/admin/users/:id', requireAdmin, ah(async (req, res) => {
  if (Number(req.params.id) === req.adminUser.id)
    return res.status(400).json({ error: 'Cannot delete yourself.' });
  await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
  logActivity(req.adminUser.id, 'user_deleted', 'id=' + req.params.id, req);
  res.json({ ok: true });
}));
// ---- per-student control panel ----
app.get('/api/admin/users/:id', requireAdmin, ah(async (req, res) => {
  const u = await db.get('SELECT id,name,email,role,created_at,last_login FROM users WHERE id = ?', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Not found.' });
  const id = u.id;
  const feats = await db.all('SELECT feature, enabled FROM student_features WHERE user_id = ?', [id]);
  const att = await db.get(
    `SELECT COUNT(*) AS n, COUNT(CASE WHEN status='completed' THEN 1 END) AS done,
            COALESCE(AVG(CASE WHEN status='completed' THEN 100.0*score/NULLIF(max_score,0) END),0) AS acc
     FROM attempts WHERE user_id = ?`, [id]);
  const attempts = await db.all(
    `SELECT a.id, a.status, a.score, a.max_score, a.started_at, a.completed_at, c.code, c.title
     FROM attempts a JOIN cases c ON c.id = a.case_id WHERE a.user_id = ? ORDER BY a.started_at DESC LIMIT 30`, [id]);
  const labs = await db.all('SELECT id, lab_key, score, max_score, created_at FROM lab_runs WHERE user_id = ? ORDER BY id DESC LIMIT 30', [id]);
  const rcm = await db.get(
    `SELECT (SELECT COUNT(*) FROM charges WHERE user_id=?) AS charges,
            (SELECT COUNT(*) FROM claims WHERE user_id=?) AS claims,
            (SELECT COUNT(*) FROM claims WHERE user_id=? AND status='PAID') AS paid,
            (SELECT COUNT(*) FROM claims WHERE user_id=? AND status='DENIED') AS denied,
            (SELECT COUNT(*) FROM payments WHERE user_id=?) AS payments`, [id, id, id, id, id]);
  res.json({ user: u, features: feats, stats: att, attempts, labs, rcm });
}));
app.post('/api/admin/users/:id/features', requireAdmin, ah(async (req, res) => {
  const u = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Not found.' });
  const feats = (req.body && req.body.features) || {};
  const valid = FEATURES.map(f => f[0]);
  for (const k of Object.keys(feats)) {
    if (!valid.includes(k)) return res.status(400).json({ error: 'Invalid feature: ' + k });
    const en = feats[k] ? 1 : 0;
    // upsert (both engines)
    const has = await db.get('SELECT 1 FROM student_features WHERE user_id=? AND feature=?', [u.id, k]);
    if (has) await db.run('UPDATE student_features SET enabled=? WHERE user_id=? AND feature=?', [en, u.id, k]);
    else await db.run('INSERT INTO student_features (user_id, feature, enabled) VALUES (?,?,?)', [u.id, k, en]);
  }
  res.json({ ok: true });
}));
app.post('/api/admin/users/:id/password', requireAdmin, ah(async (req, res) => {
  const u = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Not found.' });
  const pw = String((req.body && req.body.password) || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters.' });
  await db.run('UPDATE users SET pass_hash=? WHERE id=?', [db.hashPassword(pw), u.id]);
  res.json({ ok: true });
}));
// ---- session / device control ----
app.get('/api/admin/sessions', requireAdmin, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT s.id, s.session_id, s.ip, s.user_agent, s.created_at, s.last_seen,
            u.id AS user_id, u.name, u.email, u.role
     FROM login_sessions s JOIN users u ON u.id = s.user_id
     ORDER BY s.last_seen DESC LIMIT 100`);
  const cutoff = Date.now() - 15 * 60 * 1000;
  res.json({ sessions: rows.map(r => ({ ...r, online: parseDbTs(r.last_seen) > cutoff })) });
}));
app.post('/api/admin/sessions/:id/kill', requireAdmin, ah(async (req, res) => {
  const s = await db.get('SELECT * FROM login_sessions WHERE id = ?', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Not found.' });
  await new Promise(r => req.sessionStore.destroy(s.session_id, r));
  await db.run('DELETE FROM login_sessions WHERE id = ?', [s.id]);
  res.json({ ok: true });
}));

// ---- activity logs + IP blocking ----
app.get('/api/admin/activity/stats', requireAdmin, ah(async (req, res) => {
  const day = db.IS_MYSQL ? 'DATE(created_at) = CURDATE()' : "date(created_at) = date('now')";
  const d7 = db.IS_MYSQL ? 'created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)' : "created_at >= datetime('now', '-7 days')";
  const [loginsToday, failed7, ips7, blocked] = await Promise.all([
    db.get(`SELECT COUNT(*) AS n FROM activity_logs WHERE action='login' AND ${day}`),
    db.get(`SELECT COUNT(*) AS n FROM activity_logs WHERE action='login_failed' AND ${d7}`),
    db.get(`SELECT COUNT(DISTINCT ip) AS n FROM activity_logs WHERE ${d7} AND ip <> ''`),
    db.get('SELECT COUNT(*) AS n FROM ip_blocks'),
  ]);
  res.json({ loginsToday: loginsToday.n, failed7: failed7.n, ips7: ips7.n, blocked: blocked.n });
}));
app.get('/api/admin/activity', requireAdmin, ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const where = [], params = [];
  const action = String(req.query.action || '').slice(0, 64);
  if (action) { where.push('l.action = ?'); params.push(action); }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) { where.push('(u.name LIKE ? OR u.email LIKE ? OR l.ip LIKE ? OR l.detail LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const from = String(req.query.from || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('l.created_at >= ?'); params.push(from + ' 00:00:00'); }
  const to = String(req.query.to || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('l.created_at <= ?'); params.push(to + ' 23:59:59'); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await db.get(`SELECT COUNT(*) AS n FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ${w}`, params)).n;
  const rows = await db.all(
    `SELECT l.id, l.action, l.detail, l.ip, l.created_at, u.id AS user_id, u.name, u.email, u.role
     FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ${w}
     ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ rows, total, pages: Math.ceil(total / limit), page, limit });
}));
app.get('/api/admin/activity/actions', requireAdmin, ah(async (req, res) => {
  const rows = await db.all('SELECT DISTINCT action FROM activity_logs ORDER BY action');
  res.json({ actions: rows.map(r => r.action) });
}));
app.get('/api/admin/ip-blocks', requireAdmin, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT b.id, b.ip, b.reason, b.created_at, u.name AS blocked_by_name
     FROM ip_blocks b LEFT JOIN users u ON u.id = b.blocked_by ORDER BY b.id DESC`);
  res.json({ blocks: rows });
}));
app.post('/api/admin/ip-blocks', requireAdmin, ah(async (req, res) => {
  const ip = String((req.body && req.body.ip) || '').trim().slice(0, 64);
  const reason = String((req.body && req.body.reason) || '').slice(0, 300);
  if (!ip) return res.status(400).json({ error: 'IP required.' });
  if (ip === req.ip) return res.status(400).json({ error: 'You cannot block your own IP.' });
  try {
    const r = await db.run('INSERT INTO ip_blocks (ip, reason, blocked_by, created_at) VALUES (?,?,?,?)',
      [ip, reason, req.adminUser.id, db.now()]);
    clearIpBlockCache(ip);
    logActivity(req.adminUser.id, 'ip_blocked', `ip=${ip} reason=${reason.slice(0, 60)}`, req);
    res.json({ ok: true, id: r.id });
  } catch (e) { res.status(409).json({ error: 'IP already blocked.' }); }
}));
app.delete('/api/admin/ip-blocks/:id', requireAdmin, ah(async (req, res) => {
  const b = await db.get('SELECT * FROM ip_blocks WHERE id = ?', [req.params.id]);
  if (!b) return res.status(404).json({ error: 'Not found.' });
  await db.run('DELETE FROM ip_blocks WHERE id = ?', [b.id]);
  clearIpBlockCache(b.ip);
  logActivity(req.adminUser.id, 'ip_unblocked', `ip=${b.ip}`, req);
  res.json({ ok: true });
}));
// ---- announcements (ultra: schedule, targeting, pin/expire, placement, read receipts) ----
const ANN_PUBLISHED = () => {
  const n = db.now();
  return `active = 1 AND (scheduled_at IS NULL OR scheduled_at <= '${n}') AND (expires_at IS NULL OR expires_at > '${n}')`;
};
app.get('/api/admin/announcements', requireAdmin, ah(async (req, res) => {
  const anns = await db.all('SELECT * FROM announcements ORDER BY pinned DESC, id DESC LIMIT 50');
  const students = (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'student'")).n;
  for (const a of anns) {
    a.views = (await db.get('SELECT COUNT(*) AS n FROM announcement_views WHERE announcement_id = ?', [a.id])).n;
    a.students = students;
    a.published = a.active === 1 &&
      (!a.scheduled_at || a.scheduled_at <= db.now()) &&
      (!a.expires_at || a.expires_at > db.now());
  }
  res.json({ announcements: anns });
}));
app.post('/api/admin/announcements', requireAdmin, ah(async (req, res) => {
  const { title, body, scheduled_at, target, pinned, expires_at, placement } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required.' });
  // target: 'all' | 'at-risk' | [ids] (single student = [one_id])
  let tgt = 'all';
  if (target === 'at-risk') tgt = 'at-risk';
  else if (Array.isArray(target)) tgt = JSON.stringify(target.map(Number).filter(n => n > 0));
  const plc = placement === 'everywhere' ? 'everywhere' : 'home';
  const r = await db.run(
    'INSERT INTO announcements (title, body, active, created_by, created_at, scheduled_at, target, pinned, expires_at, placement) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [String(title).slice(0, 200), String(body || '').slice(0, 2000), 1, req.adminUser.id, db.now(),
     scheduled_at || null, tgt, pinned ? 1 : 0, expires_at || null, plc]);
  res.json({ ok: true, id: r.id });
}));
app.patch('/api/admin/announcements/:id', requireAdmin, ah(async (req, res) => {
  const { active, pinned } = req.body || {};
  const sets = [], vals = [];
  if (active !== undefined) { sets.push('active = ?'); vals.push(active ? 1 : 0); }
  if (pinned !== undefined) { sets.push('pinned = ?'); vals.push(pinned ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(req.params.id);
  await db.run(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`, vals);
  res.json({ ok: true });
}));
app.post('/api/admin/announcements/:id/toggle', requireAdmin, ah(async (req, res) => {
  await db.run('UPDATE announcements SET active = 1 - active WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/admin/announcements/:id', requireAdmin, ah(async (req, res) => {
  await db.run('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));
// student-facing: published + target-matched + placement-filtered
app.get('/api/announcements', requireAuth, ah(async (req, res) => {
  const uid = req.session.userId;
  const plc = req.query.placement === 'everywhere' ? null : 'home'; // default: home only
  let q = `SELECT id, title, body, pinned, target, created_at FROM announcements WHERE ${ANN_PUBLISHED()}`;
  const params = [];
  if (plc) { q += ' AND placement = ?'; params.push(plc); }
  q += ' ORDER BY pinned DESC, id DESC LIMIT 10';
  let anns = await db.all(q, params);
  // target filtering in JS (target can be 'all', 'at-risk', or JSON array incl. single [id])
  const since7 = db.IS_MYSQL ? 'DATE_SUB(NOW(), INTERVAL 7 DAY)' : `datetime('now', '-7 days')`;
  const activeIds = new Set((await db.all(
    `SELECT DISTINCT user_id AS id FROM (SELECT user_id, started_at AS ts FROM attempts UNION ALL SELECT user_id, created_at FROM lab_runs) t WHERE ts >= ${since7}`
  )).map(r => r.id));
  const uidN = Number(uid);
  anns = anns.filter(a => {
    const t = a.target || 'all';
    if (t === 'all') return true;
    if (t === 'at-risk') return !activeIds.has(uidN);
    try { const ids = JSON.parse(t); return Array.isArray(ids) && ids.map(Number).includes(uidN); }
    catch { return true; }
  });
  res.json({ announcements: anns });
}));
// read receipt (fire-and-forget from student dashboard)
app.post('/api/announcements/:id/view', requireAuth, ah(async (req, res) => {
  await db.insertIgnore('announcement_views', ['announcement_id', 'user_id', 'viewed_at'],
    [Number(req.params.id), req.session.userId, db.now()]);
  res.json({ ok: true });
}));
app.get('/api/leaderboard', requireAuth, ah(async (req, res) => {
  const top = await db.all(
    `SELECT u.id, u.name, COALESCE(SUM(a.score),0) AS points,
            COUNT(DISTINCT CASE WHEN a.status='completed' THEN a.case_id END) AS cases_done
     FROM users u LEFT JOIN attempts a ON a.user_id = u.id
     WHERE u.role = 'student' GROUP BY u.id ORDER BY points DESC LIMIT 10`);
  res.json({ top });
}));
// ---- ULTRA analytics: at-risk, funnel, question difficulty, time heatmap, AI insights ----

app.get('/api/admin/insights', requireAdmin, ah(cached('insights', 60000, async (req) => {
  const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 30));
  const since = db.IS_MYSQL
    ? `DATE_SUB(NOW(), INTERVAL ${days} DAY)`
    : `datetime('now', '-${days} days')`;
  const dayFn = db.IS_MYSQL ? 'DAYOFWEEK(started_at)' : `CAST(strftime('%w', started_at) AS INTEGER)`;
  const hrFn = db.IS_MYSQL ? 'HOUR(started_at)' : `CAST(strftime('%H', started_at) AS INTEGER)`;

  // ---- at-risk students ----
  const students = await db.all("SELECT id, name, email FROM users WHERE role='student' ORDER BY name");
  const lastAct = await db.all(
    `SELECT user_id, MAX(ts) AS last_ts FROM (
       SELECT user_id, started_at AS ts FROM attempts
       UNION ALL SELECT user_id, created_at AS ts FROM lab_runs
     ) t GROUP BY user_id`);
  const lastMap = Object.fromEntries(lastAct.map(r => [r.user_id, r.last_ts]));
  const recentScores = await db.all(
    `SELECT user_id, score * 100.0 / NULLIF(max_score, 0) AS pct, completed_at
     FROM attempts WHERE status='completed' AND completed_at >= ${since} ORDER BY completed_at`);
  const scoreMap = {};
  for (const r of recentScores) (scoreMap[r.user_id] ||= []).push(r.pct);
  const stuckCases = await db.all(
    `SELECT user_id, case_id, COUNT(*) AS n FROM attempts
     WHERE status != 'completed' AND started_at >= ${since} GROUP BY user_id, case_id HAVING n >= 2`);
  const stuckMap = {};
  for (const r of stuckCases) (stuckMap[r.user_id] ||= []).push(r.case_id);
  const caseCodes = Object.fromEntries((await db.all('SELECT id, code FROM cases')).map(c => [c.id, c.code]));
  const atRisk = [];
  const nowMs = Date.now();
  for (const st of students) {
    const reasons = [];
    const lt = lastMap[st.id];
    const inactiveDays = lt ? Math.floor((nowMs - parseDbTs(lt)) / 864e5) : 999;
    if (inactiveDays >= 7) reasons.push({ kind: 'inactive', label: `Inactive ${inactiveDays >= 999 ? '— never active' : inactiveDays + 'd'}` });
    const sc = scoreMap[st.id] || [];
    if (sc.length >= 4) {
      const first = sc.slice(0, Math.ceil(sc.length / 2)), last = sc.slice(Math.ceil(sc.length / 2));
      const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
      if (avg(first) - avg(last) >= 15) reasons.push({ kind: 'declining', label: `Scores dropping (${Math.round(avg(first))}% → ${Math.round(avg(last))}%)` });
    }
    if (stuckMap[st.id]) reasons.push({ kind: 'stuck', label: `Stuck on ${(stuckMap[st.id] || []).map(id => caseCodes[id]).filter(Boolean).join(', ')}` });
    if (reasons.length) atRisk.push({ id: st.id, name: st.name, email: st.email, reasons });
  }

  // ---- funnel: started vs completed per case ----
  const funnel = await db.all(
    `SELECT c.code, c.title,
       COUNT(DISTINCT CASE WHEN a.started_at >= ${since} THEN a.user_id END) AS started,
       COUNT(DISTINCT CASE WHEN a.status='completed' AND a.completed_at >= ${since} THEN a.user_id END) AS completed
     FROM cases c LEFT JOIN attempts a ON a.case_id = c.id
     WHERE c.active = 1 GROUP BY c.id ORDER BY c.sort`);

  // ---- hardest questions ----
  const hardQ = await db.all(
    `SELECT c.code AS case_code, q.qnum, SUBSTR(q.prompt, 1, 80) AS prompt,
       COUNT(*) AS tries, SUM(CASE WHEN an.correct = 0 THEN 1 ELSE 0 END) AS fails,
       100.0 * SUM(CASE WHEN an.correct = 0 THEN 1 ELSE 0 END) / COUNT(*) AS failPct
     FROM answers an JOIN questions q ON q.id = an.question_id
     JOIN cases c ON c.id = q.case_id
     WHERE an.answered_at >= ${since}
     GROUP BY an.question_id HAVING tries >= 2
     ORDER BY failPct DESC LIMIT 10`);

  // ---- study-time heatmap (day of week x hour) ----
  const acts = await db.all(`SELECT ${dayFn} AS d, ${hrFn} AS h, COUNT(*) AS n FROM attempts WHERE started_at >= ${since} GROUP BY d, h`);
  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of acts) {
    const di = db.IS_MYSQL ? (Number(r.d) + 6) % 7 : Number(r.d); // normalize to Mon=0
    if (di >= 0 && di < 7 && r.h >= 0 && r.h < 24) matrix[di][Number(r.h)] = Number(r.n);
  }

  // ---- AI insight lines ----
  const insights = [];
  if (atRisk.length) insights.push({ icon: '⚠️', text: `${atRisk.length} student${atRisk.length > 1 ? 's' : ''} need${atRisk.length > 1 ? '' : 's'} attention right now — ${atRisk.slice(0, 2).map(r => r.name.split(' ')[0]).join(', ')}${atRisk.length > 2 ? ` +${atRisk.length - 2} more` : ''}` });
  const worstFunnel = funnel.map(f => ({ ...f, started: Number(f.started), completed: Number(f.completed) })).filter(f => f.started > 0).sort((a, b) => (a.completed / a.started) - (b.completed / b.started))[0];
  if (worstFunnel && worstFunnel.started >= 2) {
    const drop = Math.round(100 * (1 - worstFunnel.completed / worstFunnel.started));
    if (drop > 0) insights.push({ icon: '📉', text: `Biggest drop-off: ${worstFunnel.code} — ${drop}% started but didn't finish` });
  }
  if (hardQ.length) {
    const q = hardQ[0], fr = Math.round(100 * q.fails / q.tries);
    insights.push({ icon: '🎯', text: `${q.case_code} Q${q.qnum} fails ${fr}% of the time (${q.tries} tries) — review this question` });
  }
  let peakD = 0, peakH = 0, peakN = 0;
  matrix.forEach((row, d) => row.forEach((n, h) => { if (n > peakN) { peakN = n; peakD = d; peakH = h; } }));
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (peakN > 0) insights.push({ icon: '🕐', text: `Peak study time: ${dayNames[peakD]}s around ${peakH}:00 — schedule announcements then` });
  const totalStarted = funnel.reduce((x, f) => x + Number(f.started), 0);
  const totalDone = funnel.reduce((x, f) => x + Number(f.completed), 0);
  if (totalStarted > 0) insights.push({ icon: '📊', text: `Completion rate: ${Math.round(100 * totalDone / totalStarted)}% across ${funnel.length} cases in the last ${days} days` });
  if (!insights.length) insights.push({ icon: '✨', text: 'Not enough activity yet — insights appear once students start training' });

  return { days, atRisk, funnel, hardQuestions: hardQ, timeHeatmap: matrix, insights };
})));

// ---- student sync: you-vs-class, rank, streak, nudges, weekly digest ----
app.get('/api/student-insights', requireAuth, ah(async (req, res) => {
  const uid = req.session.userId;
  const since7 = db.IS_MYSQL ? 'DATE_SUB(NOW(), INTERVAL 7 DAY)' : `datetime('now', '-7 days')`;

  // rank by total points
  const board = await db.all(
    `SELECT u.id, COALESCE(SUM(a.score), 0) AS points FROM users u
     LEFT JOIN attempts a ON a.user_id = u.id
     WHERE u.role = 'student' GROUP BY u.id ORDER BY points DESC`);
  const rank = board.findIndex(r => r.id === uid) + 1;
  const myPoints = (board.find(r => r.id === uid) || {}).points || 0;

  // streak: consecutive days with any activity
  const dayRows = await db.all(
    `SELECT DISTINCT DATE(ts) AS d FROM (
       SELECT started_at AS ts FROM attempts WHERE user_id = ?
       UNION ALL SELECT created_at FROM lab_runs WHERE user_id = ?
     ) t ORDER BY d DESC`, [uid, uid]);
  let streak = 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  let cursor = new Date(todayStr + 'T12:00:00Z');
  const daySet = new Set(dayRows.map(r => String(r.d).slice(0, 10)));
  if (!daySet.has(todayStr)) cursor.setUTCDate(cursor.getUTCDate() - 1); // allow today missing
  while (daySet.has(cursor.toISOString().slice(0, 10))) { streak++; cursor.setUTCDate(cursor.getUTCDate() - 1); }

  // you vs class
  const mine = await db.get(
    `SELECT COUNT(DISTINCT CASE WHEN status='completed' THEN case_id END) AS cases_done,
       AVG(CASE WHEN status='completed' THEN score * 100.0 / NULLIF(max_score, 0) END) AS acc
     FROM attempts WHERE user_id = ?`, [uid]);
  const cls = await db.get(
    `SELECT AVG(cases_done) AS avg_cases, AVG(acc) AS avg_acc FROM (
       SELECT user_id, COUNT(DISTINCT CASE WHEN status='completed' THEN case_id END) AS cases_done,
         AVG(CASE WHEN status='completed' THEN score * 100.0 / NULLIF(max_score, 0) END) AS acc
       FROM attempts GROUP BY user_id) t`);

  // weakest category
  const weak = await db.all(
    `SELECT c.category, AVG(a.score * 100.0 / NULLIF(a.max_score, 0)) AS acc
     FROM attempts a JOIN cases c ON c.id = a.case_id
     WHERE a.user_id = ? AND a.status = 'completed' GROUP BY c.category ORDER BY acc ASC LIMIT 1`, [uid]);

  // nudges
  const nudges = [];
  const myAcc = Math.round(mine.acc || 0), classAcc = Math.round(cls.avg_acc || 0);
  if (myAcc < classAcc - 5) nudges.push({ icon: '📈', text: `Your accuracy (${myAcc}%) trails the class (${classAcc}%) — hit the Practice Lab` });
  if (weak.length && weak[0].acc != null) nudges.push({ icon: '🎯', text: `Weakest area: ${weak[0].category} (${Math.round(weak[0].acc)}%) — focus here this week` });
  if (streak >= 3) nudges.push({ icon: '🔥', text: `${streak}-day streak! Keep it alive` });
  else if (streak === 0) nudges.push({ icon: '💪', text: 'Start a streak today — even one case counts' });
  if (rank > 0 && rank <= 3) nudges.push({ icon: '🏆', text: `You're #${rank} on the leaderboard — defend it!` });

  // weekly digest
  const wk = await db.get(
    `SELECT COUNT(*) AS attempts, COALESCE(SUM(score), 0) AS points,
       AVG(CASE WHEN status='completed' THEN score * 100.0 / NULLIF(max_score, 0) END) AS acc
     FROM attempts WHERE user_id = ? AND started_at >= ${since7}`, [uid]);
  const bestWk = await db.all(
    `SELECT c.code, MAX(a.score * 100.0 / NULLIF(a.max_score, 0)) AS pct
     FROM attempts a JOIN cases c ON c.id = a.case_id
     WHERE a.user_id = ? AND a.status = 'completed' AND a.completed_at >= ${since7}
     GROUP BY a.case_id ORDER BY pct DESC LIMIT 1`, [uid]);

  res.json({
    rank, totalStudents: board.length, streak, points: myPoints, level: db.levelFor(myPoints),
    vsClass: [
      { label: 'Accuracy', you: myAcc, avg: classAcc, suffix: '%' },
      { label: 'Cases done', you: mine.cases_done || 0, avg: Math.round((cls.avg_cases || 0) * 10) / 10, suffix: '' },
      { label: 'Points', you: myPoints, avg: Math.round(board.reduce((x, r) => x + Number(r.points), 0) / Math.max(1, board.length)), suffix: '' },
    ],
    nudges,
    weekly: {
      attempts: wk.attempts || 0, points: wk.points || 0, accuracy: Math.round(wk.acc || 0),
      bestCase: bestWk.length ? `${bestWk[0].code} (${Math.round(bestWk[0].pct)}%)` : '—',
    },
  });
}));

// ---- analytics: skill-gap heatmap + exam readiness ----
// ---- ULTRA analytics: trends, radar, improvers, distribution, predictions, compare ----
app.get('/api/admin/trends', requireAdmin, ah(cached('trends', 60000, async (req) => {
  const students = await db.all("SELECT id, name FROM users WHERE role='student' ORDER BY name");
  const cases = await db.all('SELECT id, code, title, category FROM cases WHERE active=1 ORDER BY sort');
  const totalCases = cases.length || 1;
  const catList = [...new Set(cases.map(c => c.category))];
  const attempts = await db.all(
    `SELECT user_id, case_id, score, max_score, completed_at FROM attempts
     WHERE status='completed' AND completed_at IS NOT NULL`);
  const labs = await db.all('SELECT user_id, created_at FROM lab_runs');
  const labByUser = {};
  for (const l of labs) (labByUser[l.user_id] ||= []).push(l.created_at);
  const attByUser = {};
  for (const a of attempts) (attByUser[a.user_id] ||= []).push(a);
  const pct = a => a.max_score > 0 ? 100 * a.score / a.max_score : 0;
  const ts = v => new Date(String(v).replace(' ', 'T') + 'Z').getTime();

  // readiness for a set of attempts + lab count (mirrors heatmap formula)
  const readinessOf = (atts, labCount) => {
    const doneCases = new Set(atts.map(a => a.case_id)).size;
    const avg = atts.length ? atts.reduce((x, a) => x + pct(a), 0) / atts.length : 0;
    return Math.round(50 * doneCases / totalCases + 0.3 * avg + 20 * Math.min(10, labCount) / 10);
  };

  // 1. weekly readiness trend — last 8 weeks, cumulative up to each week end
  const now = Date.now(), WEEK = 7 * 864e5;
  const weekStart = now - 8 * WEEK;
  const weeklyTrend = [];
  for (let w = 0; w < 8; w++) {
    const end = weekStart + (w + 1) * WEEK;
    let sum = 0, n = 0;
    for (const st of students) {
      const atts = (attByUser[st.id] || []).filter(a => ts(a.completed_at) <= end);
      const labN = (labByUser[st.id] || []).filter(t => ts(t) <= end).length;
      if (atts.length || labN) { sum += readinessOf(atts, labN); n++; }
    }
    const d = new Date(weekStart + w * WEEK);
    weeklyTrend.push({ week: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), readiness: n ? Math.round(sum / n) : 0 });
  }

  // 2. category mastery (class average best-score % per category)
  const bestByUC = {};
  for (const a of attempts) {
    const k = a.user_id + ':' + a.case_id, p = pct(a);
    if (!bestByUC[k] || p > bestByUC[k]) bestByUC[k] = p;
  }
  const caseCat = Object.fromEntries(cases.map(c => [c.id, c.category]));
  const catAcc = {};
  for (const k in bestByUC) {
    const cid = Number(k.split(':')[1]), cat = caseCat[cid];
    if (!cat) continue;
    (catAcc[cat] ||= []).push(bestByUC[k]);
  }
  const categoryMastery = catList.map(c => ({
    category: c, avg: catAcc[c] ? Math.round(catAcc[c].reduce((x, y) => x + y, 0) / catAcc[c].length) : 0,
  }));

  // 3. top improvers — last 30 days, second-half avg minus first-half avg
  const since30 = now - 30 * 864e5;
  const improvers = [];
  for (const st of students) {
    const recent = (attByUser[st.id] || []).filter(a => ts(a.completed_at) >= since30)
      .sort((a, b) => ts(a.completed_at) - ts(b.completed_at));
    if (recent.length >= 4) {
      const half = Math.floor(recent.length / 2);
      const avg = arr => arr.reduce((x, a) => x + pct(a), 0) / arr.length;
      const gain = avg(recent.slice(half)) - avg(recent.slice(0, half));
      if (gain > 0) improvers.push({ id: st.id, name: st.name, gain: Math.round(gain * 10) / 10, tries: recent.length });
    }
  }
  improvers.sort((a, b) => b.gain - a.gain);

  // 4. score distribution per case (best % buckets)
  const dist = cases.map(c => {
    const buckets = [0, 0, 0, 0];
    for (const st of students) {
      const b = bestByUC[st.id + ':' + c.id];
      if (b == null) continue;
      buckets[b < 50 ? 0 : b < 70 ? 1 : b < 85 ? 2 : 3]++;
    }
    return { code: c.code, buckets };
  });

  // 5. predicted ready date — velocity = points per active day, target 500
  const daySetByUser = {};
  for (const a of attempts) {
    const d = String(a.completed_at).slice(0, 10);
    ((daySetByUser[a.user_id] ||= new Set())).add(d);
  }
  for (const l of labs) {
    const d = String(l.created_at).slice(0, 10);
    ((daySetByUser[l.user_id] ||= new Set())).add(d);
  }
  const pointsByUser = {};
  for (const a of attempts) pointsByUser[a.user_id] = (pointsByUser[a.user_id] || 0) + a.score;
  const predictions = students.map(st => {
    const pts = pointsByUser[st.id] || 0;
    const activeDays = (daySetByUser[st.id] || new Set()).size;
    const vel = activeDays > 0 ? pts / activeDays : 0;
    let readyDate = null, status = 'no-data';
    if (pts >= 500) { status = 'achieved'; }
    else if (vel > 0) {
      const daysLeft = Math.ceil((500 - pts) / vel);
      readyDate = new Date(now + daysLeft * 864e5).toISOString().slice(0, 10);
      status = daysLeft <= 90 ? 'on-track' : 'slow';
    }
    return { id: st.id, name: st.name, points: pts, velocity: Math.round(vel * 10) / 10, readyDate, status };
  }).sort((a, b) => b.points - a.points);

  // 6. per-student stats for compare mode
  const studentStats = students.map(st => {
    const atts = attByUser[st.id] || [];
    return {
      id: st.id, name: st.name,
      points: pointsByUser[st.id] || 0,
      accuracy: atts.length ? Math.round(atts.reduce((x, a) => x + pct(a), 0) / atts.length) : 0,
      casesDone: new Set(atts.map(a => a.case_id)).size,
      attempts: atts.length,
      activeDays: (daySetByUser[st.id] || new Set()).size,
      readiness: readinessOf(atts, (labByUser[st.id] || []).length),
    };
  });

  return ({ weeklyTrend, categoryMastery, improvers: improvers.slice(0, 5), distribution: dist, predictions, studentStats });
})));

app.get('/api/admin/heatmap', requireAdmin, ah(async (req, res) => {
  const students = await db.all("SELECT id, name FROM users WHERE role = 'student' ORDER BY name");
  const cases = await db.all('SELECT id, code, title FROM cases WHERE active = 1 ORDER BY sort');
  const best = await db.all(
    `SELECT user_id, case_id, MAX(100.0 * score / NULLIF(max_score, 0)) AS pct, COUNT(*) AS tries
     FROM attempts WHERE status = 'completed' GROUP BY user_id, case_id`);
  const matrix = {};
  for (const r of best) (matrix[r.user_id] ||= {})[r.case_id] = { pct: Math.round(r.pct), tries: r.tries };
  const labCounts = await db.all('SELECT user_id, COUNT(*) AS n FROM lab_runs GROUP BY user_id');
  const labMap = Object.fromEntries(labCounts.map(r => [r.user_id, r.n]));
  const readiness = students.map(s => {
    let done = 0, sum = 0;
    for (const c of cases) { const m = (matrix[s.id] || {})[c.id]; if (m) { done++; sum += m.pct; } }
    const avg = done ? sum / done : 0;
    const labs = Math.min(labMap[s.id] || 0, 10) / 10;
    const score = Math.round((cases.length ? (done / cases.length) * 50 : 0) + avg * 0.3 + labs * 20);
    return { id: s.id, name: s.name, done, total: cases.length, avg: Math.round(avg), labs: labMap[s.id] || 0, readiness: Math.min(score, 100) };
  });
  res.json({ students, cases, matrix, readiness });
}));
// ---- CSV export ----
function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
app.get('/api/admin/export/attempts', requireAdmin, ah(async (req, res) => {
  const rows = await db.all(
    `SELECT u.name AS student, u.email, c.code, c.title, a.score, a.max_score, a.status, a.started_at, a.completed_at
     FROM attempts a JOIN users u ON u.id = a.user_id JOIN cases c ON c.id = a.case_id ORDER BY a.started_at DESC`);
  const csv = 'Student,Email,Case,Title,Score,Max,Status,Started,Completed\n' +
    rows.map(r => [r.student, r.email, r.code, r.title, r.score, r.max_score, r.status, r.started_at, r.completed_at].map(csvCell).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="attempts.csv"');
  res.send(csv);
}));
app.get('/api/admin/export/users', requireAdmin, ah(async (req, res) => {
  const rows = await db.all('SELECT name, email, role, created_at, last_login FROM users ORDER BY id');
  const csv = 'Name,Email,Role,Created,Last Login\n' +
    rows.map(r => [r.name, r.email, r.role, r.created_at, r.last_login].map(csvCell).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
  res.send(csv);
}));
// ---- answer-level review for an attempt ----
app.get('/api/admin/attempts/:id/answers', requireAdmin, ah(async (req, res) => {
  const a = await db.get(
    `SELECT a.id, a.score, a.max_score, a.status, u.name AS student, c.code
     FROM attempts a JOIN users u ON u.id = a.user_id JOIN cases c ON c.id = a.case_id WHERE a.id = ?`, [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Not found.' });
  const rows = await db.all(
    `SELECT q.qnum, q.question, q.options, q.correct_idx, an.chosen_idx, an.correct, an.points_earned
     FROM answers an JOIN questions q ON q.id = an.question_id WHERE an.attempt_id = ? ORDER BY q.qnum`, [a.id]);
  res.json({ attempt: a, answers: rows.map(r => {
    let opts = []; try { opts = JSON.parse(r.options); } catch {}
    return { qnum: r.qnum, question: r.question, options: opts, correct_idx: r.correct_idx,
             chosen_idx: r.chosen_idx, correct: !!r.correct, points_earned: r.points_earned };
  }) });
}));

// ---------- 404 + errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  const s = err.status && Number.isInteger(err.status) ? err.status : 500;
  const out = { error: s === 500 ? 'Server error.' : err.message };
  for (const k of ['duplicates', 'featureDisabled']) if (err[k] !== undefined) out[k] = err[k];
  res.status(s).json(out);
});

async function main() {
  await db.initDb(); // auto-migration + seed
  // one-time SQLite -> MySQL data migration (only when MySQL is fresh)
  try { await require('./lib/migrate').maybeAutoMigrate(db); }
  catch (e) { console.error('[migrate] skipped:', e.message); }
  // ---- boot diagnostics: where does the data live, and is it safe? ----
  try {
    const uc = await db.get('SELECT COUNT(*) AS n FROM users');
    console.log(`[db] engine=${db.ENGINE} users=${uc.n}`);
    if (!db.IS_MYSQL) {
      console.log(`[db] sqlite file: ${db.SQLITE_FILE}`);
      const proj = path.resolve(__dirname);
      if (db.SQLITE_FILE.startsWith(proj + path.sep))
        console.log('[warn] DATABASE IS INSIDE THE PROJECT DIR — GitHub redeploys WILL DELETE all users/data! Set DATA_DIR to a folder OUTSIDE the project (e.g. /home/<site>/rcm-data).');
    }
  } catch (e) { console.error('[db] diagnostics failed:', e.message); }
  app.listen(PORT, () => {
    console.log(`RCM Academy listening on :${PORT} (engine=${db.ENGINE})`);
    if (!process.env.SESSION_SECRET) console.log('[warn] SESSION_SECRET not set — using dev default');
  });
}
main().catch((e) => { console.error('[fatal] DB init failed:', e.message); process.exit(1); });
