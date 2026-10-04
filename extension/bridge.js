/* ============================================================================
 * Apple Music 歌单管家 —— 桥接脚本（ISOLATED world）
 * ----------------------------------------------------------------------------
 * content.js 跑在页面的 MAIN world（为了能用 MusicKit），那里没有 chrome.* API。
 * 这个脚本跑在 ISOLATED world，负责：
 *   1. 把 MAIN world 抓到的凭证转交后台
 *   2. 把后台转发来的请求交给 MAIN world，从「页面源」发出
 *      （Origin 天然是 https://music.apple.com，Apple 才认）
 *   3. 把独立面板窗口的播放指令转给页面，由页面的 MusicKit 执行
 *
 * 三类转发的报文标签：
 *   am-page-fetch     → __am_fetch_req__     / __am_fetch_res__
 *   am-page-play      → __am_play_req__      / __am_play_res__
 *   am-page-transport → __am_transport_req__ / __am_transport_res__
 *
 * 这里只做消息中转，不碰页面 DOM、不改页面行为。
 * ========================================================================== */

(function () {
  'use strict';

  const CRED_TAG = '__am_creds__';

  /* 转发通道表：后台消息类型 → 页面上的一对标签 */
  const CHANNELS = {
    'am-page-fetch': { req: '__am_fetch_req__', res: '__am_fetch_res__' },
    'am-page-play': { req: '__am_play_req__', res: '__am_play_res__' },
    'am-page-transport': { req: '__am_transport_req__', res: '__am_transport_res__' },
  };

  /* ---------------- 1. 凭证中继 ---------------- */

  window.addEventListener(
    'message',
    function (ev) {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || !d[CRED_TAG]) return;

      const auth = d[CRED_TAG].auth;
      const mut = d[CRED_TAG].mut;
      if (typeof auth !== 'string' || typeof mut !== 'string') return;
      if (!auth || !mut) return;

      try {
        chrome.runtime.sendMessage({ type: 'am-creds', auth: auth, mut: mut }, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) {}
    },
    false
  );

  /* ---------------- 2. 通用转发：后台 → 页面 → 后台 ---------------- */

  const pending = Object.create(null);
  let seq = 0;

  window.addEventListener(
    'message',
    function (ev) {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object') return;
      for (const key in CHANNELS) {
        const tag = CHANNELS[key].res;
        if (d[tag]) {
          const r = d[tag];
          const cb = pending[r.reqId];
          if (cb) {
            delete pending[r.reqId];
            try { cb(r); } catch (e) {}
          }
          return;
        }
      }
    },
    false
  );

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !CHANNELS[msg.type]) return;

    const chan = CHANNELS[msg.type];
    const reqId = 'r' + Date.now() + '_' + ++seq;
    let settled = false;

    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      delete pending[reqId];
      sendResponse({ ok: false, error: '页面端超时未响应' });
    }, 12000);

    pending[reqId] = function (r) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sendResponse(r);
    };

    try {
      const payload = Object.assign({}, msg);
      delete payload.type;
      payload.reqId = reqId;
      const out = {};
      out[chan.req] = payload;
      window.postMessage(out, '*');
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        delete pending[reqId];
        sendResponse({ ok: false, error: '无法向页面投递请求' });
      }
    }

    return true; // 异步响应
  });

  /* ---------------- 3. 页面请求打开独立面板窗口（桌面悬浮球触发）---------------- */
  window.addEventListener(
    'message',
    function (ev) {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || !d.__am_open_panel__) return;
      try {
        chrome.runtime.sendMessage({ type: 'am-open-panel' }, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) {}
    },
    false
  );

  /* ---------------- 5. 页面日志中继（回传到面板窗口） ---------------- */
  window.addEventListener(
    'message',
    function (ev) {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || !d.__am_log__) return;
      try {
        chrome.runtime.sendMessage(
          { type: 'am-page-log', msg: d.__am_log__.msg, cls: d.__am_log__.cls },
          function () { void chrome.runtime.lastError; }
        );
      } catch (e) {}
    },
    false
  );

  /* ---------------- 6. 告诉后台这个页面已就绪 ---------------- */
  try {
    chrome.runtime.sendMessage({ type: 'am-page-ready' }, function () {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
})();
