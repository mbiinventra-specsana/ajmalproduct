// Database layer: SQLite (better-sqlite3), schema + seed.
// All training content is fictional.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'bill.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('admin','instructor','student')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT 'Beginner',
  category TEXT NOT NULL DEFAULT 'GENERAL',
  points INTEGER NOT NULL DEFAULT 50,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  qnum INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,          -- JSON array of 4 strings
  answer_idx INTEGER NOT NULL,    -- never sent to client before answering
  points INTEGER NOT NULL DEFAULT 10,
  explanation TEXT NOT NULL DEFAULT '',
  hint TEXT NOT NULL DEFAULT '',
  UNIQUE(case_id, qnum)
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','completed','abandoned')),
  score INTEGER NOT NULL DEFAULT 0,
  max_score INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  chosen_idx INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  points_earned INTEGER NOT NULL DEFAULT 0,
  answered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(attempt_id, question_id)
);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  dob TEXT NOT NULL,
  gender TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',
  fictional INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_questions_case ON questions(case_id);
`);

// ---------- helpers ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt:${salt}:${h}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, salt, h] = stored.split(':');
    const test = crypto.scryptSync(pw, salt, 64);
    const orig = Buffer.from(h, 'hex');
    return test.length === orig.length && crypto.timingSafeEqual(test, orig);
  } catch { return false; }
}

// ---------- seed ----------
function seed() {
  // admin user (env-configurable, like the Lady Corrections pattern)
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'changeme123';
  const hasAdmin = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin');
  if (!hasAdmin) {
    db.prepare('INSERT INTO users (name, email, pass_hash, role) VALUES (?,?,?,?)')
      .run('Administrator', adminUser + '@local', hashPassword(adminPass), 'admin');
    console.log(`[seed] admin created (login: ${adminUser})` +
      (process.env.ADMIN_PASS ? '' : '  <-- default password, set ADMIN_PASS env!'));
  }

  // fictional patients
  const patients = [
    ['PT-10005', 'Olivia Thompson', '1988-03-14', 'Female', '(555) 201-8841'],
    ['PT-10006', 'James Carter', '1975-07-02', 'Male', '(555) 201-8842'],
    ['PT-10007', 'Sarah Johnson', '1992-11-28', 'Female', '(555) 201-8843'],
    ['PT-10008', 'Michael Reyes', '1981-05-19', 'Male', '(555) 201-8844'],
    ['PT-10009', 'Emily Davis', '1999-01-07', 'Female', '(555) 201-8845'],
    ['PT-10010', 'David Wilson', '1968-09-23', 'Male', '(555) 201-8846'],
    ['PT-10011', 'Sophia Martinez', '1995-12-11', 'Female', '(555) 201-8847'],
    ['PT-10012', 'Robert Anderson', '1972-04-30', 'Male', '(555) 201-8848'],
    ['PT-10013', 'Ava Thomas', '1990-08-16', 'Female', '(555) 201-8849'],
  ];
  const insP = db.prepare('INSERT OR IGNORE INTO patients (code,name,dob,gender,phone) VALUES (?,?,?,?,?)');
  for (const p of patients) insP.run(...p);

  // training cases from seed/cases.json (written by content pipeline)
  const seedPath = path.join(__dirname, '..', 'seed', 'cases.json');
  if (fs.existsSync(seedPath)) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(seedPath, 'utf8')); }
    catch (e) { console.error('[seed] cases.json parse error:', e.message); arr = []; }
    const getCase = db.prepare('SELECT id FROM cases WHERE code = ?');
    const insCase = db.prepare(
      'INSERT INTO cases (code,title,description,difficulty,category,points,sort) VALUES (?,?,?,?,?,?,?)');
    const insQ = db.prepare(
      'INSERT OR IGNORE INTO questions (case_id,qnum,prompt,options,answer_idx,points,explanation,hint) VALUES (?,?,?,?,?,?,?,?)');
    let nC = 0, nQ = 0;
    for (const c of arr) {
      let row = getCase.get(c.code);
      let caseId;
      if (!row) {
        const r = insCase.run(c.code, c.title, c.description || '', c.difficulty || 'Beginner',
          c.category || 'GENERAL', c.points || 50, c.sort || 0);
        caseId = r.lastInsertRowid; nC++;
      } else caseId = row.id;
      (c.questions || []).forEach((q, i) => {
        const r = insQ.run(caseId, i + 1, q.q, JSON.stringify(q.options), q.answer,
          q.points || 10, q.explanation || '', q.hint || '');
        if (r.changes) nQ++;
      });
    }
    console.log(`[seed] cases: ${nC} new, questions: ${nQ} new`);
  } else {
    console.log('[seed] seed/cases.json not found — skipping case seed');
  }
}
seed();

// ---------- levels ----------
const LEVELS = [
  [500, 'Billing Executive'],
  [400, 'Senior Biller'],
  [250, 'Billing Specialist'],
  [100, 'Junior Biller'],
  [0, 'Beginner'],
];
function levelFor(points) {
  for (const [min, name] of LEVELS) if (points >= min) return name;
  return 'Beginner';
}

module.exports = { db, hashPassword, verifyPassword, levelFor };
