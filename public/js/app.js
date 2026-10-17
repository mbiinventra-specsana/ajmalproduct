// Shared frontend helpers — MbiInventra RCM Academy
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function currentUser() {
  try { return (await api('/api/me')).user; } catch { return null; }
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
// page-level feature gate: returns false + shows notice if the module is off for this student
function guardFeature(user, fkey, label) {
  if (!(user.disabledFeatures || []).includes(fkey)) return true;
  const back = (user.disabledFeatures || []).includes('workspace') ? '' :
    `<p><a href="/dashboard" style="color:#0e9f8a">← Back to Command Center</a></p>`;
  document.querySelector('.main').innerHTML = `<div class="empty" style="margin-top:80px;text-align:center">
    <h2>🔒 ${esc(label || 'This module')} is disabled</h2>
    <p>Your administrator has turned off this module for your account.</p>${back}</div>`;
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
  w.addEventListener('click', e => { if (e.target === w) closeModal(); });
  document.body.appendChild(w);
  if (onMount) onMount(w);
}
function closeModal() { const w = document.getElementById('mwrap'); if (w) w.remove(); }
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function shell(active, user) {
  const off = new Set(user.disabledFeatures || []); // per-student feature gates
  const nav = [
    ['workspace', 'Workspace', [
      ['dashboard', 'Command Center', '/dashboard', '🏠'],
      ['workqueue', 'Work Queue', '/work-queue', '📥'],
    ]],
    ['patients', 'Patients', [
      ['patients', 'Patients', '/patients', '🧑‍⚕️'],
      ['insurance', 'Insurance', '/insurance', '🛡️'],
      ['eligibility', 'Eligibility', '/eligibility', '✅'],
    ]],
    ['billing', 'Billing', [
      ['charges', 'Charge Entry', '/charges', '🧾'],
      ['claims', 'Claims', '/claims', '📄'],
    ]],
    ['revenue', 'Revenue Cycle', [
      ['payments', 'Payments', '/payments', '💳'],
      ['ar', 'A/R Follow-up', '/ar', '📊'],
      ['denialsq', 'Denials', '/denials', '🚫'],
      ['reports', 'Reports', '/reports', '📈'],
    ]],
    ['training', 'Training', [
      ['training', 'Case Center', '/training', '🎯'],
      ['assignments', 'Assignments', '/assignments', '📝'],
      ['lab', 'Practice Lab', '/lab', '🧪'],
      ['progress', 'My Progress', '/progress', '🏅'],
    ]],
    ['labs', 'Advanced Labs', [
      ['scrubber', 'Claim Scrubber', '/labs/scrubber', '🧹'],
      ['denials', 'Denial Crime-Scene', '/labs/denials', '🔍'],
      ['sprints', 'Coding Sprints', '/labs/sprints', '⚡'],
      ['quiz', 'Quiz Arena', '/labs/quiz', '🎲'],
    ]],
  ];
  if (user.role === 'admin' || user.role === 'instructor') {
    nav.push(['', 'Manage', [['owner', '👑 Owner Panel', '/owner', '👑']]]);
  }
  const shown = nav.filter(([f]) => !f || !off.has(f));
  document.getElementById('sidebar').innerHTML = `
    <div class="brand"><div class="mark">⚕</div><div>MbiInventra<small>bill.mbiinventra.com</small></div></div>
    <nav class="snav">${shown.map(([f, g, items]) => `
      <div class="grp">${g}</div>
      ${items.map(([k, label, href, e]) =>
        `<a href="${href}" class="${active === k ? 'on' : ''}"><span class="e">${e}</span>${label}</a>`).join('')}
    `).join('')}</nav>
    <div class="sfoot">
      <div style="margin-bottom:8px">👤 ${esc(user.name)}<br><span style="color:#7c8ea8;font-size:12px">${esc(user.role)}</span></div>
      <button class="btn btn-ghost btn-sm" onclick="logout()">Logout</button>
      <div style="margin-top:10px"><span class="badge-fict">TRAINING MODE · fictional data</span></div>
    </div>`;
}
// Admin-only sidebar for the Owner Panel — no student items.
function adminShell(active, user) {
  const nav = [
    ['Admin', [
      ['owner', 'Dashboard', '/owner', '👑'],
      ['analytics', 'Analytics', '/owner#analytics', '📊'],
      ['accounts', 'Accounts', '/owner#users', '👥'],
      ['announce', 'Announcements', '/owner#announce', '📢'],
      ['sessions', 'Sessions', '/owner#sessions', '💻'],
      ['syshealth', 'System health', '/owner#syshealth', '🖥️'],
    ]],
  ]; // pure admin — no student items here
  document.getElementById('sidebar').innerHTML = `
    <div class="brand"><div class="mark">👑</div><div>MbiInventra<small>owner console</small></div></div>
    <nav class="snav">${nav.map(([g, items]) => `
      <div class="grp">${g}</div>
      ${items.map(([k, label, href, e]) =>
        `<a href="${href}" class="${active === k ? 'on' : ''}"><span class="e">${e}</span>${label}</a>`).join('')}
    `).join('')}</nav>
    <div class="sfoot">
      <div style="margin-bottom:8px">👤 ${esc(user.name)}<br><span style="color:#7c8ea8;font-size:12px">${esc(user.role)}</span></div>
      <button class="btn btn-ghost btn-sm" onclick="logout()">Logout</button>
      <div style="margin-top:10px"><span class="badge-fict">TRAINING MODE · fictional data</span></div>
    </div>`;
}
