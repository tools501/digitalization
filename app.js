const API_URL = 'https://script.google.com/macros/s/AKfycbxyMRYjANF1zyENakj_u27VqYq7DDO11mEwG5EgJrdkUskNty-azjNHGS-8qw2gUxB-/exec';
const HUB_API_URL =
  'https://script.google.com/macros/s/AKfycbyAHpUfM1RrPJbamCVcc5rGhUgRKoLRKSULBGnCNGLyCSaFU5lp7SX2Ge1Wwv9YEV5-Sg/exec';
const HUB_URL = '/hub/';
const SHARED_AUTH_TOKEN_KEY = 'tools501_google_id_token';
const REQUEST_TIMEOUT_MS = 25000;

let authToken = '';
let pendingTwoFactorAuth = null;
let dashboards = [];
let activeDashboardId = '';
let sessionWarningTimer = null;
let sessionExpiredTimer = null;
let sessionCountdownTimer = null;

function getSharedAuthToken() {
  try {
    return sessionStorage.getItem(SHARED_AUTH_TOKEN_KEY);
  } catch (error) {
    return null;
  }
}

function setSharedAuthToken(token) {
  try {
    sessionStorage.setItem(SHARED_AUTH_TOKEN_KEY, token);
  } catch (error) {
    console.error(error);
  }
}

function clearSharedAuthToken() {
  try {
    sessionStorage.removeItem(SHARED_AUTH_TOKEN_KEY);
  } catch (error) {
    console.error(error);
  }
}

function showOnly(id) {
  [
    'loginPage',
    'loader',
    'twoFactorPage',
    'deniedPage',
    'app'
  ].forEach(elementId => {
    document
      .getElementById(elementId)
      .classList.toggle('hidden', elementId !== id);
  });
}

async function requestJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function projectApi(action, data = {}, token = authToken) {
  if (API_URL === 'PASTE_DIGITALIZATION_GAS_URL_HERE') {
    throw new Error('API_URL_NOT_CONFIGURED');
  }

  const body = new URLSearchParams();

  body.append(
    'payload',
    JSON.stringify({
      token,
      action,
      data
    })
  );

  return requestJson(API_URL, {
    method: 'POST',
    body
  });
}

async function hubApi(action, data = {}, token = authToken) {
  const body = new URLSearchParams();

  body.append(
    'payload',
    JSON.stringify({
      token,
      action,
      data
    })
  );

  return requestJson(HUB_API_URL, {
    method: 'POST',
    body
  });
}

async function handleCredentialResponse(response) {
  if (!response || !response.credential) {
    return;
  }

  await authenticateWithToken(
    response.credential,
    {
      persist: true
    }
  );
}

async function ensureTwoFactorAccess(token, options) {
  const result = await hubApi('check2fa', {}, token);

  if (!result.success) {
    throw new Error(result.error || 'TWO_FACTOR_CHECK_FAILED');
  }

  const twoFactor =
    result.data && result.data.twoFactor;

  if (!twoFactor || !twoFactor.required) {
    return true;
  }

  if (twoFactor.setupRequired) {
    setSharedAuthToken(token);
    window.location.href = HUB_URL;
    return false;
  }

  pendingTwoFactorAuth = {
    token,
    options
  };

  document.getElementById('twoFactorCode').value = '';
  showOnly('twoFactorPage');
  document.getElementById('twoFactorCode').focus();
  return false;
}

async function submitTwoFactorCode() {
  const pending = pendingTwoFactorAuth;
  const input = document.getElementById('twoFactorCode');
  const button = document.getElementById('twoFactorSubmitBtn');
  const code = input.value.trim();

  if (!pending) {
    return;
  }

  if (!/^\d{6}$/.test(code)) {
    showToast('Введіть 6 цифр');
    return;
  }

  button.disabled = true;

  try {
    const result = await hubApi(
      'verify2faGate',
      { code },
      pending.token
    );

    if (!result.success) {
      showToast(
        result.error === 'TWO_FACTOR_INVALID'
          ? 'Невірний код'
          : 'Не вдалося перевірити 2FA'
      );
      return;
    }

    const resume = pendingTwoFactorAuth;

    pendingTwoFactorAuth = null;

    await authenticateWithToken(
      resume.token,
      {
        ...resume.options,
        skipTwoFactor: true
      }
    );
  } catch (error) {
    console.error(error);
    showRequestError('Не вдалося перевірити 2FA', error);
  } finally {
    button.disabled = false;
  }
}

function cancelTwoFactor() {
  pendingTwoFactorAuth = null;
  authToken = '';
  clearSharedAuthToken();
  showOnly('loginPage');
}

async function authenticateWithToken(token, options = {}) {
  authToken = token;
  showOnly('loader');

  try {
    if (!options.skipTwoFactor) {
      const canContinue = await ensureTwoFactorAccess(
        token,
        options
      );

      if (!canContinue) {
        return;
      }
    }

    const result = await projectApi('bootstrap', {}, token);

    if (!result.success) {
      if (result.error === 'ACCESS_DENIED') {
        showOnly('deniedPage');
        return;
      }

      throw new Error(result.error || 'BOOTSTRAP_FAILED');
    }

    if (options.persist) {
      setSharedAuthToken(token);
    }

    applyBootstrap(result.data);
    startSessionTimer(token);
    showOnly('app');
  } catch (error) {
    console.error(error);
    authToken = '';

    if (options.fromSharedSession) {
      clearSharedAuthToken();
      showOnly('loginPage');
      return;
    }

    showOnly('loginPage');
    showRequestError('Не вдалося завантажити дані', error);
  }
}

function applyBootstrap(data) {
  const ui = data.ui || {};
  const user = data.user || {};

  dashboards = Array.isArray(data.dashboards)
    ? data.dashboards
    : [];

  document.title = ui.appTitle || 'Dashboard';
  document.getElementById('appTitle').textContent =
    ui.appTitle || '';
  document.getElementById('userName').textContent =
    user.name || user.email || '';
  document.getElementById('dashboardEmpty').textContent =
    ui.emptyDashboard || 'Дані відсутні';

  activeDashboardId =
    dashboards[0] && dashboards[0].dashboard_id || '';

  renderTabs();
  renderActiveDashboard();
}

function renderTabs() {
  const tabs = document.getElementById('dashboardTabs');

  tabs.replaceChildren();

  dashboards.forEach(dashboard => {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'tab-button';
    button.textContent = dashboard.title;
    button.classList.toggle(
      'active',
      dashboard.dashboard_id === activeDashboardId
    );
    button.addEventListener('click', () => {
      activeDashboardId = dashboard.dashboard_id;
      renderTabs();
      renderActiveDashboard();
    });
    tabs.appendChild(button);
  });
}

function renderActiveDashboard() {
  const dashboard = dashboards.find(item =>
    item.dashboard_id === activeDashboardId
  );
  const canvas = document.getElementById('dashboardCanvas');
  const nodesLayer = document.getElementById('dashboardNodes');
  const linksLayer = document.getElementById('dashboardLinks');
  const viewport = document.getElementById('dashboardViewport');
  const empty = document.getElementById('dashboardEmpty');

  nodesLayer.replaceChildren();
  linksLayer.replaceChildren();

  if (!dashboard || !dashboard.nodes.length) {
    viewport.classList.add('hidden');
    empty.classList.remove('hidden');
    document.getElementById('dashboardTitle').textContent =
      dashboard ? dashboard.title : '';
    return;
  }

  viewport.classList.remove('hidden');
  empty.classList.add('hidden');
  document.getElementById('dashboardTitle').textContent =
    dashboard.title;

  const bounds = getDashboardBounds(dashboard.nodes);

  canvas.style.width = `${bounds.width}px`;
  canvas.style.height = `${bounds.height}px`;
  canvas.style.minHeight = `${bounds.height}px`;
  linksLayer.setAttribute(
    'viewBox',
    `0 0 ${bounds.width} ${bounds.height}`
  );

  dashboard.nodes.forEach(node => {
    nodesLayer.appendChild(createNode(node));
  });

  dashboard.links.forEach(link => {
    const path = createLink(link, dashboard.nodes);

    if (path) {
      linksLayer.appendChild(path);
    }
  });
}

function getDashboardBounds(nodes) {
  const padding = 36;
  const minimumWidth = activeDashboardId === 'systems'
    ? 620
    : 760;
  const width = Math.max(
    minimumWidth,
    ...nodes.map(node =>
      Number(node.x) + Number(node.width) + padding
    )
  );
  const height = Math.max(
    480,
    ...nodes.map(node =>
      Number(node.y) + Number(node.height) + padding
    )
  );

  return { width, height };
}

function createNode(node) {
  const element = document.createElement('article');
  const title = document.createElement('div');

  element.className = 'dashboard-node';
  element.dataset.color = node.color || node.block_type;
  element.dataset.shape = node.shape || 'rect';
  element.style.left = `${Number(node.x)}px`;
  element.style.top = `${Number(node.y)}px`;
  element.style.width = `${Number(node.width)}px`;
  element.style.height = `${Number(node.height)}px`;

  if (
    node.block_type === 'system' ||
    node.block_type === 'system_group'
  ) {
    element.classList.add('dashboard-node-system');
  }

  if (node.block_type === 'system_group') {
    element.classList.add('dashboard-node-group');
  }

  title.className = 'dashboard-node-title';
  title.textContent = node.title;
  element.appendChild(title);

  if (
    node.block_type === 'unit' &&
    node.dashboard_id === 'structure' &&
    Array.isArray(node.systems) &&
    node.systems.length
  ) {
    const systems = document.createElement('div');

    systems.className = 'node-systems';

    node.systems.forEach(system => {
      const chip = document.createElement('span');

      chip.className = 'system-chip';
      chip.textContent = system.name;
      systems.appendChild(chip);
    });

    element.appendChild(systems);
  }

  return element;
}

function createLink(link, nodes) {
  const source = nodes.find(node =>
    node.node_id === link.source_id
  );
  const target = nodes.find(node =>
    node.node_id === link.target_id
  );

  if (!source || !target) {
    return null;
  }

  const isSystem = link.type === 'system';
  const start = isSystem
    ? {
        x: Number(source.x) + Number(source.width),
        y: Number(source.y) + Number(source.height) / 2
      }
    : {
        x: Number(source.x) + Number(source.width) / 2,
        y: Number(source.y) + Number(source.height)
      };
  const end = isSystem
    ? {
        x: Number(target.x),
        y: Number(target.y) + Number(target.height) / 2
      }
    : {
        x: Number(target.x) + Number(target.width) / 2,
        y: Number(target.y)
      };
  const path = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'path'
  );
  let d;

  if (isSystem) {
    const distance = Math.max(80, (end.x - start.x) * .45);
    d = [
      `M ${start.x} ${start.y}`,
      `C ${start.x + distance} ${start.y},`,
      `${end.x - distance} ${end.y},`,
      `${end.x} ${end.y}`
    ].join(' ');
  } else {
    const middleY = start.y + (end.y - start.y) / 2;
    d = [
      `M ${start.x} ${start.y}`,
      `L ${start.x} ${middleY}`,
      `L ${end.x} ${middleY}`,
      `L ${end.x} ${end.y}`
    ].join(' ');
  }

  path.setAttribute('d', d);
  path.setAttribute(
    'class',
    `dashboard-link ${isSystem ? 'system' : ''}`
  );

  return path;
}

function decodeTokenPayload(token) {
  try {
    const payload = token.split('.')[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padded = payload.padEnd(
      Math.ceil(payload.length / 4) * 4,
      '='
    );

    return JSON.parse(atob(padded));
  } catch (error) {
    return null;
  }
}

function startSessionTimer(token) {
  clearSessionTimers();

  const payload = decodeTokenPayload(token);
  const expiresAt = Number(payload && payload.exp) * 1000;

  if (!expiresAt) {
    return;
  }

  const warningAt = Math.max(
    0,
    expiresAt - Date.now() - 5 * 60 * 1000
  );
  const expiresIn = Math.max(0, expiresAt - Date.now());

  sessionWarningTimer = setTimeout(
    showSessionWarning,
    warningAt
  );
  sessionExpiredTimer = setTimeout(
    expireSession,
    expiresIn
  );
}

function showSessionWarning() {
  const warning = document.getElementById('sessionWarning');

  warning.classList.remove('hidden');
  updateSessionCountdown();
  sessionCountdownTimer = setInterval(
    updateSessionCountdown,
    1000
  );
}

function updateSessionCountdown() {
  const payload = decodeTokenPayload(authToken);
  const remaining = Math.max(
    0,
    Number(payload && payload.exp) * 1000 - Date.now()
  );
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);

  document.getElementById('sessionCountdown').textContent =
    `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function expireSession() {
  authToken = '';
  clearSharedAuthToken();
  clearSessionTimers();
  document.getElementById('sessionWarning')
    .classList.add('hidden');
  document.getElementById('sessionExpired')
    .classList.remove('hidden');
}

function clearSessionTimers() {
  clearTimeout(sessionWarningTimer);
  clearTimeout(sessionExpiredTimer);
  clearInterval(sessionCountdownTimer);
}

function goToHub() {
  window.location.href = HUB_URL;
}

function showToast(message) {
  const toast = document.getElementById('toast');

  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(
    () => toast.classList.add('hidden'),
    3000
  );
}

function showRequestError(fallback, error) {
  if (error && error.name === 'AbortError') {
    showToast('Сервер відповідає надто довго');
    return;
  }

  if (error && error.message === 'API_URL_NOT_CONFIGURED') {
    showToast('Додайте URL нового GAS deployment');
    return;
  }

  showToast(fallback);
}

async function trySharedSession() {
  const token = getSharedAuthToken();

  if (!token) {
    return;
  }

  await authenticateWithToken(
    token,
    {
      fromSharedSession: true
    }
  );
}

document
  .getElementById('twoFactorSubmitBtn')
  .addEventListener('click', submitTwoFactorCode);

document
  .getElementById('twoFactorCancelBtn')
  .addEventListener('click', cancelTwoFactor);

document
  .getElementById('twoFactorCode')
  .addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      submitTwoFactorCode();
    }
  });

document.getElementById('hubBtn')
  .addEventListener('click', goToHub);
document.getElementById('deniedHubBtn')
  .addEventListener('click', goToHub);
document.getElementById('renewSessionBtn')
  .addEventListener('click', goToHub);
document.getElementById('expiredSessionBtn')
  .addEventListener('click', goToHub);

trySharedSession();
