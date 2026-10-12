let apiRequestSequence = 0;

async function requestJson(url, options, context = {}) {
  const controller = new AbortController();
  const requestId = `${Date.now()}-${++apiRequestSequence}`;
  const startedAt = performance.now();
  let response = null;
  const timeoutMs = context.timeoutMs || REQUEST_TIMEOUT_MS;
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
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
    timeoutMs: details.context.timeoutMs || REQUEST_TIMEOUT_MS,
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

  const result = await requestJson(API_URL, {
    method: 'POST',
    body
  }, {
    service: 'digitalization',
    action,
    method: 'POST',
    timeoutMs: LONG_PROJECT_ACTIONS.has(action)
      ? WRITE_REQUEST_TIMEOUT_MS
      : LONG_READ_PROJECT_ACTIONS.has(action)
      ? LONG_READ_REQUEST_TIMEOUT_MS
      : REQUEST_TIMEOUT_MS
  });

  if (!result.success && result.error === 'AUTH_REQUIRED') {
    expireSession();
    throw new Error('AUTH_REQUIRED');
  }

  return result;
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
