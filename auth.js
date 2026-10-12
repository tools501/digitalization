let authToken = '';
let sessionTimer = null;
let sessionExpireTimer = null;
let sessionCountdownTimer = null;
let sessionExpiresAt = 0;
let sessionExpired = false;
let pendingTwoFactorAuth = null;

function getSharedAuthToken() {
  try {
    const token = sessionStorage.getItem(SHARED_AUTH_TOKEN_KEY);

    if (token && !isTokenActive(token)) {
      clearSharedAuthToken();
      return null;
    }

    return token;
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

function getTokenExpirationMs(token) {
  try {
    const payload = JSON.parse(
      atob(
        String(token || '')
          .split('.')[1]
          .replace(/-/g, '+')
          .replace(/_/g, '/')
      )
    );

    return Number(payload.exp) * 1000;
  } catch (error) {
    return 0;
  }
}

function getSafeTokenExpirationMs(token) {
  const expirationMs = getTokenExpirationMs(token);

  if (!expirationMs) {
    return 0;
  }

  return expirationMs - TOKEN_EXPIRY_SAFETY_MS;
}

function isTokenActive(token) {
  return getSafeTokenExpirationMs(token) > Date.now();
}

function clearSessionTimers() {
  clearTimeout(sessionTimer);
  clearTimeout(sessionExpireTimer);
  clearInterval(sessionCountdownTimer);

  sessionTimer = null;
  sessionExpireTimer = null;
  sessionCountdownTimer = null;
}

function hideSessionWarning() {
  document
    .getElementById('sessionWarning')
    .classList.add('hidden');
}

function expireSession() {
  if (sessionExpired) {
    return;
  }

  sessionExpired = true;
  authToken = '';
  clearSessionTimers();
  clearSharedAuthToken();
  hideSessionWarning();
  showOnly('sessionExpiredPage');
}

function renewSession() {
  authToken = '';
  sessionExpired = true;
  clearSessionTimers();
  clearSharedAuthToken();
  hideSessionWarning();
  showOnly('loginPage');
}

function startSessionTimer(token) {
  clearSessionTimers();

  sessionExpired = false;
  sessionExpiresAt =
    getSafeTokenExpirationMs(token) ||
    Date.now() + 55 * 60 * 1000;

  hideSessionWarning();
  updateSessionWarningText();

  const remainingMs = sessionExpiresAt - Date.now();

  if (remainingMs <= 0) {
    expireSession();
    return;
  }

  sessionTimer = setTimeout(() => {
    updateSessionWarningText();

    document
      .getElementById('sessionWarning')
      .classList.remove('hidden');

    sessionCountdownTimer = setInterval(
      updateSessionWarningText,
      1000
    );
  }, Math.max(0, remainingMs - 5 * 60 * 1000));

  sessionExpireTimer = setTimeout(
    expireSession,
    remainingMs
  );
}

function formatSessionCountdown(ms) {
  const totalSeconds = Math.max(
    0,
    Math.ceil(ms / 1000)
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function updateSessionWarningText() {
  const remaining = sessionExpiresAt - Date.now();

  document
    .getElementById('sessionWarningText')
    .textContent =
      `Сесія завершиться через ${formatSessionCountdown(remaining)}`;
}

function showOnly(id) {
  [
    'loginPage',
    'loader',
    'twoFactorPage',
    'deniedPage',
    'networkErrorPage',
    'sessionExpiredPage',
    'app'
  ].forEach(elementId => {
    document
      .getElementById(elementId)
      .classList.toggle('hidden', elementId !== id);
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
  clearSessionTimers();
  clearSharedAuthToken();
  showOnly('loginPage');
}

async function authenticateWithToken(token, options = {}) {
  if (!isTokenActive(token)) {
    authToken = '';
    clearSessionTimers();
    clearSharedAuthToken();
    showOnly('loginPage');
    return;
  }

  sessionExpired = false;
  hideSessionWarning();
  authToken = token;
  showOnly('loader');

  try {
    if (
      TWO_FACTOR_CHECK_ENABLED &&
      !options.skipTwoFactor
    ) {
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
    await loadStartupData();
    renderRegistryUsersChangesIfVisible();
    startSessionTimer(token);
    showOnly('app');
  } catch (error) {
    console.error(error);
    authToken = '';

    if (error.message === 'AUTH_REQUIRED') {
      return;
    }

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
