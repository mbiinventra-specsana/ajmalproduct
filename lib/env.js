// Env normalization — must be required BEFORE any other module reads process.env.
// NexPanel quirk: its "KEY=value, one per line" box is often filled as "KEY = value".
// If the panel does not trim, the variable arrives as key="KEY " / value=" value"
// and `process.env.KEY` is undefined. This maps them back to the clean names.
// Values are never logged.
(function normalizeEnv() {
  const KEYS = new Set([
    'DATA_DIR', 'ADMIN_USER', 'ADMIN_PASS', 'SESSION_SECRET', 'COOKIE_SECURE',
    'DB_ENGINE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASS', 'DB_NAME',
    'RESET_ADMIN_PASS', 'SKIP_AUTO_MIGRATE', 'SQLITE_SEARCH_PATHS', 'PORT',
  ]);
  for (const raw of Object.keys(process.env)) {
    const key = raw.trim();
    if (!KEYS.has(key)) continue;
    const val = String(process.env[raw]).trim();
    if (raw !== key) delete process.env[raw];
    if (!(key in process.env)) {
      process.env[key] = val;
      if (raw !== key) console.log(`[env] normalized "${raw}" -> "${key}"`);
    } else if (raw === key && process.env[key] !== val) {
      process.env[key] = val;
      console.log(`[env] trimmed value for "${key}"`);
    }
    // if an exact key already exists, it wins over a spaced duplicate — keep it.
  }
})();
