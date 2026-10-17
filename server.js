// bill.mbiinventra.com — MbiInventra RCM Academy
// USA medical billing training simulator. Login only — no public registration;
// accounts are created by an administrator.
const express = require('express');
const session = require('express-session');
const path = require('path');
const { db, hashPassword, verifyPassword, levelFor } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PATH = (process.env.ADMIN_PATH || '/admin').replace(/\/$/, '') || '/admin';

// ---------- security headers ----------
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
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12,
            secure: process.env.COOKIE_SECURE === '1' },
}));

// ---------- tiny login rate limiter ----------
const fails = new Map(); // ip -> {count, until}
function loginLimit(req, res, next) {
  const ip = req.ip;
  const f = fails.get(ip);
  const now = Date.now();
  if (f && f.until > now) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  if (f && f.until <= now) fails.delete(ip);
  next();
}
function noteFail(req) {
  const ip = req.ip;
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 8) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  fails.set(ip, f);
}

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please log in.' });
  next();
}
function requireAdmin(req, res, next) {
  const u = req.session.userId && db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  req.adminUser = u;
  next();
}
const stripQ = (q) => ({
  id: q.id, qnum: q.qnum, prompt: q.prompt,
  options: JSON.parse(q.options), points: q.points, hint: q.hint,
});
function userStats(userId) {
  const done = db.prepare(
    `SELECT COUNT(DISTINCT case_id) AS c, COALESCE(SUM(score),0) AS pts
     FROM attempts WHERE user_id = ? AND status = 'completed'`).get(userId);
  const att = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(AVG(100.0*score/NULLIF(max_score,0)),0) AS acc
     FROM attempts WHERE user_id = ? AND status = 'completed'`).get(userId);
  const total = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE active = 1').get().n;
  const points = done.pts || 0;
  return {
    points, level: levelFor(points),
    casesCompleted: done.c || 0, totalCases: total,
    accuracy: Math.round((att.acc || 0) * 10) / 10,
    attempts: att.n || 0,
  };
}

// ---------- pages ----------
const send = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/', send('index.html'));
app.get('/login', send('login.html'));
app.get('/dashboard', send('dashboard.html'));
app.get('/training', send('training.html'));
app.get('/play', send('play.html'));
app.get('/progress', send('progress.html'));
app.get('/lab', send('lab.html'));
app.get(ADMIN_PATH, send('admin.html'));
app.get(ADMIN_PATH + '/', send('admin.html'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
// NOTE: there is intentionally NO /register route anywhere.

// ---------- auth API (login only) ----------
app.post('/api/login', loginLimit, (req, res) => {
  const { email, password } = req.body || {};
  const u = typeof email === 'string' &&
    db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  // constant-time-ish: always verify something
  const ok = u && verifyPassword(password || '', u.pass_hash);
  if (!ok) { noteFail(req); return res.status(401).json({ error: 'Invalid email or password.' }); }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error.' });
    req.session.userId = u.id;
    db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?').run(u.id);
    res.json({ ok: true, user: pub(u) });
  });
});
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/me', (req, res) => {
  const u = req.session.userId && db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!u) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: pub(u) });
});

// ---------- student API ----------
app.get('/api/dashboard', requireAuth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const stats = userStats(u.id);
  const recent = db.prepare(
    `SELECT a.id, a.score, a.max_score, a.completed_at, c.code, c.title
     FROM attempts a JOIN cases c ON c.id = a.case_id
     WHERE a.user_id = ? AND a.status = 'completed'
     ORDER BY a.completed_at DESC LIMIT 5`).all(u.id);
  res.json({ user: pub(u), stats, recent });
});

app.get('/api/cases', requireAuth, (req, res) => {
  const cases = db.prepare('SELECT * FROM cases WHERE active = 1 ORDER BY sort').all();
  const prog = db.prepare(
    `SELECT case_id, COUNT(*) AS attempts, MAX(score) AS best,
            SUM(status='completed') AS done
     FROM attempts WHERE user_id = ? GROUP BY case_id`).all(req.session.userId);
  const pm = Object.fromEntries(prog.map(p => [p.case_id, p]));
  res.json({
    cases: cases.map(c => ({
      id: c.id, code: c.code, title: c.title, description: c.description,
      difficulty: c.difficulty, category: c.category, points: c.points,
      questions: db.prepare('SELECT COUNT(*) AS n FROM questions WHERE case_id = ?').get(c.id).n,
      attempts: pm[c.id]?.attempts || 0,
      best: pm[c.id]?.best ?? null,
      completed: (pm[c.id]?.done || 0) > 0,
    })),
  });
});

app.get('/api/cases/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ? AND active = 1').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  const qs = db.prepare('SELECT * FROM questions WHERE case_id = ? ORDER BY qnum').all(c.id);
  res.json({
    id: c.id, code: c.code, title: c.title, description: c.description,
    difficulty: c.difficulty, category: c.category, points: c.points,
    questions: qs.map(stripQ),
  });
});

app.post('/api/attempts', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ? AND active = 1').get(req.body?.caseId);
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  const max = db.prepare('SELECT COALESCE(SUM(points),0) AS m FROM questions WHERE case_id = ?').get(c.id).m;
  // abandon any previous unfinished attempt on this case
  db.prepare(`UPDATE attempts SET status='abandoned' WHERE user_id=? AND case_id=? AND status='started'`)
    .run(req.session.userId, c.id);
  const r = db.prepare('INSERT INTO attempts (user_id, case_id, max_score) VALUES (?,?,?)')
    .run(req.session.userId, c.id, max);
  const qs = db.prepare('SELECT * FROM questions WHERE case_id = ? ORDER BY qnum').all(c.id);
  res.json({ attemptId: r.lastInsertRowid, questions: qs.map(stripQ), maxScore: max });
});

app.post('/api/attempts/:id/answer', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attempts WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!a || a.status !== 'started') return res.status(404).json({ error: 'Attempt not found or finished.' });
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND case_id = ?').get(req.body?.questionId, a.case_id);
  if (!q) return res.status(404).json({ error: 'Question not found.' });
  const chosen = Number(req.body?.chosen);
  if (![0, 1, 2, 3].includes(chosen)) return res.status(400).json({ error: 'Invalid choice.' });
  const dup = db.prepare('SELECT id FROM answers WHERE attempt_id = ? AND question_id = ?').get(a.id, q.id);
  if (dup) return res.status(409).json({ error: 'Already answered.' });
  const correct = chosen === q.answer_idx ? 1 : 0;
  const earned = correct ? q.points : 0;
  db.prepare('INSERT INTO answers (attempt_id, question_id, chosen_idx, correct, points_earned) VALUES (?,?,?,?,?)')
    .run(a.id, q.id, chosen, correct, earned);
  db.prepare('UPDATE attempts SET score = score + ? WHERE id = ?').run(earned, a.id);
  res.json({ correct: !!correct, correctIdx: q.answer_idx, explanation: q.explanation, pointsEarned: earned });
});

app.post('/api/attempts/:id/finish', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attempts WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!a || a.status !== 'started') return res.status(404).json({ error: 'Attempt not found or finished.' });
  db.prepare(`UPDATE attempts SET status='completed', completed_at=datetime('now') WHERE id = ?`).run(a.id);
  const fin = db.prepare('SELECT * FROM attempts WHERE id = ?').get(a.id);
  const stats = userStats(req.session.userId);
  res.json({
    score: fin.score, maxScore: fin.max_score,
    accuracy: fin.max_score ? Math.round(1000 * fin.score / fin.max_score) / 10 : 0,
    level: stats.level, points: stats.points,
  });
});

app.get('/api/progress', requireAuth, (req, res) => {
  const stats = userStats(req.session.userId);
  const attempts = db.prepare(
    `SELECT a.id, a.score, a.max_score, a.status, a.started_at, a.completed_at, c.code, c.title, c.difficulty
     FROM attempts a JOIN cases c ON c.id = a.case_id
     WHERE a.user_id = ? ORDER BY a.started_at DESC LIMIT 50`).all(req.session.userId);
  const perCase = db.prepare(
    `SELECT c.code, c.title, COUNT(*) AS attempts, MAX(a.score) AS best,
            SUM(a.status='completed') AS done
     FROM attempts a JOIN cases c ON c.id = a.case_id
     WHERE a.user_id = ? GROUP BY c.id ORDER BY c.sort`).all(req.session.userId);
  res.json({ stats, attempts, perCase });
});

app.get('/api/patients', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT code,name,dob,gender,phone,status FROM patients ORDER BY code').all();
  res.json({ fictional: true, patients: rows });
});

// ---------- admin API ----------
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    students: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='student'").get().n,
    cases: db.prepare('SELECT COUNT(*) AS n FROM cases WHERE active=1').get().n,
    questions: db.prepare('SELECT COUNT(*) AS n FROM questions').get().n,
    attempts: db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,
    recentUsers: db.prepare('SELECT id,name,email,role,created_at,last_login FROM users ORDER BY id DESC LIMIT 8').all(),
  });
});
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({
    users: db.prepare('SELECT id,name,email,role,created_at,last_login FROM users ORDER BY id').all(),
  });
});
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || password.length < 6)
    return res.status(400).json({ error: 'Name, valid email and 6+ char password required.' });
  if (!['student', 'instructor', 'admin'].includes(role))
    return res.status(400).json({ error: 'Invalid role.' });
  try {
    const r = db.prepare('INSERT INTO users (name,email,pass_hash,role) VALUES (?,?,?,?)')
      .run(String(name).slice(0, 80), String(email).toLowerCase().trim().slice(0, 120),
        hashPassword(password), role);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ error: 'Email already exists.' });
  }
});
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.adminUser.id)
    return res.status(400).json({ error: 'Cannot delete yourself.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 404 ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

app.listen(PORT, () => {
  console.log(`RCM Academy listening on :${PORT} — https://bill.mbiinventra.com`);
  if (!process.env.SESSION_SECRET) console.log('[warn] SESSION_SECRET not set — using dev default');
});
