import { createFleetView } from './fleet-view.js';

const storageKeys = {
  token: 'pkxCloudAdminToken',
  orgId: 'pkxCloudOrgId',
};

const state = {
  overview: {
    nodes: [],
    printers: [],
    jobs: [],
    commands: [],
    events: [],
  },
  setup: null,
  merchantSettings: { full_auto_merchant_mode: { enabled: false } },
  farmAutomation: {
    settings: {
      policy: {},
      inventory: { spools: [] },
      integrations: { alerts: [], ecommerce: [], vision: [], shipping: [], remote_access: [] },
    },
    plan: {
      summary: {},
      feature_map: {},
      printers: [],
      job_recommendations: [],
      ejection_queue: [],
      alerts: [],
    },
  },
  merchants: [],
  merchantApiKeys: [],
  merchantJobs: [],
  merchantUsage: [],
  merchantV2: {
    orders: [],
    files: [],
    slices: [],
    batches: [],
    reservations: [],
    shipments: [],
    invoices: [],
    webhook_deliveries: [],
    adapter_events: [],
  },
  provisionedNode: null,
  admin: null,
  adminUsers: [],
};

let farmAutomationRequestSequence = 0;

function markFarmAutomationMutation() {
  farmAutomationRequestSequence += 1;
  return farmAutomationRequestSequence;
}

function bindFarmAutomationEditorGuards() {
  [
    elements.smartQueueEnabled,
    elements.autoEjectEnabled,
    elements.failureDetectionEnabled,
    elements.releaseTemperatureC,
    elements.maxEjectAttempts,
    elements.bedClearVerification,
  ].forEach((element) => {
    element.addEventListener('change', markFarmAutomationMutation);
    element.addEventListener('input', markFarmAutomationMutation);
  });
  elements.filamentInventoryJson.addEventListener('input', markFarmAutomationMutation);
  elements.integrationsJson.addEventListener('input', markFarmAutomationMutation);
}

const commandTemplates = {
  status: {
    commandType: 'printer.status',
    payload: { local_printer_id: 'printer-1' },
  },
  pause: {
    commandType: 'printer.pause',
    payload: { local_printer_id: 'printer-1' },
  },
  resume: {
    commandType: 'printer.resume',
    payload: { local_printer_id: 'printer-1' },
  },
  stop: {
    commandType: 'printer.stop',
    payload: { local_printer_id: 'printer-1' },
  },
  printReady: {
    commandType: 'cloud.print.ready',
    payload: {
      local_printer_id: 'printer-1',
      artifact: {
        signed_url: 'https://example.com/private-print-file.gcode.3mf',
        original_name: 'part.gcode.3mf',
        content_type: 'application/octet-stream',
      },
    },
  },
  discoverPrinters: {
    commandType: 'cloud.printers.discover',
    payload: {
      scan_cidrs: [],
      wait_ms: 1500,
    },
  },
  syncPrinters: {
    commandType: 'cloud.printers.sync',
    payload: {
      scan_cidrs: [],
      include_saved_printers: true,
      sync_ams: true,
      sync_filament: true,
    },
  },
};

// Mirrors src/services/FilamentCatalog.js on the local node — the node
// validates materials against its catalog, so keep this list in sync.
const AMS_MATERIALS = [
  'PLA', 'PLA High Speed', 'PLA Silk', 'PLA-CF',
  'PETG', 'PETG HF', 'PETG-CF', 'PCTG',
  'ABS', 'ASA', 'TPU', 'TPU for AMS',
  'PA (Nylon)', 'PA-CF', 'PC', 'PVA', 'HIPS', 'BVOH',
  'EVA', 'PHA', 'PE', 'PE-CF', 'PP', 'PP-CF', 'PP-GF',
  'PPA-CF', 'PPA-GF', 'PPS', 'PPS-CF',
];

const AMS_COLORS = [
  { name: 'White', hex: 'FFFFFFFF' },
  { name: 'Black', hex: '000000FF' },
  { name: 'Red', hex: 'FF0000FF' },
  { name: 'Blue', hex: '0000FFFF' },
  { name: 'Green', hex: '00FF00FF' },
  { name: 'Yellow', hex: 'FFFF00FF' },
  { name: 'Orange', hex: 'FF8C00FF' },
  { name: 'Purple', hex: '800080FF' },
  { name: 'Pink', hex: 'FF69B4FF' },
  { name: 'Gray', hex: '808080FF' },
  { name: 'Light Gray', hex: 'C0C0C0FF' },
  { name: 'Dark Gray', hex: '404040FF' },
  { name: 'Brown', hex: '8B4513FF' },
  { name: 'Cyan', hex: '00FFFFFF' },
  { name: 'Lime', hex: '32CD32FF' },
  { name: 'Navy', hex: '000080FF' },
  { name: 'Teal', hex: '008080FF' },
  { name: 'Gold', hex: 'FFD700FF' },
  { name: 'Transparent', hex: 'FFFFFF01' },
  { name: 'Natural', hex: 'F5F5DCFF' },
];

const $ = (selector) => document.querySelector(selector);

const elements = {
  apiState: $('#api-state'),
  adminAuthState: $('#admin-auth-state'),
  adminToken: $('#admin-token'),
  adminLoginForm: $('#admin-login-form'),
  adminLoginEmail: $('#admin-login-email'),
  adminLoginPassword: $('#admin-login-password'),
  adminMe: $('#admin-me'),
  adminResetRequestForm: $('#admin-reset-request-form'),
  adminResetEmail: $('#admin-reset-email'),
  adminResetOutput: $('#admin-reset-output'),
  orgId: $('#org-id'),
  rowLimit: $('#row-limit'),
  saveToken: $('#save-token'),
  refresh: $('#refresh'),
  setupStatus: $('#setup-status'),
  setupStatusBody: $('#setup-status-body'),
  metrics: $('#metrics'),
  merchantSettingsForm: $('#merchant-settings-form'),
  farmAutomationForm: $('#farm-automation-form'),
  smartQueueEnabled: $('#smart-queue-enabled'),
  autoEjectEnabled: $('#auto-eject-enabled'),
  failureDetectionEnabled: $('#failure-detection-enabled'),
  releaseTemperatureC: $('#release-temperature-c'),
  maxEjectAttempts: $('#max-eject-attempts'),
  bedClearVerification: $('#bed-clear-verification'),
  filamentInventoryForm: $('#filament-inventory-form'),
  filamentInventoryJson: $('#filament-inventory-json'),
  amsPrinter: $('#ams-printer'),
  amsSlots: $('#ams-slots'),
  integrationsForm: $('#integrations-form'),
  integrationsJson: $('#integrations-json'),
  filamentReorderForm: $('#filament-reorder-form'),
  reorderEnabled: $('#reorder-enabled'),
  reorderMode: $('#reorder-mode'),
  reorderRegion: $('#reorder-region'),
  reorderTrialMode: $('#reorder-trial-mode'),
  reorderMonthlyBudget: $('#reorder-monthly-budget'),
  reorderMaxOrder: $('#reorder-max-order'),
  reorderUserEmail: $('#reorder-user-email'),
  reorderClientId: $('#reorder-client-id'),
  reorderClientSecret: $('#reorder-client-secret'),
  reorderRefreshToken: $('#reorder-refresh-token'),
  reorderRulesJson: $('#reorder-rules-json'),
  reorderTestConnection: $('#reorder-test-connection'),
  reorderEvaluate: $('#reorder-evaluate'),
  reorderOutput: $('#reorder-output'),
  filamentOrdersCount: $('#filament-orders-count'),
  fullAutoMode: $('#full-auto-mode'),
  merchantModeState: $('#merchant-mode-state'),
  refreshMerchantSettings: $('#refresh-merchant-settings'),
  nodeQuickstartForm: $('#node-quickstart-form'),
  quickstartOrgName: $('#quickstart-org-name'),
  quickstartNodeName: $('#quickstart-node-name'),
  quickstartMaxJobs: $('#quickstart-max-jobs'),
  quickstartScanCidrs: $('#quickstart-scan-cidrs'),
  quickstartAutoDownload: $('#quickstart-auto-download'),
  quickstartOutput: $('#quickstart-output'),
  organizationForm: $('#organization-form'),
  organizationName: $('#organization-name'),
  organizationOutput: $('#organization-output'),
  nodeForm: $('#node-form'),
  nodeOrgId: $('#node-org-id'),
  nodeName: $('#node-name'),
  nodeCapabilities: $('#node-capabilities'),
  nodeTokenOutput: $('#node-token-output'),
  downloadButtons: $('#download-buttons'),
  downloadNodePortable: $('#download-node-portable'),
  downloadNodeExe: $('#download-node-exe'),
  printerSyncForm: $('#printer-sync-form'),
  syncNode: $('#sync-node'),
  syncScanCidrs: $('#sync-scan-cidrs'),
  syncIncludeSaved: $('#sync-include-saved'),
  syncAms: $('#sync-ams'),
  syncFilament: $('#sync-filament'),
  syncOutput: $('#sync-output'),
  commandForm: $('#command-form'),
  commandNode: $('#command-node'),
  commandType: $('#command-type'),
  commandPrinter: $('#command-printer'),
  commandJob: $('#command-job'),
  commandPayload: $('#command-payload'),
  merchantListForm: $('#merchant-list-form'),
  merchantStatusFilter: $('#merchant-status-filter'),
  merchantId: $('#merchant-id'),
  merchantActionForm: $('#merchant-action-form'),
  merchantActionId: $('#merchant-action-id'),
  merchantAction: $('#merchant-action'),
  merchantIssueSetupToken: $('#merchant-issue-setup-token'),
  merchantActionMetadata: $('#merchant-action-metadata'),
  issueSetupToken: $('#issue-setup-token'),
  merchantActionOutput: $('#merchant-action-output'),
  merchantKeyForm: $('#merchant-key-form'),
  merchantKeyMerchantId: $('#merchant-key-merchant-id'),
  merchantKeyName: $('#merchant-key-name'),
  merchantKeyId: $('#merchant-key-id'),
  listMerchantKeys: $('#list-merchant-keys'),
  revokeMerchantKey: $('#revoke-merchant-key'),
  merchantKeyOutput: $('#merchant-key-output'),
  merchantLookupForm: $('#merchant-lookup-form'),
  merchantLookupId: $('#merchant-lookup-id'),
  selectedDetail: $('#selected-detail'),
  detailTitle: $('#detail-title'),
  detailBody: $('#detail-body'),
  closeDetail: $('#close-detail'),
  toast: $('#toast'),
  // Login gate
  loginView: $('#login-view'),
  consoleView: $('#console-view'),
  logoutBtn: $('#logout-btn'),
  adminEmailDisplay: $('#admin-email-display'),
  loginError: $('#login-error'),
  toggleFirstSetup: $('#toggle-first-setup'),
  toggleReset: $('#toggle-reset'),
  firstSetupCard: $('#first-setup-card'),
  resetCard: $('#reset-card'),
  firstSetupForm: $('#first-setup-form'),
  setupBootstrapToken: $('#setup-bootstrap-token'),
  setupEmail: $('#setup-email'),
  setupNewPassword: $('#setup-new-password'),
  firstSetupOutput: $('#first-setup-output'),
  // Admin account management (super admin only)
  adminUsersSection: $('#admin-users-section'),
  adminUserCreateForm: $('#admin-user-create-form'),
  adminUserEmail: $('#admin-user-email'),
  adminUserRole: $('#admin-user-role'),
  adminUsersOutput: $('#admin-users-output'),
  // Tabbed console
  consoleTabs: $('#console-tabs'),
  setupBanner: $('#setup-banner'),
  setupBannerLink: $('#setup-banner-link'),
  // Drop-in printing
  dropZone: $('#drop-zone'),
  dropFileInput: $('#drop-file-input'),
  dropStatus: $('#drop-status'),
};

// ===== Tabbed console =====
const TAB_NAMES = ['fleet', 'merchants', 'nodes', 'automation'];

function activeTab() {
  const fromHash = (window.location.hash.match(/tab=([a-z]+)/) || [])[1];
  return TAB_NAMES.includes(fromHash) ? fromHash : 'fleet';
}

function showTab(name) {
  const tab = TAB_NAMES.includes(name) ? name : 'fleet';
  document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== tab;
  });
  document.querySelectorAll('#console-tabs .tab-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  const nextHash = `#tab=${tab}`;
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, '', nextHash);
  }
}

function bindTabs() {
  if (!elements.consoleTabs) return;
  elements.consoleTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) showTab(button.dataset.tab);
  });
  if (elements.setupBannerLink) {
    elements.setupBannerLink.addEventListener('click', () => {
      showTab('nodes');
      elements.setupStatus?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  showTab(activeTab());
}

function setApiState(label, mode = '') {
  elements.apiState.textContent = label;
  elements.apiState.className = `state-pill ${mode}`.trim();
}

function setAdminAuthState(label, mode = '') {
  if (!elements.adminAuthState) return;
  elements.adminAuthState.textContent = label;
  elements.adminAuthState.className = mode;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 4500);
}

function getAdminToken() {
  return elements.adminToken.value.trim();
}

function getOrgId() {
  return elements.orgId.value.trim();
}

function getRowLimit() {
  const parsed = Number.parseInt(elements.rowLimit.value, 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(parsed, 100));
}

function parseJsonField(value, fallback = {}) {
  const text = value.trim();
  if (!text) return fallback;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON must be an object');
  }
  return parsed;
}

function parseCidrs(value) {
  return String(value || '')
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildQuickstartCapabilities() {
  return {
    max_concurrent_jobs: Math.max(1, Number.parseInt(elements.quickstartMaxJobs.value, 10) || 4),
    local_controller: true,
    command_polling: true,
    printer_lan_control: true,
    cloud_printer_sync: true,
    scan_cidrs: parseCidrs(elements.quickstartScanCidrs.value),
  };
}

function buildPrinterSyncPayload() {
  return {
    scan_cidrs: parseCidrs(elements.syncScanCidrs.value),
    include_saved_printers: elements.syncIncludeSaved.checked,
    sync_ams: elements.syncAms.checked,
    sync_filament: elements.syncFilament.checked,
  };
}

async function apiRequest(path, { method = 'GET', body = null } = {}) {
  const token = getAdminToken();
  if (!token) throw new Error('Admin token is required');

  const response = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || payload.error || `Request failed with ${response.status}`);
  }

  return payload;
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || payload.error || `Request failed with ${response.status}`);
  }

  return payload;
}

async function apiDownload(path, { body, fileName }) {
  const token = getAdminToken();
  if (!token) throw new Error('Admin token is required');

  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `Download failed with ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : {};
      message = payload.message || payload.error || message;
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  triggerBlobDownload(blob, fileName);
}

function triggerBlobDownload(blob, fileName) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function shortId(value) {
  if (!value) return '-';
  return String(value).slice(0, 8);
}

function jsonSummary(value, length = 110) {
  if (!value || typeof value !== 'object') return '-';
  const text = JSON.stringify(value);
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatMoney(value, currency = 'USD') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '-';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || ''}`.trim();
  }
}

function makeStatus(value) {
  const span = document.createElement('span');
  span.className = `status ${String(value || 'unknown').toLowerCase()}`;
  span.textContent = value || 'unknown';
  return span;
}

function makeButton(label, onClick, className = 'ghost-button') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function showDetail(title, value) {
  elements.detailTitle.textContent = title;
  elements.detailBody.textContent = JSON.stringify(value, null, 2);
  elements.selectedDetail.hidden = false;
}

function makeDetailButton(label, title, value) {
  return makeButton(label, () => showDetail(title, value), 'ghost-button small-button');
}

function merchantV2Detail(row, idKey, label) {
  return makeDetailButton('Open', `${label} ${shortId(row[idKey])}`, row);
}

function makeSetupItem(label, ok, detail) {
  const item = document.createElement('div');
  item.className = `setup-item ${ok ? 'ok' : 'missing'}`;

  const title = document.createElement('strong');
  title.textContent = label;

  const stateLabel = document.createElement('span');
  stateLabel.textContent = ok ? 'Ready' : 'Missing';

  item.append(title, stateLabel);
  if (detail) {
    const note = document.createElement('small');
    note.textContent = detail;
    item.append(note);
  }
  return item;
}

function renderSetupStatus(setup) {
  state.setup = setup;
  if (elements.setupBanner) {
    elements.setupBanner.hidden = !setup || setup.ready === true;
  }
  if (!setup) {
    elements.setupStatus.hidden = true;
    return;
  }

  elements.setupStatus.hidden = false;
  const heading = elements.setupStatus.querySelector('.panel-heading span');
  heading.textContent = setup.ready ? 'Ready' : 'Action needed';
  heading.className = setup.ready ? 'ready-label' : 'missing-label';

  const envGrid = document.createElement('div');
  envGrid.className = 'setup-grid';
  setup.env.forEach((item) => {
    envGrid.append(makeSetupItem(item.key, item.present, item.secret ? 'server secret' : 'server config'));
  });

  const backend = document.createElement('div');
  backend.className = 'setup-backend';
  const backendTitle = document.createElement('strong');
  backendTitle.textContent = 'Supabase backend';
  const backendMessage = document.createElement('span');
  backendMessage.textContent = setup.backend.checked
    ? (setup.backend.ready ? 'Schema ready' : 'Schema needs attention')
    : setup.backend.message;
  backend.append(backendTitle, backendMessage);

  if (Array.isArray(setup.backend.checks) && setup.backend.checks.length > 0) {
    const checks = document.createElement('div');
    checks.className = 'setup-checks';
    setup.backend.checks.forEach((check) => {
      checks.append(makeSetupItem(check.name, check.ok, check.error || 'verified'));
    });
    backend.append(checks);
  }

  elements.setupStatusBody.replaceChildren(envGrid, backend);
}

async function refreshSetupStatus() {
  const payload = await apiRequest('/api/cloud/setup');
  renderSetupStatus(payload.setup);
  return payload.setup;
}

function renderMetrics() {
  const overview = state.overview;
  const pendingCommands = overview.commands.filter((command) => ['queued', 'claimed', 'running'].includes(command.status)).length;
  const onlineNodes = overview.nodes.filter((node) => node.status === 'online').length;
  const onlinePrinters = overview.printers.filter((printer) => printer.status === 'online').length;
  const usageQuantity = state.merchantUsage.reduce((sum, event) => sum + (Number(event.quantity) || 0), 0);
  const automationAlerts = state.farmAutomation.plan?.alerts?.length || 0;
  const metrics = [
    ['Nodes Online', `${onlineNodes}/${overview.nodes.length}`],
    ['Printers Online', `${onlinePrinters}/${overview.printers.length}`],
    ['Print Jobs', overview.jobs.length],
    ['Pending Commands', pendingCommands],
    ['Merchants', state.merchants.length],
    ['Usage Units', formatNumber(usageQuantity)],
    ['Auto Alerts', automationAlerts],
  ];

  elements.metrics.replaceChildren(...metrics.map(([label, count]) => {
    const item = document.createElement('div');
    item.className = 'metric';

    const name = document.createElement('span');
    name.textContent = label;

    const value = document.createElement('strong');
    value.textContent = String(count);

    item.append(name, value);
    return item;
  }));
}

function renderTable(target, columns, rows, emptyText) {
  const container = $(target);
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    container.replaceChildren(empty);
    return;
  }

  const shell = document.createElement('div');
  shell.className = 'table-shell';

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  columns.forEach((column) => {
    const th = document.createElement('th');
    th.textContent = column.label;
    headRow.append(th);
  });
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((column) => {
      const td = document.createElement('td');
      const value = column.value(row);
      if (value instanceof Node) {
        td.append(value);
      } else {
        td.textContent = value;
      }
      tr.append(td);
    });
    tbody.append(tr);
  });

  table.append(thead, tbody);
  shell.append(table);
  container.replaceChildren(shell);
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = String(value);
}

function updateCounts() {
  const overview = state.overview;
  setText('#node-count', overview.nodes.length);
  setText('#printer-count', overview.printers.length);
  setText('#job-count', overview.jobs.length);
  setText('#command-count', overview.commands.length);
  setText('#event-count', overview.events.length);
  setText('#merchant-count', state.merchants.length);
  setText('#merchant-key-count', state.merchantApiKeys.length);
  setText('#merchant-job-count', state.merchantJobs.length);
  setText('#merchant-usage-count', state.merchantUsage.length);
  setText('#merchant-v2-order-count', state.merchantV2.orders.length);
  setText('#merchant-v2-file-count', state.merchantV2.files.length);
  setText('#merchant-v2-slice-count', state.merchantV2.slices.length);
  setText('#merchant-v2-batch-count', state.merchantV2.batches.length);
  setText('#merchant-v2-reservation-count', state.merchantV2.reservations.length);
  setText('#merchant-v2-shipment-count', state.merchantV2.shipments.length);
  setText('#merchant-v2-invoice-count', state.merchantV2.invoices.length);
  setText('#merchant-v2-webhook-count', state.merchantV2.webhook_deliveries.length);
  setText('#merchant-v2-adapter-count', state.merchantV2.adapter_events.length);
  setText('#automation-plan-count', state.farmAutomation.plan?.job_recommendations?.length || 0);
  setText('#automation-alert-count', state.farmAutomation.plan?.alerts?.length || 0);
}

function renderNodeOptions(select, nodes) {
  if (!select) return;
  const current = select.value;
  if (!nodes.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No nodes';
    select.replaceChildren(option);
    return;
  }

  const options = nodes.map((node) => {
    const option = document.createElement('option');
    option.value = node.node_id;
    option.textContent = `${node.name || 'Node'} (${shortId(node.node_id)})`;
    option.dataset.orgId = node.org_id;
    return option;
  });
  select.replaceChildren(...options);
  if (nodes.some((node) => node.node_id === current)) {
    select.value = current;
  }
}

function renderCommandNodeOptions(nodes) {
  renderNodeOptions(elements.commandNode, nodes);
  renderNodeOptions(elements.syncNode, nodes);
}

function selectMerchant(merchant) {
  const merchantId = merchant?.merchant_id || '';
  elements.merchantId.value = merchantId;
  elements.merchantActionId.value = merchantId;
  elements.merchantKeyMerchantId.value = merchantId;
  elements.merchantLookupId.value = merchantId;
  if (merchant?.org_id) {
    elements.orgId.value = merchant.org_id;
    elements.nodeOrgId.value = merchant.org_id;
    window.localStorage.setItem(storageKeys.orgId, merchant.org_id);
  }
  if (merchantId) {
    refreshMerchantOperationalData(merchantId).catch((error) => showToast(error.message));
  }
}

function renderMerchants() {
  renderTable('#merchants-table', [
    { label: 'Company', value: (row) => row.company_name || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Mode', value: (row) => row.approval_mode || '-' },
    { label: 'Email', value: (row) => row.contact_email || '-' },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    {
      label: 'Actions',
      value: (row) => {
        const wrap = document.createElement('div');
        wrap.className = 'row-actions';
        wrap.append(
          makeButton('Select', () => selectMerchant(row), 'ghost-button small-button'),
          makeDetailButton('Detail', `Merchant ${shortId(row.merchant_id)}`, row),
        );
        return wrap;
      },
    },
  ], state.merchants, 'No merchants found.');
}

function renderMerchantOperationalTables() {
  renderTable('#merchant-api-keys-table', [
    { label: 'Name', value: (row) => row.name || '-' },
    { label: 'Prefix', value: (row) => row.key_prefix || '-' },
    { label: 'Last Used', value: (row) => formatDate(row.last_used_at) },
    { label: 'Revoked', value: (row) => formatDate(row.revoked_at) },
    { label: 'Key ID', value: (row) => shortId(row.key_id) },
    {
      label: 'Actions',
      value: (row) => {
        const wrap = document.createElement('div');
        wrap.className = 'row-actions';
        wrap.append(
          makeButton('Use ID', () => {
            elements.merchantKeyId.value = row.key_id;
          }, 'ghost-button small-button'),
          makeDetailButton('Detail', `API Key ${shortId(row.key_id)}`, row),
        );
        return wrap;
      },
    },
  ], state.merchantApiKeys, 'No API keys loaded.');

  renderTable('#merchant-jobs-table', [
    { label: 'Job', value: (row) => row.name || shortId(row.job_id) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Node', value: (row) => shortId(row.node_id) },
    { label: 'Printer', value: (row) => shortId(row.printer_id) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Routing', value: (row) => jsonSummary(row.routing_summary) },
    { label: 'Detail', value: (row) => makeDetailButton('Open', `Merchant Job ${shortId(row.job_id)}`, row) },
  ], state.merchantJobs, 'No merchant jobs loaded.');

  renderTable('#merchant-usage-table', [
    { label: 'Event', value: (row) => row.event_type || shortId(row.usage_event_id) },
    { label: 'Quantity', value: (row) => formatNumber(row.quantity) },
    { label: 'Job', value: (row) => shortId(row.job_id) },
    { label: 'File', value: (row) => shortId(row.file_id) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Metrics', value: (row) => jsonSummary(row.metrics) },
    { label: 'Detail', value: (row) => makeDetailButton('Open', `Usage ${shortId(row.usage_event_id)}`, row) },
  ], state.merchantUsage, 'No usage loaded.');

  renderTable('#merchant-v2-orders-table', [
    { label: 'Order', value: (row) => shortId(row.order_id) },
    { label: 'External', value: (row) => row.external_order_id || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Due', value: (row) => formatDate(row.due_at) },
    { label: 'Total', value: (row) => formatMoney(row.totals?.total ?? row.totals?.amount, row.totals?.currency || 'USD') },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Detail', value: (row) => merchantV2Detail(row, 'order_id', 'Order') },
  ], state.merchantV2.orders, 'No Merchant API v2 orders loaded.');

  renderTable('#merchant-v2-files-table', [
    { label: 'File', value: (row) => shortId(row.file_id) },
    { label: 'Name', value: (row) => row.original_name || '-' },
    { label: 'Mode', value: (row) => makeStatus(row.file_mode) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Bytes', value: (row) => formatNumber(row.byte_size) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Detail', value: (row) => merchantV2Detail(row, 'file_id', 'File') },
  ], state.merchantV2.files, 'No Merchant API v2 files loaded.');

  renderTable('#merchant-v2-slices-table', [
    { label: 'Slice', value: (row) => shortId(row.slice_job_id) },
    { label: 'File', value: (row) => shortId(row.file_id) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Profile', value: (row) => jsonSummary(row.profile, 72) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Completed', value: (row) => formatDate(row.completed_at) },
    { label: 'Detail', value: (row) => merchantV2Detail(row, 'slice_job_id', 'Slice') },
  ], state.merchantV2.slices, 'No Merchant API v2 slices loaded.');

  renderTable('#merchant-v2-batches-table', [
    { label: 'Batch', value: (row) => row.name || shortId(row.batch_id) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Strategy', value: (row) => row.strategy || '-' },
    { label: 'Started', value: (row) => formatDate(row.started_at) },
    { label: 'Completed', value: (row) => formatDate(row.completed_at) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Detail', value: (row) => merchantV2Detail(row, 'batch_id', 'Batch') },
  ], state.merchantV2.batches, 'No Merchant API v2 batches loaded.');

  renderTable('#merchant-v2-reservations-table', [
    { label: 'Reservation', value: (row) => shortId(row.reservation_id) },
    { label: 'Material', value: (row) => row.material || '-' },
    { label: 'Color', value: (row) => row.color || '-' },
    { label: 'Grams', value: (row) => formatNumber(row.grams) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Expires', value: (row) => formatDate(row.expires_at) },
    { label: 'Detail', value: (row) => merchantV2Detail(row, 'reservation_id', 'Reservation') },
  ], state.merchantV2.reservations, 'No material reservations loaded.');

  renderTable('#merchant-v2-shipments-table', [
    { label: 'Shipment', value: (row) => shortId(row.shipment_id) },
    { label: 'Order', value: (row) => shortId(row.order_id) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Carrier', value: (row) => row.carrier || '-' },
    { label: 'Tracking', value: (row) => row.tracking_number || '-' },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Detail', value: (row) => merchantV2Detail(row, 'shipment_id', 'Shipment') },
  ], state.merchantV2.shipments, 'No shipments loaded.');

  renderTable('#merchant-v2-invoices-table', [
    { label: 'Invoice', value: (row) => shortId(row.invoice_id) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Period Start', value: (row) => formatDate(row.period_start) },
    { label: 'Period End', value: (row) => formatDate(row.period_end) },
    { label: 'Total', value: (row) => formatMoney(row.total, row.currency || 'USD') },
    { label: 'Issued', value: (row) => formatDate(row.issued_at) },
    { label: 'Detail', value: (row) => merchantV2Detail(row, 'invoice_id', 'Invoice') },
  ], state.merchantV2.invoices, 'No invoices loaded.');

  renderTable('#merchant-v2-webhooks-table', [
    { label: 'Delivery', value: (row) => shortId(row.delivery_id) },
    { label: 'Event', value: (row) => row.event_type || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Attempts', value: (row) => formatNumber(row.attempt_count) },
    { label: 'Response', value: (row) => row.response_status || '-' },
    { label: 'Next Retry', value: (row) => formatDate(row.next_retry_at) },
    { label: 'Detail', value: (row) => merchantV2Detail(row, 'delivery_id', 'Webhook Delivery') },
  ], state.merchantV2.webhook_deliveries, 'No webhook deliveries loaded.');

  renderTable('#merchant-v2-adapters-table', [
    { label: 'Adapter', value: (row) => row.adapter_name || '-' },
    { label: 'Event', value: (row) => row.event_type || '-' },
    { label: 'Resource', value: (row) => [row.resource_type, shortId(row.resource_id)].filter(Boolean).join(' ') || '-' },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Payload', value: (row) => jsonSummary(row.payload, 86) },
    { label: 'Metadata', value: (row) => jsonSummary(row.metadata, 86) },
    { label: 'Detail', value: (row) => merchantV2Detail(row, 'adapter_event_id', 'Adapter Event') },
  ], state.merchantV2.adapter_events, 'No adapter events loaded.');
}

function flattenPlatformStrategyRows(strategy = {}) {
  return (strategy.printer_adapters || []).map((row) => ({
    type: 'printer',
    target: row.name || row.local_printer_id || shortId(row.printer_id),
    model: row.model || row.model_family || '-',
    status: row.recommended_mode || 'unknown',
    detail: `${row.fallback_mode || '-'} fallback`,
    risk: row.risk_level || 'unknown',
    raw: row,
  }));
}

function renderPlatformStrategy(strategy = {}) {
  const adapterRows = flattenPlatformStrategyRows(strategy);

  renderTable('#platform-strategy-table', [
    { label: 'Target', value: (row) => row.target },
    { label: 'Model', value: (row) => row.model },
    { label: 'Mode', value: (row) => makeStatus(row.status) },
    { label: 'Fallback', value: (row) => row.detail },
    { label: 'Risk', value: (row) => makeStatus(row.risk) },
    { label: 'Open', value: (row) => makeDetailButton('Open', `Adapter ${row.target}`, row.raw) },
  ], adapterRows, 'No printer adapter recommendations yet.');

  renderTable('#readiness-gates-table', [
    { label: 'Gate', value: (row) => row.label || row.gate || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Next Action', value: (row) => row.next_action || '-' },
    { label: 'Open', value: (row) => makeDetailButton('Open', `Gate ${row.gate || ''}`.trim(), row) },
  ], strategy.readiness || [], 'No readiness gates reported.');

  renderTable('#roadmap-phases-table', [
    { label: 'Phase', value: (row) => row.label || row.phase || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Scope', value: (row) => row.scope || '-' },
    { label: 'Open', value: (row) => makeDetailButton('Open', `Phase ${row.phase || ''}`.trim(), row) },
  ], strategy.roadmap_phases || [], 'No roadmap phases reported.');
}

function renderFarmAutomation(automation) {
  if (automation) state.farmAutomation = automation;
  const settings = state.farmAutomation.settings || {};
  const policy = settings.policy || {};
  const inventory = settings.inventory || { spools: [] };
  const integrations = settings.integrations || { alerts: [], ecommerce: [], vision: [], shipping: [], remote_access: [] };
  const plan = state.farmAutomation.plan || { job_recommendations: [], ejection_queue: [], alerts: [], printers: [], feature_map: {}, summary: {} };

  elements.smartQueueEnabled.checked = policy.smart_queue_enabled !== false;
  elements.autoEjectEnabled.checked = policy.auto_eject_enabled !== false;
  elements.failureDetectionEnabled.checked = policy.failure_detection_enabled !== false;
  elements.releaseTemperatureC.value = policy.release_temperature_c || 27;
  elements.maxEjectAttempts.value = policy.max_eject_attempts || 3;
  elements.bedClearVerification.value = policy.bed_clear_verification || 'camera_or_operator';
  elements.filamentInventoryJson.value = JSON.stringify(inventory, null, 2);
  elements.integrationsJson.value = JSON.stringify(integrations, null, 2);

  const planRows = [
    ...Object.entries(plan.feature_map || {}).map(([key, enabled]) => ({
      type: 'feature',
      item: key.replace(/_/g, ' '),
      status: enabled ? 'enabled' : 'off',
      detail: enabled ? 'ready' : 'disabled',
    })),
    ...(plan.job_recommendations || []).map((row) => ({
      type: 'job',
      item: row.job_name || shortId(row.job_id),
      status: row.status,
      detail: row.selected_printer_id ? `printer ${shortId(row.selected_printer_id)}` : 'waiting',
      raw: row,
    })),
    ...(plan.ejection_queue || []).map((row) => ({
      type: 'eject',
      item: shortId(row.printer_id),
      status: row.action,
      detail: row.reason || row.verification || `${row.release_temperature_c || '-'} C`,
      raw: row,
    })),
  ];

  renderTable('#farm-automation-plan', [
    { label: 'Type', value: (row) => row.type },
    { label: 'Item', value: (row) => row.item },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Detail', value: (row) => row.detail || '-' },
    { label: 'Open', value: (row) => makeDetailButton('Open', `Automation ${row.type}`, row.raw || row) },
  ], planRows, 'No automation recommendations yet.');

  renderTable('#automation-alerts-table', [
    { label: 'Severity', value: (row) => makeStatus(row.severity) },
    { label: 'Type', value: (row) => row.type || '-' },
    { label: 'Message', value: (row) => row.message || '-' },
    { label: 'Target', value: (row) => row.spool_id || row.printer_id || row.job_id || '-' },
    { label: 'Open', value: (row) => makeDetailButton('Open', `Alert ${row.type || ''}`.trim(), row) },
  ], plan.alerts || [], 'No automation alerts.');

  renderPlatformStrategy(plan.platform_strategy || {});
}

// ===== AMS Filament Mapping (per-slot color + material) =====

function getAmsSelectedPrinter() {
  const printerId = elements.amsPrinter?.value;
  return (state.overview.printers || []).find((printer) => printer.printer_id === printerId) || null;
}

function amsSlotOptions(selected, values, labelOf = (v) => v, valueOf = (v) => v) {
  return values.map((value) => {
    const optionValue = valueOf(value);
    const isSelected = optionValue === selected ? ' selected' : '';
    return `<option value="${optionValue}"${isSelected}>${labelOf(value)}</option>`;
  }).join('');
}

function amsSwatchColor(hex) {
  const raw = String(hex || '').replace(/^#/, '');
  return /^[0-9A-Fa-f]{6}/.test(raw) ? `#${raw.slice(0, 6)}` : 'transparent';
}

function renderAmsPanel() {
  if (!elements.amsPrinter || !elements.amsSlots) return;

  const printers = state.overview.printers || [];
  const previousSelection = elements.amsPrinter.value;
  elements.amsPrinter.innerHTML = printers.length === 0
    ? '<option value="">No printers synced yet</option>'
    : amsSlotOptions(
      previousSelection,
      printers,
      (printer) => `${printer.name || printer.local_printer_id} (${printer.status || 'unknown'})`,
      (printer) => printer.printer_id,
    );

  const printer = getAmsSelectedPrinter() || printers[0] || null;
  if (printer && elements.amsPrinter.value !== printer.printer_id) {
    elements.amsPrinter.value = printer.printer_id;
  }

  if (!printer) {
    elements.amsSlots.innerHTML = '<p class="field-hint">Provision a node and let it heartbeat to see printers here.</p>';
    return;
  }

  // Known trays from the node's last heartbeat; always offer at least 4 slots.
  const knownTrays = Array.isArray(printer.capabilities?.ams_trays) ? printer.capabilities.ams_trays : [];
  const trayByKey = new Map(knownTrays.map((tray) => [`${tray.ams_id || 0}_${tray.tray_id || 0}`, tray]));
  const slotCount = Math.max(4, knownTrays.length);

  const rows = [];
  for (let index = 0; index < slotCount; index += 1) {
    const amsId = Math.floor(index / 4);
    const trayId = index % 4;
    const tray = trayByKey.get(`${amsId}_${trayId}`) || {};
    const material = tray.material || '';
    const colorHex = String(tray.color_hex || '').toUpperCase();
    const colorMatch = AMS_COLORS.find((color) => color.hex === colorHex || color.hex.slice(0, 6) === colorHex.replace(/^#/, '').slice(0, 6));

    rows.push(`
      <div class="ams-slot-row" data-ams-id="${amsId}" data-tray-id="${trayId}">
        <span class="ams-slot-label">U${amsId} T${trayId}</span>
        <span class="ams-slot-swatch" style="background:${amsSwatchColor(colorHex)}"></span>
        <select data-role="material">
          <option value="">— material —</option>
          ${amsSlotOptions(material, AMS_MATERIALS)}
        </select>
        <select data-role="color">
          ${amsSlotOptions(colorMatch?.hex || 'FFFFFFFF', AMS_COLORS, (color) => color.name, (color) => color.hex)}
        </select>
        <button type="button" class="small-button" data-role="apply">Apply</button>
      </div>
      <span class="ams-slot-source">${tray.material ? `${tray.source === 'configured' ? 'operator-assigned' : 'from printer'}${tray.in_sync === false ? ' · out of sync' : ''}` : 'empty / unreported'}</span>
    `);
  }
  elements.amsSlots.innerHTML = rows.join('');
}

async function handleAmsApply(event) {
  const button = event.target.closest('button[data-role="apply"]');
  if (!button) return;
  const row = button.closest('.ams-slot-row');
  const printer = getAmsSelectedPrinter();
  if (!row || !printer) return;

  const material = row.querySelector('select[data-role="material"]').value;
  if (!material) {
    showToast('Pick a material for the slot first');
    return;
  }
  const colorHex = row.querySelector('select[data-role="color"]').value;
  const colorName = AMS_COLORS.find((color) => color.hex === colorHex)?.name || null;

  button.disabled = true;
  try {
    await apiRequest('/api/cloud/commands', {
      method: 'POST',
      body: {
        org_id: printer.org_id || getOrgId(),
        node_id: printer.node_id,
        printer_id: printer.printer_id,
        command_type: 'printer.ams.set',
        payload: {
          local_printer_id: printer.local_printer_id,
          ams_id: Number.parseInt(row.dataset.amsId, 10) || 0,
          tray_id: Number.parseInt(row.dataset.trayId, 10) || 0,
          material,
          color_hex: colorHex,
          color_name: colorName,
        },
      },
    });
    showToast(`Queued ${material} for ${printer.name || printer.local_printer_id} slot U${row.dataset.amsId}·T${row.dataset.trayId}`);
  } catch (error) {
    showToast(`AMS assignment failed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function renderOverview() {
  const overview = state.overview;
  updateCounts();
  renderMetrics();
  renderCommandNodeOptions(overview.nodes);
  renderAmsPanel();
  fleetView.render();

  renderTable('#nodes-table', [
    { label: 'Node', value: (row) => row.name || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Version', value: (row) => row.agent_version || '-' },
    { label: 'Host', value: (row) => row.host_info?.hostname || '-' },
    { label: 'Slicer', value: (row) => (row.capabilities?.can_slice === true ? 'yes' : '-') },
    { label: 'Last seen', value: (row) => formatDate(row.last_seen_at) },
    { label: 'Detail', value: (row) => makeDetailButton('Open', `Node ${shortId(row.node_id)}`, row) },
    {
      label: 'Actions',
      value: (row) => makeButton('Delete', () => {
        handleDeleteNode(row).catch((error) => showToast(error.message));
      }, 'ghost-button small-button danger-button'),
    },
  ], overview.nodes, 'No nodes found.');

  renderTable('#printers-table', [
    { label: 'Printer', value: (row) => row.name || row.local_printer_id || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Model', value: (row) => row.model || '-' },
    { label: 'Node', value: (row) => shortId(row.node_id) },
    { label: 'Local ID', value: (row) => row.local_printer_id || '-' },
    { label: 'Last seen', value: (row) => formatDate(row.last_seen_at) },
    { label: 'Snapshot', value: (row) => jsonSummary(row.status_snapshot) },
    { label: 'Detail', value: (row) => makeDetailButton('Open', `Printer ${shortId(row.printer_id)}`, row) },
  ], overview.printers, 'No printers found.');

  renderTable('#jobs-table', [
    { label: 'Job', value: (row) => row.name || shortId(row.job_id) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Node', value: (row) => shortId(row.node_id) },
    { label: 'Printer', value: (row) => shortId(row.printer_id) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Options', value: (row) => jsonSummary(row.options) },
    { label: 'Detail', value: (row) => makeDetailButton('Open', `Job ${shortId(row.job_id)}`, row) },
  ], overview.jobs, 'No jobs found.');

  renderTable('#commands-table', [
    { label: 'Command', value: (row) => row.command_type || shortId(row.command_id) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Node', value: (row) => shortId(row.node_id) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Finished', value: (row) => formatDate(row.finished_at) },
    { label: 'Error', value: (row) => row.error || '-' },
    { label: 'Detail', value: (row) => makeDetailButton('Open', `Command ${shortId(row.command_id)}`, row) },
  ], overview.commands, 'No commands found.');

  renderTable('#events-table', [
    { label: 'Event', value: (row) => row.event_type || shortId(row.event_id) },
    { label: 'Node', value: (row) => shortId(row.node_id) },
    { label: 'Printer', value: (row) => shortId(row.printer_id) },
    { label: 'Command', value: (row) => shortId(row.command_id) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Payload', value: (row) => jsonSummary(row.payload) },
    { label: 'Detail', value: (row) => makeDetailButton('Open', `Event ${shortId(row.event_id)}`, row) },
  ], overview.events, 'No events found.');

  renderMerchants();
  renderMerchantOperationalTables();
  renderFarmAutomation();
  updateCounts();
  renderMetrics();
}

async function handleDeleteNode(node) {
  const label = node.name || shortId(node.node_id);
  if (!window.confirm(`Delete node "${label}"? Its token stops working immediately and its mirrored printers leave the fleet.`)) {
    return;
  }

  async function requestDelete(force) {
    const params = new URLSearchParams({ node_id: node.node_id });
    if (force) params.set('force', 'true');
    const response = await fetch(`/api/cloud/nodes?${params.toString()}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getAdminToken()}` },
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    return { status: response.status, payload };
  }

  let result = await requestDelete(false);
  if (result.status === 409 && result.payload.error === 'node_has_active_work') {
    const detail = `${result.payload.active_jobs || 0} active job(s), ${result.payload.pending_commands || 0} pending command(s)`;
    if (!window.confirm(`"${label}" still has ${detail}. Delete anyway?`)) return;
    result = await requestDelete(true);
  }

  if (result.status >= 400 || result.payload.ok === false) {
    throw new Error(result.payload.message || result.payload.error || `Delete failed with ${result.status}`);
  }

  showToast(`Node "${label}" deleted`);
  await refreshOverview();
}

// ===== Drop-in printing =====
function addDropStatusRow(fileName) {
  const row = document.createElement('div');
  row.className = 'drop-status-row';
  const name = document.createElement('strong');
  name.textContent = fileName;
  const status = document.createElement('span');
  status.textContent = 'Uploading…';
  row.append(name, status);
  elements.dropStatus.prepend(row);
  return {
    set(text, mode = '') {
      status.textContent = text;
      row.className = `drop-status-row ${mode}`.trim();
    },
  };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function submitDroppedFile(file) {
  const row = addDropStatusRow(file.name);
  try {
    if (file.size > 24 * 1024 * 1024) {
      throw new Error('File is larger than the 24MB upload limit');
    }
    const base64 = await fileToBase64(file);
    row.set('Routing to an available printer…');
    const payload = await apiRequest('/api/cloud/print-files', {
      method: 'POST',
      body: {
        name: file.name.replace(/\.[^.]+$/, ''),
        file: { name: file.name, base64 },
      },
    });

    if (payload.routing?.status === 'routed') {
      const target = payload.routing.selected_local_printer_id || shortId(payload.routing.selected_printer_id);
      row.set(payload.will_slice_on_node
        ? `Routed to ${target} — slicing on the farm node, then printing`
        : `Routed to ${target} — printing`, 'ok');
    } else {
      row.set('Queued — waiting for an available printer', 'warn');
    }
    await refreshOverview();
  } catch (error) {
    row.set(`Failed: ${error.message}`, 'error');
  }
}

function handleDroppedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  files.forEach((file) => { submitDroppedFile(file); });
}

function bindDropZone() {
  const zone = elements.dropZone;
  if (!zone) return;
  zone.addEventListener('click', () => elements.dropFileInput.click());
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      elements.dropFileInput.click();
    }
  });
  elements.dropFileInput.addEventListener('change', () => {
    handleDroppedFiles(elements.dropFileInput.files);
    elements.dropFileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((type) => {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove('dragging');
    });
  });
  zone.addEventListener('drop', (event) => {
    handleDroppedFiles(event.dataTransfer?.files);
  });
}

async function refreshOverview() {
  const params = new URLSearchParams();
  const orgId = getOrgId();
  if (orgId) params.set('org_id', orgId);
  params.set('limit', String(getRowLimit()));

  setApiState('Loading');
  const payload = await apiRequest(`/api/cloud/overview?${params.toString()}`);
  state.overview = payload.overview;
  renderOverview();
  setApiState('Connected', 'online');
}

function renderMerchantSettings(settings) {
  state.merchantSettings = settings || { full_auto_merchant_mode: { enabled: false } };
  const enabled = state.merchantSettings.full_auto_merchant_mode?.enabled === true;
  elements.fullAutoMode.checked = enabled;
  elements.merchantModeState.textContent = enabled ? 'Full auto on' : 'Approve only';
  elements.merchantModeState.className = enabled ? 'ready-label' : 'missing-label';
}

async function refreshMerchantSettings() {
  const payload = await apiRequest('/api/cloud/merchant-settings');
  renderMerchantSettings(payload.settings);
  return payload.settings;
}

async function refreshFarmAutomation() {
  const requestSequence = farmAutomationRequestSequence + 1;
  farmAutomationRequestSequence = requestSequence;
  const params = new URLSearchParams();
  const orgId = getOrgId();
  if (orgId) params.set('org_id', orgId);
  params.set('limit', String(getRowLimit()));
  const payload = await apiRequest(`/api/cloud/farm-automation?${params.toString()}`);
  if (requestSequence !== farmAutomationRequestSequence) {
    return state.farmAutomation;
  }
  renderFarmAutomation(payload.automation);
  updateCounts();
  renderMetrics();
  return payload.automation;
}

async function refreshMerchants() {
  const params = new URLSearchParams();
  const status = elements.merchantStatusFilter.value;
  if (status) params.set('status', status);
  params.set('limit', String(getRowLimit()));
  const payload = await apiRequest(`/api/cloud/merchants?${params.toString()}`);
  state.merchants = payload.merchants || [];
  renderOverview();
  return state.merchants;
}

async function refreshMerchantApiKeys(merchantId) {
  const id = merchantId || elements.merchantKeyMerchantId.value.trim() || elements.merchantLookupId.value.trim();
  if (!id) throw new Error('Merchant ID is required');
  const params = new URLSearchParams({ merchant_id: id });
  const payload = await apiRequest(`/api/cloud/merchant-api-keys?${params.toString()}`);
  state.merchantApiKeys = payload.api_keys || [];
  renderOverview();
  return state.merchantApiKeys;
}

async function refreshMerchantJobs(merchantId) {
  const id = merchantId || elements.merchantLookupId.value.trim();
  if (!id) throw new Error('Merchant ID is required');
  const params = new URLSearchParams({
    merchant_id: id,
    limit: String(getRowLimit()),
  });
  const payload = await apiRequest(`/api/cloud/merchant-jobs?${params.toString()}`);
  state.merchantJobs = payload.jobs || [];
  renderOverview();
  return state.merchantJobs;
}

async function refreshMerchantUsage(merchantId) {
  const id = merchantId || elements.merchantLookupId.value.trim();
  if (!id) throw new Error('Merchant ID is required');
  const params = new URLSearchParams({
    merchant_id: id,
    limit: String(getRowLimit()),
  });
  const payload = await apiRequest(`/api/cloud/merchant-usage?${params.toString()}`);
  state.merchantUsage = payload.usage || [];
  renderOverview();
  return state.merchantUsage;
}

async function refreshMerchantV2(merchantId) {
  const id = merchantId || elements.merchantLookupId.value.trim();
  if (!id) throw new Error('Merchant ID is required');
  const params = new URLSearchParams({
    merchant_id: id,
    limit: String(getRowLimit()),
  });
  const payload = await apiRequest(`/api/cloud/merchant-v2?${params.toString()}`);
  state.merchantV2 = {
    orders: payload.v2?.orders || [],
    files: payload.v2?.files || [],
    slices: payload.v2?.slices || [],
    batches: payload.v2?.batches || [],
    reservations: payload.v2?.reservations || [],
    shipments: payload.v2?.shipments || [],
    invoices: payload.v2?.invoices || [],
    webhook_deliveries: payload.v2?.webhook_deliveries || [],
    adapter_events: payload.v2?.adapter_events || [],
  };
  renderOverview();
  return state.merchantV2;
}

async function refreshMerchantOperationalData(merchantId) {
  const id = merchantId || elements.merchantLookupId.value.trim();
  if (!id) throw new Error('Merchant ID is required');
  elements.merchantKeyMerchantId.value = id;
  elements.merchantLookupId.value = id;
  await Promise.all([
    refreshMerchantApiKeys(id),
    refreshMerchantJobs(id),
    refreshMerchantUsage(id),
    refreshMerchantV2(id),
  ]);
  showToast('Merchant data loaded');
}

async function refreshDashboard() {
  setApiState('Loading');
  const setup = await refreshSetupStatus();
  if (!setup.ready) {
    setApiState('Setup needed', 'error');
    renderOverview();
    return;
  }
  await Promise.all([
    refreshOverview(),
    refreshMerchantSettings(),
    refreshFarmAutomation(),
    refreshFilamentOrders(),
    refreshMerchants(),
    refreshAdminUsers(),
  ]);
  setApiState('Connected', 'online');
}

function setSignedInAdmin(admin) {
  state.admin = admin || null;
  const superAdmin = state.admin?.role === 'super_admin';
  if (elements.adminUsersSection) elements.adminUsersSection.hidden = !superAdmin;
}

async function handleAdminLogin(event) {
  event.preventDefault();
  if (elements.loginError) elements.loginError.hidden = true;
  const email = elements.adminLoginEmail.value.trim();
  const password = elements.adminLoginPassword.value;
  try {
    const payload = await postJson('/api/cloud/admin/login', { email, password });
    elements.adminToken.value = payload.admin_session_token;
    window.localStorage.setItem(storageKeys.token, payload.admin_session_token);
    elements.adminLoginPassword.value = '';
    setSignedInAdmin(payload.admin);
    setAdminAuthState(payload.admin?.email || 'Signed in', 'ready-label');
    showConsole(payload.admin?.email || email);
    showToast('Signed in');
    await refreshDashboard();
  } catch (error) {
    if (elements.loginError) {
      elements.loginError.hidden = false;
      if (/invalid_admin_credentials/.test(error.message)) {
        elements.loginError.textContent = 'Incorrect email or password.';
      } else if (/rate_limited/.test(error.message)) {
        elements.loginError.textContent = 'Too many attempts — wait a minute and try again.';
      } else {
        elements.loginError.textContent = error.message;
      }
    } else {
      showToast(error.message);
    }
  }
}

// ===== Login gate =====
function showLogin() {
  if (elements.consoleView) elements.consoleView.hidden = true;
  if (elements.loginView) elements.loginView.hidden = false;
  if (elements.logoutBtn) elements.logoutBtn.hidden = true;
  if (elements.adminEmailDisplay) elements.adminEmailDisplay.hidden = true;
  setApiState('Not signed in');
}

function showConsole(email) {
  if (elements.loginView) elements.loginView.hidden = true;
  if (elements.consoleView) elements.consoleView.hidden = false;
  if (elements.logoutBtn) elements.logoutBtn.hidden = false;
  if (email && elements.adminEmailDisplay) {
    elements.adminEmailDisplay.hidden = false;
    elements.adminEmailDisplay.textContent = email;
  }
}

function handleLogout() {
  // Revoke the server-side session first (best-effort — a dead token still
  // gets dropped locally either way).
  apiRequest('/api/cloud/admin/logout', { method: 'POST' }).catch(() => {});
  window.localStorage.removeItem(storageKeys.token);
  elements.adminToken.value = '';
  setSignedInAdmin(null);
  showLogin();
  showToast('Signed out');
}

// Decide the initial view: validate a stored session, else show the login screen.
async function initView() {
  const token = getAdminToken();
  if (!token) { showLogin(); return; }
  try {
    const payload = await apiRequest('/api/cloud/admin/me');
    setSignedInAdmin(payload.admin);
    showConsole(payload.admin?.email || payload.auth_type || 'Admin');
    await refreshDashboard();
  } catch {
    // Stale/invalid token — drop it and show login.
    window.localStorage.removeItem(storageKeys.token);
    elements.adminToken.value = '';
    showLogin();
  }
}

// First-time setup: one call with the server's CLOUD_ADMIN_TOKEN creates the
// operator account, sets the password, and returns a live session — so the
// console signs straight in and daily use never needs the token again.
async function handleFirstSetup(event) {
  event.preventDefault();
  const bootstrapToken = elements.setupBootstrapToken.value.trim();
  const email = elements.setupEmail.value.trim().toLowerCase();
  const password = elements.setupNewPassword.value;
  const out = elements.firstSetupOutput;
  try {
    const response = await fetch('/api/cloud/admin/bootstrap', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bootstrapToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      if (payload.error === 'invalid_admin_token') {
        throw new Error('That CLOUD_ADMIN_TOKEN is not correct.');
      }
      if (payload.error === 'email_not_authorized') {
        throw new Error(`${email} is not an authorized operator email for this deployment.`);
      }
      throw new Error(payload.message || payload.error || 'Setup failed');
    }
    elements.setupBootstrapToken.value = '';
    elements.setupNewPassword.value = '';
    elements.adminLoginEmail.value = email;
    if (payload.admin_session_token) {
      elements.adminToken.value = payload.admin_session_token;
      window.localStorage.setItem(storageKeys.token, payload.admin_session_token);
      setSignedInAdmin(payload.admin);
      setAdminAuthState(payload.admin?.email || email, 'ready-label');
      showConsole(payload.admin?.email || email);
      showToast('Account ready — signed in');
      await refreshDashboard();
      return;
    }
    if (out) { out.hidden = false; out.textContent = `Account ready for ${email}. Sign in above.`; }
    showToast('Account created — sign in now');
  } catch (error) {
    if (out) { out.hidden = false; out.textContent = `Setup failed: ${error.message}`; }
    showToast(error.message);
  }
}

async function handleAdminMe() {
  const payload = await apiRequest('/api/cloud/admin/me');
  setAdminAuthState(payload.admin?.email || payload.auth_type || 'Admin', 'ready-label');
  showToast(`Admin: ${payload.admin?.email || payload.auth_type}`);
}

// Self-service forgot-password: public endpoint, generic response. When the
// caller happens to be signed in (super admins using it as a support tool) the
// server returns the actual link, which we surface for copy/paste.
async function handleAdminResetRequest(event) {
  event.preventDefault();
  const email = elements.adminResetEmail.value.trim();
  const token = getAdminToken();
  const payload = token
    ? await apiRequest('/api/cloud/admin/password-reset', { method: 'POST', body: { email } })
    : await postJson('/api/cloud/admin/password-reset', { email });

  elements.adminResetOutput.hidden = false;
  if (payload.reset_url) {
    elements.adminResetOutput.textContent = [
      `EMAIL=${payload.admin?.email || email}`,
      `RESET_URL=${payload.reset_url}`,
      `EXPIRES_AT=${payload.expires_at}`,
      payload.email_sent ? 'EMAIL_SENT=yes' : 'EMAIL_SENT=no (share the link manually)',
    ].join('\n');
    showToast('Admin reset link issued');
  } else {
    elements.adminResetOutput.textContent = payload.message
      || 'If that email belongs to an operator account, a reset link has been sent.';
    showToast('Reset requested');
  }
}

// ===== Admin account management (super admin only) =====
async function refreshAdminUsers() {
  if (state.admin?.role !== 'super_admin') {
    if (elements.adminUsersSection) elements.adminUsersSection.hidden = true;
    return;
  }
  try {
    const payload = await apiRequest('/api/cloud/admin/users');
    state.adminUsers = payload.admins || [];
    if (elements.adminUsersSection) elements.adminUsersSection.hidden = false;
    renderAdminUsers();
  } catch {
    // Non-fatal: older deployments may not expose the endpoint yet.
    if (elements.adminUsersSection) elements.adminUsersSection.hidden = true;
  }
}

function showAdminUserResult(payload) {
  if (!elements.adminUsersOutput) return;
  elements.adminUsersOutput.hidden = false;
  if (payload.reset_url) {
    elements.adminUsersOutput.textContent = [
      `EMAIL=${payload.admin?.email || ''}`,
      `RESET_URL=${payload.reset_url}`,
      `EXPIRES_AT=${payload.expires_at}`,
      payload.email_sent ? 'EMAIL_SENT=yes' : 'EMAIL_SENT=no (share the link manually)',
    ].join('\n');
  } else {
    elements.adminUsersOutput.textContent = `${payload.admin?.email || ''} is now ${payload.admin?.status || 'updated'}.`;
  }
}

async function handleAdminUserAction(action, email) {
  const payload = await apiRequest('/api/cloud/admin/users', {
    method: 'POST',
    body: { action, email },
  });
  showAdminUserResult(payload);
  await refreshAdminUsers();
  showToast(`Admin ${action.replace('_', ' ')} done`);
}

async function handleAdminUserCreate(event) {
  event.preventDefault();
  const payload = await apiRequest('/api/cloud/admin/users', {
    method: 'POST',
    body: {
      action: 'create',
      email: elements.adminUserEmail.value.trim(),
      role: elements.adminUserRole.value,
    },
  });
  elements.adminUserEmail.value = '';
  showAdminUserResult(payload);
  await refreshAdminUsers();
  showToast('Admin account created');
}

function renderAdminUsers() {
  renderTable('#admin-users-table', [
    { label: 'Email', value: (row) => row.email || '-' },
    { label: 'Role', value: (row) => row.role || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Last login', value: (row) => formatDate(row.last_login_at) },
    {
      label: 'Actions',
      value: (row) => {
        const wrap = document.createElement('div');
        wrap.className = 'row-actions';
        wrap.append(makeButton('Reset link', () => {
          handleAdminUserAction('reset_link', row.email).catch((error) => showToast(error.message));
        }, 'ghost-button small-button'));
        if (row.status === 'active') {
          wrap.append(makeButton('Disable', () => {
            handleAdminUserAction('disable', row.email).catch((error) => showToast(error.message));
          }, 'ghost-button small-button'));
        } else {
          wrap.append(makeButton('Enable', () => {
            handleAdminUserAction('enable', row.email).catch((error) => showToast(error.message));
          }, 'ghost-button small-button'));
        }
        return wrap;
      },
    },
  ], state.adminUsers, 'No admin accounts loaded.');
}

function syncOrgFields() {
  const orgId = getOrgId();
  if (orgId && !elements.nodeOrgId.value.trim()) {
    elements.nodeOrgId.value = orgId;
  }
}

function syncMerchantFields(id) {
  if (!id) return;
  elements.merchantId.value = id;
  elements.merchantActionId.value = id;
  elements.merchantKeyMerchantId.value = id;
  elements.merchantLookupId.value = id;
}

function setCurrentOrganization(organization) {
  elements.orgId.value = organization.org_id;
  elements.nodeOrgId.value = organization.org_id;
  window.localStorage.setItem(storageKeys.orgId, organization.org_id);
}

async function createOrganization(name) {
  const result = await apiRequest('/api/cloud/organizations', {
    method: 'POST',
    body: { name },
  });
  setCurrentOrganization(result.organization);
  return result.organization;
}

async function handleCreateOrganization(event) {
  event.preventDefault();
  const organization = await createOrganization(elements.organizationName.value.trim());
  elements.organizationOutput.hidden = false;
  elements.organizationOutput.textContent = [
    `ORG_ID=${organization.org_id}`,
    `NAME=${organization.name}`,
  ].join('\n');
  showToast('Organization created');
  await refreshOverview();
}

function setProvisionedNode({ node, token }) {
  state.provisionedNode = {
    id: node.node_id,
    name: node.name,
    token,
    cloudApiUrl: window.location.origin,
  };
}

function renderProvisionedNodeOutput(target, { organization, node, token, capabilities }) {
  target.hidden = false;
  target.textContent = [
    `CLOUD_API_URL=${window.location.origin}`,
    `LOCAL_NODE_TOKEN=${token}`,
    organization?.org_id ? `ORG_ID=${organization.org_id}` : '',
    `NODE_ID=${node.node_id}`,
    `NODE_NAME=${node.name || '-'}`,
    `CAPABILITIES=${JSON.stringify(capabilities || {})}`,
  ].filter(Boolean).join('\n');
}

async function provisionNode({ orgId, name, capabilities }) {
  const payload = {
    org_id: orgId,
    name,
    capabilities,
  };

  const result = await apiRequest('/api/cloud/nodes', {
    method: 'POST',
    body: payload,
  });

  setProvisionedNode({
    node: { ...result.node, name: result.node.name || payload.name },
    token: result.local_node_token,
  });
  return {
    node: { ...result.node, name: result.node.name || payload.name },
    token: result.local_node_token,
  };
}

async function handleProvisionNode(event) {
  event.preventDefault();
  const capabilities = parseJsonField(elements.nodeCapabilities.value, {});
  const result = await provisionNode({
    orgId: elements.nodeOrgId.value.trim(),
    name: elements.nodeName.value.trim(),
    capabilities,
  });
  renderProvisionedNodeOutput(elements.nodeTokenOutput, {
    node: result.node,
    token: result.token,
    capabilities,
  });
  elements.downloadButtons.hidden = false;
  showToast('Node provisioned');
  await refreshOverview();
}

async function handleDownloadPortable() {
  if (!state.provisionedNode) {
    throw new Error('Provision a node first');
  }

  const fileBase = (state.provisionedNode.name || 'printkinetix-node')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'printkinetix-node';

  await apiDownload('/api/cloud/node-package', {
    fileName: `${fileBase}-portable.zip`,
    body: {
      format: 'portable',
      cloud_api_url: state.provisionedNode.cloudApiUrl,
      local_node_token: state.provisionedNode.token,
      node_name: state.provisionedNode.name,
    },
  });
  const onMac = /Mac/i.test(navigator.platform || '') || /Macintosh/i.test(navigator.userAgent || '');
  showToast(onMac
    ? 'Portable app downloaded — extract, right-click "Start Farm Node.command" → Open (first launch only; no install, auto-fetches Node)'
    : 'Portable app downloaded — extract and double-click "Start Farm Node.bat" (Windows) or "Start Farm Node.command" (macOS); no install, auto-fetches Node');
}

// The Windows .exe is a single prebuilt binary hosted externally (too large for
// the serverless bundle). The handler returns either a redirect URL (open it) or
// a clear "not built yet" message with build instructions.
async function handleDownloadExe() {
  if (!state.provisionedNode) {
    throw new Error('Provision a node first');
  }

  const token = getAdminToken();
  if (!token) throw new Error('Admin token is required');

  const response = await fetch('/api/cloud/node-package', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      format: 'exe',
      cloud_api_url: state.provisionedNode.cloudApiUrl,
      local_node_token: state.provisionedNode.token,
      node_name: state.provisionedNode.name,
    }),
  });

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const payload = await response.json().catch(() => ({}));
    if (payload.download_url) {
      window.open(payload.download_url, '_blank');
      showToast('Opening the Windows .exe download…');
      return;
    }
    if (payload.error === 'exe_not_built') {
      showToast('Windows .exe not built yet — see the message below.');
      if (elements.quickstartOutput) {
        elements.quickstartOutput.hidden = false;
        elements.quickstartOutput.textContent = [
          'Windows .exe not built yet.',
          '',
          payload.message || 'Build it on Windows and host it, then set FARM_NODE_EXE_URL.',
          '',
          'Build command:  ' + (payload.build_command || 'npm run build:node:exe'),
          'Or run the "Build Windows .exe" GitHub Action (workflow_dispatch) and attach the artifact to a Release.',
          '',
          'The Portable .zip works now — no install required.',
        ].join('\n');
      }
      return;
    }
    throw new Error(payload.message || payload.error || `Download failed with ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`Download failed with ${response.status}`);
  }

  // Self-hosted case: the server streamed a locally-built farm-node.exe.
  const blob = await response.blob();
  triggerBlobDownload(blob, 'farm-node.exe');
  showToast('Windows .exe downloaded');
}

async function handleNodeQuickstart(event) {
  event.preventDefault();
  let organization = null;
  const capabilities = buildQuickstartCapabilities();
  const currentOrgId = getOrgId();

  if (currentOrgId) {
    organization = { org_id: currentOrgId, name: elements.quickstartOrgName.value.trim() || 'Bambu Farm' };
  } else {
    organization = await createOrganization(elements.quickstartOrgName.value.trim() || 'Bambu Farm');
  }

  const result = await provisionNode({
    orgId: organization.org_id,
    name: elements.quickstartNodeName.value.trim() || 'Farm Manager 01',
    capabilities,
  });

  elements.nodeOrgId.value = organization.org_id;
  elements.nodeName.value = result.node.name;
  elements.nodeCapabilities.value = JSON.stringify(capabilities, null, 2);
  elements.downloadButtons.hidden = false;
  renderProvisionedNodeOutput(elements.quickstartOutput, {
    organization,
    node: result.node,
    token: result.token,
    capabilities,
  });
  renderProvisionedNodeOutput(elements.nodeTokenOutput, {
    organization,
    node: result.node,
    token: result.token,
    capabilities,
  });

  if (elements.quickstartAutoDownload.checked) {
    await handleDownloadPortable();
  }

  showToast('Farm node ready');
  await refreshOverview();
}

function applyCommandTemplate(name) {
  const template = commandTemplates[name];
  if (!template) return;
  elements.commandType.value = template.commandType;
  elements.commandPayload.value = JSON.stringify(template.payload, null, 2);
}

async function queueNodeCommand({ nodeId, commandType, payload, printerId = null, jobId = null, orgId = null }) {
  if (!nodeId) throw new Error('Node is required');
  const node = state.overview.nodes.find((item) => item.node_id === nodeId);
  const commandOrgId = orgId || node?.org_id || getOrgId();
  if (!commandOrgId) throw new Error('Org ID is required');

  return apiRequest('/api/cloud/commands', {
    method: 'POST',
    body: {
      org_id: commandOrgId,
      node_id: nodeId,
      printer_id: printerId || null,
      job_id: jobId || null,
      command_type: commandType,
      payload,
    },
  });
}

async function handleQueueCommand(event) {
  event.preventDefault();
  const selected = elements.commandNode.selectedOptions[0];
  const orgId = selected?.dataset.orgId || getOrgId();
  await queueNodeCommand({
    orgId,
    nodeId: elements.commandNode.value,
    printerId: elements.commandPrinter.value.trim() || null,
    jobId: elements.commandJob.value.trim() || null,
    commandType: elements.commandType.value,
    payload: parseJsonField(elements.commandPayload.value, {}),
  });

  showToast('Command queued');
  await refreshOverview();
}

async function handlePrinterSync(event) {
  event.preventDefault();
  const commandType = event.submitter?.value || 'cloud.printers.sync';
  const nodeId = elements.syncNode.value || elements.commandNode.value;
  const commandPayload = buildPrinterSyncPayload();
  const result = await queueNodeCommand({
    nodeId,
    commandType,
    payload: commandPayload,
  });
  const command = result.command || result.node_command || result;

  elements.syncOutput.hidden = false;
  elements.syncOutput.textContent = [
    `COMMAND_TYPE=${commandType}`,
    command?.command_id ? `COMMAND_ID=${command.command_id}` : '',
    `NODE_ID=${nodeId}`,
    `PAYLOAD=${JSON.stringify(commandPayload)}`,
  ].filter(Boolean).join('\n');
  showToast(commandType === 'cloud.printers.discover' ? 'Discovery queued' : 'Printer sync queued');
  await refreshOverview();
}

async function handleMerchantSettingsSubmit(event) {
  event.preventDefault();
  const payload = await apiRequest('/api/cloud/merchant-settings', {
    method: 'PATCH',
    body: { full_auto_merchant_mode: elements.fullAutoMode.checked },
  });
  renderMerchantSettings(payload.settings);
  showToast('Merchant mode saved');
}

async function handleFarmAutomationSubmit(event) {
  event.preventDefault();
  const mutationSequence = markFarmAutomationMutation();
  const policy = {
    smart_queue_enabled: elements.smartQueueEnabled.checked,
    auto_eject_enabled: elements.autoEjectEnabled.checked,
    failure_detection_enabled: elements.failureDetectionEnabled.checked,
    release_temperature_c: Number(elements.releaseTemperatureC.value) || 27,
    max_eject_attempts: Number.parseInt(elements.maxEjectAttempts.value, 10) || 3,
    bed_clear_verification: elements.bedClearVerification.value,
  };
  const payload = await apiRequest('/api/cloud/farm-automation', {
    method: 'PATCH',
    body: { policy },
  });
  if (mutationSequence === farmAutomationRequestSequence) {
    renderFarmAutomation(payload.automation);
  }
  showToast('Farm automation policy saved');
}

async function handleFilamentInventorySubmit(event) {
  event.preventDefault();
  const mutationSequence = markFarmAutomationMutation();
  const inventory = parseJsonField(elements.filamentInventoryJson.value, { spools: [] });
  const payload = await apiRequest('/api/cloud/farm-automation', {
    method: 'PATCH',
    body: { inventory },
  });
  if (mutationSequence === farmAutomationRequestSequence) {
    renderFarmAutomation(payload.automation);
  }
  showToast('Filament inventory saved');
}

async function handleIntegrationsSubmit(event) {
  event.preventDefault();
  const mutationSequence = markFarmAutomationMutation();
  const integrations = parseJsonField(elements.integrationsJson.value, {});
  const payload = await apiRequest('/api/cloud/farm-automation', {
    method: 'PATCH',
    body: { integrations },
  });
  if (mutationSequence === farmAutomationRequestSequence) {
    renderFarmAutomation(payload.automation);
  }
  showToast('Farm integrations saved');
}

// ---------------------------------------------------------------------------
// Filament auto-ordering (Amazon Business)
// ---------------------------------------------------------------------------

function renderFilamentOrders(payload) {
  if (!elements.filamentReorderForm) return;
  if (payload) state.filamentReorders = payload;
  const data = state.filamentReorders || {};
  const config = data.config || {};

  elements.reorderEnabled.checked = config.enabled === true;
  elements.reorderMode.value = config.mode === 'auto' ? 'auto' : 'approval';
  elements.reorderRegion.value = config.region || 'NA';
  elements.reorderTrialMode.checked = config.trial_mode !== false;
  elements.reorderMonthlyBudget.value = config.monthly_budget_usd || 250;
  elements.reorderMaxOrder.value = config.max_order_usd || 150;
  elements.reorderUserEmail.value = config.user_email || '';
  elements.reorderClientId.value = config.credentials?.client_id || '';
  elements.reorderClientSecret.placeholder = config.credentials?.client_secret_set ? '(saved — leave blank to keep)' : '(not set)';
  elements.reorderRefreshToken.placeholder = config.credentials?.refresh_token_set ? '(saved — leave blank to keep)' : '(not set)';
  elements.reorderRulesJson.value = JSON.stringify(config.rules || [], null, 2);

  const orders = data.orders || [];
  elements.filamentOrdersCount.textContent = String(orders.length);

  renderTable('#filament-orders-table', [
    { label: 'Created', value: (row) => (row.created_at || '').replace('T', ' ').slice(0, 16) },
    { label: 'Filament', value: (row) => `${row.material}${row.color_hex ? ` ${row.color_hex}` : ''} ×${row.quantity}` },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    {
      label: 'Detail',
      value: (row) => row.error || row.reason || (row.trial_mode && row.status !== 'awaiting_approval' ? 'trial order' : `~$${row.est_total_usd || 0}`),
    },
    {
      label: 'Actions',
      value: (row) => {
        const wrap = document.createElement('span');
        if (row.status === 'awaiting_approval') {
          wrap.append(
            makeButton('Approve', () => handleFilamentOrderAction('approve', row.order_id), 'ghost-button small-button'),
            makeButton('Deny', () => handleFilamentOrderAction('deny', row.order_id), 'ghost-button small-button'),
          );
        } else {
          wrap.append(makeDetailButton('Open', `Filament order ${row.order_id}`, row));
        }
        return wrap;
      },
    },
  ], orders, 'No filament orders yet — set rules and enable auto-ordering.');
}

async function refreshFilamentOrders() {
  if (!elements.filamentReorderForm) return null;
  const payload = await apiRequest('/api/cloud/filament-orders');
  renderFilamentOrders(payload);
  return payload;
}

function collectFilamentReorderConfig() {
  const config = {
    enabled: elements.reorderEnabled.checked,
    mode: elements.reorderMode.value,
    region: elements.reorderRegion.value,
    trial_mode: elements.reorderTrialMode.checked,
    monthly_budget_usd: Number(elements.reorderMonthlyBudget.value) || 250,
    max_order_usd: Number(elements.reorderMaxOrder.value) || 150,
    user_email: elements.reorderUserEmail.value.trim() || null,
    rules: parseJsonField(elements.reorderRulesJson.value, []),
    credentials: {},
  };
  // Secrets are write-only: send them only when the operator typed a value.
  if (elements.reorderClientId.value.trim()) config.credentials.client_id = elements.reorderClientId.value.trim();
  if (elements.reorderClientSecret.value.trim()) config.credentials.client_secret = elements.reorderClientSecret.value.trim();
  if (elements.reorderRefreshToken.value.trim()) config.credentials.refresh_token = elements.reorderRefreshToken.value.trim();
  return config;
}

async function handleFilamentReorderSubmit(event) {
  event.preventDefault();
  const payload = await apiRequest('/api/cloud/filament-orders', {
    method: 'PATCH',
    body: { config: collectFilamentReorderConfig() },
  });
  elements.reorderClientSecret.value = '';
  elements.reorderRefreshToken.value = '';
  renderFilamentOrders(payload);
  showToast('Filament auto-ordering saved');
}

async function handleFilamentOrderAction(action, orderId) {
  try {
    const payload = await apiRequest('/api/cloud/filament-orders', {
      method: 'POST',
      body: { action, order_id: orderId },
    });
    renderFilamentOrders(payload);
    showToast(action === 'approve'
      ? (payload.order?.status === 'failed' ? `Order failed: ${payload.order?.error || 'see table'}` : 'Order placed with Amazon Business')
      : 'Order denied');
  } catch (error) {
    setApiState('Error', 'error');
    showToast(error.message);
  }
}

async function handleFilamentReorderEvaluate() {
  const payload = await apiRequest('/api/cloud/filament-orders', {
    method: 'POST',
    body: { action: 'evaluate' },
  });
  renderFilamentOrders(payload);
  const result = payload.result || {};
  showToast(result.created > 0
    ? `Stock check: ${result.created} reorder(s) created (${result.placed || 0} placed)`
    : 'Stock check: everything above thresholds');
}

async function handleFilamentReorderTest() {
  const payload = await apiRequest('/api/cloud/filament-orders', {
    method: 'POST',
    body: { action: 'test_connection' },
  });
  elements.reorderOutput.hidden = false;
  elements.reorderOutput.textContent = JSON.stringify(payload.connection || payload, null, 2);
  showToast(payload.connection?.ok ? 'Amazon Business connection OK' : 'Connection failed — see details');
}

async function handleMerchantAction(event) {
  event.preventDefault();
  const merchantId = elements.merchantActionId.value.trim();
  const metadata = parseJsonField(elements.merchantActionMetadata.value, {});
  const result = await apiRequest('/api/cloud/merchants', {
    method: 'POST',
    body: {
      merchant_id: merchantId,
      action: elements.merchantAction.value,
      issue_setup_token: elements.merchantIssueSetupToken.checked,
      metadata,
    },
  });

  elements.merchantActionOutput.hidden = false;
  elements.merchantActionOutput.textContent = [
    `MERCHANT_ID=${result.merchant?.merchant_id || merchantId}`,
    `STATUS=${result.merchant?.status || '-'}`,
    result.merchant_setup_token ? `MERCHANT_SETUP_TOKEN=${result.merchant_setup_token}` : '',
    result.setup_token_expires_at ? `SETUP_TOKEN_EXPIRES_AT=${result.setup_token_expires_at}` : '',
  ].filter(Boolean).join('\n');
  syncMerchantFields(merchantId);
  showToast('Merchant action applied');
  await refreshMerchants();
}

async function handleIssueSetupToken() {
  const merchantId = elements.merchantActionId.value.trim();
  if (!merchantId) throw new Error('Merchant ID is required');
  const result = await apiRequest('/api/cloud/merchant-setup-token', {
    method: 'POST',
    body: { merchant_id: merchantId },
  });
  elements.merchantActionOutput.hidden = false;
  elements.merchantActionOutput.textContent = [
    `MERCHANT_ID=${result.merchant_id}`,
    `MERCHANT_SETUP_TOKEN=${result.merchant_setup_token}`,
    `SETUP_TOKEN_EXPIRES_AT=${result.setup_token_expires_at}`,
  ].join('\n');
  showToast('Setup token issued');
}

async function handleMerchantKeySubmit(event) {
  event.preventDefault();
  const merchantId = elements.merchantKeyMerchantId.value.trim();
  const result = await apiRequest('/api/cloud/merchant-api-keys', {
    method: 'POST',
    body: {
      merchant_id: merchantId,
      name: elements.merchantKeyName.value.trim() || 'Production',
    },
  });
  elements.merchantKeyOutput.hidden = false;
  elements.merchantKeyOutput.textContent = [
    `MERCHANT_ID=${merchantId}`,
    `API_KEY_ID=${result.api_key?.key_id || '-'}`,
    `API_KEY_SECRET=${result.api_key_secret}`,
  ].join('\n');
  showToast('Live API key issued');
  await refreshMerchantApiKeys(merchantId);
}

async function handleRevokeMerchantKey() {
  const merchantId = elements.merchantKeyMerchantId.value.trim();
  const keyId = elements.merchantKeyId.value.trim();
  if (!merchantId || !keyId) throw new Error('Merchant ID and Key ID are required');
  await apiRequest('/api/cloud/merchant-api-keys', {
    method: 'DELETE',
    body: {
      merchant_id: merchantId,
      key_id: keyId,
    },
  });
  showToast('API key revoked');
  await refreshMerchantApiKeys(merchantId);
}

function restoreSettings() {
  elements.adminToken.value = window.localStorage.getItem(storageKeys.token) || '';
  elements.orgId.value = window.localStorage.getItem(storageKeys.orgId) || '';
  elements.nodeOrgId.value = elements.orgId.value;
}

// Live printer fleet board (cards, AMS slots, previews, camera, adoption).
const fleetView = createFleetView({
  $,
  getState: () => state,
  apiRequest,
  queueNodeCommand,
  showToast,
  showDetail,
  refreshOverview,
  getRowLimit,
});

function bindEvents() {
  bindFarmAutomationEditorGuards();
  bindTabs();
  bindDropZone();
  fleetView.bind();

  if (elements.amsPrinter) {
    elements.amsPrinter.addEventListener('change', () => renderAmsPanel());
  }
  if (elements.amsSlots) {
    elements.amsSlots.addEventListener('click', (event) => {
      handleAmsApply(event).catch((error) => showToast(error.message));
    });
  }

  elements.adminLoginForm.addEventListener('submit', (event) => {
    handleAdminLogin(event).catch((error) => {
      setAdminAuthState('Login failed', 'missing-label');
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });

  elements.adminMe.addEventListener('click', () => {
    handleAdminMe().catch((error) => {
      setAdminAuthState('Check failed', 'missing-label');
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });

  elements.adminResetRequestForm.addEventListener('submit', (event) => {
    handleAdminResetRequest(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });

  if (elements.logoutBtn) elements.logoutBtn.addEventListener('click', handleLogout);
  if (elements.firstSetupForm) {
    elements.firstSetupForm.addEventListener('submit', (event) => {
      handleFirstSetup(event).catch((error) => showToast(error.message));
    });
  }
  if (elements.toggleFirstSetup) {
    elements.toggleFirstSetup.addEventListener('click', () => {
      if (elements.firstSetupCard) elements.firstSetupCard.hidden = !elements.firstSetupCard.hidden;
    });
  }
  if (elements.toggleReset) {
    elements.toggleReset.addEventListener('click', () => {
      if (elements.resetCard) elements.resetCard.hidden = !elements.resetCard.hidden;
    });
  }
  if (elements.adminUserCreateForm) {
    elements.adminUserCreateForm.addEventListener('submit', (event) => {
      handleAdminUserCreate(event).catch((error) => showToast(error.message));
    });
  }

  elements.saveToken.addEventListener('click', () => {
    window.localStorage.setItem(storageKeys.token, getAdminToken());
    window.localStorage.setItem(storageKeys.orgId, getOrgId());
    syncOrgFields();
    showToast('Saved');
  });

  elements.refresh.addEventListener('click', () => {
    refreshDashboard().catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });

  elements.closeDetail.addEventListener('click', () => {
    elements.selectedDetail.hidden = true;
  });

  document.querySelectorAll('[data-command-template]').forEach((button) => {
    button.addEventListener('click', () => applyCommandTemplate(button.dataset.commandTemplate));
  });

  elements.orgId.addEventListener('input', syncOrgFields);
  elements.quickstartScanCidrs.addEventListener('input', () => {
    if (!elements.syncScanCidrs.value.trim()) {
      elements.syncScanCidrs.value = elements.quickstartScanCidrs.value;
    }
  });
  elements.merchantId.addEventListener('input', () => syncMerchantFields(elements.merchantId.value.trim()));
  elements.merchantSettingsForm.addEventListener('submit', (event) => {
    handleMerchantSettingsSubmit(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.farmAutomationForm.addEventListener('submit', (event) => {
    handleFarmAutomationSubmit(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.filamentInventoryForm.addEventListener('submit', (event) => {
    handleFilamentInventorySubmit(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.integrationsForm.addEventListener('submit', (event) => {
    handleIntegrationsSubmit(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.filamentReorderForm.addEventListener('submit', (event) => {
    handleFilamentReorderSubmit(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.reorderTestConnection.addEventListener('click', () => {
    handleFilamentReorderTest().catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.reorderEvaluate.addEventListener('click', () => {
    handleFilamentReorderEvaluate().catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.refreshMerchantSettings.addEventListener('click', () => {
    refreshMerchantSettings().catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.nodeQuickstartForm.addEventListener('submit', (event) => {
    handleNodeQuickstart(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.organizationForm.addEventListener('submit', (event) => {
    handleCreateOrganization(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.nodeForm.addEventListener('submit', (event) => {
    handleProvisionNode(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.downloadNodePortable.addEventListener('click', () => {
    handleDownloadPortable().catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.downloadNodeExe.addEventListener('click', () => {
    handleDownloadExe().catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.printerSyncForm.addEventListener('submit', (event) => {
    handlePrinterSync(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.commandForm.addEventListener('submit', (event) => {
    handleQueueCommand(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.merchantListForm.addEventListener('submit', (event) => {
    event.preventDefault();
    refreshMerchants().catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.merchantActionForm.addEventListener('submit', (event) => {
    handleMerchantAction(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.issueSetupToken.addEventListener('click', () => {
    handleIssueSetupToken().catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.merchantKeyForm.addEventListener('submit', (event) => {
    handleMerchantKeySubmit(event).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.listMerchantKeys.addEventListener('click', () => {
    refreshMerchantApiKeys().catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.revokeMerchantKey.addEventListener('click', () => {
    handleRevokeMerchantKey().catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
  elements.merchantLookupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    refreshMerchantOperationalData(elements.merchantLookupId.value.trim()).catch((error) => {
      setApiState('Error', 'error');
      showToast(error.message);
    });
  });
}

restoreSettings();
bindEvents();
renderOverview();
renderMerchantSettings(state.merchantSettings);

// Gate the console behind admin login: validate any stored session, else show login.
initView().catch(() => showLogin());
