// Loads env vars from a .env FILE. Must run before any module reads process.env.
// Why: NexPanel's "Environment variables" box only SAVES vars to an env file on
// deploy — it does not reliably inject them into the node process (verified
// 2026-10-17: a freshly deployed app saw ZERO of the configured vars, which is
// why ADMIN_PASS/DB_ENGINE/etc. never took effect). dotenv covers the file case;
// real process env (if ever present) always wins over file values.
// Never logs values.
const fs = require('fs');
const path = require('path');

let found = null;
try {
  const dotenv = require('dotenv');
  const cands = [];
  if (process.env.ENV_FILE) cands.push(process.env.ENV_FILE);
  let d = __dirname; // lib/
  cands.push(path.join(d, '.env'));
  for (let i = 0; i < 3; i++) { d = path.dirname(d); cands.push(path.join(d, '.env')); }
  const seen = new Set();
  for (const p of cands) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (fs.existsSync(p)) {
      dotenv.config({ path: p }); // does not override existing process env
      if (!found) found = p;
    }
  }
  if (found) console.log(`[env] loaded env file: ${found}`);
  else console.log('[env] WARNING: no .env file found and process env has no config vars — check NexPanel env setup.');
} catch (e) {
  console.log('[env] dotenv unavailable, using process env only.');
}

module.exports = { found };
