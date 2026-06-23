/*
 * NGA Loon 自动签到调试版
 *
 * 逻辑：
 * - HTTP-REQUEST 模式：捕获 NGA 登录 Cookie 和疑似签到请求。
 * - Cron 模式：使用保存的签到请求 + 最新 Cookie 自动重放。
 *
 * 首次使用必须开着 Loon/MitM，在 NGA App 里手动签到一次。
 */

const STORE = {
  auth: 'nga.checkin.auth.v1',
  signReq: 'nga.checkin.request.v1',
  statusReq: 'nga.checkin.status.request.v1',
  lastDebug: 'nga.checkin.debug.v1',
};

const CONFIG = {
  version: 'nga-loon-20260623-5',
  notify: true,
  debug: true,
  logStaticAssets: false,
  logNonStaticRequests: true,
  signKeywords: [
    'checkin',
    'check_in',
    'check-in',
    'signin',
    'sign_in',
    'sign-in',
    'sign',
    'mission',
    'task',
    'daily',
    'attendance',
    'award',
    'coin',
  ],
  signActionKeywords: ['checkin', 'check_in', 'signin', 'sign_in', 'attendance', 'do_sign', 'sign=1', 'action=sign', 'act=sign'],
  statusKeywords: ['checkin', 'check_in', 'signin', 'sign_in', 'mission', 'task', 'daily', 'attendance', 'award', 'coin'],
  authCookieNames: ['ngaPassportUid', 'ngaPassportCid', 'ngaPassportUrlencodedUname', 'guestJs', 'lastvisit'],
  authHeaderNames: ['authorization', 'x-token', 'token', 'access-token', 'x-access-token', 'x-uid', 'uid', 'user-id'],
};

function isRequestMode() {
  return typeof $request !== 'undefined' && $request && $request.url;
}

function done(value) {
  if (typeof $done === 'function') $done(value || {});
}

function notify(title, subtitle, message) {
  if (CONFIG.notify) $notification.post(title, subtitle || '', message || '');
}

function now() {
  return new Date().toISOString();
}

function log(message, data) {
  const line = `[NGA_LOON] ${message}${data === undefined ? '' : ` ${safeJson(data)}`}`;
  console.log(line);
  $persistentStore.write(`${now()} ${line}`, STORE.lastDebug);
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (key, val) => {
      if (typeof val !== 'string') return val;
      if (/cookie|token|authorization|passport|cid|uid/i.test(key)) return mask(val);
      return val.length > 1000 ? `${val.slice(0, 1000)}...<trimmed>` : val;
    });
  } catch (_) {
    return String(value);
  }
}

function mask(value) {
  if (!value) return value;
  if (value.length <= 14) return '***';
  return `${value.slice(0, 8)}***${value.slice(-5)}`;
}

function readJson(key, fallback) {
  const raw = $persistentStore.read(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    log('读取存储失败', { key, error: String(error) });
    return fallback;
  }
}

function writeJson(key, value) {
  return $persistentStore.write(JSON.stringify(value), key);
}

function normalizeHeaders(headers) {
  const out = {};
  Object.keys(headers || {}).forEach((name) => {
    out[name.toLowerCase()] = String(headers[name]);
  });
  return out;
}

function mergeHeaders(base, patch) {
  const headers = Object.assign({}, normalizeHeaders(base), normalizeHeaders(patch));
  delete headers.host;
  delete headers['content-length'];
  delete headers['accept-encoding'];
  delete headers.connection;
  return headers;
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch (_) {
    return null;
  }
}

function isStaticAsset(url) {
  const path = url.split('?')[0].toLowerCase();
  return /\.(css|js|map|png|jpe?g|gif|webp|svg|ico|ttf|otf|woff2?|eot|mp4|m4v|mov|webm|mp3|m4a|wav)$/.test(path);
}

function hasNGAAuthCookie(cookie) {
  if (!cookie) return false;
  if (CONFIG.authCookieNames.some((name) => new RegExp(`(^|;\\s*)${name}=`, 'i').test(cookie))) return true;

  // NGA App/WebView 有时 Cookie 名称会调整。非静态 NGA 请求中的 Cookie 先保存，
  // 后续签到失败时再通过日志判断是否缺少关键字段。
  const weakCookie = /(^|;\s*)(Hm_|UM_distinctid|CNZZDATA|__utm|_ga|_gid)=/i.test(cookie);
  return cookie.length > 20 && !weakCookie;
}

function pickAuthHeaders(headers) {
  const picked = {};
  CONFIG.authHeaderNames.forEach((name) => {
    const key = name.toLowerCase();
    if (headers[key]) picked[key] = headers[key];
  });
  if (headers.cookie && hasNGAAuthCookie(headers.cookie)) picked.cookie = headers.cookie;
  if (headers['user-agent']) picked['user-agent'] = headers['user-agent'];
  if (headers.accept) picked.accept = headers.accept;
  if (headers['accept-language']) picked['accept-language'] = headers['accept-language'];
  return picked;
}

function hasAuthSignal(headers) {
  return Object.keys(pickAuthHeaders(headers)).some((key) => !['user-agent', 'accept', 'accept-language'].includes(key));
}

function looksLikeSignRequest(url, body) {
  const text = `${decodeURIComponentSafe(url)}\n${decodeURIComponentSafe(body || '')}`.toLowerCase();
  return CONFIG.signKeywords.some((word) => text.includes(word));
}

function looksLikeSignAction(url, body) {
  const text = `${decodeURIComponentSafe(url)}\n${decodeURIComponentSafe(body || '')}`.toLowerCase();
  return CONFIG.signActionKeywords.some((word) => text.includes(word));
}

function looksLikeStatusRequest(url, body) {
  const text = `${decodeURIComponentSafe(url)}\n${decodeURIComponentSafe(body || '')}`.toLowerCase();
  return CONFIG.statusKeywords.some((word) => text.includes(word));
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (_) {
    return String(value || '');
  }
}

function capture() {
  const url = $request.url;
  const method = ($request.method || 'GET').toUpperCase();
  const headers = normalizeHeaders($request.headers || {});
  const body = $request.body || '';
  const urlObj = parseUrl(url);

  const authHeaders = pickAuthHeaders(headers);
  if (hasAuthSignal(headers)) {
    const saved = readJson(STORE.auth, {});
    const auth = {
      updatedAt: now(),
      url,
      headers: mergeHeaders(saved.headers, authHeaders),
    };
    writeJson(STORE.auth, auth);
    log('已保存 NGA 登录凭据', { url, headers: auth.headers });
    notify('NGA 捕获成功', '已保存登录凭据', urlObj ? urlObj.hostname : url);
  }

  if (isStaticAsset(url)) {
    if (CONFIG.debug && CONFIG.logStaticAssets) log('跳过静态资源', { method, url, hasCookie: Boolean(headers.cookie) });
    done();
    return;
  }

  if (CONFIG.debug && CONFIG.logNonStaticRequests) {
    log('NGA 非静态请求', {
      method,
      host: urlObj ? urlObj.hostname : '',
      path: urlObj ? urlObj.pathname : url,
      headerNames: Object.keys(headers),
      hasCookie: Boolean(headers.cookie),
      cookieLooksLikeNGA: hasNGAAuthCookie(headers.cookie),
      hasAuthorization: Boolean(headers.authorization),
      hasAuthSignal: hasAuthSignal(headers),
    });
  }

  if (looksLikeStatusRequest(url, body)) {
    const statusReq = {
      updatedAt: now(),
      url,
      method,
      headers: mergeHeaders(headers, {}),
      body,
    };
    writeJson(STORE.statusReq, statusReq);
    log('已保存疑似签到状态请求', statusReq);
  }

  if (looksLikeSignRequest(url, body) && looksLikeSignAction(url, body)) {
    const signReq = {
      updatedAt: now(),
      url,
      method,
      headers: mergeHeaders(headers, {}),
      body,
    };
    writeJson(STORE.signReq, signReq);
    notify('NGA 捕获成功', '已保存签到请求', `${method} ${url}`);
    log('已保存签到请求', signReq);
  } else {
    log('捕获到 NGA 请求，但不像签到接口', { method, url, hasCookie: Boolean(headers.cookie) });
  }

  done();
}

function sendRequest(request, callback) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'POST') {
    $httpClient.post(request, callback);
  } else {
    $httpClient.get(request, callback);
  }
}

function buildRequest(signReq, auth) {
  const headers = mergeHeaders(signReq.headers, auth.headers);
  const request = {
    url: signReq.url,
    method: signReq.method || 'GET',
    headers,
  };
  if (request.method.toUpperCase() !== 'GET' && signReq.body) request.body = signReq.body;
  return request;
}

function parseResult(status, body) {
  const text = String(body || '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}

  const source = json ? safeJson(json) : text.replace(/\s+/g, ' ');
  const already = /已签到|已经签到|今日.*签|重复签到|signed|checked/i.test(source);
  const success = /签到成功|成功|success|ok/i.test(source);
  const notSigned = /未签到|没有签到|尚未签到|not.?sign|unsigned|unchecked/i.test(source);
  const daysMatch =
    source.match(/连续[^0-9]{0,8}([0-9]+)[^0-9]{0,4}天/) ||
    source.match(/累计[^0-9]{0,8}([0-9]+)[^0-9]{0,4}天/) ||
    source.match(/check.?in.?days["':：\s]+([0-9]+)/i) ||
    source.match(/continuous.?days["':：\s]+([0-9]+)/i);
  const extracted = json ? extractStatsFromObject(json) : {};

  return {
    status,
    already: already || extracted.checkedIn === true,
    notSigned: notSigned || extracted.checkedIn === false,
    success,
    days: extracted.continuousDays || extracted.accumulateDays || (daysMatch ? daysMatch[1] : ''),
    continuousDays: extracted.continuousDays || '',
    accumulateDays: extracted.accumulateDays || '',
    summary: source.slice(0, 180),
  };
}

function extractStatsFromObject(value) {
  const result = {
    checkedIn: undefined,
    continuousDays: '',
    accumulateDays: '',
  };
  walk(value);
  return result;

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    Object.keys(node).forEach((key) => {
      const lower = key.toLowerCase();
      const val = node[key];

      if (typeof val === 'boolean' && /(checked|checkin|signin|signed|today).*(_?in)?$/.test(lower)) {
        result.checkedIn = val;
      }
      if ((typeof val === 'number' || typeof val === 'string') && !result.continuousDays && /(continuous|consecutive|streak|连续).*day|days|天/.test(lower)) {
        result.continuousDays = String(val);
      }
      if ((typeof val === 'number' || typeof val === 'string') && !result.accumulateDays && /(accumulate|total|sum|累计).*day|days|天/.test(lower)) {
        result.accumulateDays = String(val);
      }
      if (val && typeof val === 'object') walk(val);
    });
  }
}

function formatCheckinNotice(result) {
  const lines = [];
  if (result.continuousDays) lines.push(`连续签到：${result.continuousDays} 天`);
  if (result.accumulateDays) lines.push(`累计签到：${result.accumulateDays} 天`);
  if (!lines.length && result.days) lines.push(`签到天数：${result.days} 天`);
  lines.push(result.summary);
  return lines.join('\n');
}

function runCheckin() {
  log(`NGA 自动签到启动，版本 ${CONFIG.version}`);
  const signReq = readJson(STORE.signReq, null);
  const statusReq = readJson(STORE.statusReq, null);
  const auth = readJson(STORE.auth, null);

  if (!auth || !auth.headers || !auth.headers.cookie) {
    notify('NGA 签到未配置', '缺少登录 Cookie', '请打开 NGA App 进入需要登录的页面刷新一次');
    log('缺少登录 Cookie');
    done();
    return;
  }

  if (statusReq) {
    checkStatusThenSign(statusReq, signReq, auth);
    return;
  }

  if (!signReq) {
    notify('NGA 签到未配置', '缺少状态/签到请求', '请打开 NGA App 签到页刷新；未签到时再手动签到一次捕获接口');
    log('缺少状态/签到请求');
    done();
    return;
  }

  performSign(signReq, auth);
}

function checkStatusThenSign(statusReq, signReq, auth) {
  const request = buildRequest(statusReq, auth);
  log('先检查签到状态', request);

  sendRequest(request, (error, response, body) => {
    if (error) {
      log('状态检查失败，尝试直接签到', String(error));
      if (signReq) {
        performSign(signReq, auth);
      } else {
        notify('NGA 签到失败', '状态检查失败且无签到请求', String(error));
        done();
      }
      return;
    }

    const statusResult = parseResult(response && response.status, body);
    log('状态响应', statusResult);

    if (statusResult.already) {
      notify('NGA 签到', '今日已签到', formatCheckinNotice(statusResult));
      done();
      return;
    }

    if (!signReq) {
      notify('NGA 签到未配置', '今天似乎未签到，但缺少签到请求', '请在未签到状态下手动签到一次，让脚本捕获真正签到接口');
      done();
      return;
    }

    performSign(signReq, auth);
  });
}

function performSign(signReq, auth) {
  const request = buildRequest(signReq, auth);
  log('开始签到请求', request);

  sendRequest(request, (error, response, body) => {
    if (error) {
      notify('NGA 签到失败', '网络错误', String(error));
      log('网络错误', String(error));
      done();
      return;
    }

    const status = response && response.status;
    const result = parseResult(status, body);
    log('签到响应', result);

    if (result.already) {
      notify('NGA 签到', '今日已签到', formatCheckinNotice(result));
    } else if (result.success || status === 200) {
      notify('NGA 签到', '签到请求完成', formatCheckinNotice(result));
    } else {
      notify('NGA 签到失败', `HTTP ${status || 'unknown'}`, result.summary);
    }
    done();
  });
}

if (isRequestMode()) {
  capture();
} else {
  runCheckin();
}
