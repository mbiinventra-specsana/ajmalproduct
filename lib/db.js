// Database layer — dual engine: SQLite (default, local dev) or MariaDB/MySQL.
// Engine is chosen by DB_ENGINE env ('sqlite' | 'mysql'). On boot, tables are
// auto-created (migrations) and seed data inserted idempotently — so tables
// appear in phpMyAdmin automatically on first start. All training data fictional.
//
// MariaDB env: DB_ENGINE=mysql DB_HOST DB_PORT DB_USER DB_PASS DB_NAME
// Passwords are never logged.
require('./env'); // normalize "KEY = value" spacing quirks before reading env
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
  // DATA_DIR can point OUTSIDE the project (e.g. /home/user/rcm-data) so that
  // GitHub redeploys never wipe the database. Falls back to ./data for local dev.
  const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sdb = new Database(path.join(DATA_DIR, 'bill.db'));  // single file — never delete it
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
  code TEXT NOT NULL, name TEXT NOT NULL, dob TEXT NOT NULL,
  gender TEXT NOT NULL, phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active', fictional INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(code, user_id)
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_questions_case ON questions(case_id);
CREATE TABLE IF NOT EXISTS lab_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lab_key TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0,
  max_score INTEGER NOT NULL DEFAULT 100, detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_lab_runs_user ON lab_runs(user_id);
-- per-student feature toggles (admin ON/OFF per module; missing row = enabled)
CREATE TABLE IF NOT EXISTS student_features (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, feature)
);
-- owner announcements broadcast to students
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  scheduled_at TEXT,
  target TEXT NOT NULL DEFAULT 'all',
  pinned INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  placement TEXT NOT NULL DEFAULT 'home'
);
CREATE TABLE IF NOT EXISTS announcement_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TEXT NOT NULL,
  UNIQUE(announcement_id, user_id)
);
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_logs(action);
CREATE TABLE IF NOT EXISTS ip_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT '',
  blocked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
-- active login sessions (for admin session control / force logout)
CREATE TABLE IF NOT EXISTS login_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guided_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'started',
  step_idx INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(user_id, case_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON login_sessions(user_id);
-- RCM workspace tables (per-student fictional training data)
CREATE TABLE IF NOT EXISTS insurance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  patient_code TEXT NOT NULL, payer TEXT NOT NULL, member_id TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'PPO',
  status TEXT NOT NULL DEFAULT 'ACTIVE', effective TEXT NOT NULL DEFAULT '',
  copay REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS eligibility_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_code TEXT NOT NULL, payer TEXT NOT NULL, service TEXT NOT NULL,
  coverage TEXT NOT NULL, copay REAL NOT NULL DEFAULT 0,
  deductible REAL NOT NULL DEFAULT 0, result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_code TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'Dr. James Anderson',
  dos TEXT NOT NULL, cpt TEXT NOT NULL, icd TEXT NOT NULL,
  modifier TEXT NOT NULL DEFAULT '', units INTEGER NOT NULL DEFAULT 1,
  amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'READY',
  claim_id INTEGER REFERENCES claims(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_no TEXT NOT NULL UNIQUE,
  patient_code TEXT NOT NULL, payer TEXT NOT NULL,
  cpt TEXT NOT NULL, icd TEXT NOT NULL, modifier TEXT NOT NULL DEFAULT '',
  dos TEXT NOT NULL, billed REAL NOT NULL,
  allowed REAL NOT NULL DEFAULT 0, paid REAL NOT NULL DEFAULT 0,
  adjustment REAL NOT NULL DEFAULT 0, patient_resp REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  validation TEXT NOT NULL DEFAULT 'NOT_VALIDATED',
  denial_code TEXT NOT NULL DEFAULT '',
  follow_up TEXT NOT NULL DEFAULT 'NOT_STARTED',
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  paid REAL NOT NULL, adjustment REAL NOT NULL, patient_resp REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'ERA',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS ar_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS denial_work (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  root_cause TEXT NOT NULL DEFAULT '',
  corrective_action TEXT NOT NULL DEFAULT '',
  appeal_status TEXT NOT NULL DEFAULT '',
  appeal_date TEXT NOT NULL DEFAULT '',
  appeal_notes TEXT NOT NULL DEFAULT '',
  resolution_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, claim_id)
);
CREATE TABLE IF NOT EXISTS payers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  payer_id TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(name, user_id)
);
CREATE INDEX IF NOT EXISTS idx_claims_user ON claims(user_id);
CREATE INDEX IF NOT EXISTS idx_charges_user ON charges(user_id);
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
  code VARCHAR(24) NOT NULL, name VARCHAR(120) NOT NULL, dob DATE NOT NULL,
  gender VARCHAR(16) NOT NULL, phone VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'Active', fictional TINYINT NOT NULL DEFAULT 1,
  user_id INT NULL,
  UNIQUE KEY uk_code_user (code, user_id),
  INDEX idx_patients_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lab_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  lab_key VARCHAR(48) NOT NULL, score INT NOT NULL DEFAULT 0,
  max_score INT NOT NULL DEFAULT 100, detail TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS student_features (
  user_id INT NOT NULL,
  feature VARCHAR(32) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, feature),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS announcements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL, body TEXT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scheduled_at DATETIME NULL,
  target TEXT NOT NULL DEFAULT 'all',
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  expires_at DATETIME NULL,
  placement VARCHAR(20) NOT NULL DEFAULT 'home',
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS announcement_views (
  id INT AUTO_INCREMENT PRIMARY KEY,
  announcement_id INT NOT NULL,
  user_id INT NOT NULL,
  viewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_av (announcement_id, user_id),
  FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS activity_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  action VARCHAR(64) NOT NULL,
  detail VARCHAR(500) NOT NULL DEFAULT '',
  ip VARCHAR(64) NOT NULL DEFAULT '',
  user_agent VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_activity_created (created_at),
  INDEX idx_activity_user (user_id),
  INDEX idx_activity_action (action),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ip_blocks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(64) NOT NULL UNIQUE,
  reason VARCHAR(300) NOT NULL DEFAULT '',
  blocked_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (blocked_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS login_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(128) NOT NULL UNIQUE,
  user_id INT NOT NULL,
  ip VARCHAR(64) NOT NULL DEFAULT '', user_agent VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS insurance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  patient_code VARCHAR(24) NOT NULL, payer VARCHAR(120) NOT NULL, member_id VARCHAR(64) NOT NULL,
  plan VARCHAR(120) NOT NULL DEFAULT '', type VARCHAR(16) NOT NULL DEFAULT 'PPO',
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE', effective VARCHAR(24) NOT NULL DEFAULT '',
  copay DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS eligibility_checks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  patient_code VARCHAR(24) NOT NULL, payer VARCHAR(120) NOT NULL, service VARCHAR(64) NOT NULL,
  coverage VARCHAR(16) NOT NULL, copay DECIMAL(10,2) NOT NULL DEFAULT 0,
  deductible DECIMAL(10,2) NOT NULL DEFAULT 0, result VARCHAR(16) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS charges (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  patient_code VARCHAR(24) NOT NULL, provider VARCHAR(120) NOT NULL DEFAULT 'Dr. James Anderson',
  dos VARCHAR(24) NOT NULL, cpt VARCHAR(16) NOT NULL, icd VARCHAR(16) NOT NULL,
  modifier VARCHAR(8) NOT NULL DEFAULT '', units INT NOT NULL DEFAULT 1,
  amount DECIMAL(10,2) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'READY',
  claim_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS claims (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  claim_no VARCHAR(48) NOT NULL UNIQUE,
  patient_code VARCHAR(24) NOT NULL, payer VARCHAR(120) NOT NULL,
  cpt VARCHAR(16) NOT NULL, icd VARCHAR(16) NOT NULL, modifier VARCHAR(8) NOT NULL DEFAULT '',
  dos VARCHAR(24) NOT NULL, billed DECIMAL(10,2) NOT NULL,
  allowed DECIMAL(10,2) NOT NULL DEFAULT 0, paid DECIMAL(10,2) NOT NULL DEFAULT 0,
  adjustment DECIMAL(10,2) NOT NULL DEFAULT 0, patient_resp DECIMAL(10,2) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  validation VARCHAR(16) NOT NULL DEFAULT 'NOT_VALIDATED',
  denial_code VARCHAR(16) NOT NULL DEFAULT '',
  follow_up VARCHAR(16) NOT NULL DEFAULT 'NOT_STARTED',
  submitted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL, claim_id INT NOT NULL,
  paid DECIMAL(10,2) NOT NULL, adjustment DECIMAL(10,2) NOT NULL, patient_resp DECIMAL(10,2) NOT NULL,
  method VARCHAR(8) NOT NULL DEFAULT 'ERA',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ar_notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL, claim_id INT NOT NULL,
  note TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS denial_work (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL, claim_id INT NOT NULL,
  root_cause VARCHAR(60) NOT NULL DEFAULT '',
  corrective_action TEXT NOT NULL,
  appeal_status VARCHAR(40) NOT NULL DEFAULT '',
  appeal_date VARCHAR(20) NOT NULL DEFAULT '',
  appeal_notes TEXT NOT NULL,
  resolution_notes TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_claim (user_id, claim_id),
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS guided_runs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  case_id INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'started',
  step_idx INT NOT NULL DEFAULT 0,
  points INT NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL,
  completed_at DATETIME NULL,
  UNIQUE KEY uq_guided (user_id, case_id),
  INDEX idx_guided_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS payers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  payer_id VARCHAR(40) NOT NULL DEFAULT '',
  phone VARCHAR(40) NOT NULL DEFAULT '',
  website VARCHAR(160) NOT NULL DEFAULT '',
  user_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_name_user (name, user_id),
  INDEX idx_payers_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
  const adminPass = process.env.ADMIN_PASS || 'vip123';
  const adminEmail = adminUser; // login username, e.g. "admin"
  const hasAdmin = await get('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
  if (!hasAdmin) {
    await run('INSERT INTO users (name, email, pass_hash, role, created_at) VALUES (?,?,?,?,?)',
      ['Administrator', adminEmail, hashPassword(adminPass), 'admin', now()]);
    console.log(`[seed] admin created (login: ${adminUser})` +
      (process.env.ADMIN_PASS ? '' : '  <-- default password, set ADMIN_PASS env!'));
  } else if (process.env.RESET_ADMIN_PASS === '1') {
    // Owner-triggered recovery (no terminal needed): set RESET_ADMIN_PASS=1
    // + ADMIN_PASS=<new password>, redeploy, log in, then REMOVE the env var.
    // Resets password on every admin row; fixes the login email too when there
    // is exactly one admin (avoids UNIQUE(email) conflicts otherwise).
    const admins = await all("SELECT id, email FROM users WHERE role = 'admin' ORDER BY id");
    const hash = hashPassword(adminPass);
    for (const a of admins) await run('UPDATE users SET pass_hash = ? WHERE id = ?', [hash, a.id]);
    const wantEmail = adminEmail;
    if (admins.length === 1 && admins[0].email !== wantEmail)
      await run('UPDATE users SET email = ? WHERE id = ?', [wantEmail, admins[0].id]);
    console.log(`[seed] admin login RESET -> ${wantEmail}. Remove RESET_ADMIN_PASS now.`);
  }
  // No dummy patients — student creates their own practice data from scratch.
  // (Patient Registration case guides them through it.)

  // No dummy insurance — student adds their own practice coverage.

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
      } else {
        caseId = row.id;
        await run('UPDATE cases SET title=?,description=?,difficulty=?,category=?,points=?,sort=? WHERE id=?',
          [c.title, c.description || '', c.difficulty || 'Beginner',
           c.category || 'GENERAL', c.points || 50, c.sort || 0, caseId]);
      }
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

async function ensureColumn(table, col, ddlSql) {
  try {
    const cols = IS_MYSQL
      ? await all('SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])
      : await all(`PRAGMA table_info(${table})`).then(rs => rs.map(r => ({ n: r.name })));
    if (!cols.some(c => c.n === col)) await exec(`ALTER TABLE ${table} ADD COLUMN ${ddlSql}`);
  } catch (e) { /* best-effort */ }
}
async function initDb() {
  // auto-migration: create tables if missing
  const ddl = IS_MYSQL ? MYSQL_DDL : SQLITE_DDL;
  for (const stmt of ddl.split(/;\s*\n/).map(s => s.trim()).filter(Boolean))
    await exec(stmt + ';');
  // performance indexes (esp. MySQL — DDL has none)
  const INDEXES = [
    ['attempts', 'idx_attempts_user', '(user_id)'],
    ['attempts', 'idx_attempts_status', '(status)'],
    ['attempts', 'idx_attempts_started', '(started_at)'],
    ['attempts', 'idx_attempts_case', '(case_id)'],
    ['answers', 'idx_answers_attempt', '(attempt_id)'],
    ['answers', 'idx_answers_q', '(question_id)'],
    ['answers', 'idx_answers_at', '(answered_at)'],
    ['announcements', 'idx_ann_active', '(active)'],
    ['cases', 'idx_cases_active', '(active)'],
    ['claims', 'idx_claims_user', '(user_id)'],
    ['charges', 'idx_charges_user', '(user_id)'],
    ['lab_runs', 'idx_lab_runs_user', '(user_id)'],
    ['login_sessions', 'idx_sessions_user', '(user_id)'],
    ['activity_logs', 'idx_activity_created', '(created_at)'],
    ['denial_work', 'idx_denialwork_user', '(user_id)'],
    ['patients', 'idx_patients_user', '(user_id)'],
    ['patients', 'idx_patients_code_user', '(code, user_id)'],
    ['payers', 'idx_payers_user', '(user_id)'],
    ['ar_notes', 'idx_ar_notes_claim', '(claim_id)'],
  ];
  for (const [tbl, name, cols] of INDEXES) {
    try { await exec(`CREATE INDEX ${name} ON ${tbl} ${cols}`); }
    catch (e) { if (!/duplicate|exists/i.test(e.message)) throw e; }
  }
  // guarded column migration for pre-existing announcements tables
  const dt = IS_MYSQL ? 'DATETIME NULL' : 'TEXT';
  await ensureColumn('announcements', 'scheduled_at', `scheduled_at ${dt}`);
  await ensureColumn('announcements', 'target', `target ${IS_MYSQL ? 'TEXT' : 'TEXT'} NOT NULL DEFAULT 'all'`);
  await ensureColumn('announcements', 'pinned', `pinned ${IS_MYSQL ? 'TINYINT(1)' : 'INTEGER'} NOT NULL DEFAULT 0`);
  await ensureColumn('announcements', 'expires_at', `expires_at ${dt}`);
  await ensureColumn('announcements', 'placement', `placement ${IS_MYSQL ? 'VARCHAR(20)' : 'TEXT'} NOT NULL DEFAULT 'home'`);
  await ensureColumn('claims', 'validated_at', `validated_at ${dt}`);
  // ULTRA Group A: richer patient / insurance / eligibility data
  await ensureColumn('patients', 'email', `email ${IS_MYSQL ? 'VARCHAR(160)' : 'TEXT'} NOT NULL DEFAULT ''`);
  await ensureColumn('patients', 'address', `address ${IS_MYSQL ? 'VARCHAR(255)' : 'TEXT'} NOT NULL DEFAULT ''`);
  await ensureColumn('insurance', 'priority', `priority ${IS_MYSQL ? 'VARCHAR(20)' : 'TEXT'} NOT NULL DEFAULT 'primary'`);
  await ensureColumn('eligibility_checks', 'response_code', `response_code ${IS_MYSQL ? 'VARCHAR(10)' : 'TEXT'} NOT NULL DEFAULT '271'`);
  await ensureColumn('eligibility_checks', 'plan_type', `plan_type ${IS_MYSQL ? 'VARCHAR(40)' : 'TEXT'} NOT NULL DEFAULT ''`);
  await ensureColumn('eligibility_checks', 'deductible_met', `deductible_met ${IS_MYSQL ? 'DECIMAL(10,2)' : 'REAL'} NOT NULL DEFAULT 0`);
  await ensureColumn('eligibility_checks', 'coinsurance', `coinsurance ${IS_MYSQL ? 'DECIMAL(5,2)' : 'REAL'} NOT NULL DEFAULT 0`);
  await ensureColumn('eligibility_checks', 'notes', `notes TEXT NOT NULL DEFAULT ''`);
  // structured A/R follow-ups
  const txtd = IS_MYSQL ? "VARCHAR(40) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''";
  await ensureColumn('ar_notes', 'kind', `kind ${txtd}`);
  await ensureColumn('ar_notes', 'status', `status ${txtd}`);
  await ensureColumn('ar_notes', 'assigned_to', `assigned_to ${txtd}`);
  await ensureColumn('ar_notes', 'next_date', `next_date ${txtd}`);
  await ensureColumn('ar_notes', 'promise_amt', `promise_amt ${IS_MYSQL ? 'DECIMAL(12,2)' : 'REAL'} NOT NULL DEFAULT 0`);
  const vcd = IS_MYSQL ? "VARCHAR(24) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''";
  await ensureColumn('denial_work', 'denial_code', `denial_code ${vcd}`);
  await ensureColumn('denial_work', 'outcome', `outcome ${vcd}`);
  // per-student data isolation (security fix)
  await ensureColumn('patients', 'user_id', `user_id ${IS_MYSQL ? 'INT NULL' : 'INTEGER REFERENCES users(id)'}`);
  await ensureColumn('payers', 'user_id', `user_id ${IS_MYSQL ? 'INT NULL' : 'INTEGER REFERENCES users(id)'}`);
  await seed();
  // payer directory: backfill from distinct insurance payer names (idempotent, runs after seed)
  try {
    const dp = await all(`SELECT DISTINCT payer, user_id FROM insurance WHERE payer IS NOT NULL AND payer <> ''`);
    for (const r of dp) {
      try { await run('INSERT INTO payers (name, user_id, created_at) VALUES (?, ?, ?)', [r.payer, r.user_id || null, now()]); }
      catch (e) { if (!/duplicate|unique/i.test(e.message || '')) throw e; }
    }
  } catch (e) { if (!/duplicate|unique|no such table/i.test(e.message || '')) throw e; }
  console.log(`[db] engine=${ENGINE}` + (IS_MYSQL ? ` host=${process.env.DB_HOST || 'localhost'}` : ''));
}

// ---------- levels ----------
const LEVELS = [[500, 'Billing Executive'], [400, 'Senior Biller'], [250, 'Billing Specialist'], [100, 'Junior Biller'], [0, 'Beginner']];
function levelFor(points) {
  for (const [min, name] of LEVELS) if (points >= min) return name;
  return 'Beginner';
}

const _SQLITE_FILE = !IS_MYSQL ? path.join(
  process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data'), 'bill.db') : null;
module.exports = { all, get, run, insertIgnore, now, initDb, hashPassword, verifyPassword, levelFor, ENGINE, IS_MYSQL, SQLITE_FILE: _SQLITE_FILE };
