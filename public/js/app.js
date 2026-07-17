// public/js/app.js — PrintKinetix SPA (Router + Pages + Components)

// ===== UTILITY =====
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
const html = (strings, ...vals) => strings.reduce((r, s, i) => r + s + (vals[i] ?? ''), '');
const api = window.api;

function toast(message, type = 'info') {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

window.toast = toast;

window.showModal = function (content) {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');
  modal.innerHTML = content;
  overlay.classList.add('active');
  overlay.onclick = (e) => { if (e.target === overlay) hideModal(); };
}

window.hideModal = function () {
  $('#modal-overlay').classList.remove('active');
}

// ===== SHARED COLOR PICKER =====
// One picker for the slicer, the printer AMS trays and the order color
// pairings: built-in palette + saved "Custom colors" + a full-spectrum
// <input type=color> with save-to-custom. onPick(hex '#rrggbb', name).
window.showColorPickerModal = async function ({ current = '#22d3ee', title = 'Pick a color', onPick } = {}) {
  let customs = [];
  try { customs = await api.getCustomColors(); } catch { /* older server */ }
  let curHex = /^#[0-9a-fA-F]{6}$/.test(current) ? current.toLowerCase() : '#22d3ee';
  let curName = '';

  const swBtn = (c, extra = '') => html`<button type="button" class="cp-swatch" data-hex="${c.hex}" data-name="${(c.name || '').replace(/"/g, '&quot;')}" title="${c.name}"
    style="width:26px;height:26px;border-radius:6px;border:2px solid rgba(127,127,127,0.35);background:${c.hex};cursor:pointer;padding:0;${extra}"></button>`;

  const customsHtml = () => customs.length
    ? customs.map(c => html`<span style="position:relative;display:inline-block;">${swBtn(c)}
        <button type="button" class="cp-del" data-hex="${c.hex}" title="Delete ${c.name}"
          style="position:absolute;top:-7px;right:-7px;width:15px;height:15px;line-height:11px;font-size:9px;border-radius:50%;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--danger);cursor:pointer;padding:0;">✕</button>
      </span>`).join('')
    : '<span style="font-size:0.75rem;color:var(--text-muted);">None saved yet — pick a color below and hit 💾.</span>';

  showModal(html`
    <h3 style="margin-bottom:0.9rem;">🎨 ${title}</h3>
    <div class="form-group"><label>Default colors</label>
      <div style="display:flex;flex-wrap:wrap;gap:5px;">${SLICER_COLOR_FALLBACK.map(c => swBtn(c)).join('')}</div></div>
    <div class="form-group"><label>Custom colors</label>
      <div style="display:flex;flex-wrap:wrap;gap:8px;" id="cp-customs">${customsHtml()}</div></div>
    <div class="form-group"><label>Full spectrum</label>
      <div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;">
        <input type="color" id="cp-spectrum" value="${curHex}" style="width:64px;height:44px;padding:2px;border:1px solid var(--border-color);border-radius:var(--radius-md);background:var(--bg-tertiary);cursor:pointer;">
        <input class="form-control" id="cp-hex" value="${curHex}" style="max-width:110px;font-family:monospace;">
        <span id="cp-preview" style="display:inline-flex;align-items:center;gap:0.4rem;font-size:0.8rem;color:var(--text-muted);">
          <span id="cp-preview-sw" style="width:22px;height:22px;border-radius:6px;border:1px solid var(--border-color);background:${curHex};display:inline-block;"></span>
          <span id="cp-preview-name"></span>
        </span>
      </div></div>
    <div class="form-group" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
      <input class="form-control" id="cp-save-name" placeholder="Name it (e.g. Shop Orange)" style="max-width:200px;">
      <button class="btn btn-sm" id="cp-save">💾 Save to Custom colors</button>
    </div>
    <div class="btn-group" style="margin-top:0.75rem;">
      <button class="btn btn-primary" id="cp-use">✔ Use this color</button>
      <button class="btn" onclick="hideModal()">Cancel</button>
    </div>
  `);

  const setCur = (hex, name) => {
    curHex = hex.toLowerCase(); curName = name || '';
    $('#cp-spectrum').value = curHex;
    $('#cp-hex').value = curHex;
    $('#cp-preview-sw').style.background = curHex;
    $('#cp-preview-name').textContent = curName || curHex;
  };
  const bindSwatches = () => {
    $$('.cp-swatch').forEach(b => { b.onclick = () => setCur(b.dataset.hex, b.dataset.name); });
    $$('.cp-del').forEach(b => {
      b.onclick = async (e) => {
        e.stopPropagation();
        try {
          await api.deleteCustomColor(b.dataset.hex);
          customs = customs.filter(c => c.hex !== b.dataset.hex);
          $('#cp-customs').innerHTML = customsHtml();
          bindSwatches();
        } catch (err) { toast(err.message, 'error'); }
      };
    });
  };
  bindSwatches();
  setCur(curHex, '');
  $('#cp-spectrum').oninput = () => setCur($('#cp-spectrum').value, '');
  $('#cp-hex').onchange = () => {
    const v = $('#cp-hex').value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(v)) setCur(v.startsWith('#') ? v : '#' + v, '');
    else { toast('Hex must be #RRGGBB', 'warning'); $('#cp-hex').value = curHex; }
  };
  $('#cp-save').onclick = async () => {
    try {
      const name = $('#cp-save-name').value.trim() || curHex;
      const r = await api.saveCustomColor(name, curHex);
      customs = [{ name: r.color.name, hex: r.color.hex }, ...customs.filter(c => c.hex !== r.color.hex)];
      $('#cp-customs').innerHTML = customsHtml();
      bindSwatches();
      curName = r.color.name;
      $('#cp-preview-name').textContent = curName;
      toast(`Saved "${r.color.name}" to Custom colors`, 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#cp-use').onclick = () => {
    hideModal();
    if (onPick) onPick(curHex, curName || curHex);
  };
};

function timeAgo(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function statusBadge(status) {
  const colors = {
    idle: 'var(--success)', printing: 'var(--primary)', paused: 'var(--warning)',
    queued: 'var(--text-muted)', assigned: 'var(--accent-secondary)', completed: 'var(--success)',
    failed: 'var(--danger)', error: 'var(--danger)', blocked: 'var(--danger)',
    cancelled: 'var(--text-muted)', unknown: 'var(--text-muted)',
    offline: 'var(--text-muted)',
  };
  const c = colors[status] || 'var(--text-muted)';
  return `<span style="display:inline-flex;align-items:center;gap:0.3rem;font-size:0.78rem;font-weight:600;color:${c};"><span style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block;${status === 'blocked' ? 'animation:pulse 1.5s infinite;' : ''}"></span>${status}</span>`;
}

function formatEjectMode(mode) {
  if (mode === 'printhead_push') return 'Print Head Sweep';
  return mode;
}

// ===== HEADER COMPONENT =====
function renderHeader() {
  const header = document.createElement('header');
  header.className = 'app-header';
  header.innerHTML = html`
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="url(#grad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#22d3ee"/>
            <stop offset="50%" stop-color="#818cf8"/>
            <stop offset="100%" stop-color="#c084fc"/>
            <animate attributeName="x1" values="0%;100%;0%" dur="3s" repeatCount="indefinite" />
            <animate attributeName="x2" values="100%;200%;100%" dur="3s" repeatCount="indefinite" />
          </linearGradient>
        </defs>
        <path d="M4 12c0-4.4 3.6-8 8-8s8 3.6 8 8"/>
        <path d="M12 4v16"/>
        <path d="M4 12c2.2 0 4-1.8 4-4s-1.8-4-4-4"/>
        <path d="M20 12c-2.2 0-4 1.8-4 4s1.8 4 4 4"/>
      </svg>
      PrintKinetix
    </div>
    <nav>
      <a href="#/" data-route="/">Dashboard</a>
      <a href="#/printers" data-route="/printers">Printers</a>
      <a href="#/accessories" data-route="/accessories">Accessories</a>
      <a href="#/jobs" data-route="/jobs">Jobs</a>
      <a href="#/slicer" data-route="/slicer">Slicer</a>
      <a href="#/prints" data-route="/prints">Prints</a>
      <a href="#/profiles" data-route="/profiles">Profiles</a>
      <a href="#/timeline" data-route="/timeline">Timeline</a>
    </nav>
    <div class="header-actions">
      <button class="btn btn-sm btn-outline" onclick="showTunnelModal()" title="Remote Access">
        <span>🌐</span> <span class="desktop-only">Remote Access</span>
      </button>
      <button class="btn btn-sm" onclick="confirmLogout()">Logout</button>
    </div>
  `;

  const logo = header.querySelector('.logo');
  logo.addEventListener('click', () => {
    logo.classList.add('clicked');
    setTimeout(() => logo.classList.remove('clicked'), 150);
    window.location.hash = '#/';
  });

  return header;
}

// ===== ROUTER =====
const routes = {};
function route(path, handler) { routes[path] = handler; }

async function navigateTo(path) {
  if (!window.api.isAuthenticated && path !== '/login') {
    window.location.hash = '#/login';
    return;
  }

  const appEl = $('#app');
  // Render header if not login
  if (path !== '/login') {
    if (!$('.app-header', appEl)) {
      appEl.innerHTML = '';
      appEl.appendChild(renderHeader());
      const main = document.createElement('main');
      main.className = 'main-content';
      main.id = 'page-content';
      appEl.appendChild(main);
    }
    // Update active nav
    $$('.app-header nav a').forEach(a => {
      a.classList.toggle('active', a.dataset.route === path || (path.startsWith(a.dataset.route) && a.dataset.route !== '/'));
    });
    if (path === '/') $$('.app-header nav a').forEach(a => a.classList.toggle('active', a.dataset.route === '/'));
  }

  const contentEl = path === '/login' ? appEl : $('#page-content');
  if (!contentEl) return;

  // Match route
  let handler = routes[path];
  let params = {};
  if (!handler) {
    for (const [pattern, h] of Object.entries(routes)) {
      const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
      const match = path.match(regex);
      if (match) { handler = h; params = match.groups || {}; break; }
    }
  }

  if (handler) {
    contentEl.innerHTML = '<div class="loading-overlay"><div class="spinner"></div> Loading...</div>';
    try {
      await handler(contentEl, params);
    } catch (err) {
      contentEl.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${err.message}</p></div>`;
      toast(err.message, 'error');
    }
  } else {
    contentEl.innerHTML = '<div class="empty-state"><h3>404</h3><p>Page not found</p></div>';
  }
}

window.navigateTo = navigateTo;

// ===== GLOBAL INLINE-HANDLER TARGETS =====
// These are referenced from inline onclick="..." attributes, which execute in the
// global scope. Because app.js is an ES module, functions defined here must be
// explicitly attached to window or the handlers throw ReferenceError.

// Logout (header button)
window.confirmLogout = function () {
  if (confirm('Log out of PrintKinetix?')) {
    try { window.ws?.disconnect?.(); } catch { /* ignore */ }
    api.logout();
  }
};

// Connection Doctor refresh (printer detail page)
window.refreshDiagnostics = async function (id) {
  const el = document.getElementById('diag-content');
  if (!el) return;
  el.innerHTML = '<div class="loading-overlay" style="position:relative;height:60px;"><div class="spinner"></div></div>';
  try {
    const d = await api.getPrinterDiagnostics(id);
    const ok = (v) => v ? '<span style="color:var(--success,#16a34a);">●</span>' : '<span style="color:var(--danger,#dc2626);">●</span>';
    const age = d.mqtt?.last_report_age != null ? `${d.mqtt.last_report_age}s ago` : 'never';
    el.innerHTML = `
      <div>${ok(d.mqtt?.connected)} MQTT: ${d.mqtt?.connected ? 'connected' : 'disconnected'} · state ${d.mqtt?.state ?? 'unknown'} · last report ${age}</div>
      <div>${ok(d.ftps?.reachable)} FTPS: ${d.ftps?.reachable ? 'reachable' : 'unreachable'} (port ${d.ftps?.port ?? 990})</div>
      <div>${ok(!d.sd_health?.has_sd_error)} SD card: ${d.sd_health?.has_sd_error ? 'error detected' : 'ok'}${d.sd_health?.hms_errors?.length ? ` · ${d.sd_health.hms_errors.length} HMS error(s)` : ''}</div>
      <div style="color:var(--text-muted);margin-top:0.4rem;">IP ${d.ip ?? '—'} · ${d.model ?? ''}${d.active_job_id ? ` · job ${d.active_job_id}` : ''}</div>
    `;
  } catch (err) {
    el.innerHTML = `<div style="color:var(--text-muted);">Diagnostics unavailable: ${err.message}</div>`;
  }
};

// Accessory manual control (door / eject buttons)
window.execAcc = async function (id, action, params = {}) {
  try {
    await api.executeAccessory(id, action, params);
    toast(`${action.replace(/[._]/g, ' ')} sent`, 'success');
  } catch (err) {
    toast(`Accessory action failed: ${err.message}`, 'error');
  }
};

// Hash-based routing
window.addEventListener('hashchange', () => {
  const path = window.location.hash.slice(1) || '/';
  navigateTo(path);
});

// ===== LOGIN PAGE =====
route('/login', (el) => {
  el.innerHTML = html`
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem;">
      <div class="card" style="max-width:380px;width:100%;">
        <div style="text-align:center;margin-bottom:1.5rem;">
          <div style="font-size:1.8rem;font-weight:800;background:var(--accent-gradient);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">PrintKinetix</div>
          <p style="color:var(--text-muted);font-size:0.85rem;margin-top:0.3rem;">Deep Space Print Farm Orchestrator</p>
        </div>
        <form id="login-form">
          <div class="form-group">
            <label>Username</label>
            <input type="text" class="form-control" id="login-user" value="admin" required>
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" class="form-control" id="login-pass" value="antigravity" required>
          </div>
          <button type="submit" class="btn btn-primary btn-lg" style="width:100%;">Sign In</button>
          <p id="login-error" style="color:var(--danger);font-size:0.83rem;margin-top:0.75rem;text-align:center;display:none;"></p>
        </form>
      </div>
    </div>
  `;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await window.api.login($('#login-user').value, $('#login-pass').value);
      window.ws.connect();
      window.location.hash = '#/';
    } catch (err) {
      const errEl = $('#login-error');
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    }
  };
});

// ===== DASHBOARD =====
route('/', async (el) => {
  const [printers, jobs, accessories] = await Promise.all([
    api.getPrinters(), api.getJobs({ limit: 10 }), api.getAccessories()
  ]);

  const printing = printers.filter(p => {
    const snap = p.status_snapshot;
    return snap?.state === 'printing';
  });

  el.innerHTML = html`
    <h1 class="text-gradient-flow" style="font-size:1.6rem;font-weight:800;margin-bottom:1.25rem;">
      Dashboard
    </h1>

    <div class="grid-4" style="margin-bottom:1.5rem;">
      <div class="card stat-card">
        <div class="stat-value">${printers.length}</div>
        <div class="stat-label">Printers</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">${printing.length}</div>
        <div class="stat-label">Active Prints</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">${jobs.filter(j => j.status === 'queued').length}</div>
        <div class="stat-label">Queued Jobs</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">${accessories.length}</div>
        <div class="stat-label">Accessories</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header" style="align-items:center;">
          <div class="dashboard-card-title">Printers</div>
          <a href="#/printers" class="btn btn-sm">View All</a>
        </div>
        <div id="dash-printers"></div>
      </div>
      <div class="card">
        <div class="card-header" style="align-items:center;">
          <div class="dashboard-card-title">Recent Jobs</div>
          <a href="#/jobs" class="btn btn-sm">View All</a>
        </div>
        <div id="dash-jobs"></div>
      </div>
    </div>
  `;

  // Render printer mini cards
  const dp = $('#dash-printers');
  if (printers.length === 0) {
    dp.innerHTML = '<div class="empty-state"><p>No printers registered</p><a href="#/printers" class="btn btn-primary btn-sm">Add Printer</a></div>';
  } else {
    dp.innerHTML = printers.slice(0, 6).map(p => html`
      <a href="#/printers/${p.printer_id}" style="display:flex;justify-content:space-between;align-items:center;padding:0.6rem 0;border-bottom:1px solid var(--border-color);color:var(--text-primary);">
        <div>
          <div style="font-weight:600;font-size:0.9rem;">${p.name}</div>
          <div style="font-size:0.78rem;color:var(--text-muted);">${p.model} · ${timeAgo(p.last_seen)}</div>
        </div>
        ${statusBadge(p.status_snapshot?.state || 'unknown')}
      </a>
    `).join('');
  }

  // Render recent jobs
  const dj = $('#dash-jobs');
  if (jobs.length === 0) {
    dj.innerHTML = '<div class="empty-state"><p>No jobs yet</p><a href="#/jobs" class="btn btn-primary btn-sm">Submit Job</a></div>';
  } else {
    dj.innerHTML = jobs.slice(0, 8).map(j => html`
      <a href="#/jobs/${j.job_id}" style="display:flex;justify-content:space-between;align-items:center;padding:0.6rem 0;border-bottom:1px solid var(--border-color);color:var(--text-primary);">
        <div>
          <div style="font-weight:500;font-size:0.87rem;">${j.name}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);">${timeAgo(j.created_at)}</div>
        </div>
        ${statusBadge(j.status)}
      </a>
    `).join('');
  }
});

// ===== PRINTERS LIST =====
route('/printers', async (el) => {
  const printers = await api.getPrinters();

  el.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
      <h1 class="text-gradient-flow" style="font-size:1.4rem;font-weight:700;">Printers</h1>
      <button class="btn btn-primary" id="add-printer-btn">+ Add Printer</button>
    </div>
    <div class="grid-3" id="printers-grid"></div>
  `;

  const grid = $('#printers-grid');
  if (printers.length === 0) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><h3>No printers registered</h3><p>Click "Add Printer" to get started</p></div>';
  } else {
    grid.innerHTML = printers.map(p => html`
      <a href="#/printers/${p.printer_id}" class="card" style="cursor:pointer;text-decoration:none;color:inherit;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem;">
          <div>
            <h3 style="font-size:1rem;font-weight:700;">${p.name}</h3>
            <p style="font-size:0.8rem;color:var(--text-muted);">${p.model}</p>
          </div>
          <span data-pstate-dot="${p.printer_id}" class="status-dot ${(p.status_snapshot?.state === 'idle' || p.status_snapshot?.state === 'printing') ? 'online' : (p.status_snapshot?.state === 'offline' ? 'offline' : 'unknown')}"></span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-secondary);">
          <span>${p.ip_hostname}</span>
          <span data-pstate-badge="${p.printer_id}">${statusBadge(p.status_snapshot?.state || 'unknown')}</span>
        </div>
        <div data-pstate-prog="${p.printer_id}" style="${p.status_snapshot?.progress !== undefined && p.status_snapshot?.state === 'printing' ? '' : 'display:none;'}">
          <div class="progress-bar" style="margin-top:0.75rem;">
            <div class="progress-bar-fill" style="width:${p.status_snapshot?.progress || 0}%"></div>
          </div>
          <div class="pstate-prog-label" style="font-size:0.73rem;color:var(--text-muted);margin-top:0.3rem;">${p.status_snapshot?.progress || 0}% complete</div>
        </div>
        <div style="font-size:0.73rem;color:var(--text-muted);margin-top:0.5rem;">Last seen: ${timeAgo(p.last_seen)}</div>
      </a>
    `).join('');
  }

  // Add printer wizard
  $('#add-printer-btn').onclick = () => showAddPrinterModal();

  // LIVE STATUS: poll every second while this page is open (WS pushes land
  // in between, but polling guarantees a 1s worst-case refresh — previously
  // the page needed a manual reload to see state changes).
  const listTimer = setInterval(async () => {
    if ((location.hash.slice(1) || '') !== '/printers') { clearInterval(listTimer); return; }
    try {
      const ps = await api.getPrinters();
      for (const p of ps) _applyStatusToListCard(p.printer_id, p.status_snapshot || {});
    } catch { /* transient — next tick retries */ }
  }, 1000);
});

// Update one printer card on the list page in place (used by the 1s poll
// AND the live WebSocket push).
function _applyStatusToListCard(printerId, s) {
  const state = s.state || 'unknown';
  const dot = document.querySelector(`[data-pstate-dot="${printerId}"]`);
  if (dot) dot.className = `status-dot ${(state === 'idle' || state === 'printing') ? 'online' : (state === 'offline' ? 'offline' : 'unknown')}`;
  const badge = document.querySelector(`[data-pstate-badge="${printerId}"]`);
  if (badge) badge.innerHTML = statusBadge(s.print_error ? 'blocked' : state);
  const prog = document.querySelector(`[data-pstate-prog="${printerId}"]`);
  if (prog) {
    const show = s.progress !== undefined && state === 'printing';
    prog.style.display = show ? '' : 'none';
    if (show) {
      const fill = prog.querySelector('.progress-bar-fill');
      if (fill) fill.style.width = `${s.progress}%`;
      const label = prog.querySelector('.pstate-prog-label');
      if (label) label.textContent = `${s.progress}% complete`;
    }
  }
}

// ===== PRINTER DETAIL =====
route('/printers/:id', async (el, { id }) => {
  const printer = await api.getPrinter(id);
  const accessories = printer.accessories || [];
  let events = [];
  try { events = await api.getEntityEvents('printer', id); } catch { }

  el.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
      <div>
        <a href="#/printers" style="font-size:0.8rem;color:var(--text-muted);">Back to Printers</a>
        <h1 style="font-size:1.4rem;font-weight:700;margin-top:0.25rem;">${printer.name}</h1>
        <p style="font-size:0.85rem;color:var(--text-secondary);">${printer.model} · ${printer.ip_hostname}</p>
      </div>
      <div class="btn-group">
        <button class="btn btn-sm" onclick="testPrinterConn('${id}')">Test Connection</button>
        <button class="btn btn-danger btn-sm" onclick="if(confirm('Delete this printer?')){api.deletePrinter('${id}').then(()=>{toast('Deleted','success');location.hash='#/printers';});}">Delete</button>
      </div>
    </div>

    <div class="grid-2">
      <!-- Status Card (ids are the live-update hooks for the 1s poll + WS push) -->
      <div class="card">
        <div class="card-header"><h3>Status</h3><span id="printer-status-badge">${statusBadge(printer.status_snapshot?.print_error ? 'blocked' : (printer.status_snapshot?.state || 'unknown'))}</span></div>
        <div id="printer-telemetry" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;font-size:0.85rem;">
          <div><span style="color:var(--text-muted);">Bed Temp:</span> ${printer.status_snapshot?.bed_temp ?? '—'}°C</div>
          <div><span style="color:var(--text-muted);">Nozzle:</span> ${printer.status_snapshot?.nozzle_temp ?? '—'}°C</div>
          <div><span style="color:var(--text-muted);">Progress:</span> ${printer.status_snapshot?.progress ?? '—'}%</div>
          <div><span style="color:var(--text-muted);">Layer:</span> ${printer.status_snapshot?.layer ?? '—'}/${printer.status_snapshot?.total_layers ?? '—'}</div>
        </div>
        <div id="printer-progress-wrap" class="progress-bar" style="margin-top:1rem;${printer.status_snapshot?.progress !== undefined ? '' : 'display:none;'}">
          <div id="printer-progress-fill" class="progress-bar-fill" style="width:${printer.status_snapshot?.progress || 0}%"></div>
        </div>
      </div>

      <!-- BLOCKED Alert (print_error) -->
      <div class="card" id="blocked-alert" style="display:none;border:2px solid var(--danger);background:rgba(244,67,54,0.05);">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem;">
          <span style="font-size:1.5rem;">⛔</span>
          <h3 style="color:var(--danger);font-weight:700;margin:0;">PRINTER BLOCKED</h3>
        </div>
        <div id="blocked-error-msg" style="font-size:0.9rem;font-weight:600;margin-bottom:0.5rem;"></div>
        <div id="blocked-error-code" style="font-family:'Fira Code',monospace;font-size:0.8rem;color:var(--text-muted);margin-bottom:0.75rem;"></div>
        <div id="blocked-remediation" style="font-size:0.83rem;line-height:1.6;"></div>
        <div style="margin-top:1rem;display:flex;gap:0.75rem;align-items:center;">
          <button class="btn btn-primary" id="recheck-btn" onclick="recheckPrinter('${id}')">Recheck Printer Status</button>
          <span id="recheck-status" style="font-size:0.8rem;color:var(--text-muted);"></span>
        </div>
      </div>

      <!-- Camera Widget -->
      <div class="card">
        <div class="card-header">
          <h3>Camera</h3>
          ${printer.capabilities?.camera ? html`
            <div class="btn-group" style="gap:0.3rem;">
              <button class="btn btn-sm" id="cam-snapshot-btn" onclick="camMode('${id}','snapshot')" style="font-size:0.7rem;background:var(--primary);color:#fff;">📷 Snapshot</button>
              <button class="btn btn-sm" id="cam-stream-btn" onclick="camMode('${id}','stream')" style="font-size:0.7rem;">▶ Live Stream</button>
            </div>
          ` : ''}
        </div>
        <div class="camera-widget" id="camera-widget">
          ${printer.capabilities?.camera ? html`
            <div id="cam-loading" style="text-align:center;padding:1.5rem;">
              <div class="spinner" style="margin:0 auto 0.5rem;"></div>
              <div style="font-size:0.8rem;color:var(--text-muted);">Starting camera feed...</div>
            </div>
            <img id="cam-feed" src="" alt="Camera feed" style="width:100%;height:100%;object-fit:contain;display:none;border-radius:8px;">
          ` : html`<span class="no-camera">No camera available</span>`}
        </div>
      </div>

      <!-- Accessories -->
      <div class="card">
        <div class="card-header">
          <h3>Accessories (${accessories.length})</h3>
          <button class="btn btn-sm" onclick="showAttachAccessoryModal('${id}')">+ Attach</button>
        </div>
        ${accessories.length === 0 ? html`<p style="color:var(--text-muted);font-size:0.85rem;">No accessories attached</p>` :
      accessories.map(a => html`
            <div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid var(--border-color);">
              <div>
                <span style="font-weight:600;font-size:0.87rem;">${a.type.replace(/_/g, ' ')}</span>
                <span class="status-dot ${a.health}" style="margin-left:0.5rem;"></span>
              </div>
              <div class="btn-group">
                ${a.type === 'door_servo' ? html`
                  <button class="btn btn-sm btn-success" onclick="execAcc('${a.accessory_id}','door.open')">Open</button>
                  <button class="btn btn-sm" onclick="execAcc('${a.accessory_id}','door.close')">Close</button>
                ` : ''}
                ${a.type === 'eject_printhead' ? html`
                  <button class="btn btn-sm btn-primary" onclick="execAcc('${a.accessory_id}','eject.push',{cycles:2})">Push</button>
                  <button class="btn btn-sm" onclick="execAcc('${a.accessory_id}','eject.home')">Home</button>
                ` : ''}
              </div>
            </div>
          `).join('')}
      </div>

      <!-- AMS Filament Configuration -->
      <div class="card">
        <div class="card-header">
          <h3>AMS Filament Configuration</h3>
          <div class="btn-group">
            <button class="btn btn-sm" onclick="refreshAmsConfig('${id}')">↻ Refresh</button>
            <button class="btn btn-sm btn-primary" onclick="syncAmsToDevice('${id}')">Sync to Printer</button>
          </div>
        </div>
        <div id="ams-config-content" style="padding:0.75rem;">
          <div style="text-align:center;color:var(--text-muted);padding:1rem;">Loading AMS configuration...</div>
        </div>
      </div>

      <!-- Printer Controls -->
      <div class="card" style="grid-column: 1 / -1;">
        <div class="card-header">
          <h3>🎮 Printer Controls</h3>
        </div>
        <div id="printer-controls-content" style="padding:0.75rem;">

          <!-- Active printer error: decoded message + the same options the
               printer's own screen offers (populated by refreshPrintControlButtons) -->
          <div id="printer-error-panel" style="display:none;margin-bottom:1rem;background:rgba(251,191,36,0.07);border:1px solid var(--warning,#fbbf24);border-radius:var(--radius-md,10px);padding:0.85rem;"></div>

          <!-- Print Control (pause/resume/stop the current job) -->
          <div style="margin-bottom:1rem;">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:0.5rem;">Print Control</div>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;">
              <button class="btn btn-sm btn-warning" id="pc-pause" onclick="printCtrl('${id}','pause')">⏸ Pause</button>
              <button class="btn btn-sm btn-success" id="pc-resume" onclick="printCtrl('${id}','resume')">▶ Resume</button>
              <button class="btn btn-sm btn-danger" id="pc-stop" onclick="printCtrl('${id}','stop')">⏹ Stop</button>
              <button class="btn btn-sm btn-warning" id="pc-recover" onclick="recoverPrinter('${id}')" title="Dismiss the printer error and re-home if needed — the software equivalent of tapping OK/Retry on the printer screen">⚠️ Clear Error &amp; Recover</button>
              <span id="pc-state" style="font-size:0.78rem;color:var(--text-muted);"></span>
            </div>
          </div>

          <!-- Quick Actions -->
          <div style="margin-bottom:1rem;">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:0.5rem;">Quick Actions</div>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;">
              <button class="btn btn-sm" id="ctrl-light-btn" onclick="toggleLight('${id}')" style="min-width:100px;">💡 Light On</button>
              <button class="btn btn-sm" onclick="pCtrl('${id}','home',{axes:'all'})">🏠 Home All</button>
              <button class="btn btn-sm" onclick="pCtrl('${id}','home',{axes:'XY'})">↔ Home XY</button>
              <button class="btn btn-sm" onclick="pCtrl('${id}','bed_level')">📐 Bed Level</button>
            </div>
          </div>

          <!-- Temperature -->
          <div style="margin-bottom:1rem;">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:0.5rem;">Temperature</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
              <div style="background:var(--bg-tertiary);border-radius:8px;padding:0.75rem;">
                <label style="font-size:0.8rem;font-weight:600;display:flex;justify-content:space-between;">Nozzle <span id="ctrl-nozzle-val">0°C</span></label>
                <input type="range" min="0" max="300" value="0" step="5" id="ctrl-nozzle"
                  oninput="document.getElementById('ctrl-nozzle-val').textContent=this.value+'°C'"
                  onchange="pCtrl('${id}','set_nozzle_temp',{temp:+this.value})"
                  class="ctrl-slider">
                <div style="display:flex;gap:0.25rem;margin-top:0.35rem;">
                  <button class="btn btn-sm" onclick="setSlider('ctrl-nozzle',0);pCtrl('${id}','set_nozzle_temp',{temp:0})" style="font-size:0.7rem;padding:0.15rem 0.4rem;">Off</button>
                  <button class="btn btn-sm" onclick="setSlider('ctrl-nozzle',190);pCtrl('${id}','set_nozzle_temp',{temp:190})" style="font-size:0.7rem;padding:0.15rem 0.4rem;">190</button>
                  <button class="btn btn-sm" onclick="setSlider('ctrl-nozzle',220);pCtrl('${id}','set_nozzle_temp',{temp:220})" style="font-size:0.7rem;padding:0.15rem 0.4rem;">220</button>
                  <button class="btn btn-sm" onclick="setSlider('ctrl-nozzle',250);pCtrl('${id}','set_nozzle_temp',{temp:250})" style="font-size:0.7rem;padding:0.15rem 0.4rem;">250</button>
                </div>
              </div>
              <div style="background:var(--bg-tertiary);border-radius:8px;padding:0.75rem;">
                <label style="font-size:0.8rem;font-weight:600;display:flex;justify-content:space-between;">Bed <span id="ctrl-bed-val">0°C</span></label>
                <input type="range" min="0" max="120" value="0" step="5" id="ctrl-bed"
                  oninput="document.getElementById('ctrl-bed-val').textContent=this.value+'°C'"
                  onchange="pCtrl('${id}','set_bed_temp',{temp:+this.value})"
                  class="ctrl-slider">
                <div style="display:flex;gap:0.25rem;margin-top:0.35rem;">
                  <button class="btn btn-sm" onclick="setSlider('ctrl-bed',0);pCtrl('${id}','set_bed_temp',{temp:0})" style="font-size:0.7rem;padding:0.15rem 0.4rem;">Off</button>
                  <button class="btn btn-sm" onclick="setSlider('ctrl-bed',55);pCtrl('${id}','set_bed_temp',{temp:55})" style="font-size:0.7rem;padding:0.15rem 0.4rem;">55</button>
                  <button class="btn btn-sm" onclick="setSlider('ctrl-bed',70);pCtrl('${id}','set_bed_temp',{temp:70})" style="font-size:0.7rem;padding:0.15rem 0.4rem;">70</button>
                  <button class="btn btn-sm" onclick="setSlider('ctrl-bed',100);pCtrl('${id}','set_bed_temp',{temp:100})" style="font-size:0.7rem;padding:0.15rem 0.4rem;">100</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Fans -->
          <div style="margin-bottom:1rem;">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:0.5rem;">Fans</div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.75rem;">
              ${[{n:'Part Fan',f:1},{n:'Aux Fan',f:2},{n:'Chamber Fan',f:3}].map(fan => `
                <div style="background:var(--bg-tertiary);border-radius:8px;padding:0.75rem;">
                  <label style="font-size:0.8rem;font-weight:600;display:flex;justify-content:space-between;">${fan.n} <span id="ctrl-fan${fan.f}-val">0%</span></label>
                  <input type="range" min="0" max="100" value="0" id="ctrl-fan${fan.f}"
                    oninput="document.getElementById('ctrl-fan${fan.f}-val').textContent=this.value+'%'"
                    onchange="pCtrl('${id}','set_fan',{fan:${fan.f},speed:Math.round(this.value*2.55)})"
                    class="ctrl-slider">
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Movement -->
          <div style="margin-bottom:1rem;">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:0.5rem;">Movement</div>
            <div style="display:flex;gap:1rem;flex-wrap:wrap;">
              <!-- XY Pad -->
              <div style="display:flex;flex-direction:column;align-items:center;gap:0.35rem;">
                <button class="btn btn-sm" onclick="pCtrl('${id}','move',{y:_ms(1)})" style="width:42px;">▲</button>
                <div style="display:flex;gap:0.35rem;">
                  <button class="btn btn-sm" onclick="pCtrl('${id}','move',{x:-_ms()})" style="width:42px;">◄</button>
                  <button class="btn btn-sm" onclick="pCtrl('${id}','home',{axes:'XY'})" style="width:42px;font-size:0.7rem;">⌂</button>
                  <button class="btn btn-sm" onclick="pCtrl('${id}','move',{x:_ms(1)})" style="width:42px;">►</button>
                </div>
                <button class="btn btn-sm" onclick="pCtrl('${id}','move',{y:-_ms()})" style="width:42px;">▼</button>
              </div>
              <!-- Z -->
              <div style="display:flex;flex-direction:column;align-items:center;gap:0.35rem;">
                <span style="font-size:0.7rem;color:var(--text-muted);">Z</span>
                <button class="btn btn-sm" onclick="pCtrl('${id}','move',{z:_ms(1)})" style="width:42px;">▲</button>
                <button class="btn btn-sm" onclick="pCtrl('${id}','move',{z:-_ms()})" style="width:42px;">▼</button>
              </div>
              <!-- Step size -->
              <div style="display:flex;flex-direction:column;gap:0.25rem;">
                <span style="font-size:0.7rem;color:var(--text-muted);">Step (mm)</span>
                ${[1,5,10,50].map(s => `<button class="btn btn-sm" id="step-${s}" onclick="_setStep(${s})" style="font-size:0.75rem;padding:0.2rem 0.5rem;${s===10?'background:var(--primary);color:#fff;':''}"> ${s}</button>`).join('')}
              </div>
            </div>
          </div>

          <!-- Filament -->
          <div style="margin-bottom:1rem;">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:0.5rem;">Filament</div>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;">
              <button class="btn btn-sm btn-primary" onclick="pCtrl('${id}','extrude',{mm:10})">▼ Extrude 10mm</button>
              <button class="btn btn-sm" onclick="pCtrl('${id}','retract',{mm:10})">▲ Retract 10mm</button>
              <span style="color:var(--border-color);">|</span>
              <button class="btn btn-sm btn-success" onclick="pCtrl('${id}','load_filament',{temp:220})">⬇ Load</button>
              <button class="btn btn-sm btn-warning" onclick="pCtrl('${id}','unload_filament',{temp:220})">⬆ Unload</button>
            </div>
          </div>

          <!-- Print Tuning -->
          <div>
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:0.5rem;">Print Tuning</div>

            <!-- Speed Profile -->
            <div style="background:var(--bg-tertiary);border-radius:8px;padding:0.75rem;margin-bottom:0.5rem;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4rem;">
                <span style="font-size:0.8rem;font-weight:600;">Speed Profile</span>
                <div class="btn-group" style="gap:0.2rem;">
                  <button class="btn btn-sm" onclick="setSpeedProfile('${id}',2)" title="Revert to Standard" style="font-size:0.7rem;">↺ Reset</button>
                  <button class="btn btn-sm btn-primary" onclick="applyOverride('${id}','speed_profile',_pendingSpeedProfile||2)" style="font-size:0.7rem;">▶ Apply</button>
                </div>
              </div>
              <div style="display:flex;gap:0.35rem;">
                ${[{l:1,n:'Silent'},{l:2,n:'Standard'},{l:3,n:'Sport'},{l:4,n:'Ludicrous'}].map(s => `
                  <button class="btn btn-sm" id="sp-${s.l}" onclick="stageSpeedProfile(${s.l})"
                    style="flex:1;font-size:0.75rem;${s.l===2?'background:var(--primary);color:#fff;':''}">${s.n}</button>
                `).join('')}
              </div>
            </div>

            <!-- Speed Override -->
            <div style="background:var(--bg-tertiary);border-radius:8px;padding:0.75rem;margin-bottom:0.5rem;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4rem;">
                <span style="font-size:0.8rem;font-weight:600;">Speed Override</span>
                <div class="btn-group" style="gap:0.2rem;">
                  <button class="btn btn-sm" onclick="setSlider('ctrl-speed',100);document.getElementById('ctrl-speed-input').value=100;document.getElementById('ctrl-speed-val').textContent='100%'" style="font-size:0.7rem;">↺ Reset</button>
                  <button class="btn btn-sm btn-primary" onclick="applyOverride('${id}','speed_override',document.getElementById('ctrl-speed').value)" style="font-size:0.7rem;">▶ Apply</button>
                </div>
              </div>
              <div style="display:flex;gap:0.5rem;align-items:center;">
                <input type="range" min="50" max="200" value="100" id="ctrl-speed"
                  oninput="document.getElementById('ctrl-speed-val').textContent=this.value+'%';document.getElementById('ctrl-speed-input').value=this.value"
                  class="ctrl-slider" style="flex:1;">
                <input type="number" id="ctrl-speed-input" value="100" min="50" max="200" style="width:55px;text-align:center;font-size:0.8rem;padding:0.25rem;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;color:var(--text);"
                  oninput="setSlider('ctrl-speed',this.value);document.getElementById('ctrl-speed-val').textContent=this.value+'%'">
                <span id="ctrl-speed-val" style="font-size:0.8rem;font-weight:600;color:var(--primary);min-width:40px;">100%</span>
              </div>
            </div>

            <!-- Flow Override -->
            <div style="background:var(--bg-tertiary);border-radius:8px;padding:0.75rem;margin-bottom:0.5rem;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4rem;">
                <span style="font-size:0.8rem;font-weight:600;">Flow Rate</span>
                <div class="btn-group" style="gap:0.2rem;">
                  <button class="btn btn-sm" onclick="setSlider('ctrl-flow',100);document.getElementById('ctrl-flow-input').value=100;document.getElementById('ctrl-flow-val').textContent='100%'" style="font-size:0.7rem;">↺ Reset</button>
                  <button class="btn btn-sm btn-primary" onclick="applyOverride('${id}','flow_override',document.getElementById('ctrl-flow').value)" style="font-size:0.7rem;">▶ Apply</button>
                </div>
              </div>
              <div style="display:flex;gap:0.5rem;align-items:center;">
                <input type="range" min="50" max="200" value="100" id="ctrl-flow"
                  oninput="document.getElementById('ctrl-flow-val').textContent=this.value+'%';document.getElementById('ctrl-flow-input').value=this.value"
                  class="ctrl-slider" style="flex:1;">
                <input type="number" id="ctrl-flow-input" value="100" min="50" max="200" style="width:55px;text-align:center;font-size:0.8rem;padding:0.25rem;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;color:var(--text);"
                  oninput="setSlider('ctrl-flow',this.value);document.getElementById('ctrl-flow-val').textContent=this.value+'%'">
                <span id="ctrl-flow-val" style="font-size:0.8rem;font-weight:600;color:var(--primary);min-width:40px;">100%</span>
              </div>
            </div>

            <!-- Z-Offset Baby Stepping -->
            <div style="background:var(--bg-tertiary);border-radius:8px;padding:0.75rem;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4rem;">
                <span style="font-size:0.8rem;font-weight:600;">Z-Offset <span id="ctrl-zoff-val" style="color:var(--primary);">0.00mm</span></span>
                <div class="btn-group" style="gap:0.2rem;">
                  <button class="btn btn-sm" onclick="_zOff=0;updZOff()" style="font-size:0.7rem;">↺ Reset</button>
                  <button class="btn btn-sm btn-primary" onclick="applyOverride('${id}','z_offset',_zOff)" style="font-size:0.7rem;">▶ Apply</button>
                </div>
              </div>
              <div style="display:flex;gap:0.35rem;align-items:center;justify-content:center;">
                <button class="btn btn-sm" onclick="stageZ(-0.05)" style="font-size:0.85rem;padding:0.3rem 0.6rem;">-0.05</button>
                <button class="btn btn-sm" onclick="stageZ(-0.01)" style="font-size:0.85rem;padding:0.3rem 0.6rem;">-0.01</button>
                <span style="font-size:1rem;font-weight:700;min-width:60px;text-align:center;" id="ctrl-zoff-display">0.00</span>
                <button class="btn btn-sm" onclick="stageZ(0.01)" style="font-size:0.85rem;padding:0.3rem 0.6rem;">+0.01</button>
                <button class="btn btn-sm" onclick="stageZ(0.05)" style="font-size:0.85rem;padding:0.3rem 0.6rem;">+0.05</button>
              </div>
            </div>
          </div>

        </div>
      </div>

      <!-- Connection Doctor -->
      <div class="card" id="conn-doctor">
        <div class="card-header"><h3>Connection Doctor</h3><button class="btn btn-sm" onclick="refreshDiagnostics('${id}')">Refresh</button></div>
        <div id="diag-content" style="padding:1rem;font-family:monospace;font-size:0.85rem;">
          <div class="loading-overlay" style="position:relative;height:60px;"><div class="spinner"></div></div>
        </div>
      </div>

      <!-- Timeline -->
      <div class="card">
        <div class="card-header"><h3>Timeline</h3></div>
        <div class="timeline">
          ${events.length === 0 ? html`<p style="color:var(--text-muted);font-size:0.85rem;">No events yet</p>` :
      events.slice(0, 15).map(e => html`
              <div class="timeline-item">
                <div class="time">${timeAgo(e.created_at)}</div>
                <div class="event">${e.event_type}</div>
              </div>
            `).join('')}
        </div>
      </div>
    </div>
  `;

  // Load Connection Doctor
  refreshDiagnostics(id);

  // Load AMS Filament Config
  refreshAmsConfig(id);

  // Check for print_error BLOCKED state
  checkBlockedStatus(id);

  // Wire up the pause/resume/stop buttons AND the Status card to the
  // printer's live state — 1s cadence so state changes (printing/idle/…)
  // show up without a manual page reload.
  refreshPrintControlButtons(id);
  const pcTimer = setInterval(() => {
    if ((location.hash.slice(1) || '') !== `/printers/${id}`) { clearInterval(pcTimer); return; }
    refreshPrintControlButtons(id);
  }, 1000);

  // Start camera feed if camera is available
  if (printer.capabilities?.camera) startCamFeed(id);
});

// Check if printer is blocked by print_error and show alert
async function checkBlockedStatus(printerId) {
  try {
    const preflight = await api.getPrinterPreflight(printerId);
    const alertEl = document.getElementById('blocked-alert');
    if (!alertEl) return;
    if (preflight.print_error) {
      const err = preflight.print_error;
      alertEl.style.display = 'block';
      document.getElementById('blocked-error-msg').textContent = err.message;
      document.getElementById('blocked-error-code').textContent =
        `Error: ${err.formatted} (0x${err.hex?.replace('0x', '')}) · Decimal: ${err.code}`;
      const remEl = document.getElementById('blocked-remediation');
      remEl.innerHTML = '<strong>To resolve:</strong><ol style="margin:0.5rem 0;padding-left:1.25rem;">' +
        err.remediation.map(r => `<li style="margin-bottom:0.3rem;">${r}</li>`).join('') + '</ol>' +
        '<div style="margin-top:0.5rem;font-size:0.8rem;color:var(--text-muted);">This error cannot be cleared via LAN commands. Requires physical SD card action + power cycle.</div>';
    } else {
      alertEl.style.display = 'none';
    }
  } catch { /* preflight endpoint may not be available */ }
}

// Test Connection (triggered by Test Connection button) — reports the real verdict
window.testPrinterConn = async function (printerId) {
  toast('Testing connection…', 'info');
  try {
    const r = await api.testPrinter(printerId);
    toast(r.message || (r.success ? 'Connection OK' : 'Not connected'), r.success ? 'success' : 'error');
  } catch (e) {
    toast(e.message || 'Connection test failed', 'error');
  }
};

// Recheck printer status (triggered by Recheck button)
window.recheckPrinter = async function (printerId) {
  const btn = document.getElementById('recheck-btn');
  const status = document.getElementById('recheck-status');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Requesting fresh status from printer...';
  try {
    const result = await api.recheckPrinter(printerId);
    if (result.print_error) {
      if (status) status.textContent = `Still blocked: ${result.print_error.message}`;
      if (status) status.style.color = 'var(--danger)';
    } else {
      if (status) status.textContent = 'Error cleared! Printer is ready.';
      if (status) status.style.color = 'var(--success)';
      const alertEl = document.getElementById('blocked-alert');
      if (alertEl) alertEl.style.display = 'none';
      toast('Printer error cleared — ready to print!', 'success');
    }
  } catch (e) {
    if (status) status.textContent = `Recheck failed: ${e.message}`;
    if (status) status.style.color = 'var(--danger)';
  }
  if (btn) btn.disabled = false;
};

// ===== CAMERA FEED =====

let _camInterval = null;
let _camMode = 'snapshot'; // 'snapshot' or 'stream'

function startCamFeed(printerId) {
  camMode(printerId, 'stream');
}

window.camMode = function(printerId, mode) {
  _camMode = mode;
  // Update button styles
  const snapBtn = document.getElementById('cam-snapshot-btn');
  const streamBtn = document.getElementById('cam-stream-btn');
  if (snapBtn) {
    snapBtn.style.background = mode === 'snapshot' ? 'var(--primary)' : '';
    snapBtn.style.color = mode === 'snapshot' ? '#fff' : '';
  }
  if (streamBtn) {
    streamBtn.style.background = mode === 'stream' ? 'var(--primary)' : '';
    streamBtn.style.color = mode === 'stream' ? '#fff' : '';
  }

  // Clean up previous interval
  if (_camInterval) { clearInterval(_camInterval); _camInterval = null; }

  const feed = document.getElementById('cam-feed');
  const loading = document.getElementById('cam-loading');
  if (!feed) return;

  if (mode === 'stream') {
    // Switch to continuous MJPEG stream
    if (loading) loading.style.display = 'none';
    feed.src = `/api/printers/${printerId}/camera/stream?token=${api.token}`;
    feed.style.display = 'block';
  } else {
    // Snapshot mode: poll every 2 seconds
    if (loading) loading.style.display = '';
    feed.style.display = 'none';

    const loadSnapshot = () => {
      // First try to fetch as a request so we can read error bodies
      fetch(`/api/printers/${printerId}/camera/snapshot?token=${api.token}&t=${Date.now()}`)
        .then(r => {
          if (r.ok) return r.blob();
          return r.json().then(j => { throw new Error(j.error || 'Camera unavailable'); });
        })
        .then(blob => {
          const url = URL.createObjectURL(blob);
          feed.onload = () => URL.revokeObjectURL(url);
          feed.src = url;
          feed.style.display = 'block';
          if (loading) loading.style.display = 'none';
          _camErrors = 0;
        })
        .catch(err => {
          _camErrors++;
          if (_camErrors >= 5 && loading) {
            loading.innerHTML = `<div style="font-size:0.85rem;color:var(--text-muted);padding:0.5rem;">
              <div style="margin-bottom:0.3rem;">📹 Camera connection failed</div>
              <div style="font-size:0.75rem;">${err.message}</div>
            </div>`;
            clearInterval(_camInterval);
            _camInterval = null;
          }
        });
    };
    let _camErrors = 0;

    loadSnapshot();
    _camInterval = setInterval(loadSnapshot, 1000);
  }
};

// ===== PRINTER CONTROLS =====

// Send a control action to the printer
window.pCtrl = async function(printerId, action, extra = {}) {
  try {
    await api.sendControl(printerId, { action, ...extra });
  } catch (err) {
    toast(`Control failed: ${err.message}`, 'error');
  }
};

// Pause / resume / stop the current print. Stop confirms (it can't be undone).
window.printCtrl = async function(printerId, action) {
  if (action === 'stop' && !confirm('Stop the current print? This cannot be resumed.')) return;
  try {
    await api.sendControl(printerId, { action });
    toast(action === 'stop' ? 'Stopping print…' : action === 'pause' ? 'Pausing…' : 'Resuming…', 'info');
    setTimeout(() => refreshPrintControlButtons(printerId), 1500);
  } catch (err) {
    toast(`${action} failed: ${err.message}`, 'error');
  }
};

// ===== SHARED AMS SPOOL PROMPT =====
// Ask how to map a print's colors to the printer's AMS — Auto (match colors
// to loaded spools at start) or Manual (pick each tray via swatch chips).
// Returns a Promise resolving to ams_roles, or null if the user cancels.
// `defaults` (existing ams_roles) preselects mode + tray picks.
const _amsSwatch = (c) => `<span style="display:inline-block;width:0.9rem;height:0.9rem;border-radius:3px;border:1px solid #555;vertical-align:middle;background:${c || '#888'};"></span>`;
window.showAmsSpoolModal = function({ printer, ams, colors = [], material = null, defaults = null, confirmLabel = 'Start Print' }) {
  return new Promise((resolve) => {
    const colorless = colors.length === 0;
    const rows = colorless ? [null] : colors;
    const palette = ams?.color_palette || [];
    const multiAms = (ams?.slots || []).some(t => t.ams_id > 0);
    const defManual = defaults?.mode === 'manual' && !!defaults?.slot_map;
    const defSel = (idx) => {
      const d = defaults?.slot_map?.[idx + 1];
      return Number.isInteger(d) ? d : Math.min(idx, ((ams?.slots?.length || 1) - 1));
    };

    // One clickable chip per AMS tray (swatch + label) — a native <select>
    // can't render the tray colors, which left users picking from hex codes.
    const trayChips = (sel) => (ams?.slots || []).map((t, i) => {
      const mat = t.configured_material || t.live_type || '';
      const hex = (t.configured_color || t.live_color || '').replace('#', '');
      const cname = t.configured_color_name || (hex ? _matchColorName(hex, palette) : '');
      const css = hex ? '#' + hex.slice(0, 6) : null;
      const label = `${multiAms ? `A${t.ams_id + 1}·` : ''}T${t.tray_id + 1}${mat ? ' ' + mat : ''}${cname ? ' ' + cname : ''}${!mat && !hex ? ' empty' : ''}`;
      const title = `AMS ${t.ams_id + 1} · Tray ${t.tray_id + 1}${mat ? ' — ' + mat : ''}${cname ? ' ' + cname : (hex ? ' #' + hex.slice(0, 6) : '')}${!mat && !hex ? ' — empty' : ''}`;
      return `<div class="ams-tray-chip" data-tray="${i}" onclick="_amsPickTray(this)" title="${title}"
        style="display:flex;align-items:center;gap:0.35rem;padding:0.25rem 0.55rem;border-radius:999px;cursor:pointer;background:var(--bg-tertiary);transition:all 0.15s ease;
          border:2px solid ${i === sel ? 'var(--primary,#7c4dff)' : 'var(--border-color)'};
          box-shadow:${i === sel ? '0 0 0 1px var(--primary,#7c4dff)' : 'none'};">
        <span style="display:inline-block;width:1rem;height:1rem;border-radius:50%;flex-shrink:0;border:1px solid #555;
          background:${css || 'repeating-linear-gradient(45deg,var(--bg-secondary),var(--bg-secondary) 3px,var(--bg-tertiary) 3px,var(--bg-tertiary) 6px)'};"></span>
        <span style="font-size:0.72rem;white-space:nowrap;">${label}</span>
      </div>`;
    }).join('');

    let settled = false;
    const settle = (val) => { if (!settled) { settled = true; hideModal(); resolve(val); } };
    window._amsModalCancel = () => settle(null);

    showModal(html`
      <div class="modal-header"><h2>AMS spools — ${printer.name}</h2><button class="btn btn-icon btn-sm" onclick="_amsModalCancel()">✕</button></div>
      <div style="padding:1rem;display:flex;flex-direction:column;gap:0.8rem;">
        <div style="font-size:0.85rem;color:var(--text-secondary);">${colorless
          ? 'This file has no color info — choose how it feeds from the AMS.'
          : `This print uses ${colors.length} color${colors.length > 1 ? 's' : ''}: ${colors.map(_amsSwatch).join(' ')}`}</div>
        <label style="display:flex;gap:0.5rem;align-items:flex-start;cursor:pointer;">
          <input type="radio" name="ams-mode" value="auto" ${defManual ? '' : 'checked'} onchange="_amsModeToggle()" style="margin-top:0.2rem;">
          <span><b>${colorless ? 'Auto (use tray 1)' : 'Auto-map'}</b><br><span style="font-size:0.8rem;color:var(--text-muted);">${colorless
            ? 'Feed from AMS tray 1.'
            : 'Match each color to the closest spool loaded in the AMS when the print starts. Refuses to start if no close match — never prints the wrong color.'}</span></span>
        </label>
        <label style="display:flex;gap:0.5rem;align-items:flex-start;cursor:pointer;">
          <input type="radio" name="ams-mode" value="manual" ${defManual ? 'checked' : ''} onchange="_amsModeToggle()" style="margin-top:0.2rem;">
          <span><b>Pick from the printer</b><br><span style="font-size:0.8rem;color:var(--text-muted);">Choose exactly which AMS tray ${colorless ? 'feeds the print' : 'prints each color'}, regardless of the tray's set color.${defManual ? ' <b>Preselected: this job\'s saved tray picks — change them here.</b>' : ''}</span></span>
        </label>
        <div id="ams-manual-rows" style="display:${defManual ? 'flex' : 'none'};flex-direction:column;gap:0.6rem;padding-left:1.5rem;">
          ${ams?.slots?.length ? rows.map((c, idx) => html`
            <div style="display:grid;grid-template-columns:auto 1fr;gap:0.5rem;align-items:center;">
              ${colorless ? '<span style="font-size:0.78rem;color:var(--text-muted);">Tray</span>' : _amsSwatch(c)}
              <div class="ams-pick" data-slot="${idx + 1}" data-value="${defSel(idx)}" style="display:flex;flex-wrap:wrap;gap:0.35rem;">
                ${trayChips(defSel(idx))}
              </div>
            </div>`).join('') : '<div style="font-size:0.8rem;color:var(--text-muted);">No AMS trays reported for this printer.</div>'}
        </div>
        <div class="btn-group" style="justify-content:flex-end;gap:0.5rem;margin-top:0.5rem;">
          <button class="btn" onclick="_amsModalCancel()">Cancel</button>
          <button class="btn btn-primary" id="ams-confirm-start">${confirmLabel}</button>
        </div>
      </div>
    `);
    window._amsModeToggle = () => {
      const manual = document.querySelector('input[name="ams-mode"]:checked')?.value === 'manual';
      document.getElementById('ams-manual-rows').style.display = manual ? 'flex' : 'none';
    };
    window._amsPickTray = (el) => {
      const row = el.parentElement;
      row.dataset.value = el.dataset.tray;
      row.querySelectorAll('.ams-tray-chip').forEach(ch => {
        const on = ch === el;
        ch.style.border = `2px solid ${on ? 'var(--primary,#7c4dff)' : 'var(--border-color)'}`;
        ch.style.boxShadow = on ? '0 0 0 1px var(--primary,#7c4dff)' : 'none';
      });
      // selecting a tray implies manual mode
      const manualRadio = document.querySelector('input[name="ams-mode"][value="manual"]');
      if (manualRadio && !manualRadio.checked) { manualRadio.checked = true; window._amsModeToggle(); }
    };
    document.getElementById('ams-confirm-start').onclick = () => {
      const mode = document.querySelector('input[name="ams-mode"]:checked')?.value || 'auto';
      let ams_roles;
      if (mode === 'manual') {
        const slot_map = {};
        document.querySelectorAll('.ams-pick').forEach(s => { slot_map[s.dataset.slot] = parseInt(s.dataset.value, 10); });
        ams_roles = { mode: 'manual', colors, slot_map, material };
      } else if (colorless) {
        // auto + colorless = feed from tray 1 (avoids the external-spool hang)
        ams_roles = { mode: 'manual', colors: [], slot_map: { 1: 0 }, material };
      } else {
        ams_roles = { mode: 'auto', colors, material };
      }
      settle(ams_roles);
    };
  });
};

// Start a job, but first ask how to map its colors to the printer's AMS.
// Falls straight through to start() when there's no AMS or no colors to map.
window.startJobWithAms = async function(jobId) {
  let job, printer, ams = null;
  try {
    job = await api.getJob(jobId);
    if (job.printer_id) { printer = await api.getPrinter(job.printer_id); }
  } catch (err) { toast(err.message, 'error'); return; }

  const colors = job.ams_roles?.colors || [];
  const hasAms = !!printer?.status_snapshot?.ams?.ams?.length || !!printer?.capabilities?.ams;
  // No printer or no AMS → nothing to choose, just start.
  if (!printer || !hasAms) {
    return api.startJob(jobId).catch(e => toast(e.message, 'error'));
  }
  try { ams = await api.getPrinterAms(job.printer_id); } catch { ams = null; }

  const ams_roles = await showAmsSpoolModal({
    printer, ams, colors,
    material: job.ams_roles?.material,
    defaults: job.ams_roles,
  });
  if (!ams_roles) return; // canceled
  try {
    await api.request('PATCH', `/jobs/${jobId}`, { ams_roles });
    await api.startJob(jobId);
    toast('Print starting…', 'success');
  } catch (err) { toast(err.message, 'error'); }
};

// Update the printer detail Status card in place (used by the 1s poll AND
// the live WebSocket push — no page reload needed to see state changes).
function _applyStatusToDetail(s) {
  const badge = document.getElementById('printer-status-badge');
  if (badge) badge.innerHTML = statusBadge(s.print_error ? 'blocked' : (s.state || 'unknown'));
  const grid = document.getElementById('printer-telemetry');
  if (grid) {
    grid.innerHTML = html`
      <div><span style="color:var(--text-muted);">Bed Temp:</span> ${s.bed_temp ?? '—'}°C${s.bed_target ? ` / ${s.bed_target}°C` : ''}</div>
      <div><span style="color:var(--text-muted);">Nozzle:</span> ${s.nozzle_temp ?? '—'}°C${s.nozzle_target ? ` / ${s.nozzle_target}°C` : ''}</div>
      <div><span style="color:var(--text-muted);">Progress:</span> ${s.progress ?? '—'}%</div>
      <div><span style="color:var(--text-muted);">Layer:</span> ${s.layer ?? '—'}/${s.total_layers ?? '—'}</div>
    `;
  }
  const wrap = document.getElementById('printer-progress-wrap');
  if (wrap) {
    wrap.style.display = s.progress !== undefined ? '' : 'none';
    const fill = document.getElementById('printer-progress-fill');
    if (fill) fill.style.width = `${s.progress || 0}%`;
  }
}

// Enable only the buttons that make sense for the printer's current state.
window.refreshPrintControlButtons = async function(printerId) {
  const pause = document.getElementById('pc-pause');
  if (!pause) return; // not on this page
  const resume = document.getElementById('pc-resume');
  const stop = document.getElementById('pc-stop');
  const recover = document.getElementById('pc-recover');
  const label = document.getElementById('pc-state');
  let state = 'unknown', printError = 0, decoded = null, gcodeState = null, hmsDecoded = [];
  try {
    const p = await api.getPrinter(printerId);
    state = p.status_snapshot?.state || p.state || 'unknown';
    printError = p.status_snapshot?.print_error || 0;
    gcodeState = p.status_snapshot?.gcode_state || null;
    decoded = p.print_error_decoded || null;
    hmsDecoded = p.hms_decoded || [];
    _applyStatusToDetail(p.status_snapshot || {});
  } catch { /* keep unknown */ }
  const printing = state === 'printing';
  const paused = state === 'paused' || gcodeState === 'PAUSE';
  const active = printing || paused;
  const errored = state === 'error' || !!printError;
  pause.disabled = !printing;
  resume.disabled = !paused;
  stop.disabled = !active;
  if (recover && !recover.dataset.busy) {
    // Recovery (clear + re-home) is for a DEAD print's residue — a paused
    // print is live; its options are Resume/Stop (like the printer screen).
    recover.disabled = !errored || paused;
    recover.style.display = (errored && !paused) ? '' : 'none';
  }
  [pause, resume, stop, recover].filter(Boolean).forEach(b => { b.style.opacity = b.disabled ? '0.45' : '1'; });
  label.textContent = active ? `(${state})` : (state === 'idle' ? '(printer idle — nothing to control)' : `(${state})`);

  // ---- Active-error panel: decoded error + the same options the printer's
  // own screen shows (Resume/Stop when paused on the error; Clear & Recover
  // when the print is dead) ----
  const panel = document.getElementById('printer-error-panel');
  if (panel) {
    if (printError && decoded) {
      const actions = paused
        ? `<button class="btn btn-sm btn-success" onclick="printCtrl('${printerId}','resume')">▶ Resume Print</button>
           <button class="btn btn-sm btn-danger" onclick="printCtrl('${printerId}','stop')">⏹ Stop Print</button>
           <span style="font-size:0.75rem;color:var(--text-muted);">Same options as on the printer screen — the print is paused on this error.</span>`
        : `<button class="btn btn-sm btn-warning" onclick="recoverPrinter('${printerId}')">⚠️ Clear Error &amp; Recover</button>
           <span style="font-size:0.75rem;color:var(--text-muted);">Dismisses the error and re-homes if needed — like tapping OK/Retry on the printer.</span>`;
      // Active HMS notices with a real description add context to the error
      const hmsWithText = hmsDecoded.filter(h => h.message);
      const hmsBlock = hmsWithText.length
        ? `<div style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:0.6rem;">${hmsWithText.slice(0, 3).map(h => `<div style="margin-bottom:0.2rem;">🔔 <b>${h.formatted.slice(0, 9)}</b>: ${h.message}</div>`).join('')}</div>`
        : '';
      panel.innerHTML = `
        <div style="font-weight:700;color:var(--warning,#fbbf24);margin-bottom:0.35rem;">⚠ Printer error ${decoded.formatted}${paused ? ' — print PAUSED' : ''}</div>
        <div style="font-size:0.9rem;font-weight:600;margin-bottom:0.5rem;">${decoded.message}</div>
        ${hmsBlock}
        ${(decoded.remediation?.length && (!paused || decoded.known)) ? `<ul style="font-size:0.78rem;color:var(--text-secondary);margin:0 0 0.6rem 1.1rem;padding:0;">${decoded.remediation.slice(0, 3).map(r => `<li>${r}</li>`).join('')}</ul>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;">${actions}</div>`;
      panel.style.display = '';
    } else {
      panel.style.display = 'none';
      panel.innerHTML = '';
    }
  }
};

// Software equivalent of tapping OK/Retry on the printer screen: dismiss the
// error, re-home if the firmware holds a homing failure, verify it cleared.
window.recoverPrinter = async function(printerId) {
  const btn = document.getElementById('pc-recover');
  if (btn) { btn.disabled = true; btn.dataset.busy = '1'; btn.textContent = '⏳ Recovering… (up to 45s)'; }
  try {
    const res = await api.recoverPrinter(printerId);
    if (res.ok) {
      toast('Printer recovered — error cleared, printer is idle ✓', 'success');
    } else {
      const errs = res.preflight?.errors?.join('; ') || 'still blocked';
      toast(`Could not recover: ${errs}. Check the bed and the printer screen.`, 'error');
    }
  } catch (err) { toast(err.message, 'error'); }
  if (btn) { delete btn.dataset.busy; btn.textContent = '⚠️ Clear Error & Recover'; }
  refreshPrintControlButtons(printerId);
};

// Light toggle
let _lightOn = false;
window.toggleLight = function(printerId) {
  _lightOn = !_lightOn;
  const btn = document.getElementById('ctrl-light-btn');
  if (btn) {
    btn.textContent = _lightOn ? '💡 Light Off' : '💡 Light On';
    btn.style.background = _lightOn ? 'var(--primary)' : '';
    btn.style.color = _lightOn ? '#fff' : '';
  }
  pCtrl(printerId, _lightOn ? 'light_on' : 'light_off');
};

// Set a slider value and update its label
window.setSlider = function(id, val) {
  const el = document.getElementById(id);
  if (el) {
    el.value = val;
    el.dispatchEvent(new Event('input'));
  }
};

// Movement step size
let _moveStep = 10;
window._ms = function(positive) {
  return positive ? _moveStep : -_moveStep;
};
window._setStep = function(step) {
  _moveStep = step;
  [1,5,10,50].forEach(s => {
    const b = document.getElementById(`step-${s}`);
    if (b) {
      b.style.background = s === step ? 'var(--primary)' : '';
      b.style.color = s === step ? '#fff' : '';
    }
  });
};

// Z-offset — stage only (no send until Apply)
let _zOff = 0;
window.updZOff = function() {
  const v = document.getElementById('ctrl-zoff-val');
  const d = document.getElementById('ctrl-zoff-display');
  const txt = _zOff.toFixed(2) + 'mm';
  if (v) v.textContent = txt;
  if (d) d.textContent = _zOff >= 0 ? '+' + _zOff.toFixed(2) : _zOff.toFixed(2);
};
window.stageZ = function(delta) {
  _zOff = Math.round((_zOff + delta) * 100) / 100;
  _zOff = Math.max(-1, Math.min(1, _zOff));
  updZOff();
};

// Speed profile — stage only (no send until Apply)
let _pendingSpeedProfile = 2;
window.stageSpeedProfile = function(level) {
  _pendingSpeedProfile = level;
  [1,2,3,4].forEach(l => {
    const b = document.getElementById(`sp-${l}`);
    if (b) {
      b.style.background = l === level ? 'var(--primary)' : '';
      b.style.color = l === level ? '#fff' : '';
    }
  });
};

// Speed profile — apply immediate (for reset button)
window.setSpeedProfile = function(printerId, level) {
  stageSpeedProfile(level);
  pCtrl(printerId, 'set_speed_profile', { level });
};

// Apply override — sends the command AND saves to DB
window.applyOverride = async function(printerId, key, value) {
  const actionMap = {
    speed_profile: { action: 'set_speed_profile', key: 'level', transform: v => parseInt(v) },
    speed_override: { action: 'set_speed_override', key: 'percent', transform: v => parseInt(v) },
    flow_override: { action: 'set_flow_override', key: 'percent', transform: v => parseInt(v) },
    z_offset: { action: 'set_z_offset', key: 'offset', transform: v => parseFloat(v) },
  };
  const mapping = actionMap[key];
  if (!mapping) return;

  try {
    // Send to printer
    await api.sendControl(printerId, { action: mapping.action, [mapping.key]: mapping.transform(value) });
    // Save to DB
    await api.setOverride(printerId, key, String(value));
    toast(`Applied ${key.replace(/_/g,' ')}: ${value}`, 'success');
  } catch (err) {
    toast(`Apply failed: ${err.message}`, 'error');
  }
};

// ===== AMS FILAMENT CONFIG =====

// Store AMS state per page instance
let _amsData = null;
let _customColorsAms = []; // saved Custom colors in tray format {name, hex:'RRGGBBAA'}

async function refreshAmsConfig(printerId) {
  const el = document.getElementById('ams-config-content');
  if (!el) return;

  try {
    _amsData = await api.getPrinterAms(printerId);
    try {
      _customColorsAms = (await api.getCustomColors())
        .map(c => ({ name: c.name, hex: c.hex.slice(1).toUpperCase() + 'FF' }));
    } catch { _customColorsAms = []; /* older server */ }
    renderAmsSlots(el, printerId);
  } catch (err) {
    el.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:1rem;">
      <p>Could not load AMS config</p>
      <p style="font-size:0.8rem;">${err.message}</p>
    </div>`;
  }
}
window.refreshAmsConfig = refreshAmsConfig;

// Full-spectrum picker for a tray: applies the color (and its saved name) to
// the tray config, then re-renders so newly-saved Custom colors show as chips.
window.onCustomTrayColor = function (slotIdx, printerId) {
  const slot = _amsData?.slots?.[slotIdx] || {};
  const cur = '#' + String(slot.configured_color || 'FFFFFF').slice(0, 6).toLowerCase();
  showColorPickerModal({
    current: cur,
    title: `Tray ${(slot.tray_id ?? slotIdx) + 1} color`,
    onPick: async (hex, name) => {
      await window.onSwatchClick(slotIdx, hex.slice(1).toUpperCase() + 'FF', name || hex, printerId);
      refreshAmsConfig(printerId); // pick up colors saved inside the picker
    },
  });
};

function renderAmsSlots(el, printerId) {
  const slots = _amsData?.slots || [];
  const types = _amsData?.filament_types || [];
  // built-in palette + saved Custom colors (converted to the tray RRGGBBAA
  // format) — custom trays then match by name/hex everywhere, and auto-map
  // finds them by RGB distance at print start like any other color
  const palette = [...(_amsData?.color_palette || []), ...(_customColorsAms || [])];

  const numSlots = Math.max(slots.length, 4);
  let slotsHtml = '';

  for (let i = 0; i < numSlots; i++) {
    const slot = slots[i] || { ams_id: 0, tray_id: i };

    // Use configured values, falling back to live printer data
    const mat = slot.configured_material || slot.live_type || '';
    const colorHex = slot.configured_color || (slot.live_color ? slot.live_color.replace('#','') : 'FFFFFFFF');
    const colorName = slot.configured_color_name || _matchColorName(colorHex, palette) || '';
    const cssColor = '#' + colorHex.slice(0, 6);
    const hasMat = !!mat;
    const isFromPrinter = !slot.configured_material && !!slot.live_type;

    // What the PRINTER says is physically in this slot (live AMS report)
    const liveHex = (slot.live_color || '').replace('#', '');
    const liveCss = liveHex ? '#' + liveHex.slice(0, 6) : null;
    const liveLabel = slot.live_material_name || slot.live_type || null;
    const liveRemain = (slot.live_remaining ?? -1) >= 0 ? `${slot.live_remaining}% left` : null;
    const mismatch = !!slot.configured_material && !!slot.live_type && (
      slot.configured_material !== slot.live_type ||
      (!!liveHex && !!slot.configured_color && liveHex.slice(0, 6).toUpperCase() !== slot.configured_color.slice(0, 6).toUpperCase())
    );
    const liveLine = liveLabel
      ? `<div style="display:flex;align-items:center;gap:0.35rem;margin-top:0.3rem;font-size:0.72rem;color:${mismatch ? 'var(--warning,#fbbf24)' : 'var(--text-muted)'};" title="Reported live by the printer's AMS">
           <span style="display:inline-block;width:0.7rem;height:0.7rem;border-radius:50%;flex-shrink:0;border:1px solid #555;background:${liveCss || 'var(--bg-secondary)'};"></span>
           <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Printer: ${liveLabel}${liveRemain ? ' · ' + liveRemain : ''}${mismatch ? ' ⚠ differs from config' : ''}</span>
         </div>`
      : `<div style="margin-top:0.3rem;font-size:0.72rem;color:var(--text-muted);opacity:0.7;">Printer: no spool detected</div>`;

    slotsHtml += `
      <div style="background:var(--bg-tertiary);border-radius:12px;padding:1rem;position:relative;border:2px solid ${slot.loaded_now ? 'var(--success,#34d399)' : (hasMat ? 'var(--border-color)' : 'transparent')};">
        <div style="display:flex;align-items:center;gap:0.65rem;margin-bottom:0.75rem;">
          <div style="width:32px;height:32px;border-radius:50%;background:${hasMat ? cssColor : 'var(--bg-secondary)'};border:2px solid var(--border-color);flex-shrink:0;box-shadow:${hasMat ? '0 2px 8px rgba(0,0,0,0.3)' : 'none'};" id="ams-swatch-${i}"></div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:0.92rem;">Tray ${slot.tray_id + 1}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="ams-status-${i}">
              ${hasMat ? mat + (colorName ? ' · ' + colorName : '') : 'Empty — select a material'}
            </div>
            ${liveLine}
          </div>
          <div style="position:absolute;top:0.5rem;right:0.5rem;display:flex;gap:0.25rem;">
            ${slot.loaded_now ? '<span style="font-size:0.6rem;background:rgba(52,211,153,0.15);color:var(--success,#34d399);padding:0.15rem 0.4rem;border-radius:3px;font-weight:700;">● IN EXTRUDER</span>' : ''}
            ${isFromPrinter ? '<span style="font-size:0.6rem;background:rgba(100,200,255,0.12);color:var(--info,#64b5f6);padding:0.15rem 0.4rem;border-radius:3px;font-weight:600;">FROM PRINTER</span>' : ''}
          </div>
        </div>

        <div style="margin-bottom:0.6rem;">
          <label style="font-size:0.7rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:0.25rem;display:block;">Material</label>
          <select class="form-control" id="ams-mat-${i}" style="font-size:0.85rem;padding:0.4rem 0.5rem;" onchange="onTrayMaterialChange(${i},'${printerId}')">
            <option value="">— None —</option>
            ${types.map(t => `<option value="${t}" ${t === mat ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>

        <div>
          <label style="font-size:0.7rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:0.3rem;display:block;">Color</label>
          <div style="display:flex;flex-wrap:wrap;gap:5px;" id="ams-palette-${i}">
            ${palette.map(c => {
              const sel = c.hex === colorHex;
              const bg = '#' + c.hex.slice(0,6);
              const isWhitish = c.hex.startsWith('FFFFFF') || c.hex.startsWith('F5F5');
              const isTransparent = c.hex.endsWith('01');
              return `<div
                onclick="onSwatchClick(${i},'${c.hex}','${c.name.replace(/'/g,"\\'")}','${printerId}')"
                title="${c.name}"
                style="width:24px;height:24px;border-radius:50%;cursor:pointer;
                  background:${isTransparent ? 'linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%);background-size:8px 8px;background-position:0 0,4px 4px' : bg};
                  border:${sel ? '3px solid var(--primary,#7c4dff)' : (isWhitish ? '1px solid var(--border-color)' : '1px solid transparent')};
                  box-shadow:${sel ? '0 0 0 1px var(--primary,#7c4dff), 0 2px 6px rgba(124,77,255,0.3)' : 'none'};
                  transform:${sel ? 'scale(1.15)' : 'scale(1)'};
                  transition:all 0.15s ease;"
              ></div>`;
            }).join('')}
            <div
              onclick="onCustomTrayColor(${i},'${printerId}')"
              title="Custom color… (full spectrum)"
              style="width:24px;height:24px;border-radius:50%;cursor:pointer;background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);border:1px solid var(--border-color);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;text-shadow:0 0 2px #000;"
            >＋</div>
          </div>
        </div>
      </div>
    `;
  }

  // Header: what the printer reports right now (loaded tray + AMS humidity)
  const humidityText = (_amsData?.humidity || [])
    .map(h => `AMS ${h.ams_id + 1} humidity ${h.humidity}/5${h.humidity <= 2 ? ' (dry)' : (h.humidity >= 4 ? ' (humid ⚠)' : '')}`)
    .join(' · ');
  let loadedText;
  if (_amsData?.external_spool_loaded) loadedText = 'external spool in extruder';
  else if (_amsData?.tray_now !== null && _amsData?.tray_now !== undefined) loadedText = `Tray ${(_amsData.tray_now % 4) + 1}${_amsData.tray_now > 3 ? ` (AMS ${Math.floor(_amsData.tray_now / 4) + 1})` : ''} in extruder`;
  else loadedText = 'no filament in extruder';
  const liveHeader = _amsData?.ams_available
    ? `<div style="display:flex;flex-wrap:wrap;gap:0.5rem 1rem;align-items:center;margin-bottom:0.75rem;font-size:0.78rem;color:var(--text-secondary);">
         <span title="Reported live by the printer">🖨 Printer reports: <b>${loadedText}</b></span>
         ${humidityText ? `<span>💧 ${humidityText}</span>` : ''}
       </div>`
    : `<div style="margin-bottom:0.75rem;font-size:0.78rem;color:var(--text-muted);">🖨 No live AMS report from the printer (offline?) — showing saved configuration.</div>`;

  el.innerHTML = `
    ${liveHeader}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0.75rem;">
      ${slotsHtml}
    </div>
    <div style="margin-top:0.75rem;text-align:right;font-size:0.78rem;color:var(--text-muted);">
      Changes save automatically. Use "Sync to Printer" to push to the AMS.
    </div>
  `;
}

// Match a hex color to the closest palette name
function _matchColorName(hex, palette) {
  const h = hex.toUpperCase().replace('#','');
  const match = palette.find(c => c.hex.toUpperCase() === h);
  if (match) return match.name;
  // Check just RGB (ignore alpha)
  const rgb = h.slice(0,6);
  const rgbMatch = palette.find(c => c.hex.toUpperCase().slice(0,6) === rgb);
  return rgbMatch?.name || '';
}

window.onSwatchClick = async function(slotIdx, colorHex, colorName, printerId) {
  const matEl = document.getElementById(`ams-mat-${slotIdx}`);
  const material = matEl?.value;
  if (!material) {
    toast('Select a material first', 'warning');
    return;
  }

  const slot = _amsData?.slots?.[slotIdx] || { ams_id: 0, tray_id: slotIdx };
  try {
    await api.setAmsTray(printerId, slot.tray_id, {
      material,
      color_hex: colorHex,
      color_name: colorName,
      ams_id: slot.ams_id,
    });
    // Update UI
    const swatch = document.getElementById(`ams-swatch-${slotIdx}`);
    if (swatch) {
      swatch.style.background = '#' + colorHex.slice(0, 6);
      swatch.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
    }
    const status = document.getElementById(`ams-status-${slotIdx}`);
    if (status) status.textContent = material + ' · ' + colorName;

    // Re-highlight swatches
    const paletteEl = document.getElementById(`ams-palette-${slotIdx}`);
    if (paletteEl) {
      paletteEl.querySelectorAll('div').forEach(d => {
        const isSelected = d.getAttribute('onclick')?.includes(`'${colorHex}'`);
        d.style.border = isSelected ? '3px solid var(--primary,#7c4dff)' : (d.title.match(/White|Natural/) ? '1px solid var(--border-color)' : '1px solid transparent');
        d.style.boxShadow = isSelected ? '0 0 0 1px var(--primary,#7c4dff), 0 2px 6px rgba(124,77,255,0.3)' : 'none';
        d.style.transform = isSelected ? 'scale(1.15)' : 'scale(1)';
      });
    }
  } catch (err) {
    toast('Failed to save color: ' + err.message, 'error');
  }
};

window.onTrayMaterialChange = async function(slotIdx, printerId) {
  const matEl = document.getElementById(`ams-mat-${slotIdx}`);
  if (!matEl) return;

  const material = matEl.value;
  if (!material) return;

  // Use currently selected color or default white
  const slot = _amsData?.slots?.[slotIdx] || { ams_id: 0, tray_id: slotIdx };
  const colorHex = slot.configured_color || (slot.live_color ? slot.live_color.replace('#','') : 'FFFFFFFF');
  const palette = _amsData?.color_palette || [];
  const colorName = _matchColorName(colorHex, palette) || 'White';

  try {
    await api.setAmsTray(printerId, slot.tray_id, {
      material,
      color_hex: colorHex,
      color_name: colorName,
      ams_id: slot.ams_id,
    });
    const swatch = document.getElementById(`ams-swatch-${slotIdx}`);
    if (swatch) {
      swatch.style.background = '#' + colorHex.slice(0, 6);
      swatch.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
    }
    const status = document.getElementById(`ams-status-${slotIdx}`);
    if (status) status.textContent = material + ' · ' + colorName;
  } catch (err) {
    toast('Failed to save tray: ' + err.message, 'error');
  }
};

window.syncAmsToDevice = async function(printerId) {
  try {
    toast('Syncing AMS to printer...', 'info');
    const result = await api.syncAms(printerId);
    const ok = result.synced?.filter(r => r.status === 'sent').length || 0;
    const total = result.synced?.length || 0;
    toast(`AMS synced: ${ok}/${total} trays pushed to printer`, 'success');
    setTimeout(() => refreshAmsConfig(printerId), 1500);
  } catch (err) {
    toast('AMS sync failed: ' + err.message, 'error');
  }
};

// ===== ACCESSORIES =====
route('/accessories', async (el) => {
  const accessories = await api.getAccessories();
  el.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
      <h1 class="text-gradient-flow" style="font-size:1.4rem;font-weight:700;">Accessories</h1>
      <button class="btn btn-primary" onclick="showAttachAccessoryModal()">+ Add Accessory</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Type</th><th>Printer</th><th>Connection</th><th>Health</th><th>Last Seen</th><th>Actions</th></tr></thead>
        <tbody>
          ${accessories.length === 0 ? html`<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem;">No accessories registered</td></tr>` :
      accessories.map(a => html`
              <tr>
                <td><strong>${a.type.replace(/_/g, ' ')}</strong></td>
                <td>${a.printer_id ? html`<a href="#/printers/${a.printer_id}">${a.printer_id.slice(0, 8)}...</a>` : '—'}</td>
                <td>${a.connection_type}</td>
                <td><span class="status-dot ${a.health}"></span> ${a.health}</td>
                <td>${timeAgo(a.last_seen)}</td>
                <td>
                  <div class="btn-group">
                    <button class="btn btn-sm" onclick="api.testAccessory('${a.accessory_id}').then(r=>toast(JSON.stringify(r),'success'))">Test</button>
                    <button class="btn btn-sm btn-danger" onclick="if(confirm('Delete?')){api.deleteAccessory('${a.accessory_id}').then(()=>location.reload())}">Delete</button>
                  </div>
                </td>
              </tr>
            `).join('')}
        </tbody>
      </table>
    </div>
  `;
});

// ===== JOBS (Queue + Templates) =====
// ===== JOBS (Queue + History + Templates) =====
route('/jobs', async (el) => {
  // Setup HTML structure immediately
  el.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
      <h1 class="text-gradient-flow" style="font-size:1.4rem;font-weight:700;">Jobs</h1>
      <div class="btn-group">
        <button class="btn btn-primary" id="submit-job-btn">+ Submit Job</button>
        <button class="btn" id="save-template-btn">Save Template</button>
      </div>
    </div>

    <!-- Tab Navigation -->
    <div class="mobile-scroll-tabs" style="display:flex;gap:0.5rem;margin-bottom:1.25rem;border-bottom:2px solid var(--border-color);padding-bottom:0;">
      <button class="btn btn-sm tab-btn active" data-tab="queue" style="border-radius:var(--radius-md) var(--radius-md) 0 0;border-bottom:2px solid var(--accent-primary);margin-bottom:-2px;">
        Active Queue <span id="badge-queue" class="badge badge-info" style="margin-left:0.3rem;">0</span>
      </button>
      <button class="btn btn-sm tab-btn" data-tab="history" style="border-radius:var(--radius-md) var(--radius-md) 0 0;margin-bottom:-2px;">
        History <span id="badge-history" class="badge badge-default" style="margin-left:0.3rem;">0</span>
      </button>
      <button class="btn btn-sm tab-btn" data-tab="templates" style="border-radius:var(--radius-md) var(--radius-md) 0 0;margin-bottom:-2px;">
        Templates <span id="badge-templates" class="badge badge-default" style="margin-left:0.3rem;">0</span>
      </button>
    </div>

    <!-- Active Queue Tab -->
    <div id="tab-queue" class="tab-content">
      <div class="card">
        <div class="table-wrap" id="queue-table-container">
          <div class="loading-overlay" style="position:relative;height:100px;"><div class="spinner"></div></div>
        </div>
      </div>
      <!-- Debug Trace Panel (toggle) -->
      <details id="debug-trace-panel" style="margin-top:1rem;">
        <summary style="cursor:pointer;font-weight:600;color:var(--accent-primary);font-size:0.9rem;user-select:none;">
          🔍 Debug Trace (Send Pipeline)
          <button class="btn btn-sm" style="margin-left:0.5rem;font-size:0.75rem;" onclick="event.preventDefault();window._debugTrace=[];document.getElementById('debug-trace-log').innerHTML='';toast('Trace cleared','info');">Clear</button>
        </summary>
        <div id="debug-trace-log" style="margin-top:0.5rem;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:0.75rem;font-family:'Fira Code',monospace;font-size:0.78rem;max-height:400px;overflow-y:auto;white-space:pre-wrap;line-height:1.6;">
          <span style="color:var(--text-muted);">Click "Start" on a queued job to see the live send pipeline trace here...</span>
        </div>
      </details>
    </div>

     <div id="tab-history" class="tab-content" style="display:none;">
       <div class="card">
          <div style="padding:1rem;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border-color);">
             <button class="btn btn-sm btn-outline btn-danger" onclick="if(confirm('Clear all job history? This will delete all completed/failed/canceled jobs and their files.')) { api.clearJobHistory().then(r => { toast('Cleared ' + (r.count||0) + ' jobs', 'success'); document.getElementById('history-table-container').innerHTML = '<div class=&quot;empty-state&quot;><p>No job history</p></div>'; }).catch(e=>toast(e.message,'error')); }">Clear All</button>
             <div class="form-group" style="margin:0;display:flex;align-items:center;gap:0.5rem;">
                 <label style="margin:0;font-size:0.85rem;">Limit:</label>
                 <div class="select-wrapper">
                   <select id="history-limit" class="form-control">
                       <option value="20">20</option>
                       <option value="50">50</option>
                       <option value="100">100</option>
                   </select>
                 </div>
             </div>
          </div>
         <div class="table-wrap" id="history-table-container" style="border-top:none;border-top-left-radius:0;border-top-right-radius:0;">
           <div class="loading-overlay" style="position:relative;height:100px;"><div class="spinner"></div></div>
         </div>
       </div>
     </div>

     <!-- Templates Tab -->
    <div id="tab-templates" class="tab-content" style="display:none;">
      <div id="templates-container">
        <div class="loading-overlay" style="position:relative;height:100px;"><div class="spinner"></div></div>
      </div>
    </div>
  `;

  // --- Logic ---
  let currentPrinters = [];
  let currentProfiles = [];

  // load static data once
  const [printers, profiles] = await Promise.all([api.getPrinters(), api.getProfiles()]);
  currentPrinters = printers;
  currentProfiles = profiles;

  // Refresh function
  const refreshJobs = async () => {
    // If user navigated away, stop refreshing (and cleanup listeners if possible, but this check prevents errors)
    if (!document.getElementById('queue-table-container')) return;

    const historyLimit = $('#history-limit')?.value || 20;

    const [jobs, templates] = await Promise.all([
      api.getJobs({ limit: historyLimit }), // Fetch jobs (orchestrator returns separate lists? no, returns all based on params. Actually getJobs returns all by default or filtered. default is all? check api.js: getJobs(params={}). Backend likely returns all. )
      api.getJobTemplates()
    ]);

    // Split jobs
    const activeJobs = jobs.filter(j => ['queued', 'assigned', 'printing'].includes(j.status));
    const historyJobs = jobs.filter(j => ['completed', 'failed', 'canceled'].includes(j.status));

    // Update badges
    $('#badge-queue').textContent = activeJobs.length;
    $('#badge-history').textContent = historyJobs.length;
    $('#badge-templates').textContent = templates.length;

    // Render Queue
    const queueHtml = activeJobs.length === 0
      ? '<div class="empty-state"><p>No active jobs</p><p style="font-size:0.85rem;color:var(--text-muted);">Submit a job or use a template to get started</p></div>'
      : `<table>
            <thead><tr><th>Name</th><th>Status</th><th>Printer</th><th>Profile</th><th>Repeats</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>${activeJobs.map(j => renderJobRow(j, currentPrinters, currentProfiles)).join('')}</tbody>
           </table>`;
    $('#queue-table-container').innerHTML = queueHtml;

    // Render History
    const historyHtml = historyJobs.length === 0
      ? '<div class="empty-state"><p>No job history</p></div>'
      : `<table>
            <thead><tr><th>Name</th><th>Status</th><th>Printer</th><th>Profile</th><th>Repeats</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>${historyJobs.map(j => renderJobRow(j, currentPrinters, currentProfiles, true)).join('')}</tbody>
           </table>`;
    $('#history-table-container').innerHTML = historyHtml;

    // Render Templates (static-ish, but good to refresh)
    renderTemplates(templates, currentPrinters, currentProfiles);
  };

  // Helper: Render Job Row
  const renderJobRow = (j, printers, profiles, isHistory = false) => {
    const printer = printers.find(p => p.printer_id === j.printer_id);
    const profile = profiles.find(p => p.profile_id === j.profile_id);

    // Printer selection logic for queued jobs
    let printerCell = '—';
    if (j.status === 'printing') {
      printerCell = printer ? printer.name : '—';
    } else if (isHistory) {
      printerCell = printer ? printer.name : (j.printer_id ? j.printer_id.slice(0, 8) : '—');
    } else {
      // Dropdown for unassigned/queued
      printerCell = html`
          <select class="form-control" style="font-size:0.82rem;padding:0.25rem 0.5rem;min-width:120px;"
            onchange="api.updateJob('${j.job_id}', {printer_id: this.value}).catch(e=>toast(e.message,'error'))">
            <option value="" ${!j.printer_id ? 'selected' : ''}>— Unassigned —</option>
            ${printers.map(p => html`<option value="${p.printer_id}" ${j.printer_id === p.printer_id ? 'selected' : ''}>${p.name}</option>`).join('')}
          </select>
        `;
    }

    const actions = isHistory ? html`
        <button class="btn btn-sm" onclick="saveJobAsTemplate('${j.job_id}','${j.name.replace(/'/g, "\\'")}','${j.profile_id || ''}','${j.printer_id || ''}',${j.repeat_total})">Save</button>
        ${j.transformed_file_name ? html`<a class="btn btn-sm" href="${api.getJobDownloadUrl(j.job_id)}" title="Download" download>Download</a>` : ''}
        <button class="btn btn-sm btn-danger" onclick="if(confirm('Delete this job record?')) { api.deleteJob('${j.job_id}').catch(e=>toast(e.message,'error')); }" title="Delete">Delete</button>
    ` : html`
        ${['queued', 'assigned'].includes(j.status) ? html`<button class="btn btn-sm btn-success" onclick="api.startJob('${j.job_id}').catch(e=>toast(e.message,'error'))">Start</button>` : ''}
        ${!['completed', 'canceled', 'failed'].includes(j.status) ? html`<button class="btn btn-sm btn-danger" onclick="api.cancelJob('${j.job_id}').catch(e=>toast(e.message,'error'))">Cancel</button>` : ''}
        ${j.transformed_file_name ? html`<a class="btn btn-sm" href="${api.getJobDownloadUrl(j.job_id)}" title="Download transformed G-code" download>⬇️</a>` : ''}
    `;

    return html`
        <tr style="${isHistory ? 'opacity:0.7;' : ''}">
            <td><a href="#/jobs/${j.job_id}" style="font-weight:600;">${j.name}</a></td>
            <td>${statusBadge(j.status)}</td>
            <td>${printerCell}</td>
            <td style="font-size:0.8rem;">${profile ? profile.name : '—'}</td>
            <td>${j.repeat_remaining}/${j.repeat_total}</td>
            <td>${timeAgo(j.created_at)}</td>
            <td><div class="btn-group">${actions}</div></td>
        </tr>`;
  };

  // Helper: Render Templates
  const renderTemplates = (templates, printers, profiles) => {
    const container = $('#templates-container');
    if (templates.length === 0) {
      container.innerHTML = html`
              <div class="empty-state">
              <h3>No Saved Templates</h3>
              <p>Save a job configuration as a template for quick re-use.</p>
              <button class="btn btn-primary" id="save-template-btn-2">Create Template</button>
            </div>`;
      const btn2 = $('#save-template-btn-2');
      if (btn2) btn2.onclick = () => showSaveTemplateModal(profiles, printers);
      return;
    }

    container.innerHTML = `<div class="grid-3">${templates.map(t => {
      const printer = printers.find(p => p.printer_id === t.printer_id);
      const profile = profiles.find(p => p.profile_id === t.profile_id);
      const hasFile = !!t.source_file_name;
      return html`
              <div class="card" style="position:relative;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem;">
                  <div>
                    <h3 style="font-size:1rem;font-weight:700;">${t.name}</h3>
                    <p style="font-size:0.78rem;color:var(--text-muted);margin-top:0.15rem;">${t.description || 'No description'}</p>
                  </div>
                  <div style="display:flex;gap:0.35rem;align-items:center;">
                    ${t.use_count > 0 ? html`<span class="badge badge-default" title="Times used">${t.use_count}×</span>` : ''}
                    ${hasFile ? html`<span class="badge badge-success" style="font-size:0.65rem;">📁 File Saved</span>` : html`<span class="badge badge-warning" style="font-size:0.65rem;">⚠ No File</span>`}
                  </div>
                </div>
                <div style="font-size:0.82rem;display:grid;grid-template-columns:auto 1fr;gap:0.25rem 0.75rem;margin:0.5rem 0;">
                  <span style="color:var(--text-muted);">Profile:</span> <span>${profile ? profile.name : '—'}</span>
                  <span style="color:var(--text-muted);">Printer:</span> <span>${printer ? printer.name : 'Any (Global Queue)'}</span>
                  <span style="color:var(--text-muted);">Repeats:</span> <span>${t.repeat_total}</span>
                  ${hasFile ? html`<span style="color:var(--text-muted);">File:</span> <span style="font-size:0.78rem;">${t.source_file_name}</span>` : ''}
                  ${t.tags?.length ? html`<span style="color:var(--text-muted);">Tags:</span> <span>${t.tags.map(tag => html`<span class="badge badge-info" style="font-size:0.7rem;margin-right:0.25rem;">${tag}</span>`).join('')}</span>` : ''}
                </div>
                <div class="btn-group" style="margin-top:0.75rem;">
                  ${hasFile ? html`<button class="btn btn-sm btn-primary" style="background:linear-gradient(135deg, var(--accent-primary), var(--primary));font-weight:700;" onclick="quickSubmitTemplate('${t.template_id}', '${t.name.replace(/'/g, "\\'")}')">▶ Send to Queue</button>` : ''}
                  <button class="btn btn-sm ${hasFile ? '' : 'btn-primary'}" onclick="useTemplate('${t.template_id}')">${hasFile ? 'Edit & Submit' : 'Upload File & Submit'}</button>
                  <button class="btn btn-sm btn-danger" onclick="if(confirm('Delete template?')){api.deleteJobTemplate('${t.template_id}').then(()=>window.jobRefreshHandler())}">Delete</button>
                </div>
              </div>`;
    }).join('')}</div>`;
  };

  // CLEANUP previous listeners
  if (window.jobRefreshHandler) {
    window.ws.off('job.created', window.jobRefreshHandler);
    window.ws.off('job.updated', window.jobRefreshHandler);
    window.ws.off('job.status_changed', window.jobRefreshHandler);
    window.ws.off('job.canceled', window.jobRefreshHandler);
    window.ws.off('job.completed', window.jobRefreshHandler);
  }

  // Define new handler
  window.jobRefreshHandler = () => refreshJobs();

  // Attach listeners
  window.ws.on('job.created', window.jobRefreshHandler);
  window.ws.on('job.updated', window.jobRefreshHandler);
  window.ws.on('job.status_changed', window.jobRefreshHandler);
  window.ws.on('job.canceled', window.jobRefreshHandler);
  window.ws.on('job.completed', window.jobRefreshHandler);
  window.ws.on('job.deleted', window.jobRefreshHandler); // Add deleted event
  window.ws.on('jobs.history_cleared', window.jobRefreshHandler); // Add history cleared event (matches server broadcast)

  // Initial Fetch
  await refreshJobs();

  // SETUP INTERACTION HANDLERS

  // Tab switching
  $$('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      $$('.tab-btn').forEach(b => { b.classList.remove('active'); b.style.borderBottom = '2px solid transparent'; });
      btn.classList.add('active');
      btn.style.borderBottom = '2px solid var(--accent-primary)';
      $$('.tab-content').forEach(tc => tc.style.display = 'none');
      $(`#tab-${btn.dataset.tab}`).style.display = 'block';
    };
  });

  // Events
  $('#submit-job-btn').onclick = () => showSubmitJobModal(currentProfiles, currentPrinters);
  const saveTmplBtn = $('#save-template-btn');
  if (saveTmplBtn) saveTmplBtn.onclick = () => showSaveTemplateModal(currentProfiles, currentPrinters);

  if ($('#history-limit')) {
    $('#history-limit').onchange = () => refreshJobs();
  }
});

// ===== JOB DETAIL =====
route('/jobs/:id', async (el, { id }) => {
  const job = await api.getJob(id);
  const report = job.transform_report;
  let events = [];
  try { events = await api.getEntityEvents('job', id); } catch { }

  el.innerHTML = html`
    <div style="margin-bottom:1.25rem;">
      <a href="#/jobs" style="font-size:0.8rem;color:var(--text-muted);">Back to Jobs</a>
      <h1 style="font-size:1.4rem;font-weight:700;margin-top:0.25rem;">${job.name}</h1>
      <div style="display:flex;gap:0.75rem;align-items:center;margin-top:0.35rem;">
        ${statusBadge(job.status)}
        <span style="font-size:0.82rem;color:var(--text-secondary);">${job.repeat_remaining}/${job.repeat_total} repeats remaining</span>
      </div>
    </div>

    <div class="grid-2">
      <!-- Transform Report -->
      <div class="card">
        <div class="card-header"><h3>G-code Transform Report</h3></div>
        ${report ? html`
          <div style="font-size:0.85rem;">
            <p><strong>Profile:</strong> ${report.profile_name}</p>
            <p><strong>Method:</strong> ${report.prime_line?.method_used || '—'}</p>
            <p><strong>Lines Disabled:</strong> ${report.prime_line?.lines_disabled_count || 0}</p>
            <p><strong>Original Lines:</strong> ${report.original_line_count}</p>
            <p><strong>Transformed Lines:</strong> ${report.transformed_line_count}</p>
            <p><strong>Transform Time:</strong> ${report.transform_time_ms}ms</p>
            <p><strong>Hash:</strong> <code style="font-size:0.75rem;color:var(--text-muted);">${report.hash?.slice(0, 24)}...</code></p>
            ${report.warnings?.length ? html`
              <div style="margin-top:0.75rem;">
                <strong style="color:var(--warning);">Warnings:</strong>
                <ul style="margin-top:0.25rem;padding-left:1rem;">${report.warnings.map(w => html`<li style="font-size:0.82rem;color:var(--text-secondary);">${w}</li>`).join('')}</ul>
              </div>
            ` : ''}
          </div>
        ` : html`<p style="color:var(--text-muted);">No transform report available</p>`}
        ${job.transformed_file_name ? html`
          <div style="margin-top:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
            <a class="btn btn-sm btn-primary" href="${api.getJobDownloadUrl(job.job_id, 'transformed')}" download>Download Transformed</a>
            <a class="btn btn-sm" href="${api.getJobDownloadUrl(job.job_id, 'original')}" download>Download Original</a>
          </div>
        ` : ''}
      </div>

      <!-- AG Markers -->
      <div class="card">
        <div class="card-header"><h3>Automation Markers</h3></div>
        ${report?.markers ? html`
          <div style="font-size:0.82rem;font-family:var(--font-mono);background:var(--bg-secondary);padding:0.75rem;border-radius:var(--radius-md);line-height:1.8;">
            ${Object.entries(report.markers.markers || {}).map(([k, v]) => html`
              <div><span style="color:var(--accent-primary);">;${k}</span>=<span style="color:var(--accent-secondary);">${v}</span></div>
            `).join('')}
          </div>
        ` : html`<p style="color:var(--text-muted);">No markers inserted</p>`}
      </div>

      <!-- Job Runs -->
      <div class="card">
        <div class="card-header"><h3>Runs</h3></div>
        ${(job.runs || []).length === 0 ? html`<p style="color:var(--text-muted);font-size:0.85rem;">No runs yet</p>` :
      html`<div class="table-wrap"><table><thead><tr><th>Status</th><th>Started</th><th>Ended</th></tr></thead><tbody>
            ${job.runs.map(r => html`<tr><td>${statusBadge(r.status)}</td><td>${timeAgo(r.started_at)}</td><td>${timeAgo(r.ended_at)}</td></tr>`).join('')}
          </tbody></table></div>`}
      </div>

      <!-- Timeline -->
      <div class="card">
        <div class="card-header"><h3>Timeline</h3></div>
        <div class="timeline">
          ${events.slice(0, 20).map(e => html`
            <div class="timeline-item">
              <div class="time">${timeAgo(e.created_at)}</div>
              <div class="event">${e.event_type}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
});

// ===== PROFILES =====
route('/profiles', async (el) => {
  const profiles = await api.getProfiles();
  el.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
      <h1 class="text-gradient-flow" style="font-size:1.4rem;font-weight:700;">Profiles</h1>
      <button class="btn btn-primary" onclick="showCreateProfileModal()">+ New Profile</button>
    </div>
    <div class="grid-3">
      ${profiles.map(p => html`
        <div class="card">
          <h3 style="font-size:1rem;font-weight:700;margin-bottom:0.5rem;">${p.name}</h3>
          <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.75rem;">${p.description || 'No description'}</p>
          <div style="font-size:0.8rem;display:grid;grid-template-columns:1fr 1fr;gap:0.3rem;">
            <span style="color:var(--text-muted);">Model:</span> <span>${p.printer_model}</span>
            <span style="color:var(--text-muted);">Release Temp:</span> <span>${p.release_bed_temp_c}°C</span>
            <span style="color:var(--text-muted);">Prime Removal:</span> <span>${p.remove_front_prime_line ? '✓' : '✗'}</span>
            <span style="color:var(--text-muted);">AG Tags:</span> <span>${p.insert_automation_tags ? '✓' : '✗'}</span>
            <span style="color:var(--text-muted);">Park:</span> <span>X${p.park_x_mm} Y${p.park_y_mm || 'auto'} Z${p.park_z_mm}</span>
            <span style="color:var(--text-muted);">Eject Mode:</span> <span>${formatEjectMode(p.eject_mode)}</span>
          </div>
          <div class="btn-group" style="margin-top:0.75rem;">
            ${p.is_system ?
      html`<span class="badge badge-default" style="margin-left:auto;">System Profile</span>` :
      html`<button class="btn btn-sm btn-danger" onclick="if(confirm('Delete profile?')){api.deleteProfile('${p.profile_id}').then(()=>location.reload())}">Delete</button>`
    }
          </div>
        </div>
      `).join('')}
    </div>
  `;
});

// ===== SAVED PRINTS (reusable print jobs: preview + text fill + settings) =====

route('/prints', async (el) => {
  const prints = await api.request('GET', '/slice/templates').catch(() => []);
  el.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
      <h1 class="text-gradient-flow" style="font-size:1.4rem;font-weight:700;">Saved Prints</h1>
      <a href="#/slicer" class="btn btn-sm">Open Slicer</a>
    </div>
    ${!prints.length ? html`
      <div class="empty-state" style="padding:2rem;">
        <p>No saved print jobs yet.</p>
        <p style="color:var(--text-muted);font-size:0.8rem;">Build a plate in the <a href="#/slicer" style="color:var(--accent-primary);">Slicer</a> and hit <b>💾 Save print job</b>. Prints with a text object get an editable text field here.</p>
      </div>` : html`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0.8rem;">
        ${prints.map(p => html`
          <a href="#/prints/${p.template_id}" class="card" style="display:block;padding:0.9rem;text-decoration:none;color:inherit;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <b style="font-size:0.95rem;">${p.name}</b>
              ${p.has_text ? '<span class="badge badge-success" title="Has an editable text field">✏️ text</span>' : '<span class="badge badge-default">model</span>'}
            </div>
            <div style="color:var(--text-muted);font-size:0.75rem;margin-top:0.35rem;">
              ${p.printer_model} · ${p.objects} object(s)${p.has_text ? ` · ${p.mode}` : ''}
            </div>
          </a>`).join('')}
      </div>`}
  `;
});

route('/prints/:id', async (el, { id }) => {
  const t = await api.request('GET', `/slice/templates/${id}`).catch(() => null);
  if (!t) { el.innerHTML = '<div class="empty-state"><p>Print not found.</p><a href="#/prints">Back</a></div>'; return; }
  const meta = await api.getSliceBackends().catch(() => ({ setting_fields: [] }));
  const fields = meta.setting_fields || [];
  const groups = [...new Set(fields.map(f => f.group))];
  const printers = await api.getPrinters().catch(() => []);
  const printerList = printers.printers || printers || [];

  const fieldHtml = (f) => {
    const unit = f.unit ? ` (${f.unit})` : '';
    const cur = t.settings?.[f.key] ?? '';
    if (f.type === 'bool')
      return html`<div><label style="font-size:0.72rem;color:var(--text-muted);">${f.label}</label>
        <select class="form-control pr-set" data-key="${f.key}">
          <option value="" ${cur === '' ? 'selected' : ''}>default</option>
          <option value="true" ${String(cur) === 'true' || cur === '1' ? 'selected' : ''}>on</option>
          <option value="false" ${String(cur) === 'false' || cur === '0' ? 'selected' : ''}>off</option>
        </select></div>`;
    if (f.type === 'select')
      return html`<div><label style="font-size:0.72rem;color:var(--text-muted);">${f.label}</label>
        <select class="form-control pr-set" data-key="${f.key}">
          <option value="" ${cur === '' ? 'selected' : ''}>default</option>
          ${f.options.map(o => html`<option value="${o}" ${cur === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select></div>`;
    return html`<div><label style="font-size:0.72rem;color:var(--text-muted);">${f.label}${unit}</label>
      <input class="form-control pr-set" data-key="${f.key}" type="number" value="${cur}"
        ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.step != null ? `step="${f.step}"` : ''} placeholder="default"></div>`;
  };

  el.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.8rem;">
      <div>
        <a href="#/prints" style="font-size:0.8rem;color:var(--text-muted);">← Saved Prints</a>
        <h1 class="text-gradient-flow" style="font-size:1.3rem;font-weight:700;">${t.name}</h1>
        <span style="color:var(--text-muted);font-size:0.78rem;">${t.printer_model}${t.has_text ? ` · text (${t.mode})` : ''} · ${t.base_files.length} object(s)</span>
      </div>
      <button class="btn btn-sm btn-danger" id="pr-delete">Delete</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 360px;gap:1rem;align-items:start;">
      <div class="card" style="padding:0;overflow:hidden;">
        <div id="pr-viewer" style="width:100%;height:66vh;min-height:380px;"></div>
        <div style="padding:0.4rem 0.8rem;color:var(--text-muted);font-size:0.7rem;">Drag to rotate · right-drag / shift-drag to pan · scroll to zoom</div>
      </div>
      <div class="card" style="display:flex;flex-direction:column;gap:0.7rem;max-height:80vh;overflow-y:auto;">
        ${t.has_text ? html`
          <div>
            <label style="font-size:0.78rem;color:var(--text-muted);">Text</label>
            <input class="form-control" id="pr-text" maxlength="${t.text_def?.maxChars || 40}" placeholder="Type the text to print…" value="">
            <small id="pr-text-status" style="color:var(--text-muted);font-size:0.68rem;">Preview updates as you type.</small>
          </div>` : ''}
        <details>
          <summary style="cursor:pointer;font-size:0.85rem;font-weight:600;">Print settings</summary>
          ${groups.map(g => html`
            <details style="margin-top:0.35rem;">
              <summary style="cursor:pointer;font-size:0.78rem;">${g}</summary>
              <div style="margin-top:0.4rem;display:grid;grid-template-columns:1fr 1fr;gap:0.4rem;">
                ${fields.filter(f => f.group === g).map(fieldHtml).join('')}
              </div>
            </details>`).join('')}
          <button class="btn btn-sm btn-outline" id="pr-save-settings" style="margin-top:0.5rem;">💾 Save settings to this print</button>
        </details>
        <div style="border-top:1px solid var(--border,#26304a);padding-top:0.6rem;">
          <label style="font-size:0.78rem;color:var(--text-muted);">Print it</label>
          <select class="form-control" id="pr-printer">
            <option value="">— choose printer —</option>
            ${printerList.map(p => html`<option value="${p.printer_id}">${p.name} (${p.model || '?'})</option>`).join('')}
          </select>
          <div style="display:flex;gap:0.4rem;margin-top:0.35rem;align-items:center;">
            <label style="font-size:0.72rem;color:var(--text-muted);">Repeats</label>
            <input class="form-control" id="pr-repeat" type="number" min="1" value="1" style="width:5rem;">
            <button class="btn btn-primary" id="pr-print" style="flex:1;">Slice & Queue</button>
          </div>
          <div id="pr-result" style="margin-top:0.5rem;font-size:0.78rem;"></div>
        </div>
      </div>
    </div>
  `;

  // ----- 3D preview -----
  const preview3d = await import('./preview3d.js');
  const text3d = await import('./text3d.js');
  const bed = t.printer_model === 'A1_MINI' ? { x: 180, y: 180, z: 180 } : { x: 256, y: 256, z: 256 };
  const pv = preview3d.createPreview($('#pr-viewer'), { bed });
  const cleanup = () => { pv.dispose(); window.removeEventListener('hashchange', onLeave); };
  const onLeave = () => { if (!(location.hash.slice(1) || '/').startsWith('/prints/')) cleanup(); };
  window.addEventListener('hashchange', onLeave);

  // load the baked base models (printer coords) with their saved colors
  for (const f of t.base_files) {
    try {
      const r = await fetch(`/api/slice/templates/${id}/files/${f.index}`, { headers: { Authorization: `Bearer ${api.token}` } });
      if (!r.ok) continue;
      pv.addSTL(await r.arrayBuffer(), f.color || '#8b95a8');
    } catch { /* skip file */ }
  }
  pv.fit();

  // live text preview: identical geometry pipeline to the server-side fill
  const td = t.text_def || {};
  let textTimer = null;
  let fittedWithText = false;
  const renderText = async () => {
    const text = $('#pr-text')?.value?.trim();
    if (!text) { pv.setTextMesh(null); return; }
    try {
      const fdef = text3d.FONTS.find(f => f.id === td.fontId) || text3d.FONTS[0];
      const font = await text3d.loadFont(fdef.url);
      const geo = text3d.buildTextGeometry(font, { text, sizeMm: td.sizeMm || 10, thicknessMm: td.thicknessMm || 2 });
      if (!geo) { $('#pr-text-status').textContent = 'No printable glyphs.'; pv.setTextMesh(null); return; }
      geo.rotateX(-Math.PI / 2);
      geo.computeBoundingBox();
      const c = new pv.THREE.Vector3(); geo.boundingBox.getCenter(c);
      geo.translate(-c.x, -c.y, -c.z);
      const m = new pv.THREE.Matrix4().fromArray(td.matrixWorld);
      if (td.mode === 'deboss') {
        const q = new pv.THREE.Quaternion(); m.decompose(new pv.THREE.Vector3(), q, new pv.THREE.Vector3());
        const w = new pv.THREE.Vector3(0, 1, 0).applyQuaternion(q).multiplyScalar(-((td.thicknessMm || 2) - 0.4));
        m.premultiply(new pv.THREE.Matrix4().makeTranslation(w.x, w.y, w.z));
      }
      geo.applyMatrix4(m);
      pv.setTextMesh(geo, td.mode === 'deboss' ? '#20242e' : (td.color || '#e8e8e8'));
      if (!fittedWithText) { fittedWithText = true; pv.fit(); }
      $('#pr-text-status').textContent = `${text.length}/${td.maxChars || 40} characters`;
    } catch (err) {
      $('#pr-text-status').textContent = `Preview error: ${err.message}`;
    }
  };
  if (t.has_text) {
    $('#pr-text').oninput = () => { clearTimeout(textTimer); textTimer = setTimeout(renderText, 220); };
  }

  // ----- save settings -----
  $('#pr-save-settings').onclick = async () => {
    const settings = {};
    document.querySelectorAll('.pr-set').forEach(elm => { if (elm.value !== '') settings[elm.dataset.key] = elm.value; });
    try {
      await api.request('PATCH', `/slice/templates/${id}`, { settings });
      $('#pr-result').innerHTML = '<span style="color:var(--success,#34d399);">Settings saved to this print ✓</span>';
    } catch (err) {
      $('#pr-result').innerHTML = `<span style="color:#f87171;">⚠️ ${err.message}</span>`;
    }
  };

  // ----- print (server re-fills with the real engine and queues) -----
  $('#pr-print').onclick = async () => {
    const text = $('#pr-text')?.value?.trim() || '';
    if (t.has_text && !text) { $('#pr-result').innerHTML = '<span style="color:#f87171;">Enter the text first.</span>'; return; }
    const printer_id = $('#pr-printer').value || null;
    const btn = $('#pr-print'); btn.disabled = true; btn.textContent = 'Slicing…';
    try {
      const body = {
        text, submit: true,
        printer_id,
        repeat_total: parseInt($('#pr-repeat').value, 10) || 1,
      };
      if (td.colors?.length) body.ams_roles = { mode: 'auto', colors: td.colors, material: td.material || 'PLA' };
      const res = await api.request('POST', `/slice/templates/${id}/fill`, body);
      $('#pr-result').innerHTML = `<span style="color:var(--success,#34d399);">Queued as job <a href="#/jobs/${res.job_id}" style="color:var(--accent-primary);">${res.job_name}</a> ✓</span>`;
    } catch (err) {
      $('#pr-result').innerHTML = `<span style="color:#f87171;">⚠️ ${err.message}</span>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Slice & Queue';
    }
  };

  $('#pr-delete').onclick = async () => {
    if (!confirm(`Delete saved print "${t.name}"?`)) return;
    await api.request('DELETE', `/slice/templates/${id}`);
    window.location.hash = '#/prints';
  };
});

// ===== SLICER (in-browser plate editor + pluggable slice backend) =====

// Fallback print-color catalog — MUST mirror FilamentCatalog.COLOR_PALETTE
// (minus Transparent). The server sends the authoritative list via
// /api/slice/backends `color_palette`; this only covers older servers.
const SLICER_COLOR_FALLBACK = [
  { name: 'White', hex: '#ffffff' }, { name: 'Black', hex: '#000000' },
  { name: 'Red', hex: '#ff0000' }, { name: 'Blue', hex: '#0000ff' },
  { name: 'Green', hex: '#00ff00' }, { name: 'Yellow', hex: '#ffff00' },
  { name: 'Orange', hex: '#ff8c00' }, { name: 'Purple', hex: '#800080' },
  { name: 'Pink', hex: '#ff69b4' }, { name: 'Gray', hex: '#808080' },
  { name: 'Light Gray', hex: '#c0c0c0' }, { name: 'Dark Gray', hex: '#404040' },
  { name: 'Brown', hex: '#8b4513' }, { name: 'Cyan', hex: '#00ffff' },
  { name: 'Lime', hex: '#32cd32' }, { name: 'Navy', hex: '#000080' },
  { name: 'Teal', hex: '#008080' }, { name: 'Gold', hex: '#ffd700' },
  { name: 'Natural', hex: '#f5f5dc' },
];

route('/slicer', async (el) => {
  const meta = await api.getSliceBackends().catch(() => ({ backends: [], active: null, setting_fields: [] }));
  if (!meta.color_palette?.length) meta.color_palette = SLICER_COLOR_FALLBACK;
  const printers = await api.getPrinters().catch(() => []);
  const fields = meta.setting_fields || [];
  const groups = [...new Set(fields.map(f => f.group))];

  // Blank/default = "use preset value"; only explicit edits are sent to the engine.
  const fieldHtml = (f) => {
    const unit = f.unit ? ` (${f.unit})` : '';
    if (f.type === 'bool')
      return html`<div><label style="font-size:0.72rem;color:var(--text-muted);">${f.label}</label>
        <select class="form-control sl-set" data-key="${f.key}">
          <option value="">— preset default —</option><option value="1">on</option><option value="0">off</option>
        </select></div>`;
    if (f.type === 'select')
      return html`<div><label style="font-size:0.72rem;color:var(--text-muted);">${f.label}</label>
        <select class="form-control sl-set" data-key="${f.key}">
          <option value="">— preset default —</option>
          ${f.options.map(o => html`<option value="${o}">${o}</option>`).join('')}
        </select></div>`;
    return html`<div><label style="font-size:0.72rem;color:var(--text-muted);">${f.label}${unit}</label>
      <input type="number" class="form-control sl-set" data-key="${f.key}" placeholder="preset default"
        min="${f.min}" max="${f.max}" step="${f.step}"></div>`;
  };

  el.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
      <h1 class="text-gradient-flow" style="font-size:1.4rem;font-weight:700;">Slicer</h1>
      <span id="sl-backend-status" class="badge badge-default">Checking backends…</span>
    </div>
    <div style="display:grid;grid-template-columns:360px 1fr;gap:1rem;align-items:start;">
      <div class="card" style="display:flex;flex-direction:column;gap:0.7rem;max-height:84vh;overflow-y:auto;">
        <div>
          <label style="font-size:0.78rem;color:var(--text-muted);">Printer Model</label>
          <select class="form-control" id="sl-model">
            <option value="P1S">P1S</option><option value="X1">X1</option>
            <option value="A1">A1</option><option value="A1_MINI">A1 Mini</option>
            <option value="P2S">P2S</option><option value="X2D">X2D</option>
            <option value="H2D">H2D</option><option value="A2L">A2L</option>
          </select>
        </div>
        <div>
          <label style="font-size:0.78rem;color:var(--text-muted);">Material</label>
          <select class="form-control" id="sl-material">
            ${(meta.materials || ['PLA', 'PETG', 'ABS', 'TPU', 'PC']).map(m => html`<option value="${m}">${m}</option>`).join('')}
          </select>
          <small style="color:var(--text-muted);font-size:0.66rem;">Slices with this material's Bambu profile; auto-map only picks AMS spools of this material.</small>
        </div>
        <div>
          <label style="font-size:0.78rem;color:var(--text-muted);">Filament profile</label>
          <div style="display:flex;gap:0.3rem;">
            <select class="form-control" id="sl-fprofile" style="flex:1;">
              <option value="">— preset defaults —</option>
              ${(meta.filament_profiles || []).map(p => html`<option value="${p.profile_id}">${p.name} (${p.material})</option>`).join('')}
            </select>
            <button class="btn btn-sm btn-danger" id="sl-fprofile-delete" title="Delete the selected filament profile">🗑</button>
          </div>
          <details id="sl-fil-editor" style="margin-top:0.35rem;border:1px solid var(--border,#26304a);border-radius:8px;padding:0.4rem 0.6rem;">
            <summary style="cursor:pointer;font-size:0.78rem;font-weight:600;">🛠 Customize filament — tweak &amp; save your own profile</summary>
            <div style="margin-top:0.45rem;display:grid;grid-template-columns:1fr 1fr;gap:0.4rem;">
              ${fields.filter(f => f.group === 'Filament').map(fieldHtml).join('')}
            </div>
            <div style="display:flex;gap:0.3rem;margin-top:0.5rem;">
              <input class="form-control" id="sl-fprofile-name" placeholder='Profile name (e.g. "Sunlu PLA+ 215°")' style="flex:1;">
              <button class="btn btn-primary btn-sm" id="sl-fprofile-save">💾 Save profile</button>
            </div>
            <small style="color:var(--text-muted);font-size:0.66rem;">Blank fields use the material preset. Tweaks apply to your next slice even unsaved; saving adds them to the dropdown for reuse (same name overwrites). Base material = the Material selector above.</small>
          </details>
        </div>
        <div id="sl-drop" style="border:1.5px dashed var(--border,#33415c);border-radius:8px;padding:0.8rem;text-align:center;cursor:pointer;font-size:0.82rem;color:var(--text-muted);">
          ⬆️ Drop <b>STL</b> file(s) here or click
          <input type="file" id="sl-file" accept=".stl" multiple style="display:none;">
        </div>

        <div id="sl-objects" style="display:none;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3rem;">
            <label style="font-size:0.78rem;color:var(--text-muted);">Objects</label>
            <span>
              <button class="btn btn-sm btn-outline" id="sl-saveproject" title="Save this plate (models, colors, text, settings) as a reusable print job">💾 Save print job</button>
              <button class="btn btn-sm" id="sl-newmodel" title="Clear the plate and start over (asks to save first)">🆕 New</button>
              <button class="btn btn-sm" id="sl-arrange" title="Pack objects on the plate (client-side; never at slice time)">Auto-arrange</button>
              <button class="btn btn-sm btn-danger" id="sl-remove">Remove</button>
            </span>
          </div>
          <div id="sl-object-list" style="display:flex;flex-direction:column;gap:2px;"></div>
        </div>

        <div id="sl-transform" style="display:none;border-top:1px solid var(--border,#33415c);padding-top:0.6rem;">
          <label style="font-size:0.78rem;font-weight:600;color:var(--accent-primary);">Transform — <span id="sl-sel-name"></span></label>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.3rem;margin:0.3rem 0 0.1rem;">
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Size X (mm)</label><input type="number" class="form-control sl-tf" id="sl-dx" step="1" min="0.1"></div>
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Size Y (mm)</label><input type="number" class="form-control sl-tf" id="sl-dy" step="1" min="0.1"></div>
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Size Z (mm)</label><input type="number" class="form-control sl-tf" id="sl-dz" step="1" min="0.1"></div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.3rem;">
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Pos X (mm)</label><input type="number" class="form-control sl-tf" id="sl-px" step="1"></div>
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Pos Y (mm)</label><input type="number" class="form-control sl-tf" id="sl-py" step="1"></div>
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Lift Z (mm)</label><input type="number" class="form-control sl-tf" id="sl-pz" step="1"></div>
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Rot X (°)</label><input type="number" class="form-control sl-tf" id="sl-rx" step="5"></div>
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Rot Y (°)</label><input type="number" class="form-control sl-tf" id="sl-ry" step="5"></div>
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Rot Z (°)</label><input type="number" class="form-control sl-tf" id="sl-rz" step="5"></div>
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Scale X (%)</label><input type="number" class="form-control sl-tf" id="sl-sx" step="5"></div>
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Scale Y (%)</label><input type="number" class="form-control sl-tf" id="sl-sy" step="5"></div>
            <div><label style="font-size:0.68rem;color:var(--text-muted);">Scale Z (%)</label><input type="number" class="form-control sl-tf" id="sl-sz" step="5"></div>
          </div>
          <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.72rem;margin-top:0.3rem;"><input type="checkbox" id="sl-lock" checked> Uniform scale</label>
          <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.72rem;margin-top:0.3rem;" title="Orders this part last when merged with touching models, so it wins every shared volume — like Bambu Studio merge with the logo on top">
            <input type="checkbox" id="sl-insert"> ⭐ Always show through (insert / logo)
          </label>
          <small style="color:var(--text-muted);font-size:0.64rem;">For logos sunk into a model: it prints wherever it overlaps. Give it a different print color to be visible.</small>
          <div style="margin-top:0.3rem;">
            <label style="font-size:0.68rem;color:var(--text-muted);">Print color <span id="sl-color-name" style="color:var(--text-primary);"></span></label>
            <div id="sl-colors" style="display:grid;grid-template-columns:repeat(10,1fr);gap:4px;margin-top:2px;">
              ${(meta.color_palette || []).map(c => html`<button type="button" class="sl-swatch" data-hex="${c.hex}" title="${c.name}" style="height:22px;border-radius:4px;border:2px solid rgba(127,127,127,0.35);background:${c.hex};cursor:pointer;padding:0;"></button>`).join('')}
              <button type="button" id="sl-custom-color-btn" title="Custom color… (full spectrum)" style="height:22px;border-radius:4px;border:2px solid rgba(127,127,127,0.35);background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);cursor:pointer;padding:0;font-size:11px;line-height:1;">＋</button>
            </div>
            <small style="color:var(--text-muted);font-size:0.66rem;">Same named colors as the AMS tray settings on the printer page — auto-map finds the closest spool when the job starts (or choose the slot manually in Send to Printer). ＋ opens the full-spectrum picker; saved Custom colors appear here too.</small>
          </div>
          <div style="display:flex;gap:0.3rem;margin-top:0.4rem;flex-wrap:wrap;">
            <button class="btn btn-sm btn-outline" id="sl-placeface">📐 Place face on bed</button>
            <button class="btn btn-sm" id="sl-r90x">X+90°</button>
            <button class="btn btn-sm" id="sl-r90y">Y+90°</button>
            <button class="btn btn-sm" id="sl-r90z">Z+90°</button>
            <button class="btn btn-sm" id="sl-dropbed">Drop to bed</button>
            <button class="btn btn-sm btn-outline" id="sl-resettf">↺ Reset</button>
          </div>
          <small id="sl-orient-hint" style="color:var(--text-muted);font-size:0.7rem;display:none;"></small>
        </div>

        <details open style="border-top:1px solid var(--border,#33415c);padding-top:0.6rem;">
          <summary style="cursor:pointer;font-weight:600;font-size:0.85rem;color:var(--accent-primary);">Text</summary>
          <div style="margin-top:0.4rem;display:flex;flex-direction:column;gap:0.35rem;">
            <input type="text" class="form-control" id="sl-text" placeholder="Your text…" maxlength="60">
            <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:0.3rem;">
              <select class="form-control" id="sl-font" title="Font">
                <option value="sans">Sans</option>
                <option value="sans-bold">Sans Bold</option>
                <option value="serif">Serif</option>
                <option value="script">Script</option>
              </select>
              <input type="number" class="form-control" id="sl-text-size" value="10" min="3" max="80" step="1" title="Letter height (mm)">
              <input type="number" class="form-control" id="sl-text-thick" value="2" min="0.4" max="20" step="0.2" title="Thickness (mm)">
            </div>
            <button class="btn btn-sm btn-primary" id="sl-addtext">＋ Add text to plate</button>
            <div id="sl-text-actions" style="display:none;gap:0.3rem;flex-wrap:wrap;">
              <button class="btn btn-sm btn-outline" id="sl-attach">🎯 Attach to face</button>
              <button class="btn btn-sm" id="sl-emboss" title="Union the text into the model (raised)">⬆ Emboss</button>
              <button class="btn btn-sm" id="sl-deboss" title="Subtract the text from the model (recessed)">⬇ Deboss</button>
              <button class="btn btn-sm btn-outline" id="sl-savetpl" title="Save base model + this text placement as a fill-in template for automated customer text">💾 Save as template</button>
            </div>
            <small style="color:var(--text-muted);font-size:0.68rem;">Font size = letter height, thickness = raised/recessed depth. Fields edit the selected text live.</small>
          </div>

          <div style="border-top:1px solid var(--border,#33415c);padding-top:0.5rem;margin-top:0.5rem;">
            <label style="font-size:0.78rem;font-weight:600;">🖼 Logo (SVG)</label>
            <button class="btn btn-sm btn-primary" id="sl-addlogo" title="Import an SVG, then click a face on a model to place it — always 0.5mm thick, single color, always shows through">＋ Add logo to object</button>
            <input type="file" id="sl-logofile" accept=".svg,image/svg+xml" style="display:none;">
            <div id="sl-logo-actions" style="display:none;gap:0.3rem;flex-wrap:wrap;margin-top:0.3rem;">
              <button class="btn btn-sm btn-outline" id="sl-logo-place">🎯 Place on face</button>
              <button class="btn btn-sm" id="sl-logo-rot" title="Spin the logo 90° on the face it sits on">↻ Rotate 90°</button>
              <button class="btn btn-sm" id="sl-logo-inv" title="Mirror the logo (for bottom faces / reversed placement)">🪞 Invert</button>
            </div>
            <small style="color:var(--text-muted);font-size:0.68rem;">Fixed 0.5mm height, prints as one color and always shows through the model. Pick its print color above; resize with the Size fields.</small>
          </div>
        </details>

        <details style="border-top:1px solid var(--border,#33415c);padding-top:0.6rem;">
          <summary style="cursor:pointer;font-weight:600;font-size:0.85rem;color:var(--accent-primary);">Print Settings</summary>
          <small style="color:var(--text-muted);font-size:0.7rem;display:block;margin:0.3rem 0;">
            Blank = preset default. Values are passed to the real OrcaSlicer engine — results are identical to desktop slicing.
          </small>
          ${groups.filter(g => g !== 'Filament').map(g => html`
            <details style="margin-top:0.35rem;">
              <summary style="cursor:pointer;font-size:0.8rem;font-weight:600;">${g}</summary>
              <div style="margin-top:0.4rem;display:grid;grid-template-columns:1fr 1fr;gap:0.4rem;">
                ${fields.filter(f => f.group === g).map(fieldHtml).join('')}
              </div>
            </details>`).join('')}
          <small style="color:var(--text-muted);font-size:0.66rem;">Filament settings (temps, flow, fans…) live under “Customize filament” above.</small>
        </details>

        <details style="border-top:1px solid var(--border,#33415c);padding-top:0.6rem;">
          <summary style="cursor:pointer;font-weight:600;font-size:0.85rem;color:var(--accent-primary);">Send to Printer</summary>
          <div style="margin-top:0.4rem;display:flex;flex-direction:column;gap:0.35rem;">
            <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.78rem;">
              <input type="checkbox" id="sl-queue"> Queue as job after slicing
            </label>
            <div style="display:grid;grid-template-columns:2fr 1fr;gap:0.3rem;">
              <select class="form-control" id="sl-printer" title="Printer (optional — can be assigned later)">
                <option value="">— assign printer later —</option>
                ${printers.map(p => html`<option value="${p.printer_id}">${p.name}</option>`).join('')}
              </select>
              <input type="number" class="form-control" id="sl-repeat" value="1" min="1" max="999" step="1" title="Job repeats">
            </div>
            <div id="sl-ams" style="display:none;">
              <label style="font-size:0.72rem;color:var(--text-muted);">Spool selection</label>
              <select class="form-control" id="sl-ams-mode">
                <option value="auto">Auto — match print colors to AMS spools at start</option>
                <option value="manual">Manual — choose the AMS slot for each color</option>
              </select>
              <div id="sl-ams-rows" style="display:flex;flex-direction:column;gap:0.25rem;margin-top:0.3rem;"></div>
              <small id="sl-ams-hint" style="color:var(--text-muted);font-size:0.66rem;"></small>
            </div>
            <small style="color:var(--text-muted);font-size:0.68rem;">The sliced file goes through the normal loop/eject pipeline — same as uploading a .gcode.3mf on the Jobs page.</small>
          </div>
        </details>

        <button class="btn btn-primary" id="sl-slice" style="width:100%;" disabled>Slice</button>
        <div id="sl-result" style="font-size:0.78rem;color:var(--text-muted);white-space:pre-wrap;"></div>
      </div>
      <div class="card" style="padding:0;overflow:hidden;min-height:82vh;">
        <div id="sl-viewer" style="width:100%;height:82vh;"></div>
      </div>
    </div>
  `;

  const slicer = await import('./slicer.js');

  // ----- scene state -> UI -----
  let lastState = null;
  const setVal = (id, v) => { const i = $(id); if (i && document.activeElement !== i) i.value = v; };
  function renderScene(state) {
    lastState = state;
    $('#sl-objects').style.display = state.count ? 'block' : 'none';
    $('#sl-transform').style.display = state.selected ? 'block' : 'none';
    $('#sl-slice').disabled = !state.count || state.anyOutOfBed;
    $('#sl-object-list').innerHTML = state.objects.map(o => html`
      <div class="sl-obj" data-id="${o.id}" style="padding:0.25rem 0.5rem;border-radius:5px;cursor:pointer;font-size:0.78rem;
        background:${o.selected ? 'var(--accent-primary,#4053b3)' : 'transparent'};
        color:${o.outOfBed ? '#f87171' : 'inherit'};">
        <span style="display:inline-block;width:0.7rem;height:0.7rem;border-radius:2px;border:1px solid #555;background:${o.color};margin-right:0.3rem;vertical-align:middle;"></span>${o.isText ? '🔤 ' : ''}${o.name}${o.outOfBed ? ' ⚠ off bed' : ''}
      </div>`).join('');
    document.querySelectorAll('.sl-obj').forEach(d => d.onclick = () => viewer.select(parseInt(d.dataset.id, 10)));
    if (state.selected) {
      const s = state.selected;
      $('#sl-sel-name').textContent = s.name;
      setVal('#sl-dx', s.dims.x); setVal('#sl-dy', s.dims.y); setVal('#sl-dz', s.dims.z);
      const ins = $('#sl-insert'); if (ins) ins.checked = !!s.insert;
      setVal('#sl-px', s.pos.x); setVal('#sl-py', s.pos.y); setVal('#sl-pz', s.pos.z);
      setVal('#sl-rx', s.rot.x); setVal('#sl-ry', s.rot.y); setVal('#sl-rz', s.rot.z);
      setVal('#sl-sx', s.scale.x); setVal('#sl-sy', s.scale.y); setVal('#sl-sz', s.scale.z);
      // highlight the catalog swatch matching this object's print color
      {
        const cur = (s.color || '#e8e8e8').toLowerCase();
        let curName = '';
        document.querySelectorAll('#sl-colors .sl-swatch').forEach(b => {
          const on = b.dataset.hex === cur;
          b.style.borderColor = on ? 'var(--accent-primary, #7c5cff)' : 'rgba(127,127,127,0.35)';
          if (on) curName = b.title;
        });
        const nameEl = $('#sl-color-name');
        if (nameEl) nameEl.textContent = curName ? `— ${curName}` : '— none picked';
      }
      // reflect the selected text object's params back into the text fields
      if (s.isText && s.textParams) {
        setVal('#sl-text', s.textParams.text);
        setVal('#sl-font', s.textParams.fontId || 'sans');
        setVal('#sl-text-size', s.textParams.sizeMm);
        setVal('#sl-text-thick', s.textParams.thicknessMm);
      }
    }
    $('#sl-text-actions').style.display = state.selected?.isText ? 'flex' : 'none';
    $('#sl-logo-actions').style.display = state.selected?.isLogo ? 'flex' : 'none';
    renderAmsRows(); // keep tray pickers in sync with the filament slots in use
    if (state.anyOutOfBed) $('#sl-result').innerHTML = '<span style="color:#f87171;">An object is outside the build area.</span>';
  }

  // Restore the previous visit's form values (model/material/settings) so the
  // slicer feels continuous; the 3D scene itself survives via attachSlicer.
  if (window.__slicerFormStash) {
    const st = window.__slicerFormStash;
    if (st.model) $('#sl-model').value = st.model;
    if (st.material) $('#sl-material').value = st.material;
    for (const [k, v] of Object.entries(st.settings || {})) {
      const elm = document.querySelector(`.sl-set[data-key="${k}"]`);
      if (elm) elm.value = v;
    }
  }
  // The LIVE SCENE's model always wins over the select's default: the select
  // resets to P1S on every page build, and a mismatch here silently rebuilt
  // the scene (= "everything resets when I come back"). Only visible to A1/
  // mini/X1 users — P1S matched the default by luck.
  const liveModel = slicer.liveSceneModel ? slicer.liveSceneModel() : null;
  if (liveModel) $('#sl-model').value = liveModel;

  // attachSlicer REATTACHES the live scene when one exists for this model —
  // navigating away no longer loses your plate. Model change still rebuilds.
  const makeViewer = (fresh = false) => {
    if (fresh) slicer.disposeSlicer();
    return slicer.attachSlicer($('#sl-viewer'), { model: $('#sl-model').value, onSceneChange: renderScene });
  };
  let viewer = makeViewer();

  // Stash form values CONTINUOUSLY. Stashing at cleanup never worked: the
  // router's own hashchange handler runs first and has already replaced the
  // page, so cleanup read an empty DOM and saved {} every time.
  // (no eager call — collectSettings is declared later in this handler; the
  // restore above already reflects the stash, and listeners capture all edits)
  const stashNow = () => {
    window.__slicerFormStash = { model: $('#sl-model')?.value, material: $('#sl-material')?.value, settings: collectSettings() };
  };
  el.addEventListener('change', stashNow, true);
  el.addEventListener('input', stashNow, true);

  const cleanup = () => {
    slicer.detachSlicer(); // keep the scene alive — only "New model" or closing the tab clears it
    el.removeEventListener('change', stashNow, true);
    el.removeEventListener('input', stashNow, true);
    window.removeEventListener('hashchange', onLeave);
  };
  const onLeave = () => { if ((location.hash.slice(1) || '/') !== '/slicer') cleanup(); };
  window.addEventListener('hashchange', onLeave);

  // ----- file loading -----
  const loadFiles = async (files) => {
    for (const f of files) {
      try { viewer.addModel(await f.arrayBuffer(), f.name); }
      catch (err) { $('#sl-result').innerHTML = `<span style="color:#f87171;">${f.name}: ${err.message}</span>`; }
    }
  };
  const drop = $('#sl-drop'), fileInput = $('#sl-file');
  drop.onclick = () => fileInput.click();
  fileInput.onchange = () => loadFiles([...fileInput.files]);
  drop.ondragover = (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent-primary,#818cf8)'; };
  drop.ondragleave = () => { drop.style.borderColor = ''; };
  drop.ondrop = (e) => { e.preventDefault(); drop.style.borderColor = ''; loadFiles([...e.dataTransfer.files]); };

  $('#sl-model').onchange = () => { viewer = makeViewer(); $('#sl-result').textContent = 'Bed changed — reload your models.'; };

  // ----- material + custom filament profiles -----
  let filamentProfiles = meta.filament_profiles || [];
  const filamentKeys = fields.filter(f => f.target === 'filament').map(f => f.key);
  const renderFProfileOptions = () => {
    const sel = $('#sl-fprofile');
    const cur = sel.value;
    sel.innerHTML = '<option value="">— preset defaults —</option>' +
      filamentProfiles.map(p => `<option value="${p.profile_id}">${p.name} (${p.material})</option>`).join('');
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  };
  $('#sl-fprofile').onchange = () => {
    const p = filamentProfiles.find(x => x.profile_id === $('#sl-fprofile').value);
    // clear filament fields, then apply the profile's overrides
    document.querySelectorAll('.sl-set').forEach(elm => { if (filamentKeys.includes(elm.dataset.key)) elm.value = ''; });
    $('#sl-fprofile-name').value = p ? p.name : '';
    if (!p) return;
    $('#sl-material').value = p.material;
    for (const [k, v] of Object.entries(p.settings || {})) {
      const elm = document.querySelector(`.sl-set[data-key="${k}"]`);
      if (elm) elm.value = String(v);
    }
    $('#sl-fil-editor').open = true; // show the applied tweaks
    $('#sl-result').innerHTML = `<span style="color:var(--text-muted);">Filament profile "${p.name}" applied (${Object.keys(p.settings || {}).length} override(s), material ${p.material}).</span>`;
  };
  const refreshFProfiles = async (selectName = null) => {
    const list = await api.request('GET', '/slice/filament-profiles');
    filamentProfiles = list.profiles || [];
    renderFProfileOptions();
    if (selectName) {
      const p = filamentProfiles.find(x => x.name.toLowerCase() === selectName.toLowerCase());
      if (p) $('#sl-fprofile').value = p.profile_id;
    }
  };
  $('#sl-fprofile-save').onclick = async () => {
    const name = $('#sl-fprofile-name').value.trim();
    if (!name) { $('#sl-result').innerHTML = '<span style="color:#f87171;">Give the profile a name first.</span>'; $('#sl-fprofile-name').focus(); return; }
    const settings = {};
    document.querySelectorAll('.sl-set').forEach(elm => {
      if (filamentKeys.includes(elm.dataset.key) && elm.value !== '') settings[elm.dataset.key] = elm.value;
    });
    if (!Object.keys(settings).length) { $('#sl-result').innerHTML = '<span style="color:#f87171;">Set at least one filament value above — blank fields mean "preset default".</span>'; return; }
    try {
      await api.request('POST', '/slice/filament-profiles', { name, material: $('#sl-material').value, settings });
      await refreshFProfiles(name);
      $('#sl-result').innerHTML = `<span style="color:var(--success,#34d399);">Filament profile "${name}" saved ✓ (${Object.keys(settings).length} override(s), ${$('#sl-material').value}) — reusable from the dropdown</span>`;
    } catch (err) {
      $('#sl-result').innerHTML = `<span style="color:#f87171;">⚠️ ${err.message} — if this says 404/500, restart the server (Start Antigravity.bat) to load the new filament-profiles API.</span>`;
    }
  };
  $('#sl-fprofile-delete').onclick = async () => {
    const p = filamentProfiles.find(x => x.profile_id === $('#sl-fprofile').value);
    if (!p) { $('#sl-result').innerHTML = '<span style="color:#f87171;">Select a saved profile to delete.</span>'; return; }
    if (!confirm(`Delete filament profile "${p.name}"?`)) return;
    try {
      await api.request('DELETE', `/slice/filament-profiles/${p.profile_id}`);
      await refreshFProfiles();
      $('#sl-fprofile').value = '';
      $('#sl-fprofile-name').value = '';
      $('#sl-result').innerHTML = `<span style="color:var(--text-muted);">Filament profile "${p.name}" deleted.</span>`;
    } catch (err) {
      $('#sl-result').innerHTML = `<span style="color:#f87171;">⚠️ ${err.message}</span>`;
    }
  };

  // ----- transform panel -----
  $('#sl-px').onchange = () => viewer.setPositionPrinter(parseFloat($('#sl-px').value), null, null);
  $('#sl-py').onchange = () => viewer.setPositionPrinter(null, parseFloat($('#sl-py').value), null);
  $('#sl-pz').onchange = () => viewer.setPositionPrinter(null, null, parseFloat($('#sl-pz').value));
  $('#sl-rx').onchange = () => viewer.setRotationDeg(parseFloat($('#sl-rx').value), null, null);
  $('#sl-ry').onchange = () => viewer.setRotationDeg(null, parseFloat($('#sl-ry').value), null);
  $('#sl-rz').onchange = () => viewer.setRotationDeg(null, null, parseFloat($('#sl-rz').value));
  const scaleChange = (axis) => {
    const v = parseFloat($(`#sl-s${axis}`).value);
    if (isNaN(v)) return;
    if ($('#sl-lock').checked) viewer.setScalePct(v, v, v);
    else viewer.setScalePct(axis === 'x' ? v : null, axis === 'y' ? v : null, axis === 'z' ? v : null);
  };
  // absolute size in printer mm (Bambu-style Size fields); honors uniform lock
  const sizeChange = (axis) => {
    const v = parseFloat($(`#sl-d${axis}`).value);
    if (isNaN(v) || v <= 0) return;
    viewer.setSizePrinterMm({ [axis]: v }, $('#sl-lock').checked);
  };
  $('#sl-dx').onchange = () => sizeChange('x');
  $('#sl-dy').onchange = () => sizeChange('y');
  $('#sl-dz').onchange = () => sizeChange('z');
  $('#sl-insert').onchange = () => viewer.setInsert($('#sl-insert').checked);
  $('#sl-sx').onchange = () => scaleChange('x');
  $('#sl-sy').onchange = () => scaleChange('y');
  $('#sl-sz').onchange = () => scaleChange('z');

  // Face-pick modes: place-on-bed (any object) vs attach-text-to-face; exclusive.
  let activeMode = null;
  const MODE_HINTS = {
    placeFace: 'Click a face in the viewer to lay it on the bed.',
    attachText: 'Click a face on a model to stick the selected text onto it.',
  };
  function setMode(m) {
    activeMode = activeMode === m ? null : m;
    viewer.setPointerMode(activeMode);
    $('#sl-placeface').classList.toggle('btn-primary', activeMode === 'placeFace');
    $('#sl-attach')?.classList.toggle('btn-primary', activeMode === 'attachText');
    const hint = $('#sl-orient-hint');
    hint.textContent = activeMode ? MODE_HINTS[activeMode] : '';
    hint.style.display = activeMode ? 'block' : 'none';
  }
  $('#sl-placeface').onclick = () => setMode('placeFace');
  $('#sl-r90x').onclick = () => viewer.rotate90('x');
  $('#sl-r90y').onclick = () => viewer.rotate90('y');
  $('#sl-r90z').onclick = () => viewer.rotate90('z');
  $('#sl-dropbed').onclick = () => viewer.dropToBed();
  $('#sl-resettf').onclick = () => viewer.resetTransform();
  document.querySelectorAll('#sl-colors .sl-swatch').forEach(b => { b.onclick = () => viewer.setColor(b.dataset.hex); });
  // saved Custom colors ride along in the same grid (class sl-swatch, so
  // the selection-highlight code and name label pick them up automatically)
  const refreshSlicerCustomSwatches = async () => {
    const grid = $('#sl-colors');
    const plus = $('#sl-custom-color-btn');
    if (!grid || !plus) return;
    grid.querySelectorAll('.sl-custom').forEach(b => b.remove());
    let customs = [];
    try { customs = await api.getCustomColors(); } catch { return; }
    for (const c of customs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sl-swatch sl-custom';
      b.dataset.hex = c.hex;
      b.title = c.name;
      b.style.cssText = 'height:22px;border-radius:4px;border:2px dashed rgba(127,127,127,0.55);background:' + c.hex + ';cursor:pointer;padding:0;';
      b.onclick = () => viewer.setColor(c.hex);
      grid.insertBefore(b, plus);
    }
  };
  refreshSlicerCustomSwatches();
  const customBtn = $('#sl-custom-color-btn');
  if (customBtn) customBtn.onclick = () => showColorPickerModal({
    current: viewer.sceneState?.()?.selected?.color || '#22d3ee',
    title: 'Print color',
    onPick: (hex) => { viewer.setColor(hex); refreshSlicerCustomSwatches(); },
  });
  $('#sl-remove').onclick = () => viewer.removeSelected();
  $('#sl-arrange').onclick = () => viewer.autoArrange();

  // ----- text tool (DIRECTIVE §4: fonts, size, thickness, attach, emboss/deboss) -----
  let text3d = null;
  const textParams = () => ({
    text: $('#sl-text').value.trim(),
    fontId: $('#sl-font').value,
    sizeMm: parseFloat($('#sl-text-size').value) || 10,
    thicknessMm: parseFloat($('#sl-text-thick').value) || 2,
  });
  async function buildTextGeo(params) {
    if (!text3d) text3d = await import('./text3d.js');
    const fdef = text3d.FONTS.find(f => f.id === params.fontId) || text3d.FONTS[0];
    const font = await text3d.loadFont(fdef.url);
    return text3d.buildTextGeometry(font, params);
  }
  $('#sl-addtext').onclick = async () => {
    const p = textParams();
    if (!p.text) { $('#sl-result').innerHTML = '<span style="color:#f87171;">Enter some text first.</span>'; return; }
    try {
      const geo = await buildTextGeo(p);
      if (!geo) throw new Error('No printable glyphs in that text/font');
      viewer.addTextObject(geo, p);
    } catch (err) { $('#sl-result').innerHTML = `<span style="color:#f87171;">${err.message}</span>`; }
  };
  // live-update the selected text object when its fields change
  const liveTextUpdate = async () => {
    if (!lastState?.selected?.isText) return;
    const p = textParams();
    if (!p.text) return;
    try { const geo = await buildTextGeo(p); if (geo) viewer.updateSelectedText(geo, p); } catch { /* keep old */ }
  };
  $('#sl-text').onchange = liveTextUpdate;
  $('#sl-font').onchange = liveTextUpdate;
  $('#sl-text-size').onchange = liveTextUpdate;
  $('#sl-text-thick').onchange = liveTextUpdate;
  $('#sl-attach').onclick = () => setMode('attachText');

  // ----- SVG logo import (0.5mm, single color, always shows through) -----
  $('#sl-addlogo').onclick = () => $('#sl-logofile').click();
  $('#sl-logofile').onchange = async () => {
    const file = $('#sl-logofile').files?.[0];
    $('#sl-logofile').value = '';
    if (!file) return;
    try {
      const svgText = await file.text();
      const logo3d = await import('./logo3d.js');
      const geo = logo3d.svgToLogoGeometry(svgText, { widthMm: 20 });
      if (!geo) throw new Error('No fillable shapes found in that SVG');
      viewer.addLogoObject(geo, file.name, logo3d.LOGO_THICKNESS_MM);
      // straight into placement: ask for the target object + face
      setMode('attachText');
      $('#sl-result').innerHTML = '<span style="color:var(--text-muted);">Logo loaded — now click the face of the model you want it on. Then use ↻ / 🪞 to orient it, and give it its own print color.</span>';
    } catch (err) {
      $('#sl-result').innerHTML = `<span style="color:#f87171;">⚠️ ${err.message}</span>`;
    }
  };
  $('#sl-logo-place').onclick = () => setMode('attachText');
  $('#sl-logo-rot').onclick = () => viewer.spinSelected90();
  $('#sl-logo-inv').onclick = async () => {
    const logo3d = await import('./logo3d.js');
    viewer.invertSelectedLogo(logo3d.mirrorGeometryX);
  };
  const runBoolean = async (op) => {
    const btn = $(`#sl-${op}`); btn.disabled = true;
    try {
      const r = await viewer.applyTextBoolean(op);
      $('#sl-result').innerHTML = r.ok
        ? `<span style="color:var(--success,#34d399);">${op === 'deboss' ? 'Debossed (recessed)' : 'Embossed (raised)'} ✓ — text merged into the model</span>`
        : `<span style="color:#f87171;">${r.error}</span>`;
    } finally { btn.disabled = false; }
  };
  $('#sl-emboss').onclick = () => runBoolean('emboss');
  $('#sl-deboss').onclick = () => runBoolean('deboss');

  // Save the plate (models + colors + optional text placement + settings) as
  // a reusable print job. With a text object it becomes a fill-in template;
  // without one it's a plain saved print. Returns true on success.
  const saveProject = async () => {
    const name = prompt('Print job name (e.g. "Name Keychain"):');
    if (!name) return false;
    const hasTextObj = (lastState?.objects || []).some(o => o.isText);
    let mode = 'deboss';
    if (hasTextObj) {
      mode = (prompt('Text mode: deboss (recessed), emboss (raised), or separate (own filament/color)?', 'deboss') || 'deboss').toLowerCase();
      if (!['deboss', 'emboss', 'separate'].includes(mode)) mode = 'deboss';
    }
    const data = viewer.getProjectData(mode);
    if (data.error) { $('#sl-result').innerHTML = `<span style="color:#f87171;">${data.error}</span>`; return false; }
    try {
      const fd = new FormData();
      for (const b of data.baseObjects) fd.append('files', new Blob([b.buffer]), b.name);
      fd.append('files_meta', JSON.stringify(data.baseObjects.map(b => ({ name: b.name, color: b.color, filament: b.filament, insert: !!b.insert }))));
      fd.append('name', name);
      fd.append('printer_model', $('#sl-model').value);
      if (data.textDef) fd.append('text_def', JSON.stringify({ ...data.textDef, material: $('#sl-material').value }));
      else fd.append('text_def', JSON.stringify({ mode: 'none', material: $('#sl-material').value, colors: data.colors }));
      fd.append('settings', JSON.stringify(collectSettings()));
      const res = await api.saveTextTemplate(fd);
      $('#sl-result').innerHTML = `<span style="color:var(--success,#34d399);">Print job "${res.template?.name || name}" saved ✓ — find it under <a href="#/prints" style="color:var(--accent-primary);">Prints</a></span>`;
      return true;
    } catch (err) {
      $('#sl-result').innerHTML = `<span style="color:#f87171;">⚠️ ${err.message}</span>`;
      return false;
    }
  };
  $('#sl-saveproject').onclick = saveProject;
  $('#sl-newmodel').onclick = async () => {
    if (viewer.hasObjects()) {
      if (confirm('Save the current project as a print job before clearing?')) {
        const ok = await saveProject();
        if (!ok) return; // don't clear if the save was cancelled/failed
      }
    }
    viewer.clearAll();
    $('#sl-result').textContent = '';
  };

  // Legacy button in the Text panel: same save flow.
  $('#sl-savetpl').onclick = saveProject;

  // ----- backend badge / engine-missing help (DIRECTIVE §0) -----
  const badge = $('#sl-backend-status');
  if (meta.active) { badge.textContent = `Engine: ${meta.active.label}`; badge.className = 'badge badge-success'; }
  else {
    badge.textContent = 'No slicing engine found';
    badge.className = 'badge badge-warning';
    $('#sl-result').innerHTML =
      'No slicing engine is available — slicing is done by a real engine, never approximated.<br>' +
      'Install <a href="https://github.com/SoftFever/OrcaSlicer/releases" target="_blank" style="color:var(--accent-primary);">OrcaSlicer</a> ' +
      '(or Bambu Studio) and set <code>SLICER_CLI_PATH</code> to its executable, then restart the server.';
  }

  const collectSettings = () => {
    const s = {};
    document.querySelectorAll('.sl-set').forEach(elm => { if (elm.value !== '') s[elm.dataset.key] = elm.value; });
    return s;
  };

  // ----- Spool selection: print COLORS -> physical AMS trays -----
  // auto: the job stores the colors; the tray mapping is resolved from the
  //       printer's live AMS inventory when the print STARTS (spool swaps ok).
  // manual: pick a tray per color here; stored as an explicit slot_map.
  let amsData = null; // cached /printers/:id/ams response for the selected printer
  const swatch = (c) => `<span style="display:inline-block;width:0.9rem;height:0.9rem;border-radius:3px;border:1px solid #555;vertical-align:middle;background:${c};"></span>`;
  function renderAmsRows() {
    const box = $('#sl-ams');
    if (!box) return;
    const colors = lastState?.palette || [];
    if (!$('#sl-queue')?.checked || !colors.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    const mode = $('#sl-ams-mode').value;
    if (mode === 'auto') {
      $('#sl-ams-rows').innerHTML = html`
        <div style="font-size:0.74rem;display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap;">
          Print colors: ${colors.map(c => swatch(c)).join(' ')}
        </div>`;
      $('#sl-ams-hint').textContent = 'Each color is matched to the closest spool in the printer’s AMS when the print starts. If no close match is loaded, the job refuses to start instead of printing the wrong color.';
      return;
    }
    // manual mode needs the printer's AMS inventory
    if (!amsData?.slots?.length) {
      $('#sl-ams-rows').innerHTML = '<div style="font-size:0.74rem;color:var(--text-muted);">Select a printer above to list its AMS trays.</div>';
      $('#sl-ams-hint').textContent = '';
      return;
    }
    const current = {};
    document.querySelectorAll('.sl-ams-tray').forEach(s => { current[s.dataset.slot] = s.value; });
    $('#sl-ams-rows').innerHTML = colors.map((c, idx) => {
      const k = idx + 1;
      const def = current[k] ?? Math.min(idx, amsData.slots.length - 1);
      return html`
        <div style="display:grid;grid-template-columns:auto 1fr;gap:0.4rem;align-items:center;">
          <span style="font-size:0.74rem;">${swatch(c)}</span>
          <select class="form-control sl-ams-tray" data-slot="${k}">
            ${amsData.slots.map((t, i) => {
        const mat = t.live_type || t.configured_material || '?';
        const colName = t.configured_color_name || t.live_color || t.configured_color || '';
        return html`<option value="${i}" ${String(i) === String(def) ? 'selected' : ''}>AMS ${t.ams_id + 1} · Tray ${t.tray_id + 1} — ${mat}${colName ? ' ' + colName : ''}</option>`;
      }).join('')}
          </select>
        </div>`;
    }).join('');
    $('#sl-ams-hint').textContent = 'This exact tray is used regardless of its color.';
  }
  async function loadAms() {
    amsData = null;
    const pid = $('#sl-printer').value;
    if (pid && $('#sl-queue').checked) {
      try { amsData = await api.getPrinterAms(pid); } catch { amsData = null; }
    }
    renderAmsRows();
  }
  $('#sl-printer').onchange = loadAms;
  $('#sl-ams-mode').onchange = renderAmsRows;

  // ----- slice: bake transforms, one STL per object, exact layout (--arrange 0);
  //       optionally queue the result straight into the loop/eject job pipeline -----
  const sliceLabel = () => { $('#sl-slice').textContent = $('#sl-queue').checked ? 'Slice & Queue Job' : 'Slice'; };
  $('#sl-queue').onchange = () => { sliceLabel(); loadAms(); };
  $('#sl-slice').onclick = async () => {
    if (!viewer.hasObjects()) return;
    const queue = $('#sl-queue').checked;
    const btn = $('#sl-slice'); btn.disabled = true; btn.textContent = queue ? 'Slicing & queuing…' : 'Slicing…';
    $('#sl-result').textContent = '';
    try {
      const fd = new FormData();
      const exported = viewer.exportPlacedSTLs();
      for (const obj of exported) fd.append('files', new Blob([obj.buffer]), obj.name);
      fd.append('options', JSON.stringify({
        printer_model: $('#sl-model').value,
        material: $('#sl-material').value,
        settings: collectSettings(),
        filaments: exported.map(o => o.filament || 1),
        colors: lastState?.palette || [],
        // merge groups: text attached to a model shares its group so the
        // server slices them as one multi-part object (text shows through)
        groups: exported.map((o, i) => (o.group ?? i)),
      }));
      if (queue) {
        fd.append('submit', 'true');
        if ($('#sl-printer').value) fd.append('printer_id', $('#sl-printer').value);
        fd.append('repeat_total', $('#sl-repeat').value || '1');
        // Spool selection: auto = store colors, resolve trays at print start;
        // manual = explicit slot_map now.
        const colors = lastState?.palette || [];
        if (colors.length) {
          const material = $('#sl-material').value;
          if ($('#sl-ams-mode').value === 'manual') {
            const trays = document.querySelectorAll('.sl-ams-tray');
            if (trays.length) {
              const slot_map = {};
              trays.forEach(s => { slot_map[s.dataset.slot] = parseInt(s.value, 10); });
              fd.append('ams_roles', JSON.stringify({ mode: 'manual', colors, slot_map, material }));
            }
          } else {
            // material rides along so auto-map refuses spools of the wrong type
            fd.append('ams_roles', JSON.stringify({ mode: 'auto', colors, material }));
          }
        }
      }
      const res = await api.sliceModel(fd);
      const n = Object.keys(res.report?.settings || {}).length;
      if (res.job_id) {
        $('#sl-result').innerHTML =
          `<span style="color:var(--success,#34d399);">Sliced ✓ and queued as job <a href="#/jobs/${res.job_id}" style="color:var(--accent-primary);">${res.job_name}</a> — loop/eject transform applied</span>`;
      } else {
        $('#sl-result').innerHTML =
          `<span style="color:var(--success,#34d399);">Sliced ✓ ${res.output_name || ''} — ${res.report?.objects || 1} object(s), exact placement${n ? `, ${n} setting override(s)` : ''}</span>`;
      }
    } catch (err) {
      $('#sl-result').innerHTML = `<span style="color:#f87171;">⚠️ ${err.message}</span>`;
    } finally {
      btn.disabled = false; sliceLabel();
    }
  };
});


// ===== TIMELINE =====
route('/timeline', async (el) => {
  const events = await api.getEvents({ limit: 100 });
  el.innerHTML = html`
    <h1 class="text-gradient-flow" style="font-size:1.4rem;font-weight:700;margin-bottom:1.25rem;">Event Timeline</h1>
    <div class="card">
      <div class="timeline">
        ${events.length === 0 ? html`<p style="color:var(--text-muted);">No events yet</p>` :
      events.map(e => html`
            <div class="timeline-item">
              <div class="time">${timeAgo(e.created_at)} · <span class="badge badge-default">${e.entity_type}</span></div>
              <div class="event"><strong>${e.event_type}</strong></div>
              <div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-mono);margin-top:0.15rem;">${JSON.stringify(e.payload).slice(0, 120)}</div>
            </div>
          `).join('')}
      </div>
    </div>
  `;
});

// ===== MODALS =====

window.showTunnelModal = async function () {
  const status = await api.getTunnelStatus();
  renderTunnelModalContent(status);

  // Update on WS event
  const handler = (data) => renderTunnelModalContent(data);
  window.ws.on('tunnel.status_changed', handler);

  // Cleanup when modal closes
  const cleanup = () => {
    window.ws.off('tunnel.status_changed', handler);
  };
  // Hook into hideModal (simple hack: overwrite onclick of overlay/close btn inside modal logic is tricky, 
  // but existing hideModal just removes class. We can't easily hook cleanup. 
  // Instead, we'll check if modal is active in the handler or just leak a bit (it's SPA).
  // Better: make showModal return a close function or have a global event. 
  // For now, we'll just leave the listener attached but check if modal is open in handler? 
  // Or just re-render. It's fine for now, or we can use a global 'modal.closed' event if we added one.
  // Actually, let's just re-fetch status in the modal periodically or trust WS.
  // Helper to force cleanup if we specifically close it from THIS modal's close button?
};

function renderTunnelModalContent(state) {
  const isRunning = state.status === 'running';
  const isStarting = state.status === 'starting';
  const url = state.url || 'Waiting for link...';

  showModal(html`
    <div class="modal-header">
      <h2>Remote Access (Cloudflare Tunnel)</h2>
      <button class="btn btn-icon btn-sm" onclick="hideModal()">✕</button>
    </div>
    <div style="text-align:center;padding:1rem;">
      
      <div style="margin-bottom:1.5rem;">
        <div class="status-dot ${isRunning ? 'online' : (isStarting ? 'warning' : 'offline')}" style="width:12px;height:12px;display:inline-block;margin-right:0.5rem;"></div>
        <span style="font-weight:600;font-size:1.1rem;color:var(--text-primary);vertical-align:middle;">
          ${state.status.toUpperCase()}
        </span>
      </div>

      ${isRunning ? html`
        <div style="background:var(--bg-secondary);padding:1rem;border-radius:var(--radius-md);margin-bottom:1.5rem;word-break:break-all;">
          <a href="${url}" target="_blank" style="color:var(--accent-primary);font-weight:600;font-size:1.1rem;">${url}</a>
          <div style="margin-top:0.5rem;">
            <button class="btn btn-sm" onclick="navigator.clipboard.writeText('${url}');toast('Copied!','success')">Copy Link</button>
          </div>
        </div>
        <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:1.5rem;">
          Use this link to access your dashboard from anywhere. <br>
          Note: Passes through Cloudflare (free tier).
        </p>
        <button class="btn btn-danger" onclick="api.stopTunnel().catch(e=>toast(e.message,'error'))">Stop Tunnel</button>
      ` : html`
        <div style="margin-bottom:1.5rem;color:var(--text-secondary);">
          ${isStarting ? 'Starting up... This may take 10-20 seconds.' : 'Tunnel is currently stopped.'}
        </div>
        ${!isStarting ? html`
          <button class="btn btn-primary btn-lg" onclick="api.startTunnel().catch(e=>toast(e.message,'error'))">Start Tunnel</button>
        ` : ''}
      `}
    </div>
  `);
}

function showAddPrinterModal() {
  const modalContent = html`
    <div class="modal-header">
      <h2>Add Printer</h2>
      <button class="btn btn-icon btn-sm" onclick="hideModal()">✕</button>
    </div>

    <div class="wizard-steps">
      <div class="wizard-step active" id="ws-1">Discover</div>
      <div class="wizard-step" id="ws-2">Connect</div>
      <div class="wizard-step" id="ws-3">Done</div>
    </div>

    <!-- STEP 1: DISCOVER -->
    <div id="ap-step-1">
      <div id="discover-loading" style="text-align:center;padding:2rem;">
        <div class="spinner" style="margin:0 auto 1rem;"></div>
        <p style="font-weight:600;">Scanning your network...</p>
        <p style="font-size:0.8rem;color:var(--text-muted);">Listening for Bambu printers (SSDP on port 2021)</p>
      </div>
      <div id="discover-results" style="display:none;"></div>
      <div style="text-align:center;margin-top:1rem;padding-bottom:0.5rem;">
        <button class="btn btn-sm btn-outline" id="discover-rescan" style="display:none;" onclick="scanForPrinters()">↻ Rescan</button>
        <button class="btn btn-sm btn-link" style="color:var(--text-muted);" onclick="showManualEntry()">Enter details manually</button>
      </div>
    </div>

    <!-- STEP 2: CONNECT -->
    <div id="ap-step-2" style="display:none;">
      <div id="ap-connect-form">
        <div style="background:var(--bg-tertiary);border-radius:8px;padding:1rem;margin-bottom:1rem;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div id="ap-sel-name" style="font-weight:700;font-size:1.05rem;"></div>
              <div id="ap-sel-model" style="font-size:0.85rem;color:var(--text-muted);"></div>
            </div>
            <div id="ap-sel-mode" style="font-size:0.78rem;"></div>
          </div>
          <div style="font-size:0.82rem;color:var(--text-secondary);margin-top:0.5rem;">
            <span id="ap-sel-ip"></span> · <span id="ap-sel-serial" style="font-family:monospace;"></span>
          </div>
        </div>

        <div id="ap-cloud-warning" style="display:none;background:rgba(255,152,0,0.1);border:1px solid var(--warning);border-radius:8px;padding:1rem;margin-bottom:1rem;">
          <div style="font-weight:700;color:var(--warning);margin-bottom:0.5rem;">⚠️ LAN Mode Required</div>
          <ol style="margin:0;padding-left:1.25rem;font-size:0.85rem;line-height:1.7;">
            <li>Open printer Settings → Network</li>
            <li>Enable <strong>LAN Only Mode</strong></li>
            <li>Enable <strong>Developer Mode</strong></li>
            <li>Note the <strong>Access Code</strong> displayed</li>
            <li>Come back here and enter the code below</li>
          </ol>
        </div>

        <form id="ap-connect-details">
          <div class="form-group">
            <label>Printer Name</label>
            <input type="text" class="form-control" id="ap-name" required>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
            <div class="form-group">
              <label>IP Address</label>
              <input type="text" class="form-control" id="ap-ip" required>
            </div>
            <div class="form-group">
              <label>Model</label>
              <input type="text" class="form-control" id="ap-model" readonly style="opacity:0.7;">
            </div>
          </div>
          <div class="form-group">
            <label>LAN Access Code</label>
            <input type="password" class="form-control" id="ap-code" placeholder="8-digit code from printer screen" required autocomplete="off" style="letter-spacing:2px;font-size:1.1rem;">
            <small class="text-muted">Found on printer: Settings → LAN Only → Access Code</small>
          </div>
          <input type="hidden" id="ap-serial">
          <button type="submit" class="btn btn-primary" style="width:100%;">Test & Save</button>
        </form>
        <div style="margin-top:0.5rem;text-align:center;">
          <button class="btn btn-sm btn-link" style="color:var(--text-muted);" onclick="goToDiscovery()">← Back to discovery</button>
        </div>
      </div>

      <!-- Test/Save Progress -->
      <div id="ap-test-area" style="display:none;text-align:center;padding:1.5rem;">
        <div id="ap-test-loading">
          <div class="spinner" style="margin:0 auto 1rem;"></div>
          <p>Testing connection...</p>
        </div>
        <div id="ap-test-result" style="display:none;">
          <div id="ap-test-icon" style="font-size:3rem;margin-bottom:1rem;"></div>
          <h3 id="ap-test-msg" style="margin-bottom:0.5rem;"></h3>
          <p id="ap-test-detail" style="color:var(--text-muted);font-size:0.9rem;margin-bottom:1.5rem;"></p>
          <div class="btn-group" style="justify-content:center;gap:1rem;">
            <button class="btn btn-outline" onclick="goToConnectForm()">Back</button>
            <button class="btn btn-primary" id="ap-save-btn" disabled>Save Printer</button>
          </div>
          <div id="ap-force-save" style="margin-top:1rem;display:none;">
            <button class="btn btn-sm btn-link" style="color:var(--danger);" onclick="savePrinter(true)">Save anyway (skip test)</button>
          </div>
        </div>
      </div>
    </div>
  `;

  showModal(modalContent);

  // State
  let printerData = {};
  let selectedPrinter = null;

  // Scan immediately (deferred to ensure window functions are registered)
  setTimeout(() => window.scanForPrinters(), 0);

  // ---- STEP 1: Discovery ----
  window.scanForPrinters = async function() {
    const loading = document.getElementById('discover-loading');
    const results = document.getElementById('discover-results');
    const rescan = document.getElementById('discover-rescan');
    if (loading) loading.style.display = 'block';
    if (results) results.style.display = 'none';
    if (rescan) rescan.style.display = 'none';

    try {
      const discovered = await api.discoverPrinters();
      if (loading) loading.style.display = 'none';
      if (results) results.style.display = 'block';
      if (rescan) rescan.style.display = 'inline-flex';

      if (discovered.length === 0) {
        results.innerHTML = html`
          <div style="text-align:center;padding:1.5rem;color:var(--text-muted);">
            <div style="font-size:2.5rem;margin-bottom:0.75rem;">📡</div>
            <p style="font-weight:600;">No printers found</p>
            <p style="font-size:0.83rem;">Make sure your printers are on and connected to this network.<br>
            Printers may take up to 30 seconds to broadcast after powering on.</p>
          </div>
        `;
        return;
      }

      const signalBars = (bars) => {
        let s = '';
        for (let i = 0; i < 4; i++) {
          const h = 6 + i * 3;
          const color = i < bars ? 'var(--success)' : 'var(--border-color)';
          s += '<div style="width:3px;height:' + h + 'px;background:' + color + ';border-radius:1px;"></div>';
        }
        return '<div style="display:flex;align-items:flex-end;gap:1px;">' + s + '</div>';
      };

      const modeBadge = (mode) => {
        if (mode === 'lan') return '<span style="display:inline-flex;align-items:center;gap:0.25rem;font-size:0.72rem;font-weight:600;padding:0.15rem 0.45rem;border-radius:4px;background:rgba(76,175,80,0.15);color:var(--success);">🔒 LAN</span>';
        return '<span style="display:inline-flex;align-items:center;gap:0.25rem;font-size:0.72rem;font-weight:600;padding:0.15rem 0.45rem;border-radius:4px;background:rgba(255,152,0,0.15);color:var(--warning);">☁️ Cloud</span>';
      };

      results.innerHTML = discovered.map((p, i) => html`
        <div class="card" style="cursor:${p.already_added ? 'default' : 'pointer'};margin-bottom:0.5rem;padding:0.85rem 1rem;opacity:${p.already_added ? '0.5' : '1'};border:2px solid transparent;transition:border-color 0.15s;"
             ${p.already_added ? '' : 'onclick="selectDiscoveredPrinter(' + i + ')"'}
             onmouseenter="if(!this.dataset.added)this.style.borderColor='var(--primary)'"
             onmouseleave="this.style.borderColor='transparent'"
             data-added="${p.already_added}">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="display:flex;align-items:center;gap:0.75rem;">
              <div style="font-size:1.5rem;">🖨️</div>
              <div>
                <div style="font-weight:700;font-size:0.95rem;">${p.name || 'Unnamed Printer'}</div>
                <div style="font-size:0.8rem;color:var(--text-muted);">${p.model} · ${p.ip}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:0.75rem;">
              ${signalBars(p.signal_bars)}
              ${modeBadge(p.connection_mode)}
              ${p.already_added ? '<span style="font-size:0.72rem;color:var(--text-muted);font-weight:600;">ADDED</span>' : ''}
            </div>
          </div>
        </div>
      `).join('');

      // Store discovered list for selection
      window._discoveredPrinters = discovered;

    } catch (err) {
      if (loading) loading.style.display = 'none';
      if (results) {
        results.style.display = 'block';
        results.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--danger);">Discovery error: ' + err.message + '</div>';
      }
      if (rescan) rescan.style.display = 'inline-flex';
    }
  };

  // Select a discovered printer → go to Step 2
  window.selectDiscoveredPrinter = function(index) {
    selectedPrinter = window._discoveredPrinters[index];
    if (!selectedPrinter || selectedPrinter.already_added) return;

    // Auto-populate Step 2
    document.getElementById('ap-name').value = selectedPrinter.name || '';
    document.getElementById('ap-ip').value = selectedPrinter.ip || '';
    document.getElementById('ap-model').value = selectedPrinter.model || '';
    document.getElementById('ap-serial').value = selectedPrinter.serial || '';

    // Show selected printer info
    document.getElementById('ap-sel-name').textContent = selectedPrinter.name || 'Unnamed';
    document.getElementById('ap-sel-model').textContent = selectedPrinter.model;
    document.getElementById('ap-sel-ip').textContent = selectedPrinter.ip;
    document.getElementById('ap-sel-serial').textContent = selectedPrinter.serial || '';

    const modeEl = document.getElementById('ap-sel-mode');
    modeEl.innerHTML = selectedPrinter.connection_mode === 'lan'
      ? '<span style="color:var(--success);font-weight:600;">🔒 LAN Mode</span>'
      : '<span style="color:var(--warning);font-weight:600;">☁️ Cloud Mode</span>';

    // Show cloud warning if not in LAN mode
    document.getElementById('ap-cloud-warning').style.display =
      selectedPrinter.connection_mode === 'lan' ? 'none' : 'block';

    // Transition to Step 2
    document.getElementById('ws-1').classList.add('active');
    document.getElementById('ws-2').classList.add('active');
    document.getElementById('ap-step-1').style.display = 'none';
    document.getElementById('ap-step-2').style.display = 'block';
    document.getElementById('ap-connect-form').style.display = 'block';
    document.getElementById('ap-test-area').style.display = 'none';

    // Focus access code field
    setTimeout(() => document.getElementById('ap-code').focus(), 200);
  };

  // Manual entry fallback
  window.showManualEntry = function() {
    selectedPrinter = null;
    document.getElementById('ap-name').value = '';
    document.getElementById('ap-ip').value = '';
    document.getElementById('ap-model').value = 'Bambu A1';
    document.getElementById('ap-model').removeAttribute('readonly');
    document.getElementById('ap-model').style.opacity = '1';
    document.getElementById('ap-serial').value = '';
    document.getElementById('ap-sel-name').textContent = 'Manual Entry';
    document.getElementById('ap-sel-model').textContent = 'Enter details below';
    document.getElementById('ap-sel-ip').textContent = '';
    document.getElementById('ap-sel-serial').textContent = '';
    document.getElementById('ap-sel-mode').innerHTML = '';
    document.getElementById('ap-cloud-warning').style.display = 'none';

    document.getElementById('ws-1').classList.add('active');
    document.getElementById('ws-2').classList.add('active');
    document.getElementById('ap-step-1').style.display = 'none';
    document.getElementById('ap-step-2').style.display = 'block';
    document.getElementById('ap-connect-form').style.display = 'block';
    document.getElementById('ap-test-area').style.display = 'none';
  };

  window.goToDiscovery = function() {
    document.getElementById('ws-2').classList.remove('active');
    document.getElementById('ap-step-1').style.display = 'block';
    document.getElementById('ap-step-2').style.display = 'none';
  };

  window.goToConnectForm = function() {
    document.getElementById('ap-connect-form').style.display = 'block';
    document.getElementById('ap-test-area').style.display = 'none';
  };

  // ---- STEP 2: Connect form submit ----
  document.getElementById('ap-connect-details').onsubmit = async (e) => {
    e.preventDefault();
    printerData = {
      name: document.getElementById('ap-name').value,
      model: document.getElementById('ap-model').value,
      ip_hostname: document.getElementById('ap-ip').value,
      auth: {
        access_code: document.getElementById('ap-code').value,
        serial: document.getElementById('ap-serial').value,
      },
    };

    // Show test area
    document.getElementById('ap-connect-form').style.display = 'none';
    document.getElementById('ap-test-area').style.display = 'block';
    document.getElementById('ap-test-loading').style.display = 'block';
    document.getElementById('ap-test-result').style.display = 'none';

    try {
      const res = await api.testPrinterConnectionParams({
        ip_hostname: printerData.ip_hostname,
        access_code: printerData.auth.access_code,
        serial: printerData.auth.serial,
      });

      document.getElementById('ap-test-loading').style.display = 'none';
      document.getElementById('ap-test-result').style.display = 'block';

      const success = res.success;
      document.getElementById('ap-test-icon').textContent = success ? '✅' : '❌';
      document.getElementById('ap-test-msg').textContent = success ? 'Connection Successful' : 'Connection Failed';
      document.getElementById('ap-test-msg').style.color = success ? 'var(--success)' : 'var(--danger)';
      document.getElementById('ap-test-detail').textContent = res.message || '';

      if (success) {
        document.getElementById('ap-test-result').querySelector('.btn-group').innerHTML = html`
          <button class="btn btn-outline" onclick="goToConnectForm()">Back</button>
          <button class="btn btn-primary" id="ap-save-btn" onclick="savePrinter()">Save Printer</button>
        `;
        document.getElementById('ap-force-save').style.display = 'none';
      } else {
        document.getElementById('ap-test-result').querySelector('.btn-group').innerHTML = html`
          <button class="btn btn-outline" onclick="goToConnectForm()">Back</button>
          <button class="btn btn-primary" id="ap-save-btn" disabled>Save Printer</button>
        `;
        document.getElementById('ap-force-save').style.display = 'block';
      }
    } catch (err) {
      document.getElementById('ap-test-loading').style.display = 'none';
      document.getElementById('ap-test-result').style.display = 'block';
      document.getElementById('ap-test-icon').textContent = '⚠️';
      document.getElementById('ap-test-msg').textContent = 'System Error';
      document.getElementById('ap-test-msg').style.color = 'var(--danger)';
      document.getElementById('ap-test-detail').textContent = err.message;
      document.getElementById('ap-test-result').querySelector('.btn-group').innerHTML = html`
        <button class="btn btn-outline" onclick="goToConnectForm()">Back</button>
      `;
      document.getElementById('ap-force-save').style.display = 'block';
    }
  };

  // ---- Save Printer ----
  window.savePrinter = async function(force = false) {
    if (force && !confirm('Are you sure? The printer may not be controllable.')) return;

    try {
      const btn = document.getElementById('ap-save-btn');
      if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

      await api.createPrinter(printerData);

      // Step 3: Done
      document.getElementById('ws-3').classList.add('active');
      document.getElementById('ap-step-2').innerHTML = html`
        <div style="text-align:center;padding:2rem;">
          <div style="font-size:3rem;margin-bottom:1rem;">🎉</div>
          <h3>Printer Added!</h3>
          <p style="color:var(--text-muted);margin-bottom:1.5rem;">${printerData.name} is now ready to use.</p>
          <button class="btn btn-primary" onclick="hideModal();navigateTo('/printers');">Close</button>
        </div>
      `;
      toast('Printer added successfully', 'success');
      window.location.hash = '#/printers';
    } catch (err) {
      toast(err.message, 'error');
      const btn = document.getElementById('ap-save-btn');
      if (btn) { btn.textContent = 'Save Printer'; btn.disabled = false; }
    }
  };
}

window.showAttachAccessoryModal = function (printerId = '') {
  showModal(html`
    <div class="modal-header">
      <h2>Attach Accessory</h2>
      <button class="btn btn-icon btn-sm" onclick="hideModal()">✕</button>
    </div>
    <form id="add-acc-form">
      <div class="form-group">
        <label>Accessory Type</label>
        <select class="form-control" id="aa-type">
          <option value="door_servo">Door Servo</option>
          <option value="eject_printhead">Print Head Sweep</option>
          <option value="camera">Camera</option>
          <option value="scale">Scale</option>
        </select>
      </div>
      <div class="form-group">
        <label>Connection Type</label>
        <select class="form-control" id="aa-conn">
          <option value="usb_serial">USB Serial</option>
          <option value="http">HTTP</option>
          <option value="mqtt">MQTT</option>
        </select>
      </div>
      <div class="form-group">
        <label>Endpoint</label>
        <input type="text" class="form-control" id="aa-endpoint" placeholder="/dev/ttyACM0 or http://..." required>
      </div>
      ${printerId ? '' : html`
        <div class="form-group">
          <label>Printer ID (optional)</label>
          <input type="text" class="form-control" id="aa-printer" placeholder="UUID">
        </div>
      `}
      <button type="submit" class="btn btn-primary" style="width:100%;">Add Accessory</button>
    </form>
  `);

  $('#add-acc-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.createAccessory({
        type: $('#aa-type').value,
        connection_type: $('#aa-conn').value,
        endpoint: $('#aa-endpoint').value,
        printer_id: printerId || ($('#aa-printer')?.value || null),
      });
      hideModal();
      toast('Accessory added!', 'success');
      navigateTo(window.location.hash.slice(1));
    } catch (err) { toast(err.message, 'error'); }
  };
};

function showSubmitJobModal(profiles, printers) {
  showModal(html`
    <div class="modal-header">
      <h2>Submit Job</h2>
      <button class="btn btn-icon btn-sm" onclick="hideModal()">✕</button>
    </div>
    <form id="submit-job-form">
      <div class="form-group">
        <label>Job Name</label>
        <input type="text" class="form-control" id="sj-name" placeholder="e.g. CaseBatch-White">
      </div>
      <div class="form-group">
        <label>G-code File</label>
        <input type="file" class="form-control" id="sj-file" accept=".gcode,.g,.gc,.3mf" required>
      </div>
      <div class="form-group">
        <label>Assign to Printer (optional)</label>
        <select class="form-control" id="sj-printer">
          <option value="">Global Queue</option>
          ${printers.map(p => html`<option value="${p.printer_id}">${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Queue Copies (Separate Jobs)</label>
        <input type="number" class="form-control" id="sj-repeat" value="1" min="1" max="999">
        <small style="color:var(--text-muted);font-size:0.7rem;">Create N separate jobs in the queue</small>
      </div>

      <div style="border-top:1px solid var(--border-color);margin:1rem 0 0.75rem;padding-top:0.75rem;">
        <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-weight:600;">
          <input type="checkbox" id="sj-skip-transform"> Upload as Raw (skip G-code transform)
        </label>
        <small style="color:var(--text-muted);display:block;margin-top:0.25rem;">Check this to send the file to the printer exactly as-is, with no modifications.</small>
      </div>

      <div id="sj-transform-section">
        <div class="form-group">
          <label>Transform Profile</label>
          <select class="form-control" id="sj-profile">
            ${profiles.map(p => html`<option value="${p.profile_id}">${p.name} (${p.printer_model})</option>`).join('')}
          </select>
        </div>

        <details id="sj-settings-details" style="margin-top:0.5rem;">
          <summary style="cursor:pointer;font-weight:600;font-size:0.88rem;color:var(--accent-primary);user-select:none;">
            ⚙️ Automator Settings
          </summary>
          <div style="margin-top:0.75rem;display:grid;grid-template-columns:1fr 1fr;gap:0.65rem;">
            <div class="form-group" style="margin:0;">
              <label style="font-size:0.78rem;">Printer Model</label>
              <select class="form-control" id="sj-printer-model">
                <option value="P1S">P1S</option>
                <option value="P2S">P2S</option>
                <option value="X1">X1 / X1C</option>
                <option value="X2D">X2D</option>
                <option value="A1">A1</option>
                <option value="A1_MINI">A1 Mini</option>
                <option value="A2L">A2L</option>
                <option value="H2D">H2 Series</option>
              </select>
            </div>
            <div class="form-group" style="margin:0;">
              <label style="font-size:0.78rem;">Print Loops (One File)</label>
              <input type="number" class="form-control" id="sj-n-loops" step="1" min="1" max="999" placeholder="1" value="1">
            </div>
            <div class="form-group" style="margin:0;">
              <label style="font-size:0.78rem;">Cooldown Mode</label>
              <select class="form-control" id="sj-cooldown-mode">
                <option value="temperature">Wait for temperature</option>
                <option value="time">Wait fixed time</option>
              </select>
            </div>
            <div class="form-group sj-cool-temp" style="margin:0;">
              <label style="font-size:0.78rem;">Release Temp (°C)</label>
              <input type="number" class="form-control" id="sj-release-temp" step="1" min="15" max="60" placeholder="27" value="27">
              <small style="color:var(--text-muted);font-size:0.7rem;">M190 target = this − 3°C (Bambu early-exit)</small>
            </div>
            <div class="form-group sj-cool-temp" style="margin:0;">
              <label style="font-size:0.78rem;">Max Wait (min)</label>
              <input type="number" class="form-control" id="sj-max-wait" step="1" min="10" max="120" placeholder="60" value="60">
              <small style="color:var(--text-muted);font-size:0.7rem;">Repeated M190 S cooldown timeout</small>
            </div>
            <div class="form-group sj-cool-time" style="margin:0;display:none;">
              <label style="font-size:0.78rem;">Cool Time (min)</label>
              <input type="number" class="form-control" id="sj-cool-time" step="1" min="1" max="180" placeholder="30" value="30">
              <small style="color:var(--text-muted);font-size:0.7rem;">Fixed G4 dwell — ignores temperature</small>
            </div>
            <div class="form-group" style="margin:0;">
              <label style="font-size:0.78rem;">Sweep Z (mm)</label>
              <input type="number" class="form-control" id="sj-sweep-z" step="0.5" min="1" max="20" placeholder="4" value="4">
            </div>
            <div class="form-group" style="margin:0;">
              <label style="font-size:0.78rem;">Z Clear Travel (mm)</label>
              <input type="number" class="form-control" id="sj-z-clear" step="1" min="10" max="300" placeholder="200" value="200">
              <small style="color:var(--text-muted);font-size:0.7rem;">Safe height after sweep (clamped Zmax−5)</small>
            </div>
          </div>
        </details>
      </div>

      <button type="submit" class="btn btn-primary" style="width:100%;margin-top:1rem;">Submit Job</button>
    </form>
  `);

  // Auto-populate automator settings from selected profile
  // NOTE: sweep_z and z_clear use the form's hardcoded defaults (4mm, 200mm)
  // — old profiles have z_sweep_mm=2 which is wrong for the new automator
  function populateFromProfile() {
    const profileId = $('#sj-profile').value;
    const profile = profiles.find(p => p.profile_id === profileId);
    if (!profile) return;
    $('#sj-n-loops').value = profile.n_loops ?? 1;
    $('#sj-release-temp').value = profile.release_bed_temp_c ?? profile.cool_target_c ?? 27;
    $('#sj-max-wait').value = profile.max_cool_wait_minutes ?? 60;
    $('#sj-cooldown-mode').value = profile.cooldown_mode === 'time' ? 'time' : 'temperature';
    $('#sj-cool-time').value = profile.cool_time_minutes ?? 30;
    syncCooldownMode();
    // sweep_z and z_clear intentionally NOT populated from profile
  }

  // Show only the fields for the selected cooldown mode (temperature XOR time)
  function syncCooldownMode() {
    const isTime = $('#sj-cooldown-mode').value === 'time';
    document.querySelectorAll('.sj-cool-temp').forEach(el => el.style.display = isTime ? 'none' : 'block');
    document.querySelectorAll('.sj-cool-time').forEach(el => el.style.display = isTime ? 'block' : 'none');
  }

  populateFromProfile();
  $('#sj-profile').onchange = populateFromProfile;
  $('#sj-cooldown-mode').onchange = syncCooldownMode;

  // Toggle transform section visibility
  $('#sj-skip-transform').onchange = function () {
    $('#sj-settings-details').style.display = this.checked ? 'none' : 'block';
  };

  $('#submit-job-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const formData = new FormData();
      formData.append('file', $('#sj-file').files[0]);
      formData.append('name', $('#sj-name').value || $('#sj-file').files[0].name);
      formData.append('printer_id', $('#sj-printer').value || '');
      formData.append('repeat_total', $('#sj-repeat').value);

      const skipTransform = $('#sj-skip-transform').checked;
      formData.append('skip_transform', skipTransform);

      if (!skipTransform) {
        formData.append('profile_id', $('#sj-profile').value);

        // Gather automator overrides (v3)
        const overrides = {};
        const model = $('#sj-printer-model').value;
        if (model) overrides.printer_model = model;
        const nLoops = parseInt($('#sj-n-loops').value);
        if (!isNaN(nLoops) && nLoops >= 1) overrides.n_loops = nLoops;
        const cooldownMode = $('#sj-cooldown-mode').value === 'time' ? 'time' : 'temperature';
        overrides.cooldown_mode = cooldownMode;
        if (cooldownMode === 'time') {
          const coolTime = parseInt($('#sj-cool-time').value);
          if (!isNaN(coolTime)) overrides.cool_time_min = coolTime;
        } else {
          const releaseTemp = parseInt($('#sj-release-temp').value);
          if (!isNaN(releaseTemp)) overrides.release_temp_c = releaseTemp;
          const maxWait = parseInt($('#sj-max-wait').value);
          if (!isNaN(maxWait)) overrides.max_wait_min = maxWait;
        }
        const sweepZ = parseFloat($('#sj-sweep-z').value);
        if (!isNaN(sweepZ)) overrides.sweep_z_mm = sweepZ;
        const zClear = parseFloat($('#sj-z-clear').value);
        if (!isNaN(zClear)) overrides.z_clear_travel_mm = zClear;

        formData.append('transform_overrides', JSON.stringify(overrides));
      }

      await api.submitJob(formData);
      hideModal();
      toast('Job submitted!', 'success');
      navigateTo('/jobs');
    } catch (err) { toast(err.message, 'error'); }
  };
}

window.showCreateProfileModal = function () {
  showModal(html`
    <div class="modal-header">
      <h2>Create Profile</h2>
      <button class="btn btn-icon btn-sm" onclick="hideModal()">✕</button>
    </div>
    <form id="create-profile-form">
      <div class="form-group"><label>Name</label><input type="text" class="form-control" id="cp-name" required></div>
      <div class="form-group"><label>Description</label><input type="text" class="form-control" id="cp-desc"></div>
      <div class="form-group"><label>Printer Model</label><input type="text" class="form-control" id="cp-model" value="*" placeholder="* for all"></div>
      <div class="form-group"><label>Release Temp (°C)</label><input type="number" class="form-control" id="cp-temp" value="27" step="0.5"></div>
      <div class="form-group"><label>Park Y (mm)</label><input type="number" class="form-control" id="cp-parky" value="200"></div>
      <button type="submit" class="btn btn-primary" style="width:100%;">Create Profile</button>
    </form>
  `);
  $('#create-profile-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.createProfile({
        name: $('#cp-name').value, description: $('#cp-desc').value,
        printer_model: $('#cp-model').value, release_bed_temp_c: parseFloat($('#cp-temp').value),
        park_y_mm: parseFloat($('#cp-parky').value),
      });
      hideModal(); toast('Profile created!', 'success'); navigateTo('/profiles');
    } catch (err) { toast(err.message, 'error'); }
  };
};

// ===== TEMPLATE MODALS =====

function showSaveTemplateModal(profiles, printers) {
  showModal(html`
    <div class="modal-header">
      <h2>Save Job Template</h2>
      <button class="btn btn-icon btn-sm" onclick="hideModal()">✕</button>
    </div>
    <form id="save-template-form">
      <div class="form-group">
        <label>Template Name</label>
        <input type="text" class="form-control" id="st-name" placeholder="e.g. White-Cases-Batch" required>
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" class="form-control" id="st-desc" placeholder="Quick description of this job setup">
      </div>
      <div class="form-group" style="background:var(--bg-secondary);padding:0.75rem;border-radius:var(--radius-md);border:1px dashed var(--accent-primary);">
        <label style="font-weight:700;">📁 G-code / 3MF File <span style="color:var(--accent-primary);">(Required for one-click queue)</span></label>
        <input type="file" class="form-control" id="st-file" accept=".gcode,.g,.gc,.3mf" required>
        <small style="color:var(--text-muted);">This file will be stored with the template so you can send it to the queue with one click</small>
      </div>
      <div class="form-group">
        <label>Default Printer</label>
        <select class="form-control" id="st-printer">
          <option value="">Any (Global Queue)</option>
          ${printers.map(p => html`<option value="${p.printer_id}">${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Queue Copies (Separate Jobs)</label>
        <input type="number" class="form-control" id="st-repeat" value="1" min="1" max="999">
        <small style="color:var(--text-muted);font-size:0.7rem;">Create N separate jobs in the queue</small>
      </div>
      <div class="form-group">
        <label>Tags (comma-separated)</label>
        <input type="text" class="form-control" id="st-tags" placeholder="e.g. white, cases, production">
      </div>

      <div style="border-top:1px solid var(--border-color);margin:1rem 0 0.75rem;padding-top:0.75rem;">
        <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-weight:600;">
          <input type="checkbox" id="st-skip-transform"> Upload as Raw (skip G-code transform)
        </label>
        <small style="color:var(--text-muted);display:block;margin-top:0.25rem;">Check this to send the file to the printer exactly as-is, with no modifications.</small>
      </div>

      <div id="st-transform-section">
        <div class="form-group">
          <label>Transform Profile</label>
          <select class="form-control" id="st-profile">
            <option value="">— None —</option>
            ${profiles.map(p => html`<option value="${p.profile_id}">${p.name} (${p.printer_model})</option>`).join('')}
          </select>
        </div>

        <details style="margin-top:0.5rem;">
          <summary style="cursor:pointer;font-weight:600;font-size:0.88rem;color:var(--accent-primary);user-select:none;">
            ⚙️ Automator Settings
          </summary>
          <div style="margin-top:0.75rem;display:grid;grid-template-columns:1fr 1fr;gap:0.65rem;">
            <div class="form-group" style="margin:0;">
              <label style="font-size:0.78rem;">Printer Model</label>
              <select class="form-control" id="st-printer-model">
                <option value="P1S">P1S</option>
                <option value="P2S">P2S</option>
                <option value="X1">X1 / X1C</option>
                <option value="X2D">X2D</option>
                <option value="A1">A1</option>
                <option value="A1_MINI">A1 Mini</option>
                <option value="A2L">A2L</option>
                <option value="H2D">H2 Series</option>
              </select>
            </div>
            <div class="form-group" style="margin:0;">
              <label style="font-size:0.78rem;">Print Loops (One File)</label>
              <input type="number" class="form-control" id="st-n-loops" step="1" min="1" max="999" placeholder="1" value="1">
            </div>
            <div class="form-group" style="margin:0;">
              <label style="font-size:0.78rem;">Cooldown Mode</label>
              <select class="form-control" id="st-cooldown-mode">
                <option value="temperature">Wait for temperature</option>
                <option value="time">Wait fixed time</option>
              </select>
            </div>
            <div class="form-group st-cool-temp" style="margin:0;">
              <label style="font-size:0.78rem;">Release Temp (°C)</label>
              <input type="number" class="form-control" id="st-release-temp" step="1" min="15" max="60" placeholder="27" value="27">
              <small style="color:var(--text-muted);font-size:0.7rem;">M190 target = this − 3°C (Bambu early-exit)</small>
            </div>
            <div class="form-group st-cool-temp" style="margin:0;">
              <label style="font-size:0.78rem;">Max Wait (min)</label>
              <input type="number" class="form-control" id="st-max-wait" step="1" min="10" max="120" placeholder="60" value="60">
              <small style="color:var(--text-muted);font-size:0.7rem;">Repeated M190 S cooldown timeout</small>
            </div>
            <div class="form-group st-cool-time" style="margin:0;display:none;">
              <label style="font-size:0.78rem;">Cool Time (min)</label>
              <input type="number" class="form-control" id="st-cool-time" step="1" min="1" max="180" placeholder="30" value="30">
              <small style="color:var(--text-muted);font-size:0.7rem;">Fixed G4 dwell — ignores temperature</small>
            </div>
            <div class="form-group" style="margin:0;">
              <label style="font-size:0.78rem;">Sweep Z (mm)</label>
              <input type="number" class="form-control" id="st-sweep-z" step="0.5" min="1" max="20" placeholder="4" value="4">
            </div>
            <div class="form-group" style="margin:0;">
              <label style="font-size:0.78rem;">Z Clear Travel (mm)</label>
              <input type="number" class="form-control" id="st-z-clear" step="1" min="10" max="300" placeholder="200" value="200">
              <small style="color:var(--text-muted);font-size:0.7rem;">Safe height after sweep (clamped Zmax−5)</small>
            </div>
          </div>
        </details>
      </div>

      <button type="submit" class="btn btn-primary" style="width:100%;margin-top:1rem;">Save Template</button>
    </form>
  `);

  // Auto-populate automator settings from selected profile
  function stPopulateFromProfile() {
    const profileId = $('#st-profile').value;
    const profile = profiles.find(p => p.profile_id === profileId);
    if (!profile) return;
    $('#st-n-loops').value = profile.n_loops ?? 1;
    $('#st-release-temp').value = profile.release_bed_temp_c ?? profile.cool_target_c ?? 27;
    $('#st-max-wait').value = profile.max_cool_wait_minutes ?? 60;
    $('#st-cooldown-mode').value = profile.cooldown_mode === 'time' ? 'time' : 'temperature';
    $('#st-cool-time').value = profile.cool_time_minutes ?? 30;
    stSyncCooldownMode();
  }
  function stSyncCooldownMode() {
    const isTime = $('#st-cooldown-mode').value === 'time';
    document.querySelectorAll('.st-cool-temp').forEach(el => el.style.display = isTime ? 'none' : 'block');
    document.querySelectorAll('.st-cool-time').forEach(el => el.style.display = isTime ? 'block' : 'none');
  }
  stPopulateFromProfile();
  $('#st-profile').onchange = stPopulateFromProfile;
  $('#st-cooldown-mode').onchange = stSyncCooldownMode;

  // Toggle transform section visibility
  $('#st-skip-transform').onchange = function () {
    $('#st-transform-section').style.display = this.checked ? 'none' : 'block';
  };

  $('#save-template-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const formData = new FormData();
      formData.append('name', $('#st-name').value);
      formData.append('description', $('#st-desc').value);
      formData.append('profile_id', $('#st-profile').value || '');
      formData.append('printer_id', $('#st-printer').value || '');
      formData.append('repeat_total', $('#st-repeat').value || '1');
      formData.append('tags', $('#st-tags').value || '');
      const fileInput = $('#st-file');
      if (fileInput.files.length > 0) {
        formData.append('file', fileInput.files[0]);
      }

      // Gather automator overrides
      const skipTransform = $('#st-skip-transform').checked;
      if (!skipTransform) {
        const overrides = {};
        const model = $('#st-printer-model').value;
        if (model) overrides.printer_model = model;
        const nLoops = parseInt($('#st-n-loops').value);
        if (!isNaN(nLoops) && nLoops >= 1) overrides.n_loops = nLoops;
        const cooldownMode = $('#st-cooldown-mode').value === 'time' ? 'time' : 'temperature';
        overrides.cooldown_mode = cooldownMode;
        if (cooldownMode === 'time') {
          const coolTime = parseInt($('#st-cool-time').value);
          if (!isNaN(coolTime)) overrides.cool_time_min = coolTime;
        } else {
          const releaseTemp = parseInt($('#st-release-temp').value);
          if (!isNaN(releaseTemp)) overrides.release_temp_c = releaseTemp;
          const maxWait = parseInt($('#st-max-wait').value);
          if (!isNaN(maxWait)) overrides.max_wait_min = maxWait;
        }
        const sweepZ = parseFloat($('#st-sweep-z').value);
        if (!isNaN(sweepZ)) overrides.sweep_z_mm = sweepZ;
        const zClear = parseFloat($('#st-z-clear').value);
        if (!isNaN(zClear)) overrides.z_clear_travel_mm = zClear;
        formData.append('transform_overrides', JSON.stringify(overrides));
      } else {
        formData.append('transform_overrides', JSON.stringify({ skip_transform: true }));
      }

      await api.createJobTemplate(formData);
      hideModal();
      toast('Template saved!', 'success');
      navigateTo('/jobs');
    } catch (err) { toast(err.message, 'error'); }
  };
}

window.saveJobAsTemplate = async function (jobId, name, profileId, printerId, repeatTotal) {
  try {
    const formData = new FormData();
    formData.append('name', `${name} (template)`);
    formData.append('description', `Saved from job ${jobId.slice(0, 8)}`);
    formData.append('profile_id', profileId || '');
    formData.append('printer_id', printerId || '');
    formData.append('repeat_total', String(repeatTotal || 1));
    await api.createJobTemplate(formData);
    toast('Job saved as template!', 'success');
    navigateTo('/jobs');
  } catch (err) { toast(err.message, 'error'); }
};

// One-click submit from template (no modal)
let _quickSubmitting = false;
window.quickSubmitTemplate = async function(templateId, templateName) {
  if (_quickSubmitting) return;
  _quickSubmitting = true;
  // Disable all send-to-queue buttons while in-flight
  document.querySelectorAll('[onclick*="quickSubmitTemplate"]').forEach(b => { b.disabled = true; b.textContent = 'Sending…'; });
  try {
    await api.submitFromTemplate(templateId, {
      name: templateName,
    });
    toast(`"${templateName}" sent to queue!`, 'success');
    if (window.jobRefreshHandler) window.jobRefreshHandler();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    _quickSubmitting = false;
    document.querySelectorAll('[onclick*="quickSubmitTemplate"]').forEach(b => { b.disabled = false; b.textContent = '▶ Send to Queue'; });
  }
};

window.useTemplate = async function (templateId) {
  try {
    const tmpl = await api.getJobTemplate(templateId);
    const ov = tmpl.transform_overrides || {};
    const [profiles, printers] = await Promise.all([api.getProfiles(), api.getPrinters()]);

    // If template has a stored file, show the edit-and-submit modal
    if (tmpl.source_file_name) {
      showModal(html`
        <div class="modal-header">
          <h2>Submit: ${tmpl.name}</h2>
          <button class="btn btn-icon btn-sm" onclick="hideModal()">✕</button>
        </div>
        <form id="quick-submit-form">
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:1rem;margin-bottom:1rem;">
            <div style="font-size:0.85rem;display:grid;grid-template-columns:auto 1fr;gap:0.3rem 0.75rem;">
              <span style="color:var(--text-muted);">File:</span> <span style="font-weight:600;">${tmpl.source_file_name}</span>
            </div>
          </div>
          <div class="form-group">
            <label>Job Name</label>
            <input type="text" class="form-control" id="qs-name" value="${tmpl.name}">
          </div>
          <div class="form-group">
            <label>Assign to Printer</label>
            <select class="form-control" id="qs-printer">
              <option value="">Global Queue</option>
              ${printers.map(p => html`<option value="${p.printer_id}" ${p.printer_id === tmpl.printer_id ? 'selected' : ''}>${p.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Queue Copies (Separate Jobs)</label>
            <input type="number" class="form-control" id="qs-repeat" value="${tmpl.repeat_total}" min="1" max="999">
          </div>

          <div style="border-top:1px solid var(--border-color);margin:1rem 0 0.75rem;padding-top:0.75rem;">
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-weight:600;">
              <input type="checkbox" id="qs-skip-transform" ${ov.skip_transform ? 'checked' : ''}> Upload as Raw (skip G-code transform)
            </label>
          </div>

          <div id="qs-transform-section" style="${ov.skip_transform ? 'display:none;' : ''}">
            <div class="form-group">
              <label>Transform Profile</label>
              <select class="form-control" id="qs-profile">
                <option value="">— None —</option>
                ${profiles.map(p => html`<option value="${p.profile_id}" ${p.profile_id === tmpl.profile_id ? 'selected' : ''}>${p.name} (${p.printer_model})</option>`).join('')}
              </select>
            </div>

            <details style="margin-top:0.5rem;">
              <summary style="cursor:pointer;font-weight:600;font-size:0.88rem;color:var(--accent-primary);user-select:none;">
                ⚙️ Automator Settings
              </summary>
              <div style="margin-top:0.75rem;display:grid;grid-template-columns:1fr 1fr;gap:0.65rem;">
                <div class="form-group" style="margin:0;">
                  <label style="font-size:0.78rem;">Printer Model</label>
                  <select class="form-control" id="qs-printer-model">
                    <option value="P1S" ${ov.printer_model === 'P1S' ? 'selected' : ''}>P1S</option>
                    <option value="P2S" ${ov.printer_model === 'P2S' ? 'selected' : ''}>P2S</option>
                    <option value="X1" ${ov.printer_model === 'X1' ? 'selected' : ''}>X1 / X1C</option>
                    <option value="X2D" ${ov.printer_model === 'X2D' ? 'selected' : ''}>X2D</option>
                    <option value="A1" ${ov.printer_model === 'A1' ? 'selected' : ''}>A1</option>
                    <option value="A1_MINI" ${ov.printer_model === 'A1_MINI' ? 'selected' : ''}>A1 Mini</option>
                    <option value="A2L" ${ov.printer_model === 'A2L' ? 'selected' : ''}>A2L</option>
                    <option value="H2D" ${ov.printer_model === 'H2D' ? 'selected' : ''}>H2 Series</option>
                  </select>
                </div>
                <div class="form-group" style="margin:0;">
                  <label style="font-size:0.78rem;">Print Loops (One File)</label>
                  <input type="number" class="form-control" id="qs-n-loops" step="1" min="1" max="999" value="${ov.n_loops || 1}">
                </div>
                <div class="form-group" style="margin:0;">
                  <label style="font-size:0.78rem;">Cooldown Mode</label>
                  <select class="form-control" id="qs-cooldown-mode">
                    <option value="temperature" ${ov.cooldown_mode !== 'time' ? 'selected' : ''}>Wait for temperature</option>
                    <option value="time" ${ov.cooldown_mode === 'time' ? 'selected' : ''}>Wait fixed time</option>
                  </select>
                </div>
                <div class="form-group qs-cool-temp" style="margin:0;">
                  <label style="font-size:0.78rem;">Release Temp (°C)</label>
                  <input type="number" class="form-control" id="qs-release-temp" step="1" min="15" max="60" value="${ov.release_temp_c || 27}">
                  <small style="color:var(--text-muted);font-size:0.7rem;">M190 target = this − 3°C (Bambu early-exit)</small>
                </div>
                <div class="form-group qs-cool-temp" style="margin:0;">
                  <label style="font-size:0.78rem;">Max Wait (min)</label>
                  <input type="number" class="form-control" id="qs-max-wait" step="1" min="10" max="120" value="${ov.max_wait_min || 60}">
                  <small style="color:var(--text-muted);font-size:0.7rem;">Repeated M190 S cooldown timeout</small>
                </div>
                <div class="form-group qs-cool-time" style="margin:0;${ov.cooldown_mode === 'time' ? '' : 'display:none;'}">
                  <label style="font-size:0.78rem;">Cool Time (min)</label>
                  <input type="number" class="form-control" id="qs-cool-time" step="1" min="1" max="180" value="${ov.cool_time_min || 30}">
                  <small style="color:var(--text-muted);font-size:0.7rem;">Fixed G4 dwell — ignores temperature</small>
                </div>
                <div class="form-group" style="margin:0;">
                  <label style="font-size:0.78rem;">Sweep Z (mm)</label>
                  <input type="number" class="form-control" id="qs-sweep-z" step="0.5" min="1" max="20" value="${ov.sweep_z_mm || 4}">
                </div>
                <div class="form-group" style="margin:0;">
                  <label style="font-size:0.78rem;">Z Clear Travel (mm)</label>
                  <input type="number" class="form-control" id="qs-z-clear" step="1" min="10" max="300" value="${ov.z_clear_travel_mm || 200}">
                  <small style="color:var(--text-muted);font-size:0.7rem;">Safe height after sweep (clamped Zmax−5)</small>
                </div>
              </div>
            </details>
          </div>

          <button type="submit" class="btn btn-primary btn-lg" style="width:100%;font-size:1rem;margin-top:1rem;">Submit Now</button>
        </form>
      `);

      // Toggle transform section visibility
      $('#qs-skip-transform').onchange = function () {
        $('#qs-transform-section').style.display = this.checked ? 'none' : 'block';
      };

      // Auto-populate from profile
      function qsPopulateFromProfile() {
        const profileId = $('#qs-profile').value;
        const profile = profiles.find(p => p.profile_id === profileId);
        if (!profile) return;
        if (!ov.n_loops) $('#qs-n-loops').value = profile.n_loops ?? 1;
        if (!ov.release_temp_c) $('#qs-release-temp').value = profile.release_bed_temp_c ?? profile.cool_target_c ?? 27;
        if (!ov.max_wait_min) $('#qs-max-wait').value = profile.max_cool_wait_minutes ?? 60;
        if (!ov.cooldown_mode && profile.cooldown_mode) $('#qs-cooldown-mode').value = profile.cooldown_mode;
        if (!ov.cool_time_min) $('#qs-cool-time').value = profile.cool_time_minutes ?? 30;
        qsSyncCooldownMode();
      }
      function qsSyncCooldownMode() {
        const isTime = $('#qs-cooldown-mode').value === 'time';
        document.querySelectorAll('.qs-cool-temp').forEach(el => el.style.display = isTime ? 'none' : 'block');
        document.querySelectorAll('.qs-cool-time').forEach(el => el.style.display = isTime ? 'block' : 'none');
      }
      qsPopulateFromProfile();
      qsSyncCooldownMode();
      $('#qs-profile').onchange = qsPopulateFromProfile;
      $('#qs-cooldown-mode').onchange = qsSyncCooldownMode;

      $('#quick-submit-form').onsubmit = async (e) => {
        e.preventDefault();
        try {
          const submitOverrides = {};
          const skipTransform = $('#qs-skip-transform').checked;

          if (!skipTransform) {
            const model = $('#qs-printer-model').value;
            if (model) submitOverrides.printer_model = model;
            const nLoops = parseInt($('#qs-n-loops').value);
            if (!isNaN(nLoops) && nLoops >= 1) submitOverrides.n_loops = nLoops;
            const cooldownMode = $('#qs-cooldown-mode').value === 'time' ? 'time' : 'temperature';
            submitOverrides.cooldown_mode = cooldownMode;
            if (cooldownMode === 'time') {
              const coolTime = parseInt($('#qs-cool-time').value);
              if (!isNaN(coolTime)) submitOverrides.cool_time_min = coolTime;
            } else {
              const releaseTemp = parseInt($('#qs-release-temp').value);
              if (!isNaN(releaseTemp)) submitOverrides.release_temp_c = releaseTemp;
              const maxWait = parseInt($('#qs-max-wait').value);
              if (!isNaN(maxWait)) submitOverrides.max_wait_min = maxWait;
            }
            const sweepZ = parseFloat($('#qs-sweep-z').value);
            if (!isNaN(sweepZ)) submitOverrides.sweep_z_mm = sweepZ;
            const zClear = parseFloat($('#qs-z-clear').value);
            if (!isNaN(zClear)) submitOverrides.z_clear_travel_mm = zClear;
          } else {
            submitOverrides.skip_transform = true;
          }

          await api.submitFromTemplate(templateId, {
            name: $('#qs-name').value || tmpl.name,
            repeat_total: parseInt($('#qs-repeat').value) || tmpl.repeat_total,
            printer_id: $('#qs-printer').value || tmpl.printer_id || '',
            profile_id: $('#qs-profile')?.value || tmpl.profile_id || '',
            transform_overrides: submitOverrides,
          });
          hideModal();
          toast('Job submitted from template!', 'success');
          navigateTo('/jobs');
        } catch (err) { toast(err.message, 'error'); }
      };
    } else {
      // No stored file — show full upload form with all settings
      showModal(html`
        <div class="modal-header">
          <h2>Submit from Template: ${tmpl.name}</h2>
          <button class="btn btn-icon btn-sm" onclick="hideModal()">✕</button>
        </div>
        <form id="submit-from-template-form">
          <div class="form-group">
            <label>Job Name</label>
            <input type="text" class="form-control" id="sft-name" value="${tmpl.name}" required>
          </div>
          <div class="form-group" style="background:var(--bg-secondary);padding:0.75rem;border-radius:var(--radius-md);border:1px dashed var(--accent-primary);">
            <label style="font-weight:700;">📁 G-code / 3MF File</label>
            <input type="file" class="form-control" id="sft-file" accept=".gcode,.g,.gc,.3mf" required>
            <small style="color:var(--text-muted);">No file saved with this template — upload one</small>
          </div>
          <div class="form-group">
            <label>Assign to Printer</label>
            <select class="form-control" id="sft-printer">
              <option value="">Global Queue</option>
              ${printers.map(p => html`<option value="${p.printer_id}" ${p.printer_id === tmpl.printer_id ? 'selected' : ''}>${p.name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Queue Copies (Separate Jobs)</label>
            <input type="number" class="form-control" id="sft-repeat" value="${tmpl.repeat_total}" min="1" max="999">
          </div>

          <div style="border-top:1px solid var(--border-color);margin:1rem 0 0.75rem;padding-top:0.75rem;">
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-weight:600;">
              <input type="checkbox" id="sft-skip-transform" ${ov.skip_transform ? 'checked' : ''}> Upload as Raw (skip G-code transform)
            </label>
          </div>

          <div id="sft-transform-section" style="${ov.skip_transform ? 'display:none;' : ''}">
            <div class="form-group">
              <label>Transform Profile</label>
              <select class="form-control" id="sft-profile">
                <option value="">None</option>
                ${profiles.map(p => html`<option value="${p.profile_id}" ${p.profile_id === tmpl.profile_id ? 'selected' : ''}>${p.name} (${p.printer_model})</option>`).join('')}
              </select>
            </div>

            <details style="margin-top:0.5rem;">
              <summary style="cursor:pointer;font-weight:600;font-size:0.88rem;color:var(--accent-primary);user-select:none;">
                Automator Settings
              </summary>
              <div style="margin-top:0.75rem;display:grid;grid-template-columns:1fr 1fr;gap:0.65rem;">
                <div class="form-group" style="margin:0;">
                  <label style="font-size:0.78rem;">Printer Model</label>
                  <select class="form-control" id="sft-printer-model">
                    <option value="P1S" ${ov.printer_model === 'P1S' ? 'selected' : ''}>P1S</option>
                    <option value="P2S" ${ov.printer_model === 'P2S' ? 'selected' : ''}>P2S</option>
                    <option value="X1" ${ov.printer_model === 'X1' ? 'selected' : ''}>X1 / X1C</option>
                    <option value="X2D" ${ov.printer_model === 'X2D' ? 'selected' : ''}>X2D</option>
                    <option value="A1" ${ov.printer_model === 'A1' ? 'selected' : ''}>A1</option>
                    <option value="A1_MINI" ${ov.printer_model === 'A1_MINI' ? 'selected' : ''}>A1 Mini</option>
                    <option value="A2L" ${ov.printer_model === 'A2L' ? 'selected' : ''}>A2L</option>
                    <option value="H2D" ${ov.printer_model === 'H2D' ? 'selected' : ''}>H2 Series</option>
                  </select>
                </div>
                <div class="form-group" style="margin:0;">
                  <label style="font-size:0.78rem;">Print Loops (One File)</label>
                  <input type="number" class="form-control" id="sft-n-loops" step="1" min="1" max="999" value="${ov.n_loops || 1}">
                </div>
                <div class="form-group" style="margin:0;">
                  <label style="font-size:0.78rem;">Cooldown Mode</label>
                  <select class="form-control" id="sft-cooldown-mode">
                    <option value="temperature" ${ov.cooldown_mode !== 'time' ? 'selected' : ''}>Wait for temperature</option>
                    <option value="time" ${ov.cooldown_mode === 'time' ? 'selected' : ''}>Wait fixed time</option>
                  </select>
                </div>
                <div class="form-group sft-cool-temp" style="margin:0;">
                  <label style="font-size:0.78rem;">Release Temp (C)</label>
                  <input type="number" class="form-control" id="sft-release-temp" step="1" min="15" max="60" value="${ov.release_temp_c || 27}">
                </div>
                <div class="form-group sft-cool-temp" style="margin:0;">
                  <label style="font-size:0.78rem;">Max Wait (min)</label>
                  <input type="number" class="form-control" id="sft-max-wait" step="1" min="10" max="120" value="${ov.max_wait_min || 60}">
                </div>
                <div class="form-group sft-cool-time" style="margin:0;${ov.cooldown_mode === 'time' ? '' : 'display:none;'}">
                  <label style="font-size:0.78rem;">Cool Time (min)</label>
                  <input type="number" class="form-control" id="sft-cool-time" step="1" min="1" max="180" value="${ov.cool_time_min || 30}">
                </div>
                <div class="form-group" style="margin:0;">
                  <label style="font-size:0.78rem;">Sweep Z (mm)</label>
                  <input type="number" class="form-control" id="sft-sweep-z" step="0.5" min="1" max="20" value="${ov.sweep_z_mm || 4}">
                </div>
                <div class="form-group" style="margin:0;">
                  <label style="font-size:0.78rem;">Z Clear Travel (mm)</label>
                  <input type="number" class="form-control" id="sft-z-clear" step="1" min="10" max="300" value="${ov.z_clear_travel_mm || 200}">
                </div>
              </div>
            </details>
          </div>

          <button type="submit" class="btn btn-primary btn-lg" style="width:100%;font-size:1rem;margin-top:1rem;">Submit Now</button>
        </form>
      `);

      function sftSyncCooldownMode() {
        const isTime = $('#sft-cooldown-mode').value === 'time';
        document.querySelectorAll('.sft-cool-temp').forEach(el => el.style.display = isTime ? 'none' : 'block');
        document.querySelectorAll('.sft-cool-time').forEach(el => el.style.display = isTime ? 'block' : 'none');
      }

      function sftPopulateFromProfile() {
        const profileId = $('#sft-profile').value;
        const profile = profiles.find(p => p.profile_id === profileId);
        if (!profile) return;
        if (!ov.n_loops) $('#sft-n-loops').value = profile.n_loops ?? 1;
        if (!ov.release_temp_c) $('#sft-release-temp').value = profile.release_bed_temp_c ?? profile.cool_target_c ?? 27;
        if (!ov.max_wait_min) $('#sft-max-wait').value = profile.max_cool_wait_minutes ?? 60;
        if (!ov.cooldown_mode && profile.cooldown_mode) $('#sft-cooldown-mode').value = profile.cooldown_mode;
        if (!ov.cool_time_min) $('#sft-cool-time').value = profile.cool_time_minutes ?? 30;
        sftSyncCooldownMode();
      }

      sftPopulateFromProfile();
      sftSyncCooldownMode();
      $('#sft-profile').onchange = sftPopulateFromProfile;
      $('#sft-cooldown-mode').onchange = sftSyncCooldownMode;
      $('#sft-skip-transform').onchange = function () {
        $('#sft-transform-section').style.display = this.checked ? 'none' : 'block';
      };

      $('#submit-from-template-form').onsubmit = async (e) => {
        e.preventDefault();
        try {
          const file = $('#sft-file').files[0];
          if (!file) throw new Error('Select a G-code or 3MF file first');

          const formData = new FormData();
          formData.append('file', file);
          formData.append('name', $('#sft-name').value || tmpl.name || file.name);
          formData.append('printer_id', $('#sft-printer').value || tmpl.printer_id || '');
          formData.append('repeat_total', $('#sft-repeat').value || tmpl.repeat_total || '1');

          const skipTransform = $('#sft-skip-transform').checked;
          formData.append('skip_transform', skipTransform);

          if (!skipTransform) {
            formData.append('profile_id', $('#sft-profile').value || tmpl.profile_id || '');
            const submitOverrides = {};
            const model = $('#sft-printer-model').value;
            if (model) submitOverrides.printer_model = model;
            const nLoops = parseInt($('#sft-n-loops').value);
            if (!isNaN(nLoops) && nLoops >= 1) submitOverrides.n_loops = nLoops;
            const cooldownMode = $('#sft-cooldown-mode').value === 'time' ? 'time' : 'temperature';
            submitOverrides.cooldown_mode = cooldownMode;
            if (cooldownMode === 'time') {
              const coolTime = parseInt($('#sft-cool-time').value);
              if (!isNaN(coolTime)) submitOverrides.cool_time_min = coolTime;
            } else {
              const releaseTemp = parseInt($('#sft-release-temp').value);
              if (!isNaN(releaseTemp)) submitOverrides.release_temp_c = releaseTemp;
              const maxWait = parseInt($('#sft-max-wait').value);
              if (!isNaN(maxWait)) submitOverrides.max_wait_min = maxWait;
            }
            const sweepZ = parseFloat($('#sft-sweep-z').value);
            if (!isNaN(sweepZ)) submitOverrides.sweep_z_mm = sweepZ;
            const zClear = parseFloat($('#sft-z-clear').value);
            if (!isNaN(zClear)) submitOverrides.z_clear_travel_mm = zClear;
            formData.append('transform_overrides', JSON.stringify(submitOverrides));
          } else {
            formData.append('transform_overrides', JSON.stringify({ skip_transform: true }));
          }

          await api.submitJob(formData);
          hideModal();
          toast('Job submitted from template!', 'success');
          navigateTo('/jobs');
        } catch (err) { toast(err.message, 'error'); }
      };
    }
  } catch (err) {
    toast(err.message, 'error');
  }
};

// ===== APP STARTUP =====
document.addEventListener('DOMContentLoaded', () => {
  if (window.api?.isAuthenticated) {
    window.ws?.connect();
  }
  navigateTo(window.location.hash.slice(1) || '/');
});
