// Database layer — dual engine: SQLite (default, local dev) or MariaDB/MySQL.
// Engine is chosen by DB_ENGINE env ('sqlite' | 'mysql'). On boot, tables are
// auto-created (migrations) and seed data inserted idempotently — so tables
// appear in phpMyAdmin automatically on first start. All training data fictional.
//
// MariaDB env: DB_ENGINE=mysql DB_HOST DB_PORT DB_USER DB_PASS DB_NAME
// Passwords are never logged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENGINE = (process.env.DB_ENGINE || 'sqlite').toLowerCase();
const IS_MYSQL = ENGINE === 'mysql';

let sdb = null;   // better-sqlite3 instance
let pool = null;  // mysql2 pool

if (IS_MYSQL) {
  const mysql = require('mysql2/promise');
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'rcm_academy',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
  });
} else {
  const Database = require('better-sqlite3');
  const DATA_DIR = path.join(__dirname, '..', 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sdb = new Database(path.join(DATA_DIR, 'bill.db'));
  sdb.pragma('journal_mode = WAL');
  sdb.pragma('foreign_keys = ON');
}

// ---------- portable query helpers (all async) ----------
async function all(sql, params = []) {
  if (IS_MYSQL) { const [rows] = await pool.execute(sql, params); return rows; }
  return sdb.prepare(sql).all(...params);
}
async function get(sql, params = []) {
  if (IS_MYSQL) { const [rows] = await pool.execute(sql, params); return rows[0]; }
  return sdb.prepare(sql).get(...params);
}
async function run(sql, params = []) {
  if (IS_MYSQL) { const [r] = await pool.execute(sql, params); return { id: r.insertId || 0, changes: r.affectedRows || 0 }; }
  const r = sdb.prepare(sql).run(...params);
  return { id: Number(r.lastInsertRowid) || 0, changes: r.changes };
}
async function exec(sql) {
  if (IS_MYSQL) { await pool.query(sql); return; }
  sdb.exec(sql);
}
// portable "insert if not exists" for tables with a UNIQUE key
async function insertIgnore(table, cols, vals) {
  const ph = cols.map(() => '?').join(',');
  const kw = IS_MYSQL ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
  return run(`${kw} INTO ${table} (${cols.join(',')}) VALUES (${ph})`, vals);
}
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ---------- schema (auto-migration) ----------
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('admin','instructor','student')),
  created_at TEXT NOT NULL, last_login TEXT
);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT 'Beginner', category TEXT NOT NULL DEFAULT 'GENERAL',
  points INTEGER NOT NULL DEFAULT 50, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  qnum INTEGER NOT NULL, prompt TEXT NOT NULL, options TEXT NOT NULL,
  answer_idx INTEGER NOT NULL, points INTEGER NOT NULL DEFAULT 10,
  explanation TEXT NOT NULL DEFAULT '', hint TEXT NOT NULL DEFAULT '',
  UNIQUE(case_id, qnum)
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','completed','abandoned')),
  score INTEGER NOT NULL DEFAULT 0, max_score INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  chosen_idx INTEGER NOT NULL, correct INTEGER NOT NULL,
  points_earned INTEGER NOT NULL DEFAULT 0, answered_at TEXT NOT NULL,
  UNIQUE(attempt_id, question_id)
);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, dob TEXT NOT NULL,
  gender TEXT NOT NULL, phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active', fictional INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_questions_case ON questions(case_id);
`;

const MYSQL_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL, email VARCHAR(160) NOT NULL UNIQUE, pass_hash VARCHAR(255) NOT NULL,
  role ENUM('admin','instructor','student') NOT NULL DEFAULT 'student',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login DATETIME NULL,
  INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS cases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE, title VARCHAR(160) NOT NULL, description TEXT NOT NULL,
  difficulty VARCHAR(24) NOT NULL DEFAULT 'Beginner', category VARCHAR(32) NOT NULL DEFAULT 'GENERAL',
  points INT NOT NULL DEFAULT 50, sort INT NOT NULL DEFAULT 0, active TINYINT NOT NULL DEFAULT 1,
  INDEX idx_sort (sort)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS questions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL, qnum INT NOT NULL, prompt TEXT NOT NULL, options TEXT NOT NULL,
  answer_idx TINYINT NOT NULL, points INT NOT NULL DEFAULT 10,
  explanation TEXT NOT NULL, hint TEXT NOT NULL,
  UNIQUE KEY uq_case_q (case_id, qnum),
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL, case_id INT NOT NULL,
  status ENUM('started','completed','abandoned') NOT NULL DEFAULT 'started',
  score INT NOT NULL DEFAULT 0, max_score INT NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME NULL,
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS answers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attempt_id INT NOT NULL, question_id INT NOT NULL,
  chosen_idx TINYINT NOT NULL, correct TINYINT NOT NULL,
  points_earned INT NOT NULL DEFAULT 0, answered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_att_q (attempt_id, question_id),
  FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS patients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(24) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, dob DATE NOT NULL,
  gender VARCHAR(16) NOT NULL, phone VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'Active', fictional TINYINT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

// ---------- password hashing (scrypt) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, salt, h] = stored.split(':');
    const a = crypto.scryptSync(pw, salt, 64), b = Buffer.from(h, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// ---------- seed (idempotent) ----------
async function seed() {
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'changeme123';
  const hasAdmin = await get('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
  if (!hasAdmin) {
    await run('INSERT INTO users (name, email, pass_hash, role, created_at) VALUES (?,?,?,?,?)',
      ['Administrator', adminUser + '@local', hashPassword(adminPass), 'admin', now()]);
    console.log(`[seed] admin created (login: ${adminUser})` +
      (process.env.ADMIN_PASS ? '' : '  <-- default password, set ADMIN_PASS env!'));
  }
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
  for (const p of patients)
    await insertIgnore('patients', ['code', 'name', 'dob', 'gender', 'phone'], p);

  const seedPath = path.join(__dirname, '..', 'seed', 'cases.json');
  if (fs.existsSync(seedPath)) {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(seedPath, 'utf8')); }
    catch (e) { console.error('[seed] cases.json parse error:', e.message); }
    let nC = 0, nQ = 0;
    for (const c of arr) {
      let row = await get('SELECT id FROM cases WHERE code = ?', [c.code]);
      let caseId;
      if (!row) {
        const r = await run(
          'INSERT INTO cases (code,title,description,difficulty,category,points,sort) VALUES (?,?,?,?,?,?,?)',
          [c.code, c.title, c.description || '', c.difficulty || 'Beginner',
           c.category || 'GENERAL', c.points || 50, c.sort || 0]);
        caseId = r.id; nC++;
      } else caseId = row.id;
      for (let i = 0; i < (c.questions || []).length; i++) {
        const q = c.questions[i];
        const r = await insertIgnore('questions',
          ['case_id', 'qnum', 'prompt', 'options', 'answer_idx', 'points', 'explanation', 'hint'],
          [caseId, i + 1, q.q, JSON.stringify(q.options), q.answer, q.points || 10,
           q.explanation || '', q.hint || '']);
        if (r.changes) nQ++;
      }
    }
    console.log(`[seed] cases: ${nC} new, questions: ${nQ} new`);
  } else console.log('[seed] seed/cases.json not found — skipping case seed');
}

async function initDb() {
  // auto-migration: create tables if missing
  const ddl = IS_MYSQL ? MYSQL_DDL : SQLITE_DDL;
  for (const stmt of ddl.split(/;\s*\n/).map(s => s.trim()).filter(Boolean))
    await exec(stmt + ';');
  await seed();
  console.log(`[db] engine=${ENGINE}` + (IS_MYSQL ? ` host=${process.env.DB_HOST || 'localhost'}` : ''));
}

// ---------- levels ----------
const LEVELS = [[500, 'Billing Executive'], [400, 'Senior Biller'], [250, 'Billing Specialist'], [100, 'Junior Biller'], [0, 'Beginner']];
function levelFor(points) {
  for (const [min, name] of LEVELS) if (points >= min) return name;
  return 'Beginner';
}

module.exports = { all, get, run, insertIgnore, now, initDb, hashPassword, verifyPassword, levelFor, ENGINE, IS_MYSQL };
