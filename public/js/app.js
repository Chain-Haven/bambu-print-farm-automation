// public/js/app.js — Antigravity SPA (Router + Pages + Components)

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
      3DFLOW
    </div>
    <nav>
      <a href="#/" data-route="/">Dashboard</a>
      <a href="#/printers" data-route="/printers">Printers</a>
      <a href="#/accessories" data-route="/accessories">Accessories</a>
      <a href="#/jobs" data-route="/jobs">Jobs</a>
      <a href="#/slicer" data-route="/slicer">Slicer</a>
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
  if (confirm('Log out of 3DFLOW?')) {
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
          <div style="font-size:1.8rem;font-weight:800;background:var(--accent-gradient);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">3DFLOW</div>
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
          <span class="status-dot ${(p.status_snapshot?.state === 'idle' || p.status_snapshot?.state === 'printing') ? 'online' : (p.status_snapshot?.state === 'offline' ? 'offline' : 'unknown')}"></span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-secondary);">
          <span>${p.ip_hostname}</span>
          ${statusBadge(p.status_snapshot?.state || 'unknown')}
        </div>
        ${p.status_snapshot?.progress !== undefined ? html`
          <div class="progress-bar" style="margin-top:0.75rem;">
            <div class="progress-bar-fill" style="width:${p.status_snapshot.progress}%"></div>
          </div>
          <div style="font-size:0.73rem;color:var(--text-muted);margin-top:0.3rem;">${p.status_snapshot.progress}% complete</div>
        ` : ''}
        <div style="font-size:0.73rem;color:var(--text-muted);margin-top:0.5rem;">Last seen: ${timeAgo(p.last_seen)}</div>
      </a>
    `).join('');
  }

  // Add printer wizard
  $('#add-printer-btn').onclick = () => showAddPrinterModal();
});

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
      <!-- Status Card -->
      <div class="card">
        <div class="card-header"><h3>Status</h3>${statusBadge(printer.status_snapshot?.print_error ? 'blocked' : (printer.status_snapshot?.state || 'unknown'))}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;font-size:0.85rem;">
          <div><span style="color:var(--text-muted);">Bed Temp:</span> ${printer.status_snapshot?.bed_temp ?? '—'}°C</div>
          <div><span style="color:var(--text-muted);">Nozzle:</span> ${printer.status_snapshot?.nozzle_temp ?? '—'}°C</div>
          <div><span style="color:var(--text-muted);">Progress:</span> ${printer.status_snapshot?.progress ?? '—'}%</div>
          <div><span style="color:var(--text-muted);">Layer:</span> ${printer.status_snapshot?.layer ?? '—'}/${printer.status_snapshot?.total_layers ?? '—'}</div>
        </div>
        ${printer.status_snapshot?.progress !== undefined ? html`
          <div class="progress-bar" style="margin-top:1rem;">
            <div class="progress-bar-fill" style="width:${printer.status_snapshot.progress}%"></div>
          </div>
        ` : ''}
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

          <!-- Quick Actions -->
          <div style="margin-bottom:1rem;">
            <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:0.5rem;">Quick Actions</div>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;margin-bottom:0.5rem;">
              <button class="btn btn-sm" onclick="pCtrl('${id}','pause')" title="Pause the current print">⏸ Pause</button>
              <button class="btn btn-sm" onclick="pCtrl('${id}','resume')" title="Resume the current print">▶ Resume</button>
              <button class="btn btn-sm btn-danger" onclick="if(confirm('Stop the current print? This cannot be undone.'))pCtrl('${id}','stop')" title="Stop the current print">⏹ Stop</button>
            </div>
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
                  <button class="btn btn-sm btn-primary" onclick="applyOverride('${id}','speed_profile',window._pendingSpeedProfile||2)" style="font-size:0.7rem;">▶ Apply</button>
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
                  <button class="btn btn-sm" onclick="window._zOff=0;updZOff()" style="font-size:0.7rem;">↺ Reset</button>
                  <button class="btn btn-sm btn-primary" onclick="applyOverride('${id}','z_offset',window._zOff)" style="font-size:0.7rem;">▶ Apply</button>
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
// Exposed on window so inline onclick handlers (which run in global scope) can read/reset it.
window._zOff = 0;
window.updZOff = function() {
  const v = document.getElementById('ctrl-zoff-val');
  const d = document.getElementById('ctrl-zoff-display');
  const txt = window._zOff.toFixed(2) + 'mm';
  if (v) v.textContent = txt;
  if (d) d.textContent = window._zOff >= 0 ? '+' + window._zOff.toFixed(2) : window._zOff.toFixed(2);
};
window.stageZ = function(delta) {
  window._zOff = Math.round((window._zOff + delta) * 100) / 100;
  window._zOff = Math.max(-1, Math.min(1, window._zOff));
  updZOff();
};

// Speed profile — stage only (no send until Apply)
// Exposed on window so inline onclick handlers can read it (see applyOverride call sites).
window._pendingSpeedProfile = 2;
window.stageSpeedProfile = function(level) {
  window._pendingSpeedProfile = level;
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

async function refreshAmsConfig(printerId) {
  const el = document.getElementById('ams-config-content');
  if (!el) return;

  try {
    _amsData = await api.getPrinterAms(printerId);
    renderAmsSlots(el, printerId);
  } catch (err) {
    el.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:1rem;">
      <p>Could not load AMS config</p>
      <p style="font-size:0.8rem;">${err.message}</p>
    </div>`;
  }
}
window.refreshAmsConfig = refreshAmsConfig;

function renderAmsSlots(el, printerId) {
  const slots = _amsData?.slots || [];
  const types = _amsData?.filament_types || [];
  const palette = _amsData?.color_palette || [];

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

    slotsHtml += `
      <div style="background:var(--bg-tertiary);border-radius:12px;padding:1rem;position:relative;border:2px solid ${hasMat ? 'var(--border-color)' : 'transparent'};">
        <div style="display:flex;align-items:center;gap:0.65rem;margin-bottom:0.75rem;">
          <div style="width:32px;height:32px;border-radius:50%;background:${hasMat ? cssColor : 'var(--bg-secondary)'};border:2px solid var(--border-color);flex-shrink:0;box-shadow:${hasMat ? '0 2px 8px rgba(0,0,0,0.3)' : 'none'};" id="ams-swatch-${i}"></div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:0.92rem;">Tray ${slot.tray_id + 1}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="ams-status-${i}">
              ${hasMat ? mat + (colorName ? ' · ' + colorName : '') : 'Empty — select a material'}
            </div>
          </div>
          ${isFromPrinter ? '<span style="font-size:0.6rem;background:rgba(100,200,255,0.12);color:var(--info,#64b5f6);padding:0.15rem 0.4rem;border-radius:3px;font-weight:600;position:absolute;top:0.5rem;right:0.5rem;">FROM PRINTER</span>' : ''}
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
          </div>
        </div>
      </div>
    `;
  }

  el.innerHTML = `
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

// ===== SLICER (in-browser model viewer/editor + pluggable slice backend) =====
route('/slicer', async (el) => {
  const meta = await api.getSliceBackends().catch(() => ({ backends: [], active: null, setting_fields: [] }));
  const fields = meta.setting_fields || [];

  // Sensible defaults for the print-settings form.
  const defaults = { layer_height: 0.2, infill_density: 15, infill_pattern: 'grid', wall_loops: 2, top_layers: 5, bottom_layers: 3, supports: false, support_type: 'normal(auto)', brim: false, nozzle_temp: 220 };
  const fieldHtml = (f) => {
    const v = defaults[f.key];
    if (f.type === 'bool')
      return html`<label style="display:flex;align-items:center;gap:0.4rem;font-size:0.78rem;"><input type="checkbox" class="sl-set" data-key="${f.key}" ${v ? 'checked' : ''}> ${f.label}</label>`;
    if (f.type === 'select')
      return html`<div><label style="font-size:0.72rem;color:var(--text-muted);">${f.label}</label><select class="form-control sl-set" data-key="${f.key}">${f.options.map(o => html`<option value="${o}" ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
    return html`<div><label style="font-size:0.72rem;color:var(--text-muted);">${f.label}</label><input type="number" class="form-control sl-set" data-key="${f.key}" value="${v}" min="${f.min}" max="${f.max}" step="${f.step}"></div>`;
  };

  el.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
      <h1 class="text-gradient-flow" style="font-size:1.4rem;font-weight:700;">Slicer</h1>
      <span id="sl-backend-status" class="badge badge-default">Checking backends…</span>
    </div>
    <div style="display:grid;grid-template-columns:340px 1fr;gap:1rem;align-items:stretch;">
      <div class="card" style="display:flex;flex-direction:column;gap:0.8rem;max-height:82vh;overflow-y:auto;">
        <div>
          <label style="font-size:0.78rem;color:var(--text-muted);">Printer Model</label>
          <select class="form-control" id="sl-model">
            <option value="P1S">P1S</option><option value="X1">X1</option>
            <option value="A1">A1</option><option value="A1_MINI">A1 Mini</option>
          </select>
        </div>
        <div id="sl-drop" style="border:1.5px dashed var(--border,#33415c);border-radius:8px;padding:1rem;text-align:center;cursor:pointer;font-size:0.85rem;color:var(--text-muted);">
          <div style="font-size:1.3rem;">⬆️</div>Drop an <b>STL</b> here or click
          <input type="file" id="sl-file" accept=".stl" style="display:none;">
        </div>
        <div id="sl-info" style="font-size:0.8rem;color:var(--text-muted);">No model loaded.</div>

        <details open style="border-top:1px solid var(--border,#33415c);padding-top:0.6rem;">
          <summary style="cursor:pointer;font-weight:600;font-size:0.85rem;color:var(--accent-primary);">Orientation</summary>
          <div style="margin-top:0.5rem;display:flex;flex-direction:column;gap:0.4rem;">
            <button class="btn btn-sm btn-outline" id="sl-placeface">📐 Place face on bed</button>
            <div style="display:flex;gap:0.3rem;">
              <button class="btn btn-sm" id="sl-rotx" style="flex:1;">Rot X</button>
              <button class="btn btn-sm" id="sl-roty" style="flex:1;">Rot Y</button>
              <button class="btn btn-sm" id="sl-rotz" style="flex:1;">Rot Z</button>
            </div>
            <button class="btn btn-sm btn-outline" id="sl-reset">↺ Reset orientation</button>
            <small id="sl-orient-hint" style="color:var(--text-muted);font-size:0.7rem;display:none;">Click a face in the viewer to lay it on the bed.</small>
          </div>
        </details>

        <details open style="border-top:1px solid var(--border,#33415c);padding-top:0.6rem;">
          <summary style="cursor:pointer;font-weight:600;font-size:0.85rem;color:var(--accent-primary);">Print Settings</summary>
          <div style="margin-top:0.5rem;display:flex;flex-direction:column;gap:0.45rem;">
            ${fields.map(fieldHtml).join('')}
          </div>
        </details>

        <button class="btn btn-primary" id="sl-slice" style="width:100%;" disabled>Slice</button>
        <div id="sl-result" style="font-size:0.78rem;color:var(--text-muted);white-space:pre-wrap;"></div>
      </div>
      <div class="card" style="padding:0;overflow:hidden;min-height:78vh;">
        <div id="sl-viewer" style="width:100%;height:78vh;"></div>
      </div>
    </div>
  `;

  const slicer = await import('./slicer.js');
  let lastName = null;

  const showModelInfo = (m) => {
    if (!m) { $('#sl-info').textContent = 'No model loaded.'; return; }
    const fit = m.fitsBed
      ? '<span style="color:var(--success,#34d399);">fits build volume ✓</span>'
      : '<span style="color:var(--danger,#f87171);">exceeds build volume ✗</span>';
    $('#sl-info').innerHTML =
      `<b>${lastName}</b><br>Size: ${m.dims.x} × ${m.dims.y} × ${m.dims.z} mm<br>` +
      `Triangles: ${m.triangles.toLocaleString()}<br>Bed: ${m.bed.x}×${m.bed.y}×${m.bed.z} — ${fit}`;
    $('#sl-slice').disabled = false;
  };

  const makeViewer = () => slicer.initSlicer($('#sl-viewer'), { model: $('#sl-model').value, onModelChange: showModelInfo });
  let viewer = makeViewer();

  const cleanup = () => { slicer.disposeSlicer(); window.removeEventListener('hashchange', onLeave); };
  const onLeave = () => { if ((location.hash.slice(1) || '/') !== '/slicer') cleanup(); };
  window.addEventListener('hashchange', onLeave);

  let lastModelBuffer = null;
  function loadBuffer(buf, name) {
    try { lastModelBuffer = buf; lastName = name; viewer.loadModel(buf, name); }
    catch (err) { $('#sl-info').innerHTML = `<span style="color:var(--danger,#f87171);">${err.message}</span>`; $('#sl-slice').disabled = true; }
  }

  const drop = $('#sl-drop'), fileInput = $('#sl-file');
  drop.onclick = () => fileInput.click();
  fileInput.onchange = async () => { const f = fileInput.files[0]; if (f) loadBuffer(await f.arrayBuffer(), f.name); };
  drop.ondragover = (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent-primary,#818cf8)'; };
  drop.ondragleave = () => { drop.style.borderColor = ''; };
  drop.ondrop = async (e) => { e.preventDefault(); drop.style.borderColor = ''; const f = e.dataTransfer.files[0]; if (f) loadBuffer(await f.arrayBuffer(), f.name); };

  $('#sl-model').onchange = () => { viewer = makeViewer(); if (lastModelBuffer) loadBuffer(lastModelBuffer, lastName); };

  // Orientation controls
  let placeFace = false;
  $('#sl-placeface').onclick = () => {
    placeFace = !placeFace;
    viewer.setPlaceFaceMode(placeFace);
    $('#sl-placeface').classList.toggle('btn-primary', placeFace);
    $('#sl-orient-hint').style.display = placeFace ? 'block' : 'none';
  };
  $('#sl-rotx').onclick = () => viewer.rotate90('x');
  $('#sl-roty').onclick = () => viewer.rotate90('y');
  $('#sl-rotz').onclick = () => viewer.rotate90('z');
  $('#sl-reset').onclick = () => viewer.resetOrientation();

  // Backend status badge
  const badge = $('#sl-backend-status');
  if (meta.active) { badge.textContent = `Backend: ${meta.active.label}`; badge.className = 'badge badge-success'; }
  else { badge.textContent = 'No slice backend configured'; badge.className = 'badge badge-warning'; badge.title = (meta.backends || []).map(b => `${b.label}: ${b.reason}`).join('\n'); }

  // Gather print-setting form values
  const collectSettings = () => {
    const s = {};
    document.querySelectorAll('.sl-set').forEach(elm => {
      s[elm.dataset.key] = elm.type === 'checkbox' ? elm.checked : elm.value;
    });
    return s;
  };

  // Slice — send the (re-oriented) geometry so the slice matches the view.
  $('#sl-slice').onclick = async () => {
    if (!viewer.hasModel) return;
    const btn = $('#sl-slice'); btn.disabled = true; btn.textContent = 'Slicing…';
    $('#sl-result').textContent = '';
    try {
      const stl = viewer.exportSTL();
      const fd = new FormData();
      fd.append('file', new Blob([stl]), (lastName || 'model').replace(/\.[^.]+$/, '') + '.stl');
      if ($('#sl-profile')?.value) fd.append('profile_id', $('#sl-profile').value);
      fd.append('options', JSON.stringify({ printer_model: $('#sl-model').value, settings: collectSettings() }));
      const res = await api.sliceModel(fd);
      const applied = res.report?.settings && Object.keys(res.report.settings).length
        ? `<br><span style="color:var(--text-muted);font-size:0.72rem;">${Object.entries(res.report.settings).map(([k, v]) => `${k}=${v}`).join(', ')}</span>` : '';
      $('#sl-result').innerHTML = `<span style="color:var(--success,#34d399);">Sliced ✓ ${res.output_name || ''} (${res.report?.plates || 1} plate)</span>${applied}`;
    } catch (err) {
      $('#sl-result').innerHTML = `<span style="color:var(--danger,#f87171);">⚠️ ${err.message}</span>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Slice';
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
                <option value="X1">X1</option>
                <option value="A1">A1</option>
                <option value="A1_MINI">A1 Mini</option>
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
                <option value="X1">X1</option>
                <option value="A1">A1</option>
                <option value="A1_MINI">A1 Mini</option>
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
                    <option value="X1" ${ov.printer_model === 'X1' ? 'selected' : ''}>X1</option>
                    <option value="A1" ${ov.printer_model === 'A1' ? 'selected' : ''}>A1</option>
                    <option value="A1_MINI" ${ov.printer_model === 'A1_MINI' ? 'selected' : ''}>A1 Mini</option>
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
                    <option value="X1" ${ov.printer_model === 'X1' ? 'selected' : ''}>X1</option>
                    <option value="A1" ${ov.printer_model === 'A1' ? 'selected' : ''}>A1</option>
                    <option value="A1_MINI" ${ov.printer_model === 'A1_MINI' ? 'selected' : ''}>A1 Mini</option>
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
