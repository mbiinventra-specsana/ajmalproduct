// bill.mbiinventra.com — MbiInventra RCM Academy
// USA medical billing training simulator. Login only — no public registration;
// accounts are created by an administrator.
// DB: SQLite by default; MariaDB/MySQL via DB_ENGINE=mysql (+ DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME).
// Tables auto-create on boot (see lib/db.js).
require('./lib/env'); // FIRST: load NexPanel env file + normalize, before anything reads env
const express = require('express');
const session = require('express-session');
const path = require('path');
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
  if (u.role === 'student') {
    const f = featureForPath(req.path);
    if (f) {
      const row = await db.get('SELECT enabled FROM student_features WHERE user_id=? AND feature=?', [u.id, f]);
      if (row && !row.enabled)
        return res.status(403).json({ error: 'This module is disabled for your account.', featureDisabled: f });
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

// ---------- pages ----------
const send = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
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
app.get('/owner/:section(analytics|accounts|announce|sessions|system)', ownerPage);
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
  if (!ok) { noteFail(req); return res.status(401).json({ error: 'Invalid email or password.' }); }
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
      done();
    })();
  });
}));
app.post('/api/logout', (req, res) => {
  const sid = req.sessionID;
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

app.post('/api/labs/scrub', requireAuth, ah(async (req, res) => {
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

app.post('/api/labs/denials/grade', requireAuth, ah(async (req, res) => {
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

app.post('/api/labs/quiz/submit', requireAuth, ah(async (req, res) => {
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
app.post('/api/rcm/insurance', requireAuth, ah(async (req, res) => {
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
app.post('/api/rcm/eligibility/verify', requireAuth, ah(async (req, res) => {
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
app.post('/api/rcm/charges', requireAuth, ah(async (req, res) => {
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
app.post('/api/rcm/claims', requireAuth, ah(async (req, res) => {
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
app.post('/api/rcm/claims/:id/validate', requireAuth, ah(async (req, res) => {
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
app.post('/api/rcm/claims/:id/submit', requireAuth, ah(async (req, res) => {
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
app.post('/api/rcm/payments', requireAuth, ah(async (req, res) => {
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
app.post('/api/rcm/ar/note', requireAuth, ah(async (req, res) => {
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
app.post('/api/rcm/denials/:id/resolve', requireAuth, ah(async (req, res) => {
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

app.post('/api/rcm/demo', requireAuth, ah(async (req, res) => {
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
  res.json({ users: await db.all('SELECT id,name,email,role,created_at,last_login FROM users ORDER BY id') });
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
    res.json({ ok: true, id: r.id });
  } catch (e) { res.status(409).json({ error: 'Email already exists.' }); }
}));
app.delete('/api/admin/users/:id', requireAdmin, ah(async (req, res) => {
  if (Number(req.params.id) === req.adminUser.id)
    return res.status(400).json({ error: 'Cannot delete yourself.' });
  await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
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
// ---- announcements ----
app.get('/api/admin/announcements', requireAdmin, ah(async (req, res) => {
  res.json({ announcements: await db.all('SELECT * FROM announcements ORDER BY id DESC LIMIT 50') });
}));
app.post('/api/admin/announcements', requireAdmin, ah(async (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required.' });
  const r = await db.run('INSERT INTO announcements (title, body, active, created_by, created_at) VALUES (?,?,?,?,?)',
    [String(title).slice(0, 200), String(body || '').slice(0, 2000), 1, req.adminUser.id, db.now()]);
  res.json({ ok: true, id: r.id });
}));
app.post('/api/admin/announcements/:id/toggle', requireAdmin, ah(async (req, res) => {
  await db.run('UPDATE announcements SET active = 1 - active WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/admin/announcements/:id', requireAdmin, ah(async (req, res) => {
  await db.run('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));
// student-facing: active announcements + leaderboard
app.get('/api/announcements', requireAuth, ah(async (req, res) => {
  res.json({ announcements: await db.all('SELECT id, title, body, created_at FROM announcements WHERE active = 1 ORDER BY id DESC LIMIT 10') });
}));
app.get('/api/leaderboard', requireAuth, ah(async (req, res) => {
  const top = await db.all(
    `SELECT u.id, u.name, COALESCE(SUM(a.score),0) AS points,
            COUNT(DISTINCT CASE WHEN a.status='completed' THEN a.case_id END) AS cases_done
     FROM users u LEFT JOIN attempts a ON a.user_id = u.id
     WHERE u.role = 'student' GROUP BY u.id ORDER BY points DESC LIMIT 10`);
  res.json({ top });
}));
// ---- analytics: skill-gap heatmap + exam readiness ----
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
