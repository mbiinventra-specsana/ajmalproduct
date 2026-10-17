#!/usr/bin/env node
// One-time migration: SQLite bill.db -> MySQL (for switching DB_ENGINE to mysql).
// The app must have booted ONCE with DB_ENGINE=mysql first (it auto-creates
// tables + seed data). Safe to re-run: existing users/data are skipped.
// NOTE: the app also auto-migrates on boot, so this script is only needed
// for manual control.
//
// Usage (on the server, in the project dir):
//   DATA_DIR=/home/bill.mbiinventra.com/rcm-data \
//   DB_HOST=localhost DB_PORT=3306 DB_USER=jkfjkfj DB_PASS='yourpass' DB_NAME=kjsfkdf \
//   node scripts/migrate-sqlite-to-mysql.js
//
const path = require('path');
const fs = require('fs');
const { migrateSqliteToMysql } = require('../lib/migrate');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const SQLITE_FILE = path.join(DATA_DIR, 'bill.db');

async function main() {
  if (!fs.existsSync(SQLITE_FILE)) {
    console.error(`SQLite file not found: ${SQLITE_FILE}\nSet DATA_DIR to the folder containing bill.db.`);
    process.exit(1);
  }
  const cfg = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  };
  if (!cfg.user || !cfg.password || !cfg.database) {
    console.error('Set DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME env vars.');
    process.exit(1);
  }
  const counts = await migrateSqliteToMysql(SQLITE_FILE, cfg);
  console.log('Migration complete:', JSON.stringify(counts, null, 2));
  console.log('Note: cases/questions/patients/global insurance are seeded by the app — not copied.');
}

main().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
