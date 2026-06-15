const API_URL = 'https://script.google.com/macros/s/AKfycbxyMRYjANF1zyENakj_u27VqYq7DDO11mEwG5EgJrdkUskNty-azjNHGS-8qw2gUxB-/exec';
const HUB_API_URL =
  'https://script.google.com/macros/s/AKfycbyAHpUfM1RrPJbamCVcc5rGhUgRKoLRKSULBGnCNGLyCSaFU5lp7SX2Ge1Wwv9YEV5-Sg/exec';
const HUB_URL = '/hub/';
const SHARED_AUTH_TOKEN_KEY = 'tools501_google_id_token';
const REQUEST_TIMEOUT_MS = 25000;
const DIAGRAM_BASE_SCALE = 0.5;

let authToken = '';
let pendingTwoFactorAuth = null;
let diagrams = [];
let activeDiagramId = '';
let diagramZoom = 100;
const diagramUrls = new Map();

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

  diagrams = Array.isArray(data.diagrams)
    ? data.diagrams
    : [];

  document.title = ui.appTitle || 'Dashboard';
  document.getElementById('appTitle').textContent =
    ui.appTitle || '';
  document.getElementById('userName').textContent =
    user.name || user.email || '';
  document.getElementById('dashboardEmpty').textContent =
    ui.emptyDashboard || 'Дані відсутні';

  activeDiagramId =
    diagrams[0] && diagrams[0].id || '';

  renderTabs();
  renderActiveDiagram();
}

function renderTabs() {
  const tabs = document.getElementById('dashboardTabs');

  tabs.replaceChildren();

  diagrams.forEach(diagram => {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'tab-button';
    button.textContent = diagram.title;
    button.classList.toggle(
      'active',
      diagram.id === activeDiagramId
    );
    button.addEventListener('click', () => {
      activeDiagramId = diagram.id;
      diagramZoom = 100;
      renderTabs();
      renderActiveDiagram();
    });
    tabs.appendChild(button);
  });
}

async function renderActiveDiagram() {
  const diagram = diagrams.find(item =>
    item.id === activeDiagramId
  );
  const viewport = document.getElementById('dashboardViewport');
  const image = document.getElementById('diagramImage');
  const loader = document.getElementById('diagramLoader');
  const empty = document.getElementById('dashboardEmpty');

  if (!diagram) {
    viewport.classList.add('hidden');
    empty.classList.remove('hidden');
    document.getElementById('dashboardTitle').textContent = '';
    return;
  }

  viewport.classList.remove('hidden');
  empty.classList.add('hidden');
  document.getElementById('dashboardTitle').textContent =
    diagram.title;
  image.classList.add('hidden');
  loader.classList.remove('hidden');

  try {
    let url = diagramUrls.get(diagram.id);

    if (!url) {
      const result = await projectApi(
        'getDiagram',
        { id: diagram.id }
      );

      if (!result.success) {
        throw new Error(result.error || 'DIAGRAM_LOAD_FAILED');
      }

      const bytes = base64ToBytes(result.data.base64);
      const blob = new Blob(
        [bytes],
        { type: result.data.mimeType || 'image/svg+xml' }
      );

      url = URL.createObjectURL(blob);
      diagramUrls.set(diagram.id, url);
    }

    if (activeDiagramId !== diagram.id) {
      return;
    }

    image.src = url;
    image.alt = diagram.title;
    applyDiagramZoom();
    image.classList.remove('hidden');
  } catch (error) {
    console.error(error);
    showToast('Не вдалося завантажити схему');
    image.classList.add('hidden');
  } finally {
    if (activeDiagramId === diagram.id) {
      loader.classList.add('hidden');
    }
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function applyDiagramZoom() {
  const image = document.getElementById('diagramImage');
  const renderedWidth = diagramZoom * DIAGRAM_BASE_SCALE;

  image.style.width = `${renderedWidth}%`;
  document.getElementById('zoomResetBtn').textContent =
    `${diagramZoom}%`;
  document.getElementById('zoomOutBtn').disabled =
    diagramZoom <= 50;
  document.getElementById('zoomInBtn').disabled =
    diagramZoom >= 250;
}

function changeDiagramZoom(change) {
  diagramZoom = Math.min(
    250,
    Math.max(50, diagramZoom + change)
  );
  applyDiagramZoom();
}

function resetDiagramZoom() {
  diagramZoom = 100;
  applyDiagramZoom();
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
document.getElementById('zoomOutBtn')
  .addEventListener('click', () => changeDiagramZoom(-25));
document.getElementById('zoomResetBtn')
  .addEventListener('click', resetDiagramZoom);
document.getElementById('zoomInBtn')
  .addEventListener('click', () => changeDiagramZoom(25));

trySharedSession();
