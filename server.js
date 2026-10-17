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
  if (p === '/api/dashboard' || p.startsWith('/api/rcm/overview') || p.startsWith('/api/rcm/work-queue') || p.startsWith('/api/rcm/demo')) return 'workspace';
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
  ['demo', 'Load Demo Data'],
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
  if (p.startsWith('/api/rcm/work-queue') || p.startsWith('/api/rcm/demo')) return 'workqueue';
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
  return { points, level: db.levelFor(points),
    casesCompleted: done.c || 0, totalCases: total,
    accuracy: Math.round((att.acc || 0) * 10) / 10, attempts: att.n || 0 };
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
app.get('/api/dashboard', requireAuth, ah(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  const recent = await db.all(
    `SELECT a.id, a.score, a.max_score, a.completed_at, c.code, c.title
     FROM attempts a JOIN cases c ON c.id = a.case_id
     WHERE a.user_id = ? AND a.status = 'completed'
     ORDER BY a.completed_at DESC LIMIT 5`, [u.id]);
  res.json({ user: pub(u), stats: await userStats(u.id), recent });
}));

app.get('/api/cases', requireAuth, ah(async (req, res) => {
  const cases = await db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM questions q WHERE q.case_id = c.id) AS qcount
     FROM cases c WHERE c.active = 1 ORDER BY c.sort`);
  const prog = await db.all(
    `SELECT case_id, COUNT(*) AS attempts, MAX(score) AS best, SUM(status='completed') AS done
     FROM attempts WHERE user_id = ? GROUP BY case_id`, [req.session.userId]);
  const pm = Object.fromEntries(prog.map(p => [p.case_id, p]));
  res.json({ cases: cases.map(c => ({
    id: c.id, code: c.code, title: c.title, description: c.description,
    difficulty: c.difficulty, category: c.category, points: c.points,
    questions: c.qcount, attempts: pm[c.id]?.attempts || 0,
    best: pm[c.id]?.best ?? null, completed: (pm[c.id]?.done || 0) > 0,
  })) });
}));

app.get('/api/cases/:id', requireAuth, ah(async (req, res) => {
  const c = await db.get('SELECT * FROM cases WHERE id = ? AND active = 1', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  const qs = await db.all('SELECT * FROM questions WHERE case_id = ? ORDER BY qnum', [c.id]);
  res.json({ id: c.id, code: c.code, title: c.title, description: c.description,
    difficulty: c.difficulty, category: c.category, points: c.points,
    questions: qs.map(stripQ) });
}));

app.post('/api/attempts', requireAuth, ah(async (req, res) => {
  const c = await db.get('SELECT * FROM cases WHERE id = ? AND active = 1', [req.body?.caseId]);
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
    patients: await db.all('SELECT code,name,dob,gender,phone,status FROM patients ORDER BY code') });
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

const QUIZ_MODES = ['timed', 'weakest', 'missed', 'mix', 'sprint'];
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
    qs = ids.length ? await db.all(`SELECT q.id, q.qnum, q.prompt, q.options, q.hint, c.code AS caseCode
      FROM questions q JOIN cases c ON c.id = q.case_id WHERE q.id IN (${ids.map(() => '?').join(',')})`, ids) : [];
  } else if (mode === 'weakest') {
    const prog = await db.all(`SELECT c.id, c.points,
        COALESCE(MAX(CASE WHEN at.status='completed' THEN at.score END), 0) AS best
      FROM cases c LEFT JOIN attempts at ON at.case_id = c.id AND at.user_id = ?
      WHERE c.active = 1 GROUP BY c.id`, [uid]);
    prog.sort((a, b) => (a.best / a.points) - (b.best / b.points));
    const ids = prog.slice(0, 2).map(p => p.id);
    qs = ids.length ? await db.all(`SELECT q.id, q.qnum, q.prompt, q.options, q.hint, c.code AS caseCode
      FROM questions q JOIN cases c ON c.id = q.case_id WHERE q.case_id IN (${ids.map(() => '?').join(',')})
      ORDER BY ${RF} LIMIT ${n}`, ids) : [];
  } else {
    qs = await db.all(`SELECT q.id, q.qnum, q.prompt, q.options, q.hint, c.code AS caseCode
      FROM questions q JOIN cases c ON c.id = q.case_id WHERE c.active = 1
      ORDER BY ${RF} LIMIT ${n}`);
  }
  if (!qs.length) return res.json({ mode, questions: [], note: 'No questions available for this mode yet.' });
  res.json({ mode, questions: qs.map(q => ({ id: q.id, caseCode: q.caseCode, qnum: q.qnum,
    prompt: q.prompt, options: JSON.parse(q.options), hint: q.hint })) });
}));

app.post('/api/labs/quiz/submit', requireAuth, requireFn('lab-run'), ah(async (req, res) => {
  const mode = QUIZ_MODES.includes(req.body.mode) ? req.body.mode : 'mix';
  const answers = Array.isArray(req.body.answers) ? req.body.answers.slice(0, 30) : [];
  if (!answers.length) return res.status(400).json({ error: 'No answers submitted.' });
  const ids = answers.map(a => parseInt(a.questionId, 10)).filter(Number.isInteger);
  const rows = await db.all(`SELECT id, answer_idx, points, explanation FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  let score = 0, max = 0;
  const feedback = answers.map(a => {
    const q = byId[a.questionId];
    if (!q) return null;
    const correct = parseInt(a.chosen, 10) === q.answer_idx;
    if (correct) score += q.points;
    max += q.points;
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
  res.json({ patients: await db.all('SELECT code, name, dob, gender, phone FROM patients ORDER BY code') });
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

app.get('/api/rcm/eligibility', requireAuth, ah(async (req, res) => {
  res.json({ checks: await db.all('SELECT * FROM eligibility_checks WHERE user_id = ? ORDER BY id DESC LIMIT 100', [req.session.userId]) });
}));
app.post('/api/rcm/eligibility/verify', requireAuth, requireFn('eligibility-verify'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.patient_code || !b.payer) throw Object.assign(new Error('Patient and payer are required.'), { status: 400 });
  const cov = await db.get('SELECT * FROM insurance WHERE (user_id IS NULL OR user_id = ?) AND patient_code = ? AND payer = ? ORDER BY user_id DESC LIMIT 1',
    [req.session.userId, b.patient_code, b.payer]);
  const active = !!(cov && cov.status === 'ACTIVE');
  const copay = active ? r2(cov.copay) : 0;
  const deductible = active ? [500, 1000, 1500, 2000][String(cov.member_id).length % 4] : 0;
  const result = active ? 'VERIFIED' : 'INACTIVE';
  const r = await db.run(`INSERT INTO eligibility_checks (user_id, patient_code, payer, service, coverage, copay, deductible, result, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, [req.session.userId, b.patient_code, b.payer, b.service || 'Office Visit',
    active ? 'ACTIVE' : 'INACTIVE', copay, deductible, result, snow()]);
  res.json({ id: r.id, coverage: active ? 'ACTIVE' : 'INACTIVE', copay, deductible, result });
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
  await db.run('UPDATE claims SET validation = ? WHERE id = ?', [validation, c.id]);
  res.json({ validation, errors: r.errors, warnings: r.warnings, score: r.score });
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
  res.json({ payments: await db.all(`SELECT p.*, c.claim_no FROM payments p JOIN claims c ON c.id = p.claim_id
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
  await db.run('INSERT INTO ar_notes (user_id, claim_id, note, created_at) VALUES (?,?,?,?)',
    [req.session.userId, c.id, String(b.note).trim().slice(0, 500), snow()]);
  await db.run("UPDATE claims SET follow_up = 'IN_PROGRESS' WHERE id = ? AND follow_up = 'NOT_STARTED'", [c.id]);
  res.json({ ok: true });
}));

app.get('/api/rcm/denials', requireAuth, ah(async (req, res) => {
  res.json({ denials: await db.all(`SELECT * FROM claims WHERE user_id = ? AND status IN ('DENIED','APPEALED') ORDER BY id DESC`, [req.session.userId]) });
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
  if (action === 'appeal') {
    await db.run("UPDATE claims SET status = 'APPEALED', follow_up = 'IN_PROGRESS' WHERE id = ?", [c.id]);
    // deterministic appeal outcome
    const win = (((c.id * 40503) >>> 0) % 100) < 60;
    if (win) {
      const a = { status: 'PAID' };
      const allowed = r2(c.billed * 0.7), pr = r2(allowed * 0.2);
      await db.run(`UPDATE claims SET status='PAID', denial_code='', allowed=?, paid=?, adjustment=?, patient_resp=? WHERE id = ?`,
        [allowed, r2(allowed - pr), r2(c.billed - allowed), pr, c.id]);
      return res.json({ ok: true, status: 'PAID', message: 'Appeal won — payer released payment.' });
    }
    return res.json({ ok: true, status: 'APPEALED', message: 'Appeal submitted — awaiting payer decision (still denied).' });
  }
  if (action === 'correct') {
    await db.run("UPDATE claims SET status='DRAFT', validation='NOT_VALIDATED', denial_code='', follow_up='NOT_STARTED' WHERE id = ?", [c.id]);
    return res.json({ ok: true, status: 'DRAFT', message: 'Claim returned to draft — fix and re-validate.' });
  }
  await db.run("UPDATE claims SET status='WRITTEN_OFF' WHERE id = ?", [c.id]);
  res.json({ ok: true, status: 'WRITTEN_OFF', message: 'Balance written off.' });
}));

app.get('/api/rcm/work-queue', requireAuth, ah(async (req, res) => {
  const u = req.session.userId, items = [];
  const claims = await db.all('SELECT * FROM claims WHERE user_id = ?', [u]);
  const charges = await db.all('SELECT * FROM charges WHERE user_id = ? AND claim_id IS NULL', [u]);
  for (const c of claims) {
    if (c.status === 'DRAFT' && c.validation !== 'PASSED')
      items.push({ kind: 'claim', priority: 'HIGH', title: `Validate claim ${c.claim_no}`, sub: `${c.patient_code} • ${c.payer} • $${c.billed}`, amount: c.billed, action: 'Validate →', href: '/claims' });
    if (c.status === 'DRAFT' && c.validation === 'PASSED')
      items.push({ kind: 'claim', priority: 'MEDIUM', title: `Submit claim ${c.claim_no}`, sub: `${c.patient_code} • ${c.payer} • $${c.billed}`, amount: c.billed, action: 'Submit →', href: '/claims' });
    if (c.status === 'DENIED')
      items.push({ kind: 'denial', priority: 'HIGH', title: `Denial ${c.denial_code} — ${c.claim_no}`, sub: `${c.patient_code} • ${c.payer} • $${c.billed}`, amount: c.billed, action: 'Work denial →', href: '/denials' });
    if (c.status === 'SUBMITTED') {
      const bal = r2((c.allowed || c.billed) - c.paid);
      if (bal > 0) items.push({ kind: 'ar', priority: ageDays(c) > 30 ? 'HIGH' : 'MEDIUM', title: `A/R follow-up — ${c.claim_no}`, sub: `${ageBucket(ageDays(c))} days • balance $${bal}`, amount: bal, action: 'Work A/R →', href: '/ar' });
      else items.push({ kind: 'payment', priority: 'LOW', title: `Post payment — ${c.claim_no}`, sub: `${c.patient_code} • billed $${c.billed}`, amount: c.billed, action: 'Post →', href: '/payments' });
    }
  }
  for (const ch of charges)
    items.push({ kind: 'charge', priority: 'MEDIUM', title: `Create claim — ${ch.cpt} / ${ch.icd}`, sub: `${ch.patient_code} • DOS ${ch.dos} • $${ch.amount}`, amount: ch.amount, action: 'Create claim →', href: '/charges' });
  const prog = await db.all(`SELECT c.code, c.points, MAX(100.0*a.score/NULLIF(a.max_score,0)) AS best, COUNT(a.id) AS n FROM cases c
    LEFT JOIN attempts a ON a.case_id = c.id AND a.user_id = ? AND a.status = 'completed' GROUP BY c.id`, [u]);
  for (const p of prog)
    if (!p.n) items.push({ kind: 'case', priority: 'LOW', title: `Start training ${p.code}`, sub: 'Not attempted yet', amount: 0, action: 'Start →', href: '/training' });
    else if ((p.best || 0) < 70) items.push({ kind: 'case', priority: 'MEDIUM', title: `Improve ${p.code} (best ${Math.round(p.best)}%)`, sub: 'Below 70% mastery', amount: 0, action: 'Retry →', href: '/training' });
  const pw = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  items.sort((a, b) => pw[a.priority] - pw[b.priority]);
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

app.get('/api/rcm/reports', requireAuth, ah(async (req, res) => {
  const u = req.session.userId;
  const att = await db.all(`SELECT a.*, c.code, c.title FROM attempts a JOIN cases c ON c.id = a.case_id
    WHERE a.user_id = ? AND a.status = 'finished' ORDER BY a.id DESC`, [u]);
  const labs = await db.all('SELECT lab_key, MAX(score) AS best, COUNT(*) AS n FROM lab_runs WHERE user_id = ? GROUP BY lab_key', [u]);
  const cl = await db.all('SELECT * FROM claims WHERE user_id = ?', [u]);
  const validated = cl.filter(c => ['PASSED', 'FAILED'].includes(c.validation));
  const open = cl.filter(c => ['SUBMITTED', 'DENIED', 'APPEALED'].includes(c.status));
  res.json({
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
    recent: att.slice(0, 10).map(a => ({ code: a.code, title: a.title, score: a.score, max: a.max_score, when: a.finished_at || a.created_at })),
  });
}));

app.post('/api/rcm/demo', requireAuth, requireFn('demo'), ah(async (req, res) => {
  const u = req.session.userId, now = snow();
  const n = (await db.get('SELECT COUNT(*) AS n FROM claims WHERE user_id = ?', [u])).n;
  if (n > 0) throw Object.assign(new Error('Demo data already exists — clear your workspace first.'), { status: 409 });
  const demoCharges = [
    ['PT-10005', '2026-10-02', '99213', 'J06.9', '', 120],
    ['PT-10008', '2026-10-05', '99214', 'I10', '25', 220],
    ['PT-10011', '2026-10-09', '87880', 'J02.9', '', 85],
  ];
  for (const [pc, dos, cpt, icd, mod, amt] of demoCharges) {
    const ch = await db.run(`INSERT INTO charges (user_id, patient_code, dos, cpt, icd, modifier, units, amount, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,'READY',?)`, [u, pc, dos, cpt, icd, mod, 1, amt, now]);
    const ins = await db.get('SELECT payer FROM insurance WHERE patient_code = ? AND user_id IS NULL LIMIT 1', [pc]);
    const cl = await db.run(`INSERT INTO claims (user_id, claim_no, patient_code, payer, cpt, icd, modifier, dos, billed, status, validation, created_at)
      VALUES (?,?,?,?,?,?,? ,?,?,'DRAFT','NOT_VALIDATED',?)`,
      [u, 'PENDING', pc, ins ? ins.payer : 'BlueCross BlueShield (Simulated)', cpt, icd, mod, dos, amt, now]);
    const claimNo = `CLM-${Date.now()}-${cl.id}`;
    await db.run('UPDATE claims SET claim_no = ? WHERE id = ?', [claimNo, cl.id]);
    await db.run('UPDATE charges SET claim_id = ?, status = ? WHERE id = ?', [cl.id, 'LINKED', ch.id]);
    // validate + submit through the real lifecycle
    const r = labData.scrubClaim({ patientId: pc, payer: payerKey(ins ? ins.payer : ''), dos, pos: '11',
      npiR: '1234567890', npiB: '0987654321', icds: [icd],
      lines: [{ cpt, dx: [1], mod: mod ? [mod] : [], units: 1, charge: amt }] });
    const val = r.errors.length ? 'FAILED' : 'PASSED';
    await db.run('UPDATE claims SET validation = ? WHERE id = ?', [val, cl.id]);
    if (val === 'PASSED') {
      const a = adjudicate({ id: cl.id, billed: amt });
      await db.run(`UPDATE claims SET status=?, denial_code=?, allowed=?, paid=?, adjustment=?, patient_resp=?, submitted_at=? WHERE id = ?`,
        [a.status, a.denial_code || '', a.allowed || 0, a.paid || 0, a.adjustment || 0, a.patient_resp || 0, now, cl.id]);
    }
  }
  res.json({ ok: true, charges: 3, claims: 3 });
}));

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
app.get('/api/admin/overview', requireAdmin, ah(async (req, res) => {  res.json({
    users: (await db.get('SELECT COUNT(*) AS n FROM users')).n,
    students: (await db.get("SELECT COUNT(*) AS n FROM users WHERE role='student'")).n,
    cases: (await db.get('SELECT COUNT(*) AS n FROM cases WHERE active=1')).n,
    questions: (await db.get('SELECT COUNT(*) AS n FROM questions')).n,
    attempts: (await db.get('SELECT COUNT(*) AS n FROM attempts')).n,
    recentUsers: await db.all('SELECT id,name,email,role,created_at,last_login FROM users ORDER BY id DESC LIMIT 8'),
  });
}));
// System health: which DB is active, where the data lives, is the config safe?
// Returns presence flags only — never secret values.
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
  } catch (e) { res.status(409).json({ error: 'Email already exists.' }); }
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
  res.json({ sessions: rows.map(r => ({ ...r, online: new Date(r.last_seen.replace(' ', 'T') + 'Z').getTime() > cutoff })) });
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
app.get('/api/admin/insights', requireAdmin, ah(async (req, res) => {
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
    const inactiveDays = lt ? Math.floor((nowMs - new Date(lt.replace(' ', 'T') + 'Z').getTime()) / 864e5) : 999;
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
       COUNT(*) AS tries, SUM(CASE WHEN an.correct = 0 THEN 1 ELSE 0 END) AS fails
     FROM answers an JOIN questions q ON q.id = an.question_id
     JOIN cases c ON c.id = q.case_id
     WHERE an.answered_at >= ${since}
     GROUP BY an.question_id HAVING tries >= 2
     ORDER BY 1.0 * fails / tries DESC, tries DESC LIMIT 10`);

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
  const worstFunnel = funnel.filter(f => f.started > 0).sort((a, b) => (a.completed / a.started) - (b.completed / b.started))[0];
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

  res.json({ days, atRisk, funnel, hardQuestions: hardQ, timeHeatmap: matrix, insights });
}));

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
app.get('/api/admin/trends', requireAdmin, ah(async (req, res) => {
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

  res.json({ weeklyTrend, categoryMastery, improvers: improvers.slice(0, 5), distribution: dist, predictions, studentStats });
}));

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
  res.status(s).json({ error: s === 500 ? 'Server error.' : err.message });
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
