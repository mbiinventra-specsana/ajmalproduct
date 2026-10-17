// SQLite -> MySQL one-time migration (shared by the CLI script and auto-migrate on boot).
// Copies student accounts + all training data, remapping foreign keys.
// Safe to re-run: existing users/data are detected and skipped.
const path = require('path');
const fs = require('fs');

// MySQL DATETIME needs 'YYYY-MM-DD HH:MM:SS' (no T, no Z, no millis)
const dt = v => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 19).replace('T', ' ') : s.slice(0, 19);
};

async function migrateSqliteToMysql(sqliteFile, dbCfg) {
  const Database = require('better-sqlite3');
  const lite = new Database(sqliteFile, { readonly: true });
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection(dbCfg);
  try {
    const [t] = await conn.execute("SHOW TABLES LIKE 'users'");
    if (!t.length) throw new Error("MySQL 'users' table missing — schema not created yet.");

    const q = async (sql, p = []) => (await conn.execute(sql, p))[0];
    const liteAll = (sql, p = []) => lite.prepare(sql).all(...p);
    const counts = {};

    const myUsers = Object.fromEntries((await q('SELECT id, email FROM users')).map(r => [r.email, r.id]));
    const myCases = Object.fromEntries((await q('SELECT id, code FROM cases')).map(r => [r.code, r.id]));
    const myQuestions = {};
    for (const r of await q('SELECT questions.id, cases.code AS cc, questions.qnum FROM questions JOIN cases ON cases.id = questions.case_id'))
      myQuestions[r.cc + '#' + r.qnum] = r.id;

    // ---- users ----
    const userMap = {};
    for (const u of liteAll('SELECT * FROM users')) {
      if (myUsers[u.email]) { userMap[u.id] = myUsers[u.email]; counts.usersSkipped = (counts.usersSkipped || 0) + 1; continue; }
      const r = await conn.execute(
        'INSERT INTO users (name, email, pass_hash, role, created_at, last_login) VALUES (?,?,?,?,?,?)',
        [u.name, u.email, u.pass_hash, u.role, dt(u.created_at), dt(u.last_login)]);
      userMap[u.id] = r[0].insertId;
      counts.users = (counts.users || 0) + 1;
    }

    const hasRows = async (tbl, mid) => (await q(`SELECT COUNT(*) AS n FROM ${tbl} WHERE user_id = ?`, [mid]))[0].n > 0;

    // ---- attempts + answers ----
    const attemptMap = {};
    for (const [sid, mid] of Object.entries(userMap)) {
      if (await hasRows('attempts', mid)) continue;
      for (const a of liteAll('SELECT * FROM attempts WHERE user_id = ?', [Number(sid)])) {
        const caseCode = lite.prepare('SELECT code FROM cases WHERE id = ?').get(a.case_id)?.code;
        const mcase = myCases[caseCode];
        if (!mcase) continue;
        const r = await conn.execute(
          'INSERT INTO attempts (user_id, case_id, status, score, max_score, started_at, completed_at) VALUES (?,?,?,?,?,?,?)',
          [mid, mcase, a.status, a.score, a.max_score, dt(a.started_at), dt(a.completed_at)]);
        attemptMap[a.id] = r[0].insertId;
        counts.attempts = (counts.attempts || 0) + 1;
        for (const an of liteAll('SELECT * FROM answers WHERE attempt_id = ?', [a.id])) {
          const qq = lite.prepare('SELECT cases.code AS cc, questions.qnum FROM questions JOIN cases ON cases.id = questions.case_id WHERE questions.id = ?').get(an.question_id);
          const mq = myQuestions[qq.cc + '#' + qq.qnum];
          if (!mq) continue;
          await conn.execute(
            'INSERT INTO answers (attempt_id, question_id, chosen_idx, correct, points_earned, answered_at) VALUES (?,?,?,?,?,?)',
            [attemptMap[a.id], mq, an.chosen_idx, an.correct, an.points_earned, dt(an.answered_at)]);
          counts.answers = (counts.answers || 0) + 1;
        }
      }
    }

    const copySimple = async (tbl, cols, fkCols = {}) => {
      for (const [sid, mid] of Object.entries(userMap)) {
        if (await hasRows(tbl, mid)) continue;
        for (const r of liteAll(`SELECT * FROM ${tbl} WHERE user_id = ?`, [Number(sid)])) {
          const vals = cols.map(c => {
            if (c === 'user_id') return mid;
            if (fkCols[c]) return fkCols[c](r[c]);
            if (/(_at|effective)$/.test(c)) return dt(r[c]);
            return r[c];
          });
          await conn.execute(`INSERT INTO ${tbl} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
          counts[tbl] = (counts[tbl] || 0) + 1;
        }
      }
    };

    await copySimple('lab_runs', ['user_id', 'lab_key', 'score', 'max_score', 'detail', 'created_at']);
    await copySimple('eligibility_checks', ['user_id', 'patient_code', 'payer', 'service', 'coverage', 'copay', 'deductible', 'result', 'created_at']);

    for (const [sid, mid] of Object.entries(userMap)) {
      if (await hasRows('insurance', mid)) continue;
      for (const r of liteAll('SELECT * FROM insurance WHERE user_id = ?', [Number(sid)])) {
        await conn.execute(
          'INSERT INTO insurance (user_id, patient_code, payer, member_id, plan, type, status, effective, copay, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [mid, r.patient_code, r.payer, r.member_id, r.plan, r.type, r.status, r.effective, r.copay, dt(r.created_at)]);
        counts.insurance = (counts.insurance || 0) + 1;
      }
    }

    // ---- claims (id map needed by charges/payments/notes) ----
    const claimMap = {};
    for (const [sid, mid] of Object.entries(userMap)) {
      if (await hasRows('claims', mid)) {
        for (const r of liteAll('SELECT id, claim_no FROM claims WHERE user_id = ?', [Number(sid)])) {
          const m = await q('SELECT id FROM claims WHERE claim_no = ? AND user_id = ?', [r.claim_no, mid]);
          if (m[0]) claimMap[r.id] = m[0].id;
        }
        continue;
      }
      for (const c of liteAll('SELECT * FROM claims WHERE user_id = ?', [Number(sid)])) {
        const r = await conn.execute(
          `INSERT INTO claims (user_id, claim_no, patient_code, payer, cpt, icd, modifier, dos, billed,
           allowed, paid, adjustment, patient_resp, status, validation, denial_code, follow_up, submitted_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [mid, c.claim_no, c.patient_code, c.payer, c.cpt, c.icd, c.modifier, c.dos, c.billed,
           c.allowed, c.paid, c.adjustment, c.patient_resp, c.status, c.validation, c.denial_code,
           c.follow_up, dt(c.submitted_at), dt(c.created_at)]);
        claimMap[c.id] = r[0].insertId;
        counts.claims = (counts.claims || 0) + 1;
      }
    }
    const cmap = sid => (sid === null || sid === undefined ? null : (claimMap[sid] ?? null));

    await copySimple('charges', ['user_id', 'patient_code', 'provider', 'dos', 'cpt', 'icd', 'modifier', 'units', 'amount', 'status', 'claim_id', 'created_at'], { claim_id: cmap });
    await copySimple('payments', ['user_id', 'claim_id', 'paid', 'adjustment', 'patient_resp', 'method', 'created_at'], { claim_id: cmap });
    await copySimple('ar_notes', ['user_id', 'claim_id', 'note', 'created_at'], { claim_id: cmap });

    return counts;
  } finally {
    await conn.end();
    lite.close();
  }
}

// Auto-migrate on boot: only when running on MySQL, a SQLite bill.db with
// student users exists, and MySQL has no student users yet. Set
// SKIP_AUTO_MIGRATE=1 to disable.
async function maybeAutoMigrate(db) {
  if (process.env.SKIP_AUTO_MIGRATE === '1') return;
  if ((process.env.DB_ENGINE || 'sqlite').toLowerCase() !== 'mysql') return;
  try {
    const DATA_DIR = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.join(__dirname, '..', 'data');
    const sqliteFile = path.join(DATA_DIR, 'bill.db');
    if (!fs.existsSync(sqliteFile)) return;
    const myStudents = await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'student'");
    if (myStudents && myStudents.n > 0) return; // already migrated (or fresh)
    const Database = require('better-sqlite3');
    const lite = new Database(sqliteFile, { readonly: true });
    let liteStudents = 0;
    try { liteStudents = lite.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student'").get().n; }
    catch { /* table missing */ }
    lite.close();
    if (!liteStudents) return;
    console.log(`[migrate] auto-migrating ${liteStudents} student(s) from SQLite to MySQL…`);
    const counts = await migrateSqliteToMysql(sqliteFile, {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
    });
    console.log('[migrate] auto-migration complete:', JSON.stringify(counts));
  } catch (e) {
    console.error('[migrate] auto-migration failed (app continues on MySQL):', e.message);
  }
}

module.exports = { migrateSqliteToMysql, maybeAutoMigrate };
