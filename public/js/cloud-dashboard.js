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
  provisionedNode: null,
};

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
  organizationForm: $('#organization-form'),
  organizationName: $('#organization-name'),
  organizationOutput: $('#organization-output'),
  nodeForm: $('#node-form'),
  nodeOrgId: $('#node-org-id'),
  nodeName: $('#node-name'),
  nodeCapabilities: $('#node-capabilities'),
  nodeTokenOutput: $('#node-token-output'),
  downloadNodePackage: $('#download-node-package'),
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
  setText('#automation-plan-count', state.farmAutomation.plan?.job_recommendations?.length || 0);
  setText('#automation-alert-count', state.farmAutomation.plan?.alerts?.length || 0);
}

function renderCommandNodeOptions(nodes) {
  const current = elements.commandNode.value;
  if (!nodes.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No nodes';
    elements.commandNode.replaceChildren(option);
    return;
  }

  const options = nodes.map((node) => {
    const option = document.createElement('option');
    option.value = node.node_id;
    option.textContent = `${node.name || 'Node'} (${shortId(node.node_id)})`;
    option.dataset.orgId = node.org_id;
    return option;
  });
  elements.commandNode.replaceChildren(...options);
  if (nodes.some((node) => node.node_id === current)) {
    elements.commandNode.value = current;
  }
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
  const params = new URLSearchParams();
  const orgId = getOrgId();
  if (orgId) params.set('org_id', orgId);
  params.set('limit', String(getRowLimit()));
  const payload = await apiRequest(`/api/cloud/farm-automation?${params.toString()}`);
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

async function refreshMerchantOperationalData(merchantId) {
  const id = merchantId || elements.merchantLookupId.value.trim();
  if (!id) throw new Error('Merchant ID is required');
  elements.merchantKeyMerchantId.value = id;
  elements.merchantLookupId.value = id;
  await Promise.all([
    refreshMerchantApiKeys(id),
    refreshMerchantJobs(id),
    refreshMerchantUsage(id),
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
  const email = elements.adminLoginEmail.value.trim();
  const password = elements.adminLoginPassword.value;
  const payload = await postJson('/api/cloud/admin/login', { email, password });

  elements.adminToken.value = payload.admin_session_token;
  window.localStorage.setItem(storageKeys.token, payload.admin_session_token);
  elements.adminLoginPassword.value = '';
  setAdminAuthState(payload.admin?.email || 'Signed in', 'ready-label');
  showToast('Admin signed in');
  await refreshDashboard();
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

async function handleCreateOrganization(event) {
  event.preventDefault();
  const name = elements.organizationName.value.trim();
  const result = await apiRequest('/api/cloud/organizations', {
    method: 'POST',
    body: { name },
  });
  const organization = result.organization;

  elements.orgId.value = organization.org_id;
  elements.nodeOrgId.value = organization.org_id;
  window.localStorage.setItem(storageKeys.orgId, organization.org_id);
  elements.organizationOutput.hidden = false;
  elements.organizationOutput.textContent = [
    `ORG_ID=${organization.org_id}`,
    `NAME=${organization.name}`,
  ].join('\n');
  showToast('Organization created');
  await refreshOverview();
}

async function handleProvisionNode(event) {
  event.preventDefault();
  const capabilities = parseJsonField(elements.nodeCapabilities.value, {});
  const payload = {
    org_id: elements.nodeOrgId.value.trim(),
    name: elements.nodeName.value.trim(),
    capabilities,
  };

  const result = await apiRequest('/api/cloud/nodes', {
    method: 'POST',
    body: payload,
  });

  state.provisionedNode = {
    id: result.node.node_id,
    name: result.node.name || payload.name,
    token: result.local_node_token,
    cloudApiUrl: window.location.origin,
  };
  elements.nodeTokenOutput.hidden = false;
  elements.nodeTokenOutput.textContent = [
    `CLOUD_API_URL=${window.location.origin}`,
    `LOCAL_NODE_TOKEN=${result.local_node_token}`,
    '',
    `Node ID: ${result.node.node_id}`,
  ].join('\n');
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
  showToast('Windows ZIP downloaded');
}

function applyCommandTemplate(name) {
  const template = commandTemplates[name];
  if (!template) return;
  elements.commandType.value = template.commandType;
  elements.commandPayload.value = JSON.stringify(template.payload, null, 2);
}

async function handleQueueCommand(event) {
  event.preventDefault();
  const selected = elements.commandNode.selectedOptions[0];
  const orgId = selected?.dataset.orgId || getOrgId();
  const payload = {
    org_id: orgId,
    node_id: elements.commandNode.value,
    printer_id: elements.commandPrinter.value.trim() || null,
    job_id: elements.commandJob.value.trim() || null,
    command_type: elements.commandType.value,
    payload: parseJsonField(elements.commandPayload.value, {}),
  };

  await apiRequest('/api/cloud/commands', {
    method: 'POST',
    body: payload,
  });

  showToast('Command queued');
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
  renderFarmAutomation(payload.automation);
  showToast('Farm automation policy saved');
}

async function handleFilamentInventorySubmit(event) {
  event.preventDefault();
  const inventory = parseJsonField(elements.filamentInventoryJson.value, { spools: [] });
  const payload = await apiRequest('/api/cloud/farm-automation', {
    method: 'PATCH',
    body: { inventory },
  });
  renderFarmAutomation(payload.automation);
  showToast('Filament inventory saved');
}

async function handleIntegrationsSubmit(event) {
  event.preventDefault();
  const integrations = parseJsonField(elements.integrationsJson.value, {});
  const payload = await apiRequest('/api/cloud/farm-automation', {
    method: 'PATCH',
    body: { integrations },
  });
  renderFarmAutomation(payload.automation);
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

if (getAdminToken()) {
  refreshDashboard().catch((error) => {
    setApiState('Error', 'error');
    showToast(error.message);
  });
}
