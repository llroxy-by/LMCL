const DEFAULT_SCOPE = 'XboxLive.signin offline_access';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 1_000_000;

export const MICROSOFT_AUTH_ENDPOINTS = Object.freeze({
  deviceCode: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
  token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  xboxLive: 'https://user.auth.xboxlive.com/user/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  minecraftLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  entitlements: 'https://api.minecraftservices.com/entitlements/mcstore',
  profile: 'https://api.minecraftservices.com/minecraft/profile',
});

const SENSITIVE_KEYS = /^(?:access_token|refresh_token|device_code|user_code|token|identityToken|RpsTicket|authorization)$/i;
const OAUTH_PENDING = new Set(['authorization_pending', 'slow_down']);

export class MicrosoftAuthError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'MicrosoftAuthError';
    this.code = code;
    if (options.service) this.service = options.service;
    if (options.status !== undefined) this.status = options.status;
    if (options.oauthError) this.oauthError = options.oauthError;
    if (options.xerr !== undefined) this.xerr = options.xerr;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(object, key, service) {
  if (typeof object[key] !== 'string' || object[key].length === 0) {
    throw new MicrosoftAuthError('INVALID_RESPONSE', `${service} returned an invalid ${key}`, { service });
  }
  return object[key];
}

function optionalPositiveNumber(object, key, service) {
  if (object[key] === undefined) return undefined;
  if (typeof object[key] !== 'number' || !Number.isFinite(object[key]) || object[key] <= 0) {
    throw new MicrosoftAuthError('INVALID_RESPONSE', `${service} returned an invalid ${key}`, { service });
  }
  return object[key];
}

function requireRecord(value, service) {
  if (!isRecord(value)) throw new MicrosoftAuthError('INVALID_RESPONSE', `${service} returned an invalid response`, { service });
  return value;
}

/** Removes common credentials from diagnostic text. This is not a serialization helper. */
export function redactSensitive(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/\b(Bearer|XBL3\.0 x=[^;\s]+;)\s*[^\s"']+/gi, '$1 [REDACTED]')
    .replace(/\b(?:access_token|refresh_token|device_code|user_code|token|identityToken|RpsTicket)\b\s*[:=]\s*["']?[^\s,"'}]+/gi, match => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?\b/g, '[REDACTED]');
}

function safeDescription(value, secrets) {
  if (typeof value !== 'string') return '';
  return redactSensitive(value, secrets).replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function validateOptions(options) {
  if (!isRecord(options)) throw new TypeError('options must be an object');
  if (typeof options.fetch !== 'function') throw new TypeError('options.fetch must be a function');
  if (typeof options.clientId !== 'string' || options.clientId.length === 0) throw new TypeError('options.clientId must be a non-empty string');
  if (options.clientSecret !== undefined) throw new TypeError('clientSecret is not supported by the public-client device flow');
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new TypeError('options.timeoutMs must be a positive number');
  }
}

function form(data) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) if (value !== undefined) body.set(key, String(value));
  return body;
}

function linkSignals(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('request timeout'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function delay(ms, signal, sleep) {
  if (signal?.aborted) return Promise.reject(new MicrosoftAuthError('CANCELLED', 'Microsoft authentication was cancelled'));
  if (sleep) return Promise.resolve(sleep(ms, signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() { cleanup(); resolve(); }
    function cancelled() { cleanup(); reject(new MicrosoftAuthError('CANCELLED', 'Microsoft authentication was cancelled')); }
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); }
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

function publicError(service, status, payload, secrets) {
  const oauthError = typeof payload?.error === 'string' ? payload.error : undefined;
  const xerr = typeof payload?.XErr === 'number' || typeof payload?.XErr === 'string' ? payload.XErr : undefined;
  const description = safeDescription(payload?.error_description ?? payload?.Message, secrets);
  const suffix = description ? `: ${description}` : '';
  return new MicrosoftAuthError('HTTP_ERROR', `${service} request failed (${status})${suffix}`, {
    service, status, oauthError, xerr,
  });
}

/** Creates a protocol-only client. It never opens a browser or stores credentials. */
export function createMicrosoftAuthClient(options) {
  validateOptions(options);
  const fetchImpl = options.fetch;
  const clientId = options.clientId;
  const scope = options.scope ?? DEFAULT_SCOPE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoints = Object.freeze({ ...MICROSOFT_AUTH_ENDPOINTS, ...(options.endpoints ?? {}) });
  const sleep = options.sleep;
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('options.scope must be a non-empty string');
  if (sleep !== undefined && typeof sleep !== 'function') throw new TypeError('options.sleep must be a function');

  async function requestJson(service, url, init = {}, requestOptions = {}) {
    const timeout = requestOptions.timeoutMs ?? timeoutMs;
    const linked = linkSignals(requestOptions.signal, timeout);
    const secrets = (requestOptions.secrets ?? []).filter(value => typeof value === 'string');
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: linked.signal });
    } catch (error) {
      linked.cleanup();
      if (linked.timedOut()) throw new MicrosoftAuthError('TIMEOUT', `${service} request timed out`, { service, cause: error });
      if (requestOptions.signal?.aborted || linked.signal.aborted) {
        throw new MicrosoftAuthError('CANCELLED', `${service} request was cancelled`, { service, cause: error });
      }
      throw new MicrosoftAuthError('NETWORK_ERROR', `${service} network request failed`, { service, cause: error });
    }
    if (!response || typeof response.ok !== 'boolean' || typeof response.status !== 'number' || typeof response.text !== 'function') {
      linked.cleanup();
      throw new MicrosoftAuthError('INVALID_RESPONSE', `${service} returned an invalid fetch response`, { service });
    }
    let text;
    try { text = await response.text(); }
    catch (error) {
      linked.cleanup();
      if (linked.timedOut()) throw new MicrosoftAuthError('TIMEOUT', `${service} request timed out`, { service, cause: error });
      if (requestOptions.signal?.aborted || linked.signal.aborted) {
        throw new MicrosoftAuthError('CANCELLED', `${service} request was cancelled`, { service, cause: error });
      }
      throw new MicrosoftAuthError('INVALID_RESPONSE', `${service} response could not be read`, { service, cause: error });
    }
    linked.cleanup();
    if (text.length > MAX_RESPONSE_CHARS) throw new MicrosoftAuthError('INVALID_RESPONSE', `${service} response is too large`, { service });
    let payload = {};
    if (text.length > 0) {
      try { payload = JSON.parse(text); }
      catch (error) {
        throw new MicrosoftAuthError('INVALID_RESPONSE', `${service} returned malformed JSON`, { service, status: response.status, cause: error });
      }
    }
    if (!response.ok) throw publicError(service, response.status, isRecord(payload) ? payload : {}, secrets);
    return requireRecord(payload, service);
  }

  async function requestDeviceCode(requestOptions = {}) {
    const result = await requestJson('Microsoft device code', endpoints.deviceCode, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: clientId, scope }),
    }, requestOptions);
    const expiresIn = optionalPositiveNumber(result, 'expires_in', 'Microsoft device code');
    const interval = result.interval === undefined ? 5 : optionalPositiveNumber(result, 'interval', 'Microsoft device code');
    return Object.freeze({
      deviceCode: requiredString(result, 'device_code', 'Microsoft device code'),
      userCode: requiredString(result, 'user_code', 'Microsoft device code'),
      verificationUri: requiredString(result, result.verification_uri ? 'verification_uri' : 'verification_uri_complete', 'Microsoft device code'),
      verificationUriComplete: typeof result.verification_uri_complete === 'string' ? result.verification_uri_complete : undefined,
      message: typeof result.message === 'string' ? result.message : undefined,
      expiresIn: expiresIn ?? 900,
      interval,
    });
  }

  function validateMicrosoftToken(result, service = 'Microsoft token') {
    const expiresIn = optionalPositiveNumber(result, 'expires_in', service);
    return Object.freeze({
      tokenType: requiredString(result, 'token_type', service),
      accessToken: requiredString(result, 'access_token', service),
      refreshToken: typeof result.refresh_token === 'string' && result.refresh_token.length > 0 ? result.refresh_token : undefined,
      scope: typeof result.scope === 'string' ? result.scope : undefined,
      expiresIn,
    });
  }

  async function pollDeviceCode(device, requestOptions = {}) {
    if (!isRecord(device)) throw new TypeError('device must be an object');
    const deviceCode = typeof device.deviceCode === 'string' ? device.deviceCode : device.device_code;
    if (typeof deviceCode !== 'string' || deviceCode.length === 0) throw new TypeError('device.deviceCode must be a non-empty string');
    let intervalSeconds = device.interval ?? 5;
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) throw new TypeError('device.interval must be a positive number');
    const expiresIn = device.expiresIn ?? device.expires_in ?? 900;
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new TypeError('device.expiresIn must be a positive number');
    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
      if (requestOptions.signal?.aborted) throw new MicrosoftAuthError('CANCELLED', 'Microsoft device authorization was cancelled', { service: 'Microsoft token' });
      let result;
      try {
        result = await requestJson('Microsoft token', endpoints.token, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({ client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode }),
        }, { ...requestOptions, secrets: [deviceCode] });
      } catch (error) {
        if (!(error instanceof MicrosoftAuthError) || !OAUTH_PENDING.has(error.oauthError)) throw error;
        if (error.oauthError === 'slow_down') intervalSeconds += 5;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(intervalSeconds * 1000, remaining), requestOptions.signal, sleep);
        continue;
      }
      return validateMicrosoftToken(result);
    }
    throw new MicrosoftAuthError('DEVICE_CODE_EXPIRED', 'Microsoft device authorization expired', { service: 'Microsoft token' });
  }

  async function refreshMicrosoftToken(refreshToken, requestOptions = {}) {
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) throw new TypeError('refreshToken must be a non-empty string');
    const result = await requestJson('Microsoft token', endpoints.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope }),
    }, { ...requestOptions, secrets: [refreshToken] });
    return validateMicrosoftToken(result);
  }

  async function authenticateXboxLive(microsoftAccessToken, requestOptions = {}) {
    if (typeof microsoftAccessToken !== 'string' || microsoftAccessToken.length === 0) throw new TypeError('microsoftAccessToken must be a non-empty string');
    const result = await requestJson('Xbox Live', endpoints.xboxLive, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${microsoftAccessToken}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' }),
    }, { ...requestOptions, secrets: [microsoftAccessToken] });
    return Object.freeze({ token: requiredString(result, 'Token', 'Xbox Live') });
  }

  async function authorizeXsts(xboxToken, requestOptions = {}) {
    if (typeof xboxToken !== 'string' || xboxToken.length === 0) throw new TypeError('xboxToken must be a non-empty string');
    const result = await requestJson('XSTS', endpoints.xsts, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ Properties: { SandboxId: 'RETAIL', UserTokens: [xboxToken] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' }),
    }, { ...requestOptions, secrets: [xboxToken] });
    const claims = requireRecord(result.DisplayClaims, 'XSTS');
    if (!Array.isArray(claims.xui) || claims.xui.length === 0 || !isRecord(claims.xui[0])) {
      throw new MicrosoftAuthError('INVALID_RESPONSE', 'XSTS returned invalid display claims', { service: 'XSTS' });
    }
    return Object.freeze({ token: requiredString(result, 'Token', 'XSTS'), userHash: requiredString(claims.xui[0], 'uhs', 'XSTS') });
  }

  async function authenticateMinecraft(userHash, xstsToken, requestOptions = {}) {
    if (typeof userHash !== 'string' || userHash.length === 0) throw new TypeError('userHash must be a non-empty string');
    if (typeof xstsToken !== 'string' || xstsToken.length === 0) throw new TypeError('xstsToken must be a non-empty string');
    const identityToken = `XBL3.0 x=${userHash};${xstsToken}`;
    const result = await requestJson('Minecraft authentication', endpoints.minecraftLogin, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ identityToken }),
    }, { ...requestOptions, secrets: [userHash, xstsToken, identityToken] });
    return Object.freeze({
      tokenType: requiredString(result, 'token_type', 'Minecraft authentication'),
      accessToken: requiredString(result, 'access_token', 'Minecraft authentication'),
      expiresIn: optionalPositiveNumber(result, 'expires_in', 'Minecraft authentication'),
    });
  }

  async function getEntitlements(minecraftAccessToken, requestOptions = {}) {
    if (typeof minecraftAccessToken !== 'string' || minecraftAccessToken.length === 0) throw new TypeError('minecraftAccessToken must be a non-empty string');
    const result = await requestJson('Minecraft entitlements', endpoints.entitlements, {
      method: 'GET', headers: { authorization: `Bearer ${minecraftAccessToken}`, accept: 'application/json' },
    }, { ...requestOptions, secrets: [minecraftAccessToken] });
    if (!Array.isArray(result.items)) throw new MicrosoftAuthError('INVALID_RESPONSE', 'Minecraft entitlements returned invalid items', { service: 'Minecraft entitlements' });
    for (const item of result.items) {
      if (!isRecord(item) || typeof item.name !== 'string' || item.name.length === 0) {
        throw new MicrosoftAuthError('INVALID_RESPONSE', 'Minecraft entitlements returned an invalid item', { service: 'Minecraft entitlements' });
      }
    }
    return Object.freeze({ items: Object.freeze(result.items.map(item => Object.freeze({ ...item }))), signature: typeof result.signature === 'string' ? result.signature : undefined, keyId: typeof result.keyId === 'string' ? result.keyId : undefined });
  }

  async function getProfile(minecraftAccessToken, requestOptions = {}) {
    if (typeof minecraftAccessToken !== 'string' || minecraftAccessToken.length === 0) throw new TypeError('minecraftAccessToken must be a non-empty string');
    const result = await requestJson('Minecraft profile', endpoints.profile, {
      method: 'GET', headers: { authorization: `Bearer ${minecraftAccessToken}`, accept: 'application/json' },
    }, { ...requestOptions, secrets: [minecraftAccessToken] });
    const skins = result.skins === undefined ? [] : result.skins;
    const capes = result.capes === undefined ? [] : result.capes;
    if (!Array.isArray(skins) || !Array.isArray(capes)) throw new MicrosoftAuthError('INVALID_RESPONSE', 'Minecraft profile returned invalid cosmetics', { service: 'Minecraft profile' });
    return Object.freeze({ id: requiredString(result, 'id', 'Minecraft profile'), name: requiredString(result, 'name', 'Minecraft profile'), skins: Object.freeze(skins.map(x => Object.freeze({ ...requireRecord(x, 'Minecraft profile') }))), capes: Object.freeze(capes.map(x => Object.freeze({ ...requireRecord(x, 'Minecraft profile') }))) });
  }

  async function completeLogin(microsoftToken, requestOptions = {}) {
    const accessToken = typeof microsoftToken === 'string' ? microsoftToken : microsoftToken?.accessToken;
    if (typeof accessToken !== 'string' || accessToken.length === 0) throw new TypeError('microsoftToken must contain accessToken');
    const xbox = await authenticateXboxLive(accessToken, requestOptions);
    const xsts = await authorizeXsts(xbox.token, requestOptions);
    const minecraft = await authenticateMinecraft(xsts.userHash, xsts.token, requestOptions);
    const entitlements = await getEntitlements(minecraft.accessToken, requestOptions);
    const profile = await getProfile(minecraft.accessToken, requestOptions);
    return Object.freeze({ microsoft: typeof microsoftToken === 'string' ? undefined : microsoftToken, xbox, xsts, minecraft, entitlements, profile });
  }

  async function login(requestOptions = {}) {
    const device = await requestDeviceCode(requestOptions);
    requestOptions.onDeviceCode?.(device);
    const microsoft = await pollDeviceCode(device, requestOptions);
    const result = await completeLogin(microsoft, requestOptions);
    return Object.freeze({ device, ...result, microsoft });
  }

  return Object.freeze({ requestDeviceCode, pollDeviceCode, refreshMicrosoftToken, authenticateXboxLive, authorizeXsts, authenticateMinecraft, getEntitlements, getProfile, completeLogin, login });
}

export const createMicrosoftAuth = createMicrosoftAuthClient;
