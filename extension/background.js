/* ============================================================================
 * Apple Music 歌单管家 —— 后台 Service Worker（MV3）
 * ----------------------------------------------------------------------------
 * 职责：
 *   1. 接收 bridge.js 中继过来的凭证（developer token + Music-User-Token）并保存
 *   2. 向独立面板窗口提供凭证
 *   3. 提供一条"经后台发起"的 API 通道（用于对比 CORS 行为）
 *   4. 打开独立面板窗口
 * ========================================================================== */

const CRED_KEY = 'am_cred_v1';
const PANEL_PATH = 'panel.html';

/* ---------------------------- 凭证存取 ---------------------------- */

async function saveCred(auth, mut) {
  try {
    await chrome.storage.local.set({
      [CRED_KEY]: { auth: auth, mut: mut, at: Date.now() },
    });
  } catch (e) {}
}

async function loadCred() {
  try {
    const o = await chrome.storage.local.get(CRED_KEY);
    const c = o && o[CRED_KEY];
    if (!c || !c.auth || !c.mut) return null;
    return c;
  } catch (e) {
    return null;
  }
}

/* ---------------------------- API 通道 ---------------------------- */

/**
 * 从后台发起请求。
 * MV3 里带 host_permissions 的扩展可以跨源请求，不受页面 CORS 限制。
 * 这里返回结构化的结果，方便面板对比"直连"与"经后台"两种方式。
 */
async function apiViaBackground(url, headers) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: headers || {},
      credentials: 'omit',
      cache: 'no-store',
    });
    const text = await res.text();
    return {
      transport: 'service-worker',
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      body: text.slice(0, 1200),
    };
  } catch (e) {
    return {
      transport: 'service-worker',
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: String(e && e.message ? e.message : e),
    };
  }
}

async function apiDirect(url, headers) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: headers || {},
      credentials: 'omit',
      cache: 'no-store',
    });
    const text = await res.text();
    return {
      transport: 'panel-direct',
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      body: text.slice(0, 1200),
    };
  } catch (e) {
    return {
      transport: 'panel-direct',
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: String(e && e.message ? e.message : e),
    };
  }
}

/* ------------------- declarativeNetRequest：改写 Origin/Referer -------------------
 * Apple 的开发者令牌绑定来源。扩展页面发出的请求 Origin 是 chrome-extension://，
 * 会被判未授权（401，且响应体为空）。这里把它改写成 music.apple.com。
 * ------------------------------------------------------------------------------ */
const DNR_RULE_ID = 1001;

function installDnrRules() {
  try {
    const rules = [
      {
        id: DNR_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'origin', operation: 'set', value: 'https://music.apple.com' },
            { header: 'referer', operation: 'set', value: 'https://music.apple.com/' },
          ],
        },
        condition: {
          urlFilter: '||music.apple.com',
          resourceTypes: ['xmlhttprequest'],
        },
      },
    ];
    chrome.declarativeNetRequest.updateDynamicRules(
      { removeRuleIds: [DNR_RULE_ID], addRules: rules },
      function () {
        void chrome.runtime.lastError;
      }
    );
  } catch (e) {}
}

installDnrRules();
try {
  chrome.runtime.onStartup.addListener(installDnrRules);
} catch (e) {}

/* ------------------- 经内容脚本代理（页面源，最可靠） ------------------- */

function sendToTab(tabId, payload, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const timer = setTimeout(function () {
      if (!done) { done = true; resolve({ __timeout: true, error: '页面端超时未响应' }); }
    }, timeoutMs || 12000);
    try {
      chrome.tabs.sendMessage(tabId, payload, function (resp) {
        const err = chrome.runtime.lastError;
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          // 最常见的是 "Could not establish connection. Receiving end does not exist."
          // —— 扩展刚重载过，页面里旧的 bridge.js 已成为孤儿脚本
          resolve({ __noReceiver: true, error: err.message || String(err) });
          return;
        }
        resolve(resp || null);
      });
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ __noReceiver: true, error: String((e && e.message) || e) });
      }
    }
  });
}

/* 把 bridge.js 重新注入某个标签页（扩展重载后用来复活通道） */
async function ensureBridge(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['bridge.js'],
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function pageCall(payload, timeoutMs) {
  const started = Date.now();
  const t = timeoutMs || 12000;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://music.apple.com/*' });
    if (!tabs || !tabs.length) {
      return { ok: false, status: 0, ms: 0, error: '没有打开 music.apple.com 的标签页' };
    }

    let lastErr = '';
    for (const tab of tabs) {
      let res = await sendToTab(tab.id, payload, t);

      // 接收端不存在（多为扩展刚重载）→ 自动重新注入 bridge.js 再试一次
      if (res && res.__noReceiver) {
        lastErr = res.error || '';
        const ok = await ensureBridge(tab.id);
        if (ok) {
          await new Promise(function (r) { setTimeout(r, 250); });
          res = await sendToTab(tab.id, payload, t);
        }
      }

      if (res && !res.__noReceiver && !res.__timeout) {
        res.ms = Date.now() - started;
        return res;
      }
      lastErr = (res && res.error) || lastErr;
    }

    return {
      ok: false, status: 0, ms: Date.now() - started,
      error: lastErr || '标签页没有响应',
    };
  } catch (e) {
    return {
      ok: false, status: 0, ms: Date.now() - started,
      error: String((e && e.message) || e),
    };
  }
}

async function apiViaContentScript(req) {
  const r = await pageCall({
    type: 'am-page-fetch',
    url: req.url,
    method: req.method || 'GET',
    body: req.body || null,
  }, 9000);
  return {
    transport: 'content-script（页面源）',
    ok: !!r.ok,
    status: r.status || 0,
    ms: r.ms || 0,
    body: r.body || '',
    error: r.error || null,
  };
}

/* ---------------------------- 消息路由 ---------------------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object' || !msg.type) return;

  if (msg.type === 'am-creds') {
    saveCred(msg.auth, msg.mut);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'am-get-creds') {
    loadCred().then(function (c) {
      sendResponse({ ok: !!c, cred: c });
    });
    return true; // 异步响应
  }

  if (msg.type === 'am-whoami') {
    sendResponse({
      ok: true,
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
    });
    return true;
  }

  if (msg.type === 'am-api') {
    (async function () {
      // 经内容脚本代理不需要凭证（页面自己有）
      if (msg.via === 'cs') {
        sendResponse(await apiViaContentScript(msg));
        return;
      }
      const cred = await loadCred();
      if (!cred) {
        sendResponse({ ok: false, status: 0, error: '后台还没有凭证（请先在 Apple Music 网页里刷新一次）' });
        return;
      }
      const headers = {
        Authorization: cred.auth,
        'Music-User-Token': cred.mut,
      };
      const out =
        msg.via === 'panel'
          ? await apiDirect(msg.url, headers)
          : await apiViaBackground(msg.url, headers);
      sendResponse(out);
    })();
    return true;
  }

  if (msg.type === 'am-play') {
    (async function () {
      sendResponse(await pageCall({ type: 'am-page-play', ids: msg.ids, startWith: msg.startWith }, 20000));
    })();
    return true;
  }

  if (msg.type === 'am-transport') {
    (async function () {
      sendResponse(await pageCall({ type: 'am-page-transport', action: msg.action }, 9000));
    })();
    return true;
  }

  if (msg.type === 'am-open-panel') {
    openPanel();
    sendResponse({ ok: true });
    return true;
  }
});

/* ---------------- 打开独立面板窗口（已开着就聚焦，不重复开） ---------------- */
async function openPanel() {
  const url = chrome.runtime.getURL(PANEL_PATH);

  // 先找有没有已经开着的面板窗口
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins || []) {
      for (const t of w.tabs || []) {
        if (t && t.url && t.url.indexOf(url) === 0) {
          try {
            await chrome.windows.update(w.id, { focused: true, drawAttention: true });
          } catch (e) {}
          return;
        }
      }
    }
  } catch (e) {}

  try {
    chrome.windows.create(
      { url: url, type: 'popup', width: 470, height: 820, top: 70, left: 120 },
      function () {
        void chrome.runtime.lastError;
      }
    );
  } catch (e) {}
}

try {
  chrome.action.onClicked.addListener(function () {
    openPanel();
  });
} catch (e) {}

/* ------------------- 装好后自动打开一次面板 ------------------- */
chrome.runtime.onInstalled.addListener(function (details) {
  try {
    if (details && details.reason === 'install') openPanel();
  } catch (e) {}
});
