const API_URL = 'https://script.google.com/macros/s/AKfycbxyMRYjANF1zyENakj_u27VqYq7DDO11mEwG5EgJrdkUskNty-azjNHGS-8qw2gUxB-/exec';
const HUB_API_URL =
  'https://script.google.com/macros/s/AKfycbyAHpUfM1RrPJbamCVcc5rGhUgRKoLRKSULBGnCNGLyCSaFU5lp7SX2Ge1Wwv9YEV5-Sg/exec';
const HUB_URL = '/hub/';
const SHARED_AUTH_TOKEN_KEY = 'tools501_google_id_token';
const REQUEST_TIMEOUT_MS = 25000;
const MOBILE_VIEWPORT_QUERY = '(max-width: 760px)';
const ICS_REGISTRY_TAB_ID = 'ics-registry';

let authToken = '';
let pendingTwoFactorAuth = null;
let diagrams = [];
let icsSystems = [];
let icsOptions = { units: [], commands: [] };
let activeDiagramId = ICS_REGISTRY_TAB_ID;
let diagramZoom = 100;
const diagramUrls = new Map();
let icsModalCloseTimer = null;

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
  icsSystems = Array.isArray(data.icsSystems)
    ? data.icsSystems
    : [];
  icsOptions = data.icsOptions || { units: [], commands: [] };

  document.title = ui.appTitle || 'Dashboard';
  document.getElementById('appTitle').textContent =
    ui.appTitle || '';
  document.getElementById('userName').textContent =
    user.name || user.email || '';
  document.getElementById('dashboardEmpty').textContent =
    ui.emptyDashboard || 'Дані відсутні';

  activeDiagramId = ICS_REGISTRY_TAB_ID;

  renderTabs();
  renderCurrentView();
}

function renderTabs() {
  const tabs = document.getElementById('dashboardTabs');

  tabs.replaceChildren();

  tabs.appendChild(createTabButton(
    ICS_REGISTRY_TAB_ID,
    'Облік ІКС'
  ));

  diagrams.forEach(diagram => {
    tabs.appendChild(createTabButton(diagram.id, diagram.title));
  });
}

function createTabButton(id, title) {
  const button = document.createElement('button');

  button.type = 'button';
  button.className = 'tab-button';
  button.textContent = title;
  button.classList.toggle('active', id === activeDiagramId);
  button.addEventListener('click', () => {
    activeDiagramId = id;
    diagramZoom = 100;
    renderTabs();
    renderCurrentView();
  });

  return button;
}

function renderCurrentView() {
  const registry = document.getElementById('icsRegistry');
  const dashboard = document.getElementById('dashboardShell');
  const app = document.getElementById('app');
  const isRegistry = activeDiagramId === ICS_REGISTRY_TAB_ID;

  registry.classList.toggle('hidden', !isRegistry);
  dashboard.classList.toggle('hidden', isRegistry);
  app.classList.toggle('registry-mode', isRegistry);

  if (isRegistry) {
    renderIcsList();
    return;
  }

  renderActiveDiagram();
}

function renderIcsList() {
  const list = document.getElementById('icsList');
  const empty = document.getElementById('icsEmpty');

  list.replaceChildren();
  empty.classList.toggle('hidden', icsSystems.length > 0);

  icsSystems.forEach(item => {
    const card = document.createElement('button');
    const visual = createIcsVisual(item);
    const name = document.createElement('span');

    card.type = 'button';
    card.className = 'ics-card';
    card.setAttribute('aria-label', `Відкрити ${item.name}`);
    name.className = 'ics-card-name';
    name.textContent = item.name;
    card.append(visual, name);
    card.addEventListener('click', () => openIcsDetails(item));
    list.appendChild(card);
  });
}

function createIcsVisual(item) {
  const visual = document.createElement('span');

  visual.className = 'ics-card-visual';

  if (item.logoUrl) {
    const image = document.createElement('img');

    image.src = item.logoUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      visual.replaceChildren(createIcsMonogram(item.name));
    });
    visual.appendChild(image);
  } else {
    visual.appendChild(createIcsMonogram(item.name));
  }

  return visual;
}

function createIcsMonogram(name) {
  const monogram = document.createElement('span');

  monogram.className = 'ics-monogram';
  monogram.textContent = String(name || 'ІКС').trim().slice(0, 2).toUpperCase();
  return monogram;
}

function openIcsDetails(item) {
  const details = document.getElementById('icsDetails');

  document.getElementById('icsModalTitle').textContent = item.name;
  document.getElementById('icsForm').classList.add('hidden');
  details.classList.remove('hidden');
  details.replaceChildren();

  appendIcsDetail(details, 'Про ІКС', item.about);
  appendIcsLink(details, 'Посилання', item.url);
  appendIcsDetail(details, 'Документація ІКС', item.documentation);
  appendIcsDetail(details, 'Інформація про розгортання', item.deploymentInfo);
  appendIcsDetail(details, 'Підрозділи', item.units && item.units.join(', '));
  appendIcsDetail(
    details,
    'Командування',
    item.commands && item.commands.join(', ')
  );
  showIcsModal();
}

function appendIcsDetail(container, label, value) {
  const row = document.createElement('div');
  const title = document.createElement('dt');
  const content = document.createElement('dd');

  row.className = 'ics-detail-row';
  title.textContent = label;
  content.textContent = value || 'Не вказано';
  row.append(title, content);
  container.appendChild(row);
}

function appendIcsLink(container, label, url) {
  if (!url) {
    appendIcsDetail(container, label, 'Не вказано');
    return;
  }

  const row = document.createElement('div');
  const title = document.createElement('dt');
  const content = document.createElement('dd');
  const link = document.createElement('a');

  row.className = 'ics-detail-row';
  title.textContent = label;
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Відкрити';
  content.appendChild(link);
  row.append(title, content);
  container.appendChild(row);
}

function openIcsForm() {
  const form = document.getElementById('icsForm');

  document.getElementById('icsModalTitle').textContent = 'Додати ІКС';
  document.getElementById('icsDetails').classList.add('hidden');
  form.classList.remove('hidden');
  form.reset();
  renderIcsSelectOptions();
  showIcsModal();
  form.elements.name.focus();
}

function renderIcsSelectOptions() {
  const units = document.getElementById('icsUnits');
  const commands = document.getElementById('icsCommands');

  units.replaceChildren(...(icsOptions.units || []).map(createOption));
  commands.replaceChildren(
    ...(icsOptions.commands || []).map(createOption)
  );
}

function createOption(value) {
  const option = document.createElement('option');

  option.value = value;
  option.textContent = value;
  return option;
}

function showIcsModal() {
  const modal = document.getElementById('icsModal');

  clearTimeout(icsModalCloseTimer);
  modal.classList.remove('hidden', 'closing');
  document.body.classList.add('modal-open');
}

function closeIcsModal() {
  const modal = document.getElementById('icsModal');

  if (modal.classList.contains('hidden') || modal.classList.contains('closing')) {
    return;
  }

  modal.classList.add('closing');
  clearTimeout(icsModalCloseTimer);
  icsModalCloseTimer = setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('closing');
    document.body.classList.remove('modal-open');
  }, 180);
}

async function submitIcsForm(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = document.getElementById('saveIcsBtn');
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());

  data.units = Array.from(form.elements.units.selectedOptions).map(option => option.value);
  data.commands = Array.from(form.elements.commands.selectedOptions).map(option => option.value);
  button.disabled = true;

  try {
    const result = await projectApi('createIcs', data);

    if (!result.success) {
      throw new Error(result.error || 'ICS_CREATE_FAILED');
    }

    icsSystems.push(result.data);
    icsSystems.sort((left, right) => left.name.localeCompare(right.name));
    renderIcsList();
    closeIcsModal();
    showToast('ІКС додано');
  } catch (error) {
    console.error(error);
    const messages = {
      ICS_NAME_REQUIRED: 'Назва ІКС повинна містити від 2 до 100 символів',
      ICS_URL_INVALID: 'Посилання повинно починатися з https://',
      ICS_TEXT_TOO_LONG: 'Одне з текстових полів перевищує допустиму довжину',
      ICS_UNIT_INVALID: 'Обрано недоступний підрозділ',
      ICS_COMMAND_INVALID: 'Обрано недоступне командування'
    };

    showRequestError(
      messages[error.message] || 'Не вдалося додати ІКС',
      error
    );
  } finally {
    button.disabled = false;
  }
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
  const titleLink = document.getElementById('dashboardTitle');

  if (diagram.sourceUrl) {
    titleLink.href = diagram.sourceUrl;
    titleLink.title = 'Відкрити в draw.io';
    titleLink.removeAttribute('aria-disabled');
  } else {
    titleLink.removeAttribute('href');
    titleLink.removeAttribute('title');
    titleLink.setAttribute('aria-disabled', 'true');
  }
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
  const baseScale = window.matchMedia(
    MOBILE_VIEWPORT_QUERY
  ).matches
    ? 1
    : 0.5;
  const renderedWidth = diagramZoom * baseScale;

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
document.getElementById('addIcsBtn')
  .addEventListener('click', openIcsForm);
document.getElementById('icsForm')
  .addEventListener('submit', submitIcsForm);
document.querySelectorAll('[data-close-ics-modal]')
  .forEach(element => element.addEventListener('click', closeIcsModal));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeIcsModal();
  }
});
window.matchMedia(MOBILE_VIEWPORT_QUERY)
  .addEventListener('change', applyDiagramZoom);

trySharedSession();
