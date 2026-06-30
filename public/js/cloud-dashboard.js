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
  provisionedNode: null,
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  apiState: $('#api-state'),
  adminToken: $('#admin-token'),
  orgId: $('#org-id'),
  rowLimit: $('#row-limit'),
  saveToken: $('#save-token'),
  refresh: $('#refresh'),
  setupStatus: $('#setup-status'),
  setupStatusBody: $('#setup-status-body'),
  metrics: $('#metrics'),
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
  toast: $('#toast'),
};

function setApiState(label, mode = '') {
  elements.apiState.textContent = label;
  elements.apiState.className = `state-pill ${mode}`.trim();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 4000);
}

function getAdminToken() {
  return elements.adminToken.value.trim();
}

function getOrgId() {
  return elements.orgId.value.trim();
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

function jsonSummary(value) {
  if (!value || typeof value !== 'object') return '-';
  const text = JSON.stringify(value);
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

function makeStatus(value) {
  const span = document.createElement('span');
  span.className = `status ${String(value || 'unknown')}`;
  span.textContent = value || 'unknown';
  return span;
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

function renderMetrics(overview) {
  const metrics = [
    ['Nodes', overview.nodes.length],
    ['Printers', overview.printers.length],
    ['Jobs', overview.jobs.length],
    ['Commands', overview.commands.length],
    ['Events', overview.events.length],
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

function updateCounts(overview) {
  $('#node-count').textContent = String(overview.nodes.length);
  $('#printer-count').textContent = String(overview.printers.length);
  $('#job-count').textContent = String(overview.jobs.length);
  $('#command-count').textContent = String(overview.commands.length);
  $('#event-count').textContent = String(overview.events.length);
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

function renderOverview() {
  const overview = state.overview;
  renderMetrics(overview);
  updateCounts(overview);
  renderCommandNodeOptions(overview.nodes);

  renderTable('#nodes-table', [
    { label: 'Node', value: (row) => row.name || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Version', value: (row) => row.agent_version || '-' },
    { label: 'Host', value: (row) => row.host_info?.hostname || '-' },
    { label: 'Last seen', value: (row) => formatDate(row.last_seen_at) },
    { label: 'Node ID', value: (row) => shortId(row.node_id) },
  ], overview.nodes, 'No nodes found.');

  renderTable('#printers-table', [
    { label: 'Printer', value: (row) => row.name || row.local_printer_id || '-' },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Model', value: (row) => row.model || '-' },
    { label: 'Local ID', value: (row) => row.local_printer_id || '-' },
    { label: 'Last seen', value: (row) => formatDate(row.last_seen_at) },
    { label: 'Snapshot', value: (row) => jsonSummary(row.status_snapshot) },
  ], overview.printers, 'No printers found.');

  renderTable('#jobs-table', [
    { label: 'Job', value: (row) => row.name || shortId(row.job_id) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Node', value: (row) => shortId(row.node_id) },
    { label: 'Printer', value: (row) => shortId(row.printer_id) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Options', value: (row) => jsonSummary(row.options) },
  ], overview.jobs, 'No jobs found.');

  renderTable('#commands-table', [
    { label: 'Command', value: (row) => row.command_type || shortId(row.command_id) },
    { label: 'Status', value: (row) => makeStatus(row.status) },
    { label: 'Node', value: (row) => shortId(row.node_id) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Finished', value: (row) => formatDate(row.finished_at) },
    { label: 'Payload', value: (row) => jsonSummary(row.payload) },
  ], overview.commands, 'No commands found.');

  renderTable('#events-table', [
    { label: 'Event', value: (row) => row.event_type || shortId(row.event_id) },
    { label: 'Node', value: (row) => shortId(row.node_id) },
    { label: 'Printer', value: (row) => shortId(row.printer_id) },
    { label: 'Command', value: (row) => shortId(row.command_id) },
    { label: 'Created', value: (row) => formatDate(row.created_at) },
    { label: 'Payload', value: (row) => jsonSummary(row.payload) },
  ], overview.events, 'No events found.');
}

async function refreshOverview() {
  const params = new URLSearchParams();
  const orgId = getOrgId();
  const limit = elements.rowLimit.value || '50';
  if (orgId) params.set('org_id', orgId);
  params.set('limit', limit);

  setApiState('Loading');
  const payload = await apiRequest(`/api/cloud/overview?${params.toString()}`);
  state.overview = payload.overview;
  renderOverview();
  setApiState('Connected', 'online');
}

async function refreshDashboard() {
  setApiState('Loading');
  const setup = await refreshSetupStatus();
  if (!setup.ready) {
    setApiState('Setup needed', 'error');
    return;
  }
  await refreshOverview();
}

function syncOrgFields() {
  const orgId = getOrgId();
  if (orgId && !elements.nodeOrgId.value.trim()) {
    elements.nodeOrgId.value = orgId;
  }
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

function restoreSettings() {
  elements.adminToken.value = window.localStorage.getItem(storageKeys.token) || '';
  elements.orgId.value = window.localStorage.getItem(storageKeys.orgId) || '';
  elements.nodeOrgId.value = elements.orgId.value;
}

function bindEvents() {
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

  elements.orgId.addEventListener('input', syncOrgFields);
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
}

restoreSettings();
bindEvents();
renderOverview();

if (getAdminToken()) {
  refreshDashboard().catch((error) => {
    setApiState('Error', 'error');
    showToast(error.message);
  });
}
