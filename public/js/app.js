// Shared frontend helpers — MbiInventra RCM Academy
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'Request failed'); e.status = r.status; Object.assign(e, data); throw e; }
  return data;
}
async function currentUser() {
  try { const u = (await api('/api/me')).user; window._fnUser = u; return u; }
  catch { return null; }
}
async function requireLogin() {
  const u = await currentUser();
  if (!u) { location.href = '/login'; return null; }
  return u;
}
async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  location.href = '/';
}
// page-level feature gate: accepts a menu ITEM key (granular) or a group key (legacy)
// returns false + shows notice if off for this student
function guardFeature(user, fkey, label) {
  const off = new Set(user.disabledFeatures || []);
  const blocked = ITEM_GROUP[fkey]
    ? (off.has('menu:' + fkey) || off.has(ITEM_GROUP[fkey]))
    : off.has(fkey);
  if (!blocked) return true;
  const back = off.has('workspace') ? '' :
    `<p><a href="/dashboard" style="color:#0e9f8a">← Back to Command Center</a></p>`;
  document.querySelector('.main').innerHTML = `<div class="empty" style="margin-top:80px;text-align:center">
    <h2>🔒 ${esc(label || 'This menu item')} is disabled</h2>
    <p>Your administrator has turned off this menu item for your account.</p>${back}</div>`;
  return false;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function openModal(title, bodyHTML, onMount) {
  closeModal();
  const w = document.createElement('div');
  w.className = 'mwrap'; w.id = 'mwrap';
  w.innerHTML = `<div class="mbox"><div class="mhead"><b>${esc(title)}</b><button class="mx" onclick="closeModal()">✕</button></div><div class="mbody"></div></div>`;
  w.querySelector('.mbody').innerHTML = bodyHTML;
  if (window._fnUser) applyFnGates(window._fnUser); // hide disabled-function buttons in modals
  w.addEventListener('click', e => { if (e.target === w) closeModal(); });
  document.body.appendChild(w);
  if (onMount) onMount(w);
}
function closeModal() { const w = document.getElementById('mwrap'); if (w) w.remove(); }
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- professional SVG icon set (stroke style, Midnight Teal theme) ----
const _svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const I = {
  grid: _svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  inbox: _svg('<path d="M22 12h-5l-2 3h-6l-2-3H2"/><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.5z"/>'),
  users: _svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
  shield: _svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
  check: _svg('<circle cx="12" cy="12" r="10"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/>'),
  receipt: _svg('<path d="M5 3h14v18l-2.3-1.5L14.4 21l-2.4-1.5L9.6 21l-2.3-1.5L5 21z"/><path d="M9 8h6M9 12h6"/>'),
  file: _svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>'),
  card: _svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>'),
  trend: _svg('<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>'),
  ban: _svg('<circle cx="12" cy="12" r="10"/><path d="m5 5 14 14"/>'),
  chart: _svg('<path d="M18 20V10M12 20V4M6 20v-6"/>'),
  target: _svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
  clip: _svg('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/>'),
  flask: _svg('<path d="M9 3h6M10 3v6L4.5 19a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 9V3"/><path d="M7 15h10"/>'),
  award: _svg('<circle cx="12" cy="9" r="6"/><path d="m8.5 14-1.5 7 5-3 5 3-1.5-7"/>'),
  spark: _svg('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.5"/>'),
  search: _svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  zap: _svg('<path d="M13 2 3 14h8l-1 8 10-12h-8z"/>'),
  help: _svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4"/><circle cx="12" cy="17.5" r=".5" fill="currentColor"/>'),
  crown: _svg('<path d="m3 8 4 4 5-6 5 6 4-4-1.5 10h-15z"/><path d="M5 21h14"/>'),
  mega: _svg('<path d="m3 11 18-7-7 18-2.5-7.5z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>'),
  monitor: _svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  pulse: _svg('<path d="M22 12h-4l-3 8-6-16-3 8H2"/>'),
  list: _svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>'),
  sliders: _svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>'),
};
// menu item → group mapping (mirrors MENU_ITEMS in server.js)
const ITEM_GROUP = {
  dashboard: 'workspace', workqueue: 'workspace',
  patients: 'patients', insurance: 'patients', eligibility: 'patients',
  charges: 'billing', claims: 'billing',
  payments: 'revenue', ar: 'revenue', denialsq: 'revenue', reports: 'revenue',
  training: 'training', assignments: 'training', lab: 'training', progress: 'training',
  scrubber: 'labs', denials: 'labs', sprints: 'labs', quiz: 'labs',
};
// true if a menu item is off for this student (item key checked first, then group)
function itemOff(user, itemKey) {
  const off = new Set(user.disabledFeatures || []);
  return off.has('menu:' + itemKey) || off.has(ITEM_GROUP[itemKey]);
}
// hide buttons/elements by id when a per-student FUNCTION is disabled (fn:<key>)
function hideFn(user, fnKey, ...ids) {
  if ((user.disabledFeatures || []).includes('fn:' + fnKey)) {
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  }
}
// declarative function gating: any element with data-fn="<key>" is hidden when that
// function is disabled for the student. Runs on page load and after each modal opens.
function applyFnGates(user) {
  const off = new Set(user.disabledFeatures || []);
  const scope = document;
  scope.querySelectorAll('[data-fn]').forEach(el => {
    if (off.has('fn:' + el.dataset.fn)) el.style.display = 'none';
  });
}
// auto-gate dynamically rendered [data-fn] elements (tables, quiz stages, etc.)
(function initFnObserver() {
  const start = () => {
    if (!window.MutationObserver || !document.body) return;
    new MutationObserver(muts => {
      const u = window._fnUser;
      if (!u) return;
      const off = new Set(u.disabledFeatures || []);
      for (const m of muts) for (const n of m.addedNodes) {
        if (!n || n.nodeType !== 1) continue;
        const els = n.matches && n.matches('[data-fn]') ? [n] : (n.querySelectorAll ? [...n.querySelectorAll('[data-fn]')] : []);
        els.forEach(el => { if (off.has('fn:' + el.dataset.fn)) el.style.display = 'none'; });
      }
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
function shell(active, user) {
  const off = new Set(user.disabledFeatures || []); // per-student feature gates
  const nav = [
    ['workspace', 'Workspace', [
      ['dashboard', 'Command Center', '/dashboard', 'grid'],
      ['workqueue', 'Work Queue', '/work-queue', 'inbox'],
    ]],
    ['patients', 'Patients', [
      ['patients', 'Patients', '/patients', 'users'],
      ['insurance', 'Insurance', '/insurance', 'shield'],
      ['eligibility', 'Eligibility', '/eligibility', 'check'],
    ]],
    ['billing', 'Billing', [
      ['charges', 'Charge Entry', '/charges', 'receipt'],
      ['claims', 'Claims', '/claims', 'file'],
    ]],
    ['revenue', 'Revenue Cycle', [
      ['payments', 'Payments', '/payments', 'card'],
      ['ar', 'A/R Follow-up', '/ar', 'trend'],
      ['denialsq', 'Denials', '/denials', 'ban'],
      ['reports', 'Reports', '/reports', 'chart'],
    ]],
    ['training', 'Training', [
      ['training', 'Case Center', '/training', 'target'],
      ['assignments', 'Assignments', '/assignments', 'clip'],
      ['lab', 'Practice Lab', '/lab', 'flask'],
      ['progress', 'My Progress', '/progress', 'award'],
    ]],
    ['labs', 'Advanced Labs', [
      ['scrubber', 'Claim Scrubber', '/labs/scrubber', 'spark'],
      ['denials', 'Denial Crime-Scene', '/labs/denials', 'search'],
      ['sprints', 'Coding Sprints', '/labs/sprints', 'zap'],
      ['quiz', 'Quiz Arena', '/labs/quiz', 'help'],
    ]],
  ];
  if (user.role === 'admin' || user.role === 'instructor') {
    nav.push(['', 'Manage', [['owner', 'Owner Panel', '/owner', 'crown']]]);
  }
  const shown = nav
    .filter(([f]) => !f || !off.has(f))
    .map(([f, g, items]) => [f, g, items.filter(([k]) => !itemOff(user, k))])
    .filter(([, , items]) => items.length); // hide group header when all its items are off
  document.getElementById('sidebar').innerHTML = `
    <div class="brand"><div class="mark">${I.grid}</div><div>MbiInventra<small>bill.mbiinventra.com</small></div></div>
    <nav class="snav">${shown.map(([f, g, items]) => `
      <div class="grp">${g}</div>
      ${items.map(([k, label, href, ic]) =>
        `<a href="${href}" class="${active === k ? 'on' : ''}"><span class="ic">${I[ic] || ''}</span><span class="lbl">${label}</span></a>`).join('')}
    `).join('')}</nav>
    <div class="sfoot">
      <div class="uinfo"><span class="uavatar">${esc((user.name || 'U')[0].toUpperCase())}</span><div>👤 ${esc(user.name)}<br><span class="urole">${esc(user.role)}</span></div></div>
      <button class="btn btn-ghost btn-sm" onclick="logout()">Logout</button>
      <div style="margin-top:10px"><span class="badge-fict">TRAINING MODE</span></div>
    </div>`;
  applyFnGates(user); // hide buttons for disabled per-student functions
}
// Admin-only sidebar for the Owner Panel — no student items.
function adminShell(active, user) {
  const nav = [
    ['Admin', [
      ['owner', 'dashboard', 'Dashboard', '/owner', 'crown'],
      ['analytics', 'analytics', 'Analytics', '/owner/analytics', 'chart'],
      ['accounts', 'accounts', 'Accounts', '/owner/accounts', 'users'],
      ['announce', 'announce', 'Announcements', '/owner/announce', 'mega'],
      ['menus', 'menus', 'Menu Control', '/owner/menus', 'sliders'],
      ['sessions', 'sessions', 'Sessions', '/owner/sessions', 'monitor'],
      ['activity', 'activity', 'Activity', '/owner/activity', 'list'],
      ['syshealth', 'system', 'System health', '/owner/system', 'pulse'],
    ]],
  ]; // pure admin — no student items here
  document.getElementById('sidebar').innerHTML = `
    <div class="brand"><div class="mark">${I.crown}</div><div>MbiInventra<small>owner console</small></div></div>
    <nav class="snav">${nav.map(([g, items]) => `
      <div class="grp">${g}</div>
      ${items.map(([k, sec, label, href, ic]) =>
        `<a href="${href}" data-sec="${sec}" onclick="ownerGo('${sec}',this);return false;" class="${active === k ? 'on' : ''}" style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;font-size:14px;font-weight:500;color:#a9bdd6;text-decoration:none;margin-bottom:2px"><span class="ic" style="width:20px;height:20px;flex:none;display:flex;align-items:center;justify-content:center">${I[ic] || ''}</span><span class="lbl" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</span></a>`).join('')}
    `).join('')}</nav>
    <div class="sfoot">
      <div class="uinfo"><span class="uavatar">${esc((user.name || 'U')[0].toUpperCase())}</span><div>👤 ${esc(user.name)}<br><span class="urole">${esc(user.role)}</span></div></div>
      <button class="btn btn-ghost btn-sm" onclick="logout()">Logout</button>
      <div style="margin-top:10px"><span class="badge-fict">TRAINING MODE · fictional data</span></div>
    </div>`;
}
