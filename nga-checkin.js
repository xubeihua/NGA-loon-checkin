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
  lastDebug: 'nga.checkin.debug.v1',
};

const CONFIG = {
  version: 'nga-loon-20260623-1',
  notify: true,
  debug: true,
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
  authCookieNames: ['ngaPassportUid', 'ngaPassportCid', 'ngaPassportUrlencodedUname', 'guestJs', 'lastvisit'],
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

function isStaticAsset(url) {
  const path = url.split('?')[0].toLowerCase();
  return /\.(css|js|map|png|jpe?g|gif|webp|svg|ico|ttf|otf|woff2?|eot|mp4|m4v|mov|webm|mp3|m4a|wav)$/.test(path);
}

function hasNGAAuthCookie(cookie) {
  if (!cookie) return false;
  return CONFIG.authCookieNames.some((name) => new RegExp(`(^|;\\s*)${name}=`, 'i').test(cookie));
}

function looksLikeSignRequest(url, body) {
  const text = `${decodeURIComponentSafe(url)}\n${decodeURIComponentSafe(body || '')}`.toLowerCase();
  return CONFIG.signKeywords.some((word) => text.includes(word));
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

  if (isStaticAsset(url)) {
    if (CONFIG.debug) log('跳过静态资源', { method, url });
    done();
    return;
  }

  if (headers.cookie && hasNGAAuthCookie(headers.cookie)) {
    const saved = readJson(STORE.auth, {});
    const auth = {
      updatedAt: now(),
      url,
      headers: mergeHeaders(saved.headers, {
        cookie: headers.cookie,
        'user-agent': headers['user-agent'],
        accept: headers.accept,
        'accept-language': headers['accept-language'],
      }),
    };
    writeJson(STORE.auth, auth);
    log('已保存 NGA 登录 Cookie', { url, headers: auth.headers });
  }

  if (looksLikeSignRequest(url, body)) {
    const signReq = {
      updatedAt: now(),
      url,
      method,
      headers: mergeHeaders(headers, {}),
      body,
    };
    writeJson(STORE.signReq, signReq);
    notify('NGA 捕获成功', '已保存疑似签到请求', `${method} ${url}`);
    log('已保存疑似签到请求', signReq);
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
  const daysMatch =
    source.match(/连续[^0-9]{0,8}([0-9]+)[^0-9]{0,4}天/) ||
    source.match(/累计[^0-9]{0,8}([0-9]+)[^0-9]{0,4}天/) ||
    source.match(/check.?in.?days["':：\s]+([0-9]+)/i) ||
    source.match(/continuous.?days["':：\s]+([0-9]+)/i);

  return {
    status,
    already,
    success,
    days: daysMatch ? daysMatch[1] : '',
    summary: source.slice(0, 180),
  };
}

function runCheckin() {
  log(`NGA 自动签到启动，版本 ${CONFIG.version}`);
  const signReq = readJson(STORE.signReq, null);
  const auth = readJson(STORE.auth, null);

  if (!auth || !auth.headers || !auth.headers.cookie) {
    notify('NGA 签到未配置', '缺少登录 Cookie', '请打开 NGA App 进入需要登录的页面刷新一次');
    log('缺少登录 Cookie');
    done();
    return;
  }

  if (!signReq) {
    notify('NGA 签到未配置', '缺少签到请求', '首次需要在 NGA App 手动签到一次用于捕获接口');
    log('缺少签到请求');
    done();
    return;
  }

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
      notify('NGA 签到', '今日已签到', result.days ? `连续/累计签到约 ${result.days} 天\n${result.summary}` : result.summary);
    } else if (result.success || status === 200) {
      notify('NGA 签到', '签到请求完成', result.days ? `签到天数：${result.days} 天\n${result.summary}` : result.summary);
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
