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
let icsOptions = { units: [] };
let activeDiagramId = ICS_REGISTRY_TAB_ID;
let diagramZoom = 100;
const diagramUrls = new Map();
let icsModalCloseTimer = null;
let icsViewTransitionTimer = null;
let activeIcsItem = null;
let editingIcsId = '';
let icsUsers = [];
let loadedIcsUsersId = '';
const icsUsersCache = new Map();
const icsUsersLoadingPromises = new Map();
let activeIcsUser = null;
let editingIcsUserId = '';
let bookPeople = null;
let bookPeopleLoadingPromise = null;
let apiRequestSequence = 0;

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
    'networkErrorPage',
    'app'
  ].forEach(elementId => {
    document
      .getElementById(elementId)
      .classList.toggle('hidden', elementId !== id);
  });
}

async function requestJson(url, options, context = {}) {
  const controller = new AbortController();
  const requestId = `${Date.now()}-${++apiRequestSequence}`;
  const startedAt = performance.now();
  let response = null;
  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const result = await response.json();

    logApiRequest('success', {
      requestId,
      context,
      response,
      startedAt,
      result
    });

    return result;
  } catch (error) {
    logApiRequest('error', {
      requestId,
      context,
      response,
      startedAt,
      error
    });

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function logApiRequest(level, details) {
  const error = details.error;
  const response = details.response;
  const durationMs = Math.round(performance.now() - details.startedAt);
  const errorType = !error
    ? null
    : error.name === 'AbortError'
      ? 'TIMEOUT'
      : error instanceof SyntaxError
        ? 'INVALID_JSON'
        : error instanceof TypeError
          ? 'NETWORK_OR_CORS'
          : 'UNEXPECTED';
  const entry = {
    requestId: details.requestId,
    service: details.context.service || 'unknown',
    action: details.context.action || 'unknown',
    method: details.context.method || 'POST',
    durationMs,
    status: response ? response.status : null,
    statusText: response ? response.statusText : null,
    redirected: response ? response.redirected : null,
    responseType: response ? response.type : null,
    responseUrl: response ? response.url : null,
    contentType: response ? response.headers.get('content-type') : null,
    apiSuccess: details.result && typeof details.result.success === 'boolean'
      ? details.result.success
      : null,
    apiError: details.result && details.result.error
      ? String(details.result.error)
      : null,
    errorType,
    errorName: error ? error.name : null,
    errorMessage: error ? error.message : null,
    timestamp: new Date().toISOString()
  };

  if (level === 'error') {
    console.error('[Digitalization API request failed]', entry);
    return;
  }

  console.info('[Digitalization API request completed]', entry);
}

function isTransientRequestError(error) {
  return Boolean(error) &&
    (
      error.name === 'AbortError' ||
      error instanceof TypeError
    );
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
  }, {
    service: 'digitalization',
    action,
    method: 'POST'
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
  }, {
    service: 'hub',
    action,
    method: 'POST'
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
      if (isTransientRequestError(error)) {
        showOnly('networkErrorPage');
        showRequestError('Не вдалося завантажити дані', error);
        return;
      }

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
  icsOptions = data.icsOptions || { units: [] };

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

function openIcsDetails(item, activeTab = 'info') {
  const details = document.getElementById('icsDetails');

  activeIcsItem = item;
  editingIcsId = '';
  editingIcsUserId = '';
  activeIcsUser = null;

  if (icsUsersCache.has(item.id)) {
    icsUsers = icsUsersCache.get(item.id);
    loadedIcsUsersId = item.id;
  } else {
    loadedIcsUsersId = '';
    icsUsers = [];
  }

  document.getElementById('icsModalTitle').textContent = item.name;
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
  switchIcsModalView('icsDetailsView');
  showIcsModal();
  showIcsDetailsTab(activeTab);
}

function showIcsDetailsTab(tabName) {
  const showUsers = tabName === 'users';

  document.getElementById('icsInfoTabBtn').classList.toggle('active', !showUsers);
  document.getElementById('icsUsersTabBtn').classList.toggle('active', showUsers);
  document.getElementById('icsInfoPanel').classList.toggle('hidden', showUsers);
  document.getElementById('icsUsersPanel').classList.toggle('hidden', !showUsers);

  if (showUsers) {
    renderIcsUsers();
    loadIcsUsers();
    preloadBookPeople();
  }
}

async function loadIcsUsers(force = false) {
  if (!activeIcsItem) {
    return;
  }

  const icsId = activeIcsItem.id;

  if (!force && icsUsersCache.has(icsId)) {
    icsUsers = icsUsersCache.get(icsId);
    loadedIcsUsersId = icsId;
    renderIcsUsers();
    return icsUsers;
  }

  if (icsUsersLoadingPromises.has(icsId)) {
    return icsUsersLoadingPromises.get(icsId);
  }

  const loader = document.getElementById('icsUsersLoader');

  loader.classList.remove('hidden');
  document.getElementById('icsUsersEmpty').classList.add('hidden');
  document.getElementById('icsUsersList').replaceChildren();

  const loadingPromise = projectApi('getIcsUsers', { icsId })
    .then(result => {
      if (!result.success) {
        throw new Error(result.error || 'ICS_USERS_LOAD_FAILED');
      }

      const users = Array.isArray(result.data) ? result.data : [];

      icsUsersCache.set(icsId, users);

      if (activeIcsItem && activeIcsItem.id === icsId) {
        icsUsers = users;
        loadedIcsUsersId = icsId;
        renderIcsUsers();
      }

      return users;
    })
    .catch(error => {
      console.error(error);

      if (activeIcsItem && activeIcsItem.id === icsId) {
        showRequestError('Не вдалося завантажити користувачів ІКС', error);
      }

      return null;
    })
    .finally(() => {
      icsUsersLoadingPromises.delete(icsId);

      if (activeIcsItem && activeIcsItem.id === icsId) {
        loader.classList.add('hidden');
      }
    });

  icsUsersLoadingPromises.set(icsId, loadingPromise);
  return loadingPromise;
}

function renderIcsUsers() {
  const list = document.getElementById('icsUsersList');
  const empty = document.getElementById('icsUsersEmpty');
  const count = document.getElementById('icsUsersCount');

  list.replaceChildren();
  count.textContent = loadedIcsUsersId
    ? `Користувачів: ${icsUsers.length}`
    : '';
  empty.classList.toggle(
    'hidden',
    !loadedIcsUsersId || icsUsers.length > 0
  );

  icsUsers.forEach(user => {
    const card = document.createElement('article');
    const header = document.createElement('div');
    const identity = document.createElement('div');
    const name = document.createElement('h3');
    const subtitle = document.createElement('p');
    const actions = document.createElement('div');
    const editButton = document.createElement('button');
    const deleteButton = document.createElement('button');
    const details = document.createElement('dl');

    card.className = 'ics-user-card';
    header.className = 'ics-user-card-header';
    actions.className = 'ics-user-actions';
    details.className = 'ics-user-details';
    name.textContent = user.fullName;
    subtitle.textContent = [user.rank, user.callSign]
      .filter(Boolean)
      .join(' · ') || 'Звання та позивний не вказано';

    editButton.type = 'button';
    editButton.className = 'ics-user-action';
    editButton.textContent = 'Редагувати';
    editButton.addEventListener('click', () => openIcsUserForm(user));

    deleteButton.type = 'button';
    deleteButton.className = 'ics-user-action danger';
    deleteButton.textContent = 'Видалити';
    deleteButton.addEventListener('click', () => showDeleteIcsUserConfirm(user));

    identity.append(name, subtitle);
    actions.append(editButton, deleteButton);
    header.append(identity, actions);
    appendIcsUserDetail(details, 'Підрозділ', user.unit);
    appendIcsUserDetail(details, 'Посада', user.position);
    appendIcsUserDetail(details, 'Телефон', user.phone, 'tel');
    appendIcsUserDetail(details, 'Пошта', user.email, 'mailto');
    appendIcsUserDetail(details, 'Права доступу', user.accessRights, '', true);
    card.append(header, details);
    list.appendChild(card);
  });
}

function appendIcsUserDetail(container, label, value, linkType = '', wide = false) {
  const wrapper = document.createElement('div');
  const title = document.createElement('dt');
  const content = document.createElement('dd');

  wrapper.className = wide ? 'wide' : '';
  title.textContent = label;

  if (value && linkType) {
    const link = document.createElement('a');

    link.href = `${linkType}:${value}`;
    link.textContent = value;
    content.appendChild(link);
  } else {
    content.textContent = value || 'Не вказано';
  }

  wrapper.append(title, content);
  container.appendChild(wrapper);
}

async function openIcsUserForm(user = null) {
  if (!activeIcsItem) {
    return;
  }

  const form = document.getElementById('icsUserForm');
  const requestedIcsId = activeIcsItem.id;

  if (!user && !bookPeople) {
    setIcsBusy(true, 'Завантажуємо довідник Book');

    try {
      await loadBookPeople();
    } catch (error) {
      console.error(error);
      showRequestError('Не вдалося завантажити довідник Book', error);
      return;
    } finally {
      setIcsBusy(false);
    }

    if (
      !activeIcsItem ||
      activeIcsItem.id !== requestedIcsId ||
      document.getElementById('icsModal').classList.contains('hidden')
    ) {
      return;
    }
  }

  activeIcsUser = user;
  editingIcsUserId = user ? user.id : '';
  document.getElementById('icsModalTitle').textContent =
    user ? 'Редагувати користувача' : 'Додати користувача';
  form.reset();
  hideBookPeopleSuggestions();
  renderIcsUserUnitOptions(user && user.unit);

  if (user) {
    form.elements.fullName.value = user.fullName || '';
    form.elements.rank.value = user.rank || '';
    form.elements.callSign.value = user.callSign || '';
    form.elements.unit.value = user.unit || '';
    form.elements.position.value = user.position || '';
    form.elements.phone.value = formatUkrainianPhone(user.phone || '');
    form.elements.email.value = user.email || '';
    form.elements.accessRights.value = user.accessRights || '';
    form.elements.sourceKey.value = user.sourceKey || '';
    form.elements.identityType.value = user.identityType || '';
  }

  switchIcsModalView('icsUserForm');
  setTimeout(() => form.elements.fullName.focus(), 190);
}

function loadBookPeople() {
  if (bookPeople) {
    return Promise.resolve(bookPeople);
  }

  if (bookPeopleLoadingPromise) {
    return bookPeopleLoadingPromise;
  }

  bookPeopleLoadingPromise = projectApi('getBookPeople')
    .then(result => {
      if (!result.success) {
        throw new Error(result.error || 'BOOK_PEOPLE_LOAD_FAILED');
      }

      bookPeople = Array.isArray(result.data) ? result.data : [];
      return bookPeople;
    })
    .finally(() => {
      bookPeopleLoadingPromise = null;
    });

  return bookPeopleLoadingPromise;
}

function preloadBookPeople() {
  if (bookPeople) {
    return;
  }

  loadBookPeople().catch(error => {
    console.warn('[Book people preload failed]', {
      errorName: error.name,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    });
  });
}

function normalizeBookPeopleSearch(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('uk');
}

function renderBookPeopleSuggestions() {
  const input = document.getElementById('icsUserFullName');
  const suggestions = document.getElementById('icsPeopleSuggestions');
  const query = normalizeBookPeopleSearch(input.value);

  suggestions.replaceChildren();

  if (!bookPeople || query.length < 2) {
    suggestions.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    return;
  }

  const matches = bookPeople
    .filter(person =>
      normalizeBookPeopleSearch(person.fullName).includes(query) ||
      normalizeBookPeopleSearch(person.callSign).includes(query)
    )
    .slice(0, 20);

  if (!matches.length) {
    const empty = document.createElement('div');

    empty.className = 'ics-people-suggestions-empty';
    empty.textContent = 'Нічого не знайдено';
    suggestions.appendChild(empty);
  } else {
    matches.forEach(person => {
      const button = document.createElement('button');
      const name = document.createElement('strong');
      const meta = document.createElement('span');

      button.type = 'button';
      button.className = 'ics-person-suggestion';
      button.setAttribute('role', 'option');
      name.textContent = person.fullName;
      meta.textContent = [person.rank, person.callSign, person.position]
        .filter(Boolean)
        .join(' · ');
      button.appendChild(name);

      if (meta.textContent) {
        button.appendChild(meta);
      }

      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => selectBookPerson(person));
      suggestions.appendChild(button);
    });
  }

  suggestions.classList.remove('hidden');
  input.setAttribute('aria-expanded', 'true');
}

function selectBookPerson(person) {
  const form = document.getElementById('icsUserForm');

  form.elements.fullName.value = person.fullName;
  form.elements.sourceKey.value = person.sourceKey || '';
  form.elements.identityType.value = person.identityType || '';

  ['rank', 'callSign', 'position'].forEach(field => {
    if (Object.prototype.hasOwnProperty.call(person, field)) {
      form.elements[field].value = person[field];
    }
  });

  hideBookPeopleSuggestions();
}

function handleIcsUserNameInput() {
  const form = document.getElementById('icsUserForm');

  form.elements.sourceKey.value = '';
  form.elements.identityType.value = '';
  renderBookPeopleSuggestions();
}

function hideBookPeopleSuggestions() {
  document.getElementById('icsPeopleSuggestions').classList.add('hidden');
  document.getElementById('icsUserFullName').setAttribute('aria-expanded', 'false');
}

function renderIcsUserUnitOptions(currentValue = '') {
  const select = document.getElementById('icsUserUnit');
  const values = (icsOptions.units || []).slice();

  if (currentValue && values.indexOf(currentValue) === -1) {
    values.push(currentValue);
  }

  select.replaceChildren(
    createOption(''),
    ...values.map(createOption)
  );
  select.options[0].textContent = 'Не вказано';
}

function formatUkrainianPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');

  if (digits.indexOf('380') === 0) {
    digits = digits.slice(3);
  } else if (digits.indexOf('38') === 0) {
    digits = digits.slice(2);
  } else if (digits[0] === '0') {
    digits = digits.slice(1);
  }

  digits = digits.slice(0, 9);

  if (!digits) {
    return '';
  }

  const parts = [
    digits.slice(0, 2),
    digits.slice(2, 5),
    digits.slice(5, 7),
    digits.slice(7, 9)
  ].filter(Boolean);

  return `+380 ${parts.join(' ')}`;
}

function handleIcsUserPhoneInput(event) {
  event.currentTarget.value = formatUkrainianPhone(event.currentTarget.value);
}

function returnToIcsUsers() {
  if (activeIcsItem) {
    openIcsDetails(activeIcsItem, 'users');
  }
}

async function submitIcsUserForm(event) {
  event.preventDefault();

  if (!activeIcsItem) {
    return;
  }

  const form = event.currentTarget;
  const button = document.getElementById('saveIcsUserBtn');
  const data = Object.fromEntries(new FormData(form).entries());
  const wasEditing = Boolean(editingIcsUserId);

  data.id = editingIcsUserId;
  data.icsId = activeIcsItem.id;
  button.disabled = true;
  setIcsBusy(
    true,
    editingIcsUserId ? 'Зберігаємо користувача' : 'Додаємо користувача'
  );

  try {
    const action = wasEditing ? 'updateIcsUser' : 'createIcsUser';
    const result = await projectApi(action, data);

    if (!result.success) {
      throw new Error(result.error || 'ICS_USER_SAVE_FAILED');
    }

    const existingIndex = icsUsers.findIndex(user => user.id === result.data.id);

    if (existingIndex === -1) {
      icsUsers.push(result.data);
    } else {
      icsUsers[existingIndex] = result.data;
    }

    updatePersonInCachedIcsUsers(result.data);
    icsUsers.sort((left, right) => left.fullName.localeCompare(right.fullName));
    loadedIcsUsersId = activeIcsItem.id;
    icsUsersCache.set(activeIcsItem.id, icsUsers);
    returnToIcsUsers();
    showToast(
      wasEditing
        ? 'Користувача оновлено'
        : result.data.alreadyExists
          ? 'Користувач уже є в цій ІКС; дані оновлено'
          : 'Користувача додано'
    );
  } catch (error) {
    console.error(error);
    const messages = {
      ICS_USER_NAME_REQUIRED: 'ПІБ має містити від 2 до 150 символів',
      ICS_USER_EMAIL_INVALID: 'Вкажіть коректну адресу пошти',
      ICS_USER_PHONE_INVALID: 'Вкажіть телефон у форматі +380 67 123 45 67',
      PERSON_IDENTITY_AMBIGUOUS: 'Знайдено декілька людей з однаковим ПІБ',
      ICS_TEXT_TOO_LONG: 'Одне з полів перевищує допустиму довжину'
    };

    showRequestError(
      messages[error.message] || 'Не вдалося зберегти користувача',
      error
    );
  } finally {
    button.disabled = false;
    setIcsBusy(false);
  }
}

function updatePersonInCachedIcsUsers(updatedUser) {
  const personFields = [
    'sourceKey',
    'identityType',
    'fullName',
    'rank',
    'callSign',
    'unit',
    'position',
    'phone',
    'email'
  ];

  icsUsersCache.forEach(users => {
    users.forEach(user => {
      if (user.personId !== updatedUser.personId) {
        return;
      }

      personFields.forEach(field => {
        user[field] = updatedUser[field] || '';
      });
    });
  });
}

function showDeleteIcsUserConfirm(user) {
  activeIcsUser = user;
  document.getElementById('icsModalTitle').textContent = 'Видалити користувача';
  document.getElementById('icsUserDeleteText').textContent =
    `${user.fullName} зникне зі списку цієї ІКС.`;
  switchIcsModalView('icsUserDeleteConfirm');
}

async function confirmDeleteIcsUser() {
  if (!activeIcsItem || !activeIcsUser) {
    return;
  }

  const user = activeIcsUser;

  setIcsBusy(true, 'Видаляємо користувача');

  try {
    const result = await projectApi('deleteIcsUser', {
      id: user.id,
      icsId: activeIcsItem.id
    });

    if (!result.success) {
      throw new Error(result.error || 'ICS_USER_DELETE_FAILED');
    }

    icsUsers = icsUsers.filter(existing => existing.id !== user.id);
    icsUsersCache.set(activeIcsItem.id, icsUsers);
    activeIcsUser = null;
    returnToIcsUsers();
    showToast('Користувача видалено');
  } catch (error) {
    console.error(error);
    showRequestError('Не вдалося видалити користувача', error);
  } finally {
    setIcsBusy(false);
  }
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

function openIcsForm(item = null) {
  const form = document.getElementById('icsForm');

  editingIcsId = item ? item.id : '';
  activeIcsItem = item;
  document.getElementById('icsModalTitle').textContent =
    item ? 'Редагувати ІКС' : 'Додати ІКС';
  form.reset();
  renderIcsSelectOptions();

  if (item) {
    form.elements.name.value = item.name || '';
    form.elements.about.value = item.about || '';
    form.elements.url.value = item.url || '';
    form.elements.documentation.value = item.documentation || '';
    form.elements.deploymentInfo.value = item.deploymentInfo || '';
    form.elements.logoUrl.value = item.logoUrl || '';
    Array.from(form.elements.units.options).forEach(option => {
      option.selected = (item.units || []).indexOf(option.value) !== -1;
    });
  }

  switchIcsModalView('icsForm');
  showIcsModal();
  setTimeout(() => form.elements.name.focus(), 190);
}

function showDeleteIcsConfirm() {
  if (!activeIcsItem) {
    return;
  }

  document.getElementById('icsModalTitle').textContent = activeIcsItem.name;
  switchIcsModalView('icsDeleteConfirm');
}

function cancelDeleteIcs() {
  if (activeIcsItem) {
    openIcsDetails(activeIcsItem);
  }
}

function setIcsBusy(isBusy, message = 'Зберігаємо') {
  const overlay = document.getElementById('icsBusyOverlay');

  document.getElementById('icsBusyText').textContent = message;
  overlay.classList.toggle('hidden', !isBusy);
}

function switchIcsModalView(targetId) {
  const modal = document.getElementById('icsModal');
  const target = document.getElementById(targetId);
  const views = Array.from(document.querySelectorAll('.ics-modal-view'));
  const current = views.find(view =>
    view !== target && !view.classList.contains('hidden')
  );

  clearTimeout(icsViewTransitionTimer);
  views.forEach(view => {
    view.classList.remove('view-entering', 'view-leaving');
  });

  if (modal.classList.contains('hidden') || !current) {
    views.forEach(view => view.classList.toggle('hidden', view !== target));
    target.classList.add('view-entering');
    icsViewTransitionTimer = setTimeout(
      () => target.classList.remove('view-entering'),
      180
    );
    return;
  }

  current.classList.add('view-leaving');
  icsViewTransitionTimer = setTimeout(() => {
    current.classList.add('hidden');
    current.classList.remove('view-leaving');
    target.classList.remove('hidden');
    target.classList.add('view-entering');
    icsViewTransitionTimer = setTimeout(
      () => target.classList.remove('view-entering'),
      180
    );
  }, 120);
}

function renderIcsSelectOptions() {
  const units = document.getElementById('icsUnits');

  units.replaceChildren(...(icsOptions.units || []).map(createOption));
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
  data.id = editingIcsId;
  button.disabled = true;
  setIcsBusy(true, editingIcsId ? 'Зберігаємо зміни' : 'Створюємо ІКС');

  try {
    const action = editingIcsId ? 'updateIcs' : 'createIcs';
    const result = await projectApi(action, data);

    if (!result.success) {
      throw new Error(result.error || 'ICS_SAVE_FAILED');
    }

    const existingIndex = icsSystems.findIndex(item => item.id === result.data.id);

    if (existingIndex === -1) {
      icsSystems.push(result.data);
    } else {
      icsSystems[existingIndex] = result.data;
    }

    icsSystems.sort((left, right) => left.name.localeCompare(right.name));
    renderIcsList();
    closeIcsModal();
    showToast(editingIcsId ? 'Зміни збережено' : 'ІКС додано');
  } catch (error) {
    console.error(error);
    const messages = {
      ICS_NAME_REQUIRED: 'Назва ІКС повинна містити від 2 до 100 символів',
      ICS_URL_INVALID: 'Посилання повинно починатися з https://',
      ICS_TEXT_TOO_LONG: 'Одне з текстових полів перевищує допустиму довжину',
      ICS_UNIT_INVALID: 'Обрано недоступний підрозділ'
    };

    showRequestError(
      messages[error.message] || 'Не вдалося зберегти ІКС',
      error
    );
  } finally {
    button.disabled = false;
    setIcsBusy(false);
  }
}

async function confirmDeleteIcs() {
  if (!activeIcsItem) {
    return;
  }

  const item = activeIcsItem;

  setIcsBusy(true, 'Видаляємо ІКС');

  try {
    const result = await projectApi('deleteIcs', { id: item.id });

    if (!result.success) {
      throw new Error(result.error || 'ICS_DELETE_FAILED');
    }

    icsSystems = icsSystems.filter(existing => existing.id !== item.id);
    icsUsersCache.delete(item.id);
    icsUsersLoadingPromises.delete(item.id);
    activeIcsItem = null;
    renderIcsList();
    closeIcsModal();
    showToast('ІКС видалено');
  } catch (error) {
    console.error(error);
    showRequestError('Не вдалося видалити ІКС', error);
  } finally {
    setIcsBusy(false);
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
document.getElementById('networkHubBtn')
  .addEventListener('click', goToHub);
document.getElementById('networkRetryBtn')
  .addEventListener('click', trySharedSession);
document.getElementById('zoomOutBtn')
  .addEventListener('click', () => changeDiagramZoom(-25));
document.getElementById('zoomResetBtn')
  .addEventListener('click', resetDiagramZoom);
document.getElementById('zoomInBtn')
  .addEventListener('click', () => changeDiagramZoom(25));
document.getElementById('addIcsBtn')
  .addEventListener('click', () => openIcsForm());
document.getElementById('icsInfoTabBtn')
  .addEventListener('click', () => showIcsDetailsTab('info'));
document.getElementById('icsUsersTabBtn')
  .addEventListener('click', () => showIcsDetailsTab('users'));
document.getElementById('addIcsUserBtn')
  .addEventListener('click', () => openIcsUserForm());
document.getElementById('editIcsBtn')
  .addEventListener('click', () => openIcsForm(activeIcsItem));
document.getElementById('deleteIcsBtn')
  .addEventListener('click', showDeleteIcsConfirm);
document.getElementById('confirmDeleteIcsBtn')
  .addEventListener('click', confirmDeleteIcs);
document.getElementById('cancelDeleteIcsBtn')
  .addEventListener('click', cancelDeleteIcs);
document.getElementById('icsForm')
  .addEventListener('submit', submitIcsForm);
document.getElementById('icsUserForm')
  .addEventListener('submit', submitIcsUserForm);
document.getElementById('icsUserPhone')
  .addEventListener('input', handleIcsUserPhoneInput);
document.getElementById('icsUserFullName')
  .addEventListener('input', handleIcsUserNameInput);
document.getElementById('icsUserFullName')
  .addEventListener('focus', renderBookPeopleSuggestions);
document.getElementById('icsUserFullName')
  .addEventListener('blur', hideBookPeopleSuggestions);
document.getElementById('cancelIcsUserBtn')
  .addEventListener('click', returnToIcsUsers);
document.getElementById('confirmDeleteIcsUserBtn')
  .addEventListener('click', confirmDeleteIcsUser);
document.getElementById('cancelDeleteIcsUserBtn')
  .addEventListener('click', returnToIcsUsers);
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
