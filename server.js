// bill.mbiinventra.com — MbiInventra RCM Academy
// USA medical billing training simulator. Login only — no public registration;
// accounts are created by an administrator.
// DB: SQLite by default; MariaDB/MySQL via DB_ENGINE=mysql (+ DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME).
// Tables auto-create on boot (see lib/db.js).
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./lib/db');

const app = express();
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
            secure: process.env.COOKIE_SECURE === '1' },
}));

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
  next();
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
// owner panel: fully separate + hidden — only a logged-in admin can open it,
// everyone else gets the branded 404 (no mention of it anywhere user-side).
async function ownerPage(req, res, next) {
  try {
    const u = req.session.userId ? await db.get('SELECT role FROM users WHERE id=?', [req.session.userId]) : null;
    if (u && u.role === 'admin') return send('owner.html')(req, res, next);
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  } catch (e) { next(e); }
}
app.get('/owner', ownerPage);
app.get('/owner/', ownerPage);
app.get(ADMIN_PATH, send('admin.html'));
app.get(ADMIN_PATH + '/', send('admin.html'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
// NOTE: intentionally NO /register route anywhere.

// ---------- auth API (login only) ----------
app.post('/api/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const u = typeof email === 'string' &&
    await db.get('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  const ok = u && db.verifyPassword(password || '', u.pass_hash);
  if (!ok) { noteFail(req); return res.status(401).json({ error: 'Invalid email or password.' }); }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error.' });
    req.session.userId = u.id;
    db.run('UPDATE users SET last_login = ? WHERE id = ?', [db.now(), u.id])
      .then(() => res.json({ ok: true, user: pub(u) }))
      .catch(() => res.json({ ok: true, user: pub(u) }));
  });
}));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', ah(async (req, res) => {
  const u = req.session.userId && await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  if (!u) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: pub(u) });
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

// ---------- admin API ----------
app.get('/api/admin/overview', requireAdmin, ah(async (req, res) => {
  res.json({
    users: (await db.get('SELECT COUNT(*) AS n FROM users')).n,
    students: (await db.get("SELECT COUNT(*) AS n FROM users WHERE role='student'")).n,
    cases: (await db.get('SELECT COUNT(*) AS n FROM cases WHERE active=1')).n,
    questions: (await db.get('SELECT COUNT(*) AS n FROM questions')).n,
    attempts: (await db.get('SELECT COUNT(*) AS n FROM attempts')).n,
    recentUsers: await db.all('SELECT id,name,email,role,created_at,last_login FROM users ORDER BY id DESC LIMIT 8'),
  });
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

// ---------- 404 + errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Server error.' });
});

async function main() {
  await db.initDb(); // auto-migration + seed
  app.listen(PORT, () => {
    console.log(`RCM Academy listening on :${PORT} (engine=${db.ENGINE})`);
    if (!process.env.SESSION_SECRET) console.log('[warn] SESSION_SECRET not set — using dev default');
  });
}
main().catch((e) => { console.error('[fatal] DB init failed:', e.message); process.exit(1); });
