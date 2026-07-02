// Merchant portal: email/password sign-in for merchants, password reset, and
// API key management over the merchant-user session endpoints. Machine
// integrations keep using pkx_live_ API keys — this page is for humans.

const SESSION_KEY = 'pkxMerchantSessionToken';

const $ = (selector) => document.querySelector(selector);

const elements = {
  subtitle: $('#portal-subtitle'),
  logoutBtn: $('#logout-btn'),
  signinView: $('#signin-view'),
  resetView: $('#reset-view'),
  portalView: $('#portal-view'),
  loginForm: $('#login-form'),
  loginEmail: $('#login-email'),
  loginPassword: $('#login-password'),
  loginStatus: $('#login-status'),
  showForgot: $('#show-forgot'),
  forgotForm: $('#forgot-form'),
  forgotEmail: $('#forgot-email'),
  forgotStatus: $('#forgot-status'),
  resetForm: $('#reset-form'),
  resetPassword: $('#reset-password'),
  resetStatus: $('#reset-status'),
  companyName: $('#company-name'),
  merchantStatus: $('#merchant-status'),
  userEmail: $('#user-email'),
  approvalMode: $('#approval-mode'),
  memberSince: $('#member-since'),
  pendingNotice: $('#pending-notice'),
  apiKeysTable: $('#api-keys-table'),
  createKeyForm: $('#create-key-form'),
  newKeyName: $('#new-key-name'),
  keySecretOutput: $('#key-secret-output'),
  keysStatus: $('#keys-status'),
};

function getSessionToken() {
  return window.localStorage.getItem(SESSION_KEY) || '';
}

function setStatus(element, message, isError = false) {
  if (!element) return;
  element.hidden = !message;
  element.textContent = message || '';
  element.className = `status-box ${isError ? 'error' : ''}`.trim();
}

async function requestJson(path, { method = 'GET', body = null, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getSessionToken();
    if (!token) throw new Error('not_signed_in');
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || payload.message || `Request failed with ${response.status}`);
  }
  return payload;
}

function showView(view) {
  elements.signinView.hidden = view !== 'signin';
  elements.resetView.hidden = view !== 'reset';
  elements.portalView.hidden = view !== 'portal';
  elements.logoutBtn.hidden = view !== 'portal';
  if (elements.subtitle) {
    elements.subtitle.textContent = view === 'portal'
      ? 'Manage your account, API keys, and print jobs.'
      : 'Sign in to manage your print farm account.';
  }
}

function statusPill(status) {
  const pill = document.createElement('span');
  pill.className = `pill ${status || ''}`.trim();
  pill.textContent = status || 'unknown';
  return pill;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function renderPortal({ merchant, merchant_user: merchantUser }) {
  elements.companyName.textContent = merchant?.company_name || 'Your account';
  elements.merchantStatus.replaceChildren(statusPill(merchant?.status));
  elements.userEmail.textContent = merchantUser?.email || '—';
  elements.approvalMode.textContent = merchant?.approval_mode || '—';
  elements.memberSince.textContent = formatDate(merchant?.created_at);
  elements.pendingNotice.hidden = merchant?.status === 'active';
}

function renderApiKeys(apiKeys) {
  if (!apiKeys.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No API keys yet — create your first key below.';
    elements.apiKeysTable.replaceChildren(empty);
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr>';
  const tbody = document.createElement('tbody');

  for (const key of apiKeys) {
    const tr = document.createElement('tr');
    const cells = [
      key.name || '—',
      key.key_prefix ? `${key.key_prefix}…` : '—',
      formatDate(key.created_at),
      formatDate(key.last_used_at),
      key.revoked_at ? 'revoked' : 'active',
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    const actions = document.createElement('td');
    if (!key.revoked_at) {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'ghost small';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', () => {
        handleRevokeKey(key.key_id).catch((error) => setStatus(elements.keysStatus, error.message, true));
      });
      actions.append(revoke);
    }
    tr.append(actions);
    tbody.append(tr);
  }

  table.append(thead, tbody);
  elements.apiKeysTable.replaceChildren(table);
}

async function refreshApiKeys() {
  try {
    const payload = await requestJson('/api/public/api-keys');
    setStatus(elements.keysStatus, '');
    renderApiKeys(payload.api_keys || []);
  } catch (error) {
    if (error.message === 'merchant_not_active') {
      renderApiKeys([]);
      setStatus(elements.keysStatus, 'API keys unlock once your account is approved.', false);
      return;
    }
    setStatus(elements.keysStatus, error.message, true);
  }
}

async function enterPortal(sessionPayload) {
  renderPortal(sessionPayload);
  showView('portal');
  await refreshApiKeys();
}

async function handleLogin(event) {
  event.preventDefault();
  setStatus(elements.loginStatus, '');
  try {
    const payload = await requestJson('/api/public/merchant/login', {
      method: 'POST',
      auth: false,
      body: {
        email: elements.loginEmail.value.trim(),
        password: elements.loginPassword.value,
      },
    });
    window.localStorage.setItem(SESSION_KEY, payload.merchant_session_token);
    elements.loginPassword.value = '';
    await enterPortal(payload);
  } catch (error) {
    if (/invalid_merchant_credentials/.test(error.message)) {
      setStatus(elements.loginStatus, 'Incorrect email or password.', true);
    } else if (/rate_limited/.test(error.message)) {
      setStatus(elements.loginStatus, 'Too many attempts — wait a minute and try again.', true);
    } else {
      setStatus(elements.loginStatus, error.message, true);
    }
  }
}

async function handleForgot(event) {
  event.preventDefault();
  try {
    const payload = await requestJson('/api/public/merchant/password-reset', {
      method: 'POST',
      auth: false,
      body: { email: elements.forgotEmail.value.trim() },
    });
    setStatus(elements.forgotStatus, payload.message
      || 'If that email belongs to a merchant account, a reset link has been sent.');
  } catch (error) {
    setStatus(elements.forgotStatus, error.message, true);
  }
}

async function handleReset(event) {
  event.preventDefault();
  const params = new URLSearchParams(window.location.search);
  try {
    await requestJson('/api/public/merchant/password', {
      method: 'POST',
      auth: false,
      body: {
        reset_token: params.get('reset_token'),
        password: elements.resetPassword.value,
      },
    });
    elements.resetPassword.value = '';
    window.history.replaceState({}, '', '/merchant');
    setStatus(elements.loginStatus, '');
    showView('signin');
    setStatus(elements.forgotStatus, '');
    setStatus(elements.loginStatus, 'Password updated — sign in with your new password.', false);
  } catch (error) {
    setStatus(elements.resetStatus, error.message, true);
  }
}

async function handleCreateKey(event) {
  event.preventDefault();
  try {
    const payload = await requestJson('/api/public/api-keys', {
      method: 'POST',
      body: { name: elements.newKeyName.value.trim() || 'Production' },
    });
    elements.keySecretOutput.hidden = false;
    elements.keySecretOutput.textContent = [
      'Copy this key now — it is shown only once.',
      `API_KEY=${payload.api_key_secret}`,
    ].join('\n');
    await refreshApiKeys();
  } catch (error) {
    setStatus(elements.keysStatus, error.message === 'merchant_not_active'
      ? 'API keys unlock once your account is approved.'
      : error.message, true);
  }
}

async function handleRevokeKey(keyId) {
  await requestJson('/api/public/api-keys/revoke', {
    method: 'POST',
    body: { key_id: keyId },
  });
  await refreshApiKeys();
}

function handleLogout() {
  requestJson('/api/public/merchant/logout', { method: 'POST' }).catch(() => {});
  window.localStorage.removeItem(SESSION_KEY);
  showView('signin');
}

async function initView() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('reset_token')) {
    showView('reset');
    return;
  }

  if (!getSessionToken()) {
    showView('signin');
    return;
  }

  try {
    const payload = await requestJson('/api/public/merchant/session');
    await enterPortal(payload);
  } catch {
    window.localStorage.removeItem(SESSION_KEY);
    showView('signin');
  }
}

elements.loginForm.addEventListener('submit', handleLogin);
elements.forgotForm.addEventListener('submit', handleForgot);
elements.resetForm.addEventListener('submit', handleReset);
elements.createKeyForm.addEventListener('submit', handleCreateKey);
elements.logoutBtn.addEventListener('click', handleLogout);
elements.showForgot.addEventListener('click', () => {
  elements.forgotForm.hidden = !elements.forgotForm.hidden;
});

initView();
