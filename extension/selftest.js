/* ============================================================================
 * Apple Music 歌单管家 —— 独立面板窗口（连通性自检 v2）
 * ----------------------------------------------------------------------------
 * 四条传输路径对比，决定 P2 的最终架构：
 *   1. 面板直连 amp-api      （DNR 改写 Origin）
 *   2. 经后台 Service Worker （DNR 改写 Origin）
 *   3. 经内容脚本（页面源）   ← 保底方案，Origin 天然正确
 *   4. 面板直连 api（对照）
 * ========================================================================== */

(function () {
  'use strict';

  const AMP = 'https://amp-api.music.apple.com';
  const PUB = 'https://api.music.apple.com';
  const PATH = '/v1/me/library/playlists?limit=3';

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setBadge(id, ok, text) {
    const el = $(id);
    if (!el) return;
    el.className = 'badge ' + (ok === null ? 'wait' : ok ? 'pass' : 'fail');
    el.textContent = text || (ok === null ? '检测中' : ok ? '通过' : '失败');
  }

  function showResult(id, r) {
    const el = $(id);
    if (!el) return;
    if (!r) { el.innerHTML = ''; return; }
    let html = '';
    html += '<div class="kv"><b>传输方式</b><span>' + esc(r.transport || '-') + '</span></div>';
    html += '<div class="kv"><b>HTTP 状态</b><span>' + esc(String(r.status)) + '</span></div>';
    html += '<div class="kv"><b>耗时</b><span>' + esc(String(r.ms)) + ' ms</span></div>';
    if (r.error) html += '<div class="kv"><b>错误</b><span>' + esc(r.error) + '</span></div>';
    if (r.body) html += '<pre>' + esc(r.body) + '</pre>';
    el.innerHTML = html;
  }

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  async function directFetch(url, cred) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: cred.auth, 'Music-User-Token': cred.mut },
        credentials: 'omit',
        cache: 'no-store',
      });
      const text = await res.text();
      return {
        transport: 'panel-direct（扩展页面直接 fetch）',
        ok: res.ok, status: res.status, ms: Date.now() - started,
        body: text.slice(0, 1000),
      };
    } catch (e) {
      return {
        transport: 'panel-direct（扩展页面直接 fetch）',
        ok: false, status: 0, ms: Date.now() - started,
        error: String((e && e.message) || e),
      };
    }
  }

  async function run() {
    /* ---------- 0. 环境 ---------- */
    const who = await send({ type: 'am-whoami' });
    const credResp = await send({ type: 'am-get-creds' });
    const cred = credResp && credResp.cred ? credResp.cred : null;

    let env = '';
    env += '<div class="kv"><b>扩展 ID</b><span>' + esc(who && who.id) + '</span></div>';
    env += '<div class="kv"><b>扩展版本</b><span>' + esc(who && who.version) + '</span></div>';
    env += '<div class="kv"><b>当前源</b><span>' + esc(location.origin) + '</span></div>';
    if (cred) {
      const age = Math.round((Date.now() - (cred.at || 0)) / 1000);
      env += '<div class="kv"><b>后台凭证</b><span style="color:#4ade80">已拿到 ✓（更新于 ' + esc(String(age)) + ' 秒前）</span></div>';
      env += '<div class="kv"><b>开发者令牌</b><span>' + esc(cred.auth.slice(0, 26)) + '…（' + cred.auth.length + ' 字符）</span></div>';
      env += '<div class="kv"><b>用户令牌</b><span>' + esc(cred.mut.slice(0, 10)) + '…（' + cred.mut.length + ' 字符）</span></div>';
    } else {
      env += '<div class="kv"><b>后台凭证</b><span style="color:#f87171">没有 ✗ —— 请先打开一次 music.apple.com 并刷新</span></div>';
    }
    $('env').innerHTML = env;

    /* 第 3 条不需要凭证（页面自己有），所以即使没凭证也测 */
    for (const b of ['b1', 'b2', 'b3', 'b4']) setBadge(b, null, '检测中');
    for (const r of ['r1', 'r2', 'r3', 'r4']) $(r).innerHTML = '';

    /* ---------- 1. 面板直连 amp-api ---------- */
    let r1 = null;
    if (cred) {
      r1 = await directFetch(AMP + PATH, cred);
      showResult('r1', r1);
      setBadge('b1', r1.ok);
    } else { setBadge('b1', false, '跳过'); }

    /* ---------- 2. 经后台 Service Worker ---------- */
    let r2 = null;
    if (cred) {
      r2 = await send({ type: 'am-api', url: AMP + PATH, via: 'sw' });
      showResult('r2', r2);
      setBadge('b2', !!(r2 && r2.ok));
    } else { setBadge('b2', false, '跳过'); }

    /* ---------- 3. 经内容脚本（页面源） ---------- */
    const r3 = await send({ type: 'am-api', url: AMP + PATH, via: 'cs' });
    showResult('r3', r3);
    setBadge('b3', !!(r3 && r3.ok));

    /* ---------- 4. 面板直连 api（对照） ---------- */
    let r4 = null;
    if (cred) {
      r4 = await directFetch(PUB + PATH, cred);
      showResult('r4', r4);
      setBadge('b4', r4.ok);
    } else { setBadge('b4', false, '跳过'); }

    /* ---------- 总结 ---------- */
    const good = [];
    if (r1 && r1.ok) good.push('① 面板直连 amp-api');
    if (r2 && r2.ok) good.push('② 后台 Service Worker');
    if (r3 && r3.ok) good.push('③ 经内容脚本（页面源）');
    if (r4 && r4.ok) good.push('④ 面板直连 api');

    const s = $('summary');
    if (good.length >= 2) {
      s.className = 'summary good';
      s.innerHTML = '✅ <b>可行！</b>可用通道：' + esc(good.join('　')) +
        '<br>P2 按原计划进行：把 content.js 的完整 UI 搬进这个窗口，传输层用最靠前的可用通道。';
    } else if (good.length === 1) {
      s.className = 'summary mid';
      s.innerHTML = '⚠️ <b>只有一条可用：' + esc(good[0]) + '</b><br>' +
        (good[0].indexOf('③') === 0
          ? '那就用「经内容脚本」方案 —— 面板能开，但需要浏览器里有一个 music.apple.com 标签页。'
          : '就用这条通道，P2 可以继续。');
    } else {
      s.className = 'summary bad';
      s.innerHTML = '❌ <b>四条全不通。</b><br>把本页内容告诉我，我需要重新排查（可能是令牌本身的问题）。';
    }
  }

  $('again').addEventListener('click', run);
  run();
})();
