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
  integrationsForm: $('#integrations-form'),
  integrationsJson: $('#integrations-json'),
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
  downloadNodePackage: $('#download-node-package'),
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
};

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

function renderOverview() {
  const overview = state.overview;
  updateCounts();
  renderMetrics();
  renderCommandNodeOptions(overview.nodes);

  renderTable('#nodes-table', [
    { label: 'Node', value: (row) => row.name || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Version', value: (row) => row.agent_version || '-' },
    { label: 'Host', value: (row) => row.host_info?.hostname || '-' },
    { label: 'NICs', value: (row) => row.capabilities?.network_interface_count ?? '-' },
    { label: 'Pending Results', value: (row) => row.capabilities?.pending_result_count ?? '-' },
    { label: 'Last seen', value: (row) => formatDate(row.last_seen_at) },
    { label: 'Detail', value: (row) => makeDetailButton('Open', `Node ${shortId(row.node_id)}`, row) },
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
    refreshMerchants(),
  ]);
  setApiState('Connected', 'online');
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
    setAdminAuthState(payload.admin?.email || 'Signed in', 'ready-label');
    showConsole(payload.admin?.email || email);
    showToast('Signed in');
    await refreshDashboard();
  } catch (error) {
    if (elements.loginError) {
      elements.loginError.hidden = false;
      elements.loginError.textContent = /invalid_admin_credentials/.test(error.message)
        ? 'Incorrect email or password.'
        : error.message;
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
  window.localStorage.removeItem(storageKeys.token);
  elements.adminToken.value = '';
  showLogin();
  showToast('Signed out');
}

// Decide the initial view: validate a stored session, else show the login screen.
async function initView() {
  const token = getAdminToken();
  if (!token) { showLogin(); return; }
  try {
    const payload = await apiRequest('/api/cloud/admin/me');
    showConsole(payload.admin?.email || payload.auth_type || 'Admin');
    await refreshDashboard();
  } catch {
    // Stale/invalid token — drop it and show login.
    window.localStorage.removeItem(storageKeys.token);
    elements.adminToken.value = '';
    showLogin();
  }
}

// First-time setup / password recovery: create the operator account with the
// server's CLOUD_ADMIN_TOKEN, then set a password — so daily use needs no token.
async function handleFirstSetup(event) {
  event.preventDefault();
  const bootstrapToken = elements.setupBootstrapToken.value.trim();
  const email = elements.setupEmail.value.trim().toLowerCase();
  const password = elements.setupNewPassword.value;
  const out = elements.firstSetupOutput;
  try {
    const bootstrapRes = await fetch('/api/cloud/admin/bootstrap', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bootstrapToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue_reset_tokens: true }),
    });
    const bootstrap = await bootstrapRes.json();
    if (!bootstrapRes.ok || bootstrap.ok === false) {
      throw new Error(bootstrap.error === 'invalid_admin_token'
        ? 'That CLOUD_ADMIN_TOKEN is not correct.'
        : (bootstrap.message || bootstrap.error || 'Bootstrap failed'));
    }
    const link = (bootstrap.reset_links || []).find((l) => (l.email || '').toLowerCase() === email);
    if (!link) {
      throw new Error(`${email} is not an authorized operator email for this deployment.`);
    }
    const setRes = await fetch('/api/cloud/admin/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset_token: link.reset_token, password }),
    });
    const set = await setRes.json();
    if (!setRes.ok || set.ok === false) {
      throw new Error(set.message || set.error || 'Could not set password');
    }
    elements.setupBootstrapToken.value = '';
    elements.setupNewPassword.value = '';
    if (out) { out.hidden = false; out.textContent = `Account ready for ${email}. Sign in above.`; }
    elements.adminLoginEmail.value = email;
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

async function handleAdminResetRequest(event) {
  event.preventDefault();
  const email = elements.adminResetEmail.value.trim();
  const payload = await apiRequest('/api/cloud/admin/password-reset', {
    method: 'POST',
    body: { email },
  });

  elements.adminResetOutput.hidden = false;
  elements.adminResetOutput.textContent = [
    `EMAIL=${payload.admin?.email || email}`,
    `RESET_URL=${payload.reset_url}`,
    `RESET_TOKEN=${payload.reset_token}`,
    `EXPIRES_AT=${payload.expires_at}`,
  ].join('\n');
  showToast('Admin reset link issued');
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
  elements.downloadNodePackage.hidden = false;
  showToast('Node provisioned');
  await refreshOverview();
}

async function handleDownloadNodePackage() {
  if (!state.provisionedNode) {
    throw new Error('Provision a node first');
  }

  const fileBase = (state.provisionedNode.name || 'printkinetix-node')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'printkinetix-node';

  await apiDownload('/api/cloud/node-package', {
    fileName: `${fileBase}-cloud-node.zip`,
    body: {
      cloud_api_url: state.provisionedNode.cloudApiUrl,
      local_node_token: state.provisionedNode.token,
      node_name: state.provisionedNode.name,
    },
  });
  showToast('Farm node downloaded — Windows: run Start Farm Node.bat · Pi/Linux: bash start-farm-node.sh (no install, no keys)');
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
    name: elements.quickstartNodeName.value.trim() || 'Windows Farm Manager 01',
    capabilities,
  });

  elements.nodeOrgId.value = organization.org_id;
  elements.nodeName.value = result.node.name;
  elements.nodeCapabilities.value = JSON.stringify(capabilities, null, 2);
  elements.downloadNodePackage.hidden = false;
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
    await handleDownloadNodePackage();
  }

  showToast('Windows manager ready');
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

function bindEvents() {
  bindFarmAutomationEditorGuards();

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
    // Recovery uses the same bootstrap-token setup card (the reset-link flow itself
    // requires an admin token, which a locked-out operator won't have).
    elements.toggleReset.addEventListener('click', () => {
      if (elements.firstSetupCard) elements.firstSetupCard.hidden = false;
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
  elements.downloadNodePackage.addEventListener('click', () => {
    handleDownloadNodePackage().catch((error) => {
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
