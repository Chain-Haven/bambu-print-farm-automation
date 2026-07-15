// fleet-view.js — the live Print Fleet board on the cloud console.
//
// Renders one card per mirrored printer: model-accurate chassis art, the four
// AMS filament slots (color / material / % remaining), the in-progress model
// preview rendered inside the printer window, progress + time remaining, and
// remote actions (camera, pause/resume, stop) that ride the durable node
// command channel. Also shows LAN-discovered printers so operators can adopt
// and name them with one click.

const FAMILY_LABELS = {
  a1: 'A1',
  a1mini: 'A1 Mini',
  a2: 'A2L',
  p1: 'P1',
  x1: 'X1',
  x2: 'X2',
  p2: 'P2',
  h2: 'H2',
  generic: 'Bambu',
};

export function detectPrinterFamily(model) {
  const value = String(model || '').toUpperCase();
  if (value.includes('A1') && value.includes('MINI')) return 'a1mini';
  if (value.includes('A2')) return 'a2';
  if (value.includes('A1')) return 'a1';
  if (value.includes('H2')) return 'h2';
  if (value.includes('X2')) return 'x2';
  if (value.includes('X1')) return 'x1';
  if (value.includes('P2')) return 'p2';
  if (value.includes('P1')) return 'p1';
  return 'generic';
}

// ---------------------------------------------------------------------------
// Printer chassis art. Each family gets a distinct, recognizable silhouette.
// The window area is left transparent — the live job preview <img> sits in a
// layer beneath the SVG, so the model appears "inside" the printer.
// ---------------------------------------------------------------------------

function corexySvg({ body, accent, trim, brandBand, dualNozzle = false, label }) {
  return `
  <svg viewBox="0 0 200 190" xmlns="http://www.w3.org/2000/svg" class="chassis" aria-hidden="true">
    <!-- body shell drawn as frame strips so the window stays transparent -->
    <rect x="14" y="14" width="172" height="168" rx="12" fill="none" stroke="${trim}" stroke-width="3"/>
    <path d="M14 26 q0 -12 12 -12 h148 q12 0 12 12 v30 H14 Z" fill="${body}"/>
    <rect x="14" y="150" width="172" height="20" fill="${body}"/>
    <path d="M14 170 h172 v0 q0 12 -12 12 h-148 q-12 0 -12 -12 Z" fill="${body}"/>
    <rect x="14" y="56" width="16" height="94" fill="${body}"/>
    <rect x="170" y="56" width="16" height="94" fill="${body}"/>
    <!-- brand band + status -->
    <rect x="14" y="42" width="172" height="14" fill="${brandBand}"/>
    <text x="26" y="53" font-family="Inter,system-ui,sans-serif" font-size="9" font-weight="700" fill="${accent}" letter-spacing="1">${label}</text>
    <circle class="status-led" cx="176" cy="49" r="3.5" fill="#9aa3a0"/>
    <!-- touchscreen -->
    <rect x="132" y="26" width="34" height="11" rx="2" fill="#0c1210" stroke="${accent}" stroke-width="0.8"/>
    <!-- nozzle carriage across the window top -->
    <rect x="30" y="58" width="140" height="4" fill="${trim}" opacity="0.7"/>
    <g class="nozzle-carriage">
      <rect x="88" y="56" width="24" height="12" rx="2" fill="${trim}"/>
      <path d="M96 68 l4 7 l4 -7 Z" fill="${accent}"/>
      ${dualNozzle ? '<path d="M104 68 l4 7 l4 -7 Z" fill="#8fb3ab"/>' : ''}
    </g>
    <!-- glass door tint + handle -->
    <rect x="30" y="62" width="140" height="88" fill="url(#glass-${label})" opacity="0.16"/>
    <rect x="96" y="98" width="8" height="22" rx="4" fill="${trim}" opacity="0.55"/>
    <!-- build plate -->
    <rect x="38" y="142" width="124" height="5" rx="2" fill="${trim}"/>
    <!-- feet -->
    <rect x="26" y="182" width="24" height="5" rx="2" fill="${trim}"/>
    <rect x="150" y="182" width="24" height="5" rx="2" fill="${trim}"/>
    <defs>
      <linearGradient id="glass-${label}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset="1" stop-color="#7fd4c0"/>
      </linearGradient>
    </defs>
  </svg>`;
}

function bedslingerSvg({ body, accent, trim, label, mini = false }) {
  const towerX = mini ? 90 : 88;
  const bedWidth = mini ? 96 : 120;
  const bedX = (200 - bedWidth) / 2;
  return `
  <svg viewBox="0 0 200 190" xmlns="http://www.w3.org/2000/svg" class="chassis" aria-hidden="true">
    <!-- base -->
    <rect x="${bedX - 14}" y="150" width="${bedWidth + 28}" height="26" rx="8" fill="${body}" stroke="${trim}" stroke-width="1.5"/>
    <rect x="${bedX - 6}" y="176" width="20" height="6" rx="2" fill="${trim}"/>
    <rect x="${bedX + bedWidth - 14}" y="176" width="20" height="6" rx="2" fill="${trim}"/>
    <!-- vertical tower + crossbar (bedslinger silhouette) -->
    <rect x="${towerX}" y="18" width="24" height="136" rx="6" fill="${body}" stroke="${trim}" stroke-width="1.5"/>
    <rect x="26" y="30" width="148" height="10" rx="4" fill="${body}" stroke="${trim}" stroke-width="1.2"/>
    <g class="nozzle-carriage">
      <rect x="86" y="26" width="28" height="20" rx="3" fill="${trim}"/>
      <path d="M96 46 l4 8 l4 -8 Z" fill="${accent}"/>
    </g>
    <!-- print bed -->
    <rect x="${bedX}" y="140" width="${bedWidth}" height="10" rx="2" fill="#3b4440"/>
    <rect x="${bedX}" y="138" width="${bedWidth}" height="4" rx="2" fill="${accent}" opacity="0.85"/>
    <!-- screen on the base -->
    <rect x="${bedX + bedWidth - 8}" y="154" width="26" height="14" rx="3" fill="#0c1210" stroke="${accent}" stroke-width="0.8" transform="rotate(8 ${bedX + bedWidth - 8} 154)"/>
    <circle class="status-led" cx="${towerX + 12}" cy="12" r="3.5" fill="#9aa3a0"/>
    <text x="${towerX + 12}" y="110" font-family="Inter,system-ui,sans-serif" font-size="9" font-weight="700" fill="${accent}" letter-spacing="1" transform="rotate(-90 ${towerX + 12} 110)">${label}</text>
  </svg>`;
}

const CHASSIS = {
  p1: () => corexySvg({ body: '#d9dde1', trim: '#7c858c', accent: '#146c5a', brandBand: '#c6ccd1', label: 'P1S' }),
  x1: () => corexySvg({ body: '#2c3136', trim: '#14181c', accent: '#4fd1ae', brandBand: '#22262b', label: 'X1C' }),
  x2: () => corexySvg({ body: '#31363c', trim: '#171b1f', accent: '#5bd6b4', brandBand: '#262b30', label: 'X2D', dualNozzle: true }),
  p2: () => corexySvg({ body: '#39423f', trim: '#1d2422', accent: '#7fd4c0', brandBand: '#2c3431', label: 'P2S' }),
  h2: () => corexySvg({ body: '#23282e', trim: '#101418', accent: '#66d9b8', brandBand: '#1a1f24', label: 'H2', dualNozzle: true }),
  a1: () => bedslingerSvg({ body: '#e4e7ea', trim: '#8d959b', accent: '#146c5a', label: 'A1' }),
  a1mini: () => bedslingerSvg({ body: '#e9ebee', trim: '#98a0a5', accent: '#1d8a72', label: 'A1 MINI', mini: true }),
  a2: () => bedslingerSvg({ body: '#dfe3e6', trim: '#868f95', accent: '#12735e', label: 'A2L' }),
  generic: () => corexySvg({ body: '#cfd4d8', trim: '#7c858c', accent: '#146c5a', brandBand: '#bfc6cb', label: 'BAMBU' }),
};

// ---------------------------------------------------------------------------

const STATUS_LED = {
  printing: '#2f9e6f',
  online: '#2f9e6f',
  paused: '#d9a13c',
  degraded: '#d9a13c',
  offline: '#b3261e',
  unknown: '#9aa3a0',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function swatchColor(hex) {
  const raw = String(hex || '').replace(/^#/, '');
  return /^[0-9A-Fa-f]{6}/.test(raw) ? `#${raw.slice(0, 6)}` : null;
}

function formatRemaining(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`;
  return `${mins}m`;
}

function firstFourSlots(printer) {
  const trays = Array.isArray(printer.capabilities?.ams_trays) ? printer.capabilities.ams_trays : [];
  const byKey = new Map(trays.map((tray) => [`${tray.ams_id || 0}_${tray.tray_id || 0}`, tray]));
  return [0, 1, 2, 3].map((slot) => byKey.get(`0_${slot}`) || null);
}

function amsSlotHtml(tray, index) {
  if (!tray || (!tray.material && !tray.color_hex)) {
    return `
      <div class="ams-slot empty" title="Slot ${index + 1}: empty">
        <div class="spool"><span class="spool-hole"></span></div>
        <span class="ams-material">—</span>
        <span class="ams-remaining">empty</span>
      </div>`;
  }
  const color = swatchColor(tray.color_hex) || '#e6e6e6';
  const remaining = Number(tray.live_remaining);
  const hasRemaining = Number.isFinite(remaining) && remaining >= 0;
  const fillPct = hasRemaining ? Math.max(6, Math.min(remaining, 100)) : 100;
  const material = escapeHtml(tray.material_base || tray.material || '?');
  const title = `Slot ${index + 1}: ${escapeHtml(tray.material || '?')}${tray.color_name ? ` · ${escapeHtml(tray.color_name)}` : ''}${hasRemaining ? ` · ${Math.round(remaining)}% left` : ''}`;

  return `
    <div class="ams-slot" title="${title}">
      <div class="spool">
        <div class="spool-fill" style="height:${fillPct}%;background:${color}"></div>
        <span class="spool-hole"></span>
      </div>
      <span class="ams-material">${material}</span>
      <span class="ams-remaining">${hasRemaining ? `${Math.round(remaining)}%` : '·'}</span>
    </div>`;
}

function currentJobOf(printer) {
  const job = printer.status_snapshot?.current_job;
  return job && typeof job === 'object' ? job : null;
}

export function createFleetView(deps) {
  const {
    $,
    getState,
    apiRequest,
    queueNodeCommand,
    showToast,
    refreshOverview,
    getRowLimit,
  } = deps;

  const local = {
    cameraTimer: null,
    cameraPrinter: null,
    cameraGeneration: 0,
    liveTimer: null,
    liveInFlight: false,
    lastDiscoverCommandId: null,
  };

  const els = () => ({
    grid: $('#fleet-grid'),
    discovered: $('#fleet-discovered'),
    discoveredList: $('#fleet-discovered-list'),
    subtitle: $('#fleet-subtitle'),
    live: $('#fleet-live'),
    scan: $('#fleet-scan'),
    cameraModal: $('#camera-modal'),
    cameraTitle: $('#camera-modal-title'),
    cameraImage: $('#camera-image'),
    cameraStatus: $('#camera-status'),
    cameraClose: $('#camera-close'),
    adoptModal: $('#adopt-modal'),
    adoptForm: $('#adopt-form'),
    adoptClose: $('#adopt-close'),
    adoptSummary: $('#adopt-summary'),
    adoptName: $('#adopt-name'),
    adoptModel: $('#adopt-model'),
    adoptIp: $('#adopt-ip'),
    adoptAccessCode: $('#adopt-access-code'),
    adoptSerial: $('#adopt-serial'),
    adoptNode: $('#adopt-node'),
    adoptStatus: $('#adopt-status'),
  });

  function nodeOf(printer) {
    return (getState().overview.nodes || []).find((node) => node.node_id === printer.node_id) || null;
  }

  function pickOnlineNode() {
    const nodes = getState().overview.nodes || [];
    return nodes.find((node) => node.status === 'online') || nodes[0] || null;
  }

  // ---- printer cards -------------------------------------------------------

  function cardHtml(printer) {
    const family = detectPrinterFamily(printer.model);
    const status = String(printer.status || 'unknown').toLowerCase();
    const job = currentJobOf(printer);
    const printing = status === 'printing' || (job && ['printing', 'running', 'prepare'].includes(job.state));
    const progress = job && Number.isFinite(Number(job.progress_percent)) ? Number(job.progress_percent) : null;
    const remaining = job ? formatRemaining(Number(job.remaining_minutes)) : null;
    const slots = firstFourSlots(printer);
    const preview = job?.preview || null;
    const led = STATUS_LED[status] || STATUS_LED.unknown;

    return `
    <article class="printer-card${printing ? ' is-printing' : ''}" data-printer-id="${escapeHtml(printer.printer_id)}">
      <header class="printer-card-head">
        <div>
          <h3>${escapeHtml(printer.name || printer.local_printer_id || 'Printer')}</h3>
          <span class="printer-model-chip">${escapeHtml(printer.model || FAMILY_LABELS[family])}</span>
        </div>
        <span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span>
      </header>

      <div class="ams-rack" aria-label="AMS filament slots">
        ${slots.map((tray, index) => amsSlotHtml(tray, index)).join('')}
      </div>

      <div class="printer-visual" data-family="${family}" style="--led:${led}">
        ${preview
          ? `<img class="job-preview" src="${preview}" alt="Model being printed">`
          : (printing
            ? '<div class="job-preview placeholder">▣</div>'
            : '')}
        ${CHASSIS[family] ? CHASSIS[family]() : CHASSIS.generic()}
      </div>

      <div class="print-progress">
        ${job ? `
          <div class="progress-track"><div class="progress-fill" style="width:${progress ?? 0}%"></div></div>
          <div class="progress-meta">
            <span>${progress !== null ? `${Math.round(progress)}%` : '…'}</span>
            <span class="time-remaining">${remaining ? `⏱ ${remaining} left` : (job.state === 'paused' || job.state === 'pause' ? 'paused' : 'estimating…')}</span>
          </div>
          <p class="job-name" title="${escapeHtml(job.name || '')}">${escapeHtml(job.name || 'Printing')}</p>
        ` : `
          <div class="progress-meta idle-meta">
            <span>${status === 'offline' ? 'Offline' : 'Idle — ready for jobs'}</span>
            <span>${escapeHtml(nodeOf(printer)?.name || '')}</span>
          </div>
        `}
      </div>

      <footer class="printer-actions">
        <button type="button" data-fleet-action="camera" title="Remote camera">📷 Camera</button>
        ${printing
          ? `<button type="button" data-fleet-action="${job?.state === 'paused' || job?.state === 'pause' ? 'resume' : 'pause'}">${job?.state === 'paused' || job?.state === 'pause' ? '▶ Resume' : '⏸ Pause'}</button>
             <button type="button" data-fleet-action="stop" class="danger">⏹ Stop</button>`
          : ''}
        <button type="button" data-fleet-action="detail" title="Raw detail">ⓘ</button>
      </footer>
    </article>`;
  }

  function render() {
    const { grid } = els();
    if (!grid) return;
    const printers = [...(getState().overview.printers || [])]
      .sort((a, b) => String(a.name || a.local_printer_id || '').localeCompare(String(b.name || b.local_printer_id || '')));

    if (printers.length === 0) {
      grid.innerHTML = '<p class="empty">No printers yet — bring a farm node online and its printers appear here automatically.</p>';
    } else {
      grid.innerHTML = printers.map(cardHtml).join('');
    }

    renderDiscovered();
    const { subtitle } = els();
    if (subtitle) {
      const printing = printers.filter((printer) => printer.status === 'printing').length;
      subtitle.textContent = printers.length === 0
        ? 'Live view of every connected Bambu printer'
        : `${printers.length} printer${printers.length === 1 ? '' : 's'} · ${printing} printing`;
    }
  }

  // ---- discovered printers (adoption) -------------------------------------

  function latestDiscovery() {
    const commands = getState().overview.commands || [];
    return commands
      .filter((command) => command.command_type === 'cloud.printers.discover' && command.status === 'succeeded')
      .sort((a, b) => String(b.finished_at || '').localeCompare(String(a.finished_at || '')))[0] || null;
  }

  // Discovered printers arrive two ways: automatically in every node heartbeat
  // (host_info.discovered_printers — no operator action needed) and, as a
  // fallback for older nodes, from manually queued cloud.printers.discover
  // command results. Merge both, deduped by serial/ip, each entry keeping the
  // node that saw it so adoption goes through the right host.
  function collectDiscovered() {
    const seen = new Map();
    const add = (printer, nodeId) => {
      if (!printer) return;
      const key = printer.serial || printer.ip;
      if (!key || seen.has(key)) return;
      seen.set(key, { ...printer, node_id: nodeId || null });
    };

    for (const node of (getState().overview.nodes || [])) {
      const found = node?.host_info?.discovered_printers;
      if (!Array.isArray(found)) continue;
      for (const printer of found) add(printer, node.node_id);
    }

    const command = latestDiscovery();
    if (command && Array.isArray(command.result?.printers)) {
      for (const printer of command.result.printers) add(printer, command.node_id);
    }

    return Array.from(seen.values());
  }

  function renderDiscovered() {
    const { discovered, discoveredList } = els();
    if (!discovered || !discoveredList) return;
    const found = collectDiscovered();
    const knownIps = new Set((getState().overview.printers || [])
      .map((printer) => printer.capabilities?.ip_hostname || printer.status_snapshot?.ip_hostname)
      .filter(Boolean));
    const adoptable = found.filter((printer) => printer.already_added !== true && !knownIps.has(printer.ip));

    if (adoptable.length === 0) {
      discovered.hidden = true;
      return;
    }

    discovered.hidden = false;
    discoveredList.innerHTML = adoptable.map((printer, index) => `
      <button type="button" class="discovered-chip" data-discovered-index="${index}">
        <span class="discovered-pulse"></span>
        <strong>${escapeHtml(printer.name || printer.model || 'Bambu printer')}</strong>
        <span>${escapeHtml(printer.model || '?')} · ${escapeHtml(printer.ip || '?')}</span>
        <em>Click to adopt</em>
      </button>
    `).join('');
    discoveredList._adoptable = adoptable;
  }

  function openAdoptModal(found, nodeId) {
    const e = els();
    e.adoptSummary.textContent = `${found.model || 'Bambu printer'} at ${found.ip || 'unknown IP'}${found.serial ? ` · serial ${found.serial}` : ''}`;
    e.adoptName.value = found.name || `${found.model || 'Printer'} ${found.ip ? found.ip.split('.').pop() : ''}`.trim();
    const modelOption = Array.from(e.adoptModel.options).find((option) => (
      option.value.toUpperCase() === String(found.model || '').toUpperCase()
    ));
    e.adoptModel.value = modelOption ? modelOption.value : (detectPrinterFamily(found.model) === 'a1' ? 'A1' : 'P1S');
    e.adoptIp.value = found.ip || '';
    e.adoptSerial.value = found.serial || '';
    e.adoptNode.value = nodeId || pickOnlineNode()?.node_id || '';
    e.adoptStatus.hidden = true;
    e.adoptModal.hidden = false;
    e.adoptName.focus();
  }

  async function pollCommandResult(commandId, { attempts = 30, intervalMs = 1000 } = {}) {
    if (!commandId) return null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      // Direct lookup — never misses the result on busy farms the way the
      // capped overview command list could.
      const payload = await apiRequest(`/api/cloud/commands?command_id=${encodeURIComponent(commandId)}`);
      const command = payload.command;
      if (command && ['succeeded', 'failed'].includes(command.status)) {
        return command;
      }
    }
    return null;
  }

  async function handleAdoptSubmit(event) {
    event.preventDefault();
    const e = els();
    const nodeId = e.adoptNode.value || pickOnlineNode()?.node_id;
    if (!nodeId) {
      showToast('No online farm node to adopt through');
      return;
    }

    e.adoptStatus.hidden = false;
    e.adoptStatus.textContent = 'Sending adopt command to the farm node…';
    const response = await queueNodeCommand({
      nodeId,
      commandType: 'cloud.printers.adopt',
      payload: {
        name: e.adoptName.value.trim(),
        model: e.adoptModel.value,
        ip_hostname: e.adoptIp.value.trim(),
        access_code: e.adoptAccessCode.value.trim() || null,
        serial: e.adoptSerial.value.trim() || null,
      },
    });
    const commandId = response.command?.command_id;
    e.adoptStatus.textContent = 'Waiting for the node to register the printer…';

    const command = await pollCommandResult(commandId);
    if (command?.status === 'succeeded') {
      e.adoptStatus.textContent = 'Adopted! The printer joins the fleet on the next heartbeat.';
      showToast(`${e.adoptName.value.trim()} adopted into the farm`);
      window.setTimeout(() => { e.adoptModal.hidden = true; }, 1200);
      await refreshOverview();
    } else {
      e.adoptStatus.textContent = `Adoption failed: ${command?.error || 'node did not respond in time'}`;
    }
  }

  async function handleScan() {
    const node = pickOnlineNode();
    if (!node) {
      showToast('Bring a farm node online first');
      return;
    }
    const { scan } = els();
    if (scan) { scan.disabled = true; scan.textContent = '⌖ Scanning…'; }
    try {
      const response = await queueNodeCommand({
        nodeId: node.node_id,
        commandType: 'cloud.printers.discover',
        payload: { wait_ms: 3000 },
      });
      showToast('Network scan running on the farm node…');
      await pollCommandResult(response.command?.command_id, { attempts: 20, intervalMs: 1200 });
      await refreshOverview();
      const found = latestDiscovery()?.result?.printers?.length || 0;
      showToast(found > 0 ? `Scan complete — ${found} printer(s) responded` : 'Scan complete — no new printers responded');
    } finally {
      if (scan) { scan.disabled = false; scan.textContent = '⌖ Scan network'; }
    }
  }

  // ---- remote camera -------------------------------------------------------

  function closeCamera() {
    const e = els();
    local.cameraGeneration += 1;
    local.cameraPrinter = null;
    if (local.cameraTimer) window.clearTimeout(local.cameraTimer);
    local.cameraTimer = null;
    e.cameraModal.hidden = true;
    e.cameraImage.hidden = true;
    e.cameraImage.removeAttribute('src');
  }

  // Translate raw node/proxy errors into something an operator can act on.
  function describeCameraError(message) {
    const text = String(message || '');
    const lower = text.toLowerCase();
    if (lower.includes('access code')) {
      return `${text} — add the printer's LAN access code (printer screen → Settings → WLAN).`;
    }
    if (lower.includes('econnrefused') || lower.includes('unreachable') || lower.includes('timed out') || lower.includes('etimedout')) {
      return `${text} — check the printer is on the node's network with LAN Mode + Developer Mode enabled.`;
    }
    if (lower.includes('ffmpeg')) {
      return `${text} — this model streams RTSPS and needs ffmpeg on the farm node (npm i @ffmpeg-installer/ffmpeg).`;
    }
    if (lower.includes('not yet available')) {
      return 'Camera stream is starting up — retrying…';
    }
    return text || 'node did not answer in time';
  }

  async function cameraLoop(printer, generation) {
    const e = els();
    if (generation !== local.cameraGeneration) return;
    try {
      const response = await queueNodeCommand({
        nodeId: printer.node_id,
        printerId: printer.printer_id,
        commandType: 'printer.camera.snapshot',
        payload: { local_printer_id: printer.local_printer_id },
      });
      // Node poll interval (~2s) + stream startup (~3s) means the first frame
      // can take a while; give it a generous window before declaring failure.
      const command = await pollCommandResult(response.command?.command_id, { attempts: 25, intervalMs: 1000 });
      if (generation !== local.cameraGeneration) return;

      if (command?.status === 'succeeded' && command.result?.image_base64) {
        e.cameraImage.src = `data:${command.result.content_type || 'image/jpeg'};base64,${command.result.image_base64}`;
        e.cameraImage.hidden = false;
        e.cameraStatus.textContent = command.result.mock
          ? `Simulated frame · ${new Date().toLocaleTimeString()}`
          : `Live · ${new Date().toLocaleTimeString()}`;
      } else {
        e.cameraStatus.textContent = `Camera unavailable: ${describeCameraError(command?.error)}`;
      }
    } catch (error) {
      if (generation === local.cameraGeneration) {
        e.cameraStatus.textContent = `Camera error: ${describeCameraError(error.message)}`;
      }
    }

    if (generation === local.cameraGeneration) {
      local.cameraTimer = window.setTimeout(() => cameraLoop(printer, generation), 3500);
    }
  }

  function openCamera(printer) {
    const e = els();
    if (!printer.node_id) {
      showToast('This printer has no online farm node — camera unavailable');
      return;
    }
    local.cameraGeneration += 1;
    const generation = local.cameraGeneration;
    local.cameraPrinter = printer;
    e.cameraTitle.textContent = `Camera — ${printer.name || printer.local_printer_id}`;
    e.cameraStatus.textContent = 'Requesting frame from the farm node…';
    e.cameraImage.hidden = true;
    e.cameraModal.hidden = false;
    cameraLoop(printer, generation);
  }

  // ---- card actions --------------------------------------------------------

  async function handleCardAction(printer, action) {
    if (action === 'camera') { openCamera(printer); return; }
    if (action === 'detail') { deps.showDetail(`Printer ${printer.name || printer.local_printer_id}`, printer); return; }

    const commandType = { pause: 'printer.pause', resume: 'printer.resume', stop: 'printer.stop' }[action];
    if (!commandType) return;
    if (action === 'stop' && !window.confirm(`Stop the current print on ${printer.name || printer.local_printer_id}?`)) return;

    await queueNodeCommand({
      nodeId: printer.node_id,
      printerId: printer.printer_id,
      commandType,
      payload: { local_printer_id: printer.local_printer_id },
    });
    showToast(`${action[0].toUpperCase()}${action.slice(1)} sent to ${printer.name || printer.local_printer_id}`);
  }

  // ---- live updates --------------------------------------------------------

  function startLiveUpdates() {
    if (local.liveTimer) return;
    local.liveTimer = window.setInterval(async () => {
      const { live } = els();
      if (!live?.checked || document.visibilityState !== 'visible') return;
      if (local.liveInFlight) return;
      const consoleVisible = !document.querySelector('#console-view')?.hidden;
      if (!consoleVisible) return;
      local.liveInFlight = true;
      try {
        await refreshOverview();
      } catch { /* transient — next tick retries */ } finally {
        local.liveInFlight = false;
      }
    }, 8000);
  }

  // ---- wiring --------------------------------------------------------------

  function bind() {
    const e = els();

    e.grid?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-fleet-action]');
      if (!button) return;
      const card = button.closest('.printer-card');
      const printer = (getState().overview.printers || [])
        .find((item) => item.printer_id === card?.dataset.printerId);
      if (!printer) return;
      handleCardAction(printer, button.dataset.fleetAction).catch((error) => showToast(error.message));
    });

    e.discoveredList?.addEventListener('click', (event) => {
      const chip = event.target.closest('button[data-discovered-index]');
      if (!chip) return;
      const adoptable = e.discoveredList._adoptable || [];
      const found = adoptable[Number.parseInt(chip.dataset.discoveredIndex, 10)];
      if (found) openAdoptModal(found, found.node_id);
    });

    e.scan?.addEventListener('click', () => handleScan().catch((error) => showToast(error.message)));
    e.adoptForm?.addEventListener('submit', (event) => handleAdoptSubmit(event).catch((error) => {
      const status = els().adoptStatus;
      if (status) { status.hidden = false; status.textContent = `Adoption failed: ${error.message}`; }
    }));
    e.adoptClose?.addEventListener('click', () => { e.adoptModal.hidden = true; });
    e.cameraClose?.addEventListener('click', closeCamera);
    e.cameraModal?.addEventListener('click', (event) => {
      if (event.target === e.cameraModal) closeCamera();
    });
    e.adoptModal?.addEventListener('click', (event) => {
      if (event.target === e.adoptModal) e.adoptModal.hidden = true;
    });

    startLiveUpdates();
  }

  return { render, bind };
}
