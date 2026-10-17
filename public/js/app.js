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
  location.href = '/login';
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(active, user) {
  const nav = [
    ['Workspace', [
      ['dashboard', 'Dashboard', '/dashboard', '🏠'],
      ['progress', 'My Progress', '/progress', '📊'],
    ]],
    ['Training', [
      ['training', 'Case Center', '/training', '🎯'],
      ['lab', 'Practice Lab', '/lab', '🧪'],
    ]],
    ['Advanced Labs', [
      ['scrubber', 'Claim Scrubber', '/labs/scrubber', '🧹'],
      ['denials', 'Denial Crime-Scene', '/labs/denials', '🔍'],
      ['sprints', 'Coding Sprints', '/labs/sprints', '⚡'],
      ['quiz', 'Quiz Arena', '/labs/quiz', '🎲'],
    ]],
  ];
  if (user.role === 'admin' || user.role === 'instructor') {
    nav.push(['Manage', [['owner', '👑 Owner Panel', '/owner', '👑']]]);
  }
  document.getElementById('sidebar').innerHTML = `
    <div class="brand"><div class="mark">⚕</div><div>MbiInventra<small>bill.mbiinventra.com</small></div></div>
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
