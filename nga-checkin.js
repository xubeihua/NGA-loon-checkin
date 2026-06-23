const COOKIE_KEY = "NGA_COOKIES";

const CHECKIN_URL = "https://bbs.nga.cn/nuke.php?__lib=check_in&__act=check_in&__output=14";

main();

function main() {
  if (typeof $request !== "undefined") {
    saveCookie();
  } else {
    checkIn();
  }
}

function saveCookie() {
  const headers = $request.headers || {};
  const cookie = headers["Cookie"] || headers["cookie"] || "";

  if (!cookie) return finish();

  if (cookie.indexOf("ngaPassportUid") === -1 || cookie.indexOf("ngaPassportCid") === -1) {
    return finish();
  }

  const uidMatch = cookie.match(/ngaPassportUid=([^;]+)/);
  const uid = uidMatch ? uidMatch[1] : "";

  if (!uid) return finish();

  let cookies = [];

  try {
    cookies = JSON.parse($persistentStore.read(COOKIE_KEY) || "[]");
  } catch (e) {
    cookies = [];
  }

  const account = {
    uid: uid,
    cookie: cookie,
    updateTime: new Date().toLocaleString()
  };

  const index = cookies.findIndex(item => item.uid === uid);

  if (index >= 0) {
    cookies[index] = account;
    notify("Cookie 更新成功", `UID：${uid}`);
  } else {
    cookies.push(account);
    notify("Cookie 添加成功", `UID：${uid}`);
  }

  $persistentStore.write(JSON.stringify(cookies), COOKIE_KEY);
  finish();
}

function checkIn() {
  let cookies = [];

  try {
    cookies = JSON.parse($persistentStore.read(COOKIE_KEY) || "[]");
  } catch (e) {
    cookies = [];
  }

  if (!cookies.length) {
    notify("未获取 Cookie", "请先分别登录 NGA 账号并访问 bbs.nga.cn");
    return finish();
  }

  let index = 0;
  let results = [];

  function next() {
    if (index >= cookies.length) {
      notify("NGA 多账号签到完成", results.join("\n"));
      return finish();
    }

    const account = cookies[index];
    index++;

    doCheckIn(account, function (msg) {
      results.push(`UID ${account.uid}：${msg}`);
      setTimeout(next, 1500);
    });
  }

  next();
}

function doCheckIn(account, callback) {
  const request = {
    url: CHECKIN_URL,
    timeout: 10000,
    headers: {
      "Cookie": account.cookie,
      "User-Agent": "Nga_Official",
      "X-User-Agent": "Nga_Official",
      "Referer": "https://bbs.nga.cn/",
      "Origin": "https://bbs.nga.cn",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: ""
  };

  $httpClient.post(request, function (error, response, body) {
    if (error) {
      return callback("请求失败：" + error);
    }

    const result = parseBody(body);
    const message = extractMessage(result, body);

    callback(message || "签到完成");
  });
}

function parseBody(body) {
  if (!body) return null;

  let text = String(body).trim();

  text = text.replace(/^window\.[\w$]+\s*=\s*/, "");
  text = text.replace(/;$/, "");

  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {}
    }
  }

  return null;
}

function extractMessage(result, rawBody) {
  if (result) {
    if (result.error) {
      if (Array.isArray(result.error)) return String(result.error[0]);
      return JSON.stringify(result.error);
    }

    if (result.data) {
      if (Array.isArray(result.data)) return String(result.data[0]);
      if (typeof result.data === "string") return result.data;
      if (result.data.msg) return String(result.data.msg);
      return JSON.stringify(result.data).slice(0, 300);
    }

    if (result.message) return String(result.message);
    if (result.msg) return String(result.msg);
  }

  if (typeof rawBody === "string" && rawBody.length > 0) {
    return rawBody.slice(0, 300);
  }

  return "接口无返回内容";
}

function notify(subtitle, content) {
  console.log(`[NGA] ${subtitle}: ${content}`);
  $notification.post("NGA 多账号签到", subtitle, String(content || ""));
}

function finish() {
  $done({});
}
