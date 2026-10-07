/* ============================================================================
 * Apple Music 歌单管家 —— 内容脚本 (MAIN world)
 * 在 music.apple.com 上注入一个悬浮挂件：
 *   · 我的歌单：拉取全部歌单、展开看曲目、播放、删除
 *   · 歌曲管理：歌单内搜索添加 / 移除曲目
 *   · 创建歌单：批量建歌单（多版本选择、失败跳过、报告）
 *   · 播放：优先驱动页面 MusicKit，失败则打开歌曲页
 * ========================================================================== */
(function () {
  'use strict';

  /* ==================== 运行模式 ====================
   * 默认：music.apple.com 页面里的悬浮挂件
   * PANEL_MODE：由 panel.html 加载，同一个窗口里跑整套 UI（P2 独立面板）
   * 两种模式共用下面全部 UI / API / 流程代码。
   * ================================================ */
  /* 独立面板模式下 location.protocol 是 chrome-extension:（扩展页面 CSP 禁止内联脚本，
     所以用协议判断，而不是在面板页面里写内联赋值） */
  const PANEL_MODE = !!(
    (typeof window !== 'undefined' && window.__AM_PANEL_MODE__) ||
    (typeof location !== 'undefined' && location.protocol === 'chrome-extension:')
  );

  /* 独立窗口下的布局覆盖：面板铺满窗口、隐藏挂件球 */
  const PMODE_CSS = `
    .fab{display:none !important}
    .panel{position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;
           width:auto !important;height:100vh !important;max-height:none !important;
           border-radius:0 !important;border:0 !important;box-shadow:none !important}
    .panel .hd{cursor:default !important}
  `;

  const API = 'https://api.music.apple.com';
  const ALT_HOST = 'https://amp-api.music.apple.com';
  const SAMPLE = [
    '夜空中最亮的星 - 逃跑计划',
    '我的歌声里 - 曲婉婷',
    '缘分一道桥 - 王力宏',
    '小宇 - 蓝心羽',
    '阿拉斯加海湾 - 蓝心羽',
    '无论你多怪异我还是会喜欢你 - 周子琰',
    '你的 - 贺仙人',
    '明天你好 - 牛奶咖啡',
    '醉赤壁 - 林俊杰',
    '月亮之上 - 凤凰传奇',
  ].join('\n');

  const LS = {
    get(k, d) {
      try { const v = localStorage.getItem('__am_pb_' + k); return v === null ? d : v; } catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem('__am_pb_' + k, v); } catch (e) {} },
  };

  /* ======================== 凭证 ======================== */
  const have = { auth: null, mut: null };
  const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/;
  const findJwt = (s) => (typeof s === 'string' && JWT_RE.test(s) ? s.match(JWT_RE)[0] : null);
  const looksOpaque = (v) =>
    typeof v === 'string' && /^\S{40,4000}$/.test(v.trim()) &&
    !/^\s*Bearer\s/i.test(v) && !JWT_RE.test(v);

  const hdrEntries = (h) => {
    try {
      if (!h) return [];
      if (typeof Headers !== 'undefined' && h instanceof Headers) return [...h.entries()];
      if (Array.isArray(h)) return h.map((x) => [String(x[0]), x[1]]);
      if (typeof h === 'object') return Object.keys(h).map((k) => [k, h[k]]);
    } catch (e) {}
    return [];
  };

  const recordHeaders = (h) => {
    for (const [k, v] of hdrEntries(h)) {
      const kn = String(k);
      const vs = typeof v === 'string' ? v : String(v);
      const jwt = findJwt(vs);
      if (jwt && !have.auth) have.auth = 'Bearer ' + jwt;
      else if (!jwt && looksOpaque(vs) && !have.mut && /token|auth/i.test(kn)) have.mut = vs.trim();
    }
  };

  const tryMusicKit = () => {
    try {
      const MK = window.MusicKit;
      if (!MK || !MK.getInstance) return null;
      const inst = MK.getInstance();
      if (!inst) return null;
      if (inst.musicUserToken && !have.mut) have.mut = inst.musicUserToken;
      const dt = inst.developerToken || (inst.config && inst.config.developerToken);
      if (dt && !have.auth) have.auth = 'Bearer ' + String(dt).replace(/^Bearer\s+/i, '');
      return inst;
    } catch (e) { return null; }
  };

  const scanStorage = () => {
    for (const name of ['localStorage', 'sessionStorage']) {
      try {
        const s = window[name];
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          const v = s.getItem(k);
          if (!v) continue;
          const jwt = findJwt(v);
          if (jwt && !have.auth) have.auth = 'Bearer ' + jwt;
          if (/music.?user.?token|media.?user.?token/i.test(k) && looksOpaque(v) && !have.mut) {
            have.mut = v.trim();
          }
        }
      } catch (e) {}
    }
  };

  const HOOK_FLAG = '__am_pb_hooked__';
  if (!window[HOOK_FLAG]) {
    window[HOOK_FLAG] = true;
    const of = window.fetch;
    const oOpen = XMLHttpRequest.prototype.open;
    const oSetH = XMLHttpRequest.prototype.setRequestHeader;
    const oSend = XMLHttpRequest.prototype.send;
    window.fetch = function (input, init) {
      try {
        if (init && init.headers) recordHeaders(init.headers);
        else if (input && typeof input === 'object' && input.headers) recordHeaders(input.headers);
      } catch (e) {}
      return of.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = function () { this.__amh = {}; return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (this.__amh) this.__amh[k] = v; } catch (e) {}
      return oSetH.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try { recordHeaders(this.__amh); } catch (e) {}
      return oSend.apply(this, arguments);
    };
  }

  tryMusicKit();
  scanStorage();

  /* ============== 凭证中继（供 P2 独立面板窗口使用） ==============
   * content.js 跑在 MAIN world，没有 chrome.* API 可用。
   * 这里把抓到的凭证 postMessage 出去，由 bridge.js（ISOLATED world）转交后台，
   * 独立面板窗口再从后台取用。变化时才发送，开销可忽略。
   * ============================================================ */
  (function relayCreds() {
    let sentKey = '';
    setInterval(function () {
      try {
        if (!have.auth || !have.mut) return;
        const key = have.auth + '|' + have.mut;
        if (key === sentKey) return;
        sentKey = key;
        window.postMessage({ __am_creds__: { auth: have.auth, mut: have.mut } }, '*');
      } catch (e) {}
    }, 1200);
  })();

  /* ========== 代独立面板窗口从「页面源」发请求（P2） ==========
   * 扩展页面发出的请求 Origin 是 chrome-extension://，Apple 判 401。
   * 这里让请求回到网页里发出 —— Origin 天然是 https://music.apple.com。
   * ========================================================= */
  window.addEventListener(
    'message',
    function (ev) {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || !d.__am_fetch_req__) return;
      const req = d.__am_fetch_req__;
      (async function () {
        const out = { reqId: req.reqId, ok: false, status: 0, body: '', error: null };
        try {
          const opts = {
            method: req.method || 'GET',
            headers: {
              Authorization: have.auth || '',
              'Music-User-Token': have.mut || '',
              'Content-Type': 'application/json',
            },
          };
          if (req.body) opts.body = req.body;
          const res = await fetch(req.url, opts);
          out.status = res.status;
          out.ok = res.ok;
          out.body = (await res.text()).slice(0, 200000);
        } catch (e) {
          out.error = String((e && e.message) || e);
        }
        try { window.postMessage({ __am_fetch_res__: out }, '*'); } catch (e) {}
      })();
    },
    false
  );

  /* ========== 代独立面板窗口执行播放（P2 · B 方案） ==========
   * 面板窗口没有 MusicKit，把播放/控制指令转回网页，由页面播放器执行。
   * 通道：面板 → 后台 → bridge.js → 本文件（页面侧）→ MusicKit
   * 下面 sendChrome/playViaPage/pageTransport 只在面板窗口里被调用；
   * 页面 MAIN world 没有 chrome.* API，所以都包在 try 里。
   * ====================================================== */
  function sendChrome(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError;
          resolve(r || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function playViaPage(ids, startWith) {
    const list = (ids || []).filter(Boolean).map(String);
    if (!list.length) return '失败：没有可播放的曲目（可能都是本地上传）';
    log('已把播放指令转给网页…', 'info');
    const r = await sendChrome({
      type: 'am-play',
      ids: list,
      startWith: startWith ? String(startWith) : null,
    });
    if (!r) return '失败：扩展后台没有响应';
    if (!r.ok) return '失败：' + (r.error || '网页端未执行');
    return '网页 MusicKit';
  }

  // 找 Apple Music 网页【自己的】上一首/下一首按钮。
  // 用途：MusicKit 的 skipToNextItem() 有可能静默无效，兜底直接点真实按钮。
  function findTransportBtn(a) {
    const want = a === 'next' ? /next|下一首|下一曲/i : /prev|previous|上一首|上一曲/i;
    const all = document.querySelectorAll('button, [role="button"]');
    for (const b of all) {
      const txt = String(b.className || '') + ' ' +
        (b.getAttribute && (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || ''));
      if (want.test(txt) && !b.disabled) return b;
    }
    // 退而求其次：播放控制条里按位置取（首=上一首，尾=下一首）
    const bar = document.querySelector('[class*="playback-controls"]');
    if (bar) {
      const bs = [...bar.querySelectorAll('button')].filter((x) => !x.disabled);
      if (bs.length >= 3) return a === 'next' ? bs[bs.length - 1] : bs[0];
    }
    return null;
  }
  async function pageTransport(action) {
    if (!action) return { ok: false, error: '未知控制指令' };
    const r = await sendChrome({ type: 'am-transport', action: action });
    return r || { ok: false, error: '扩展后台没有响应' };
  }

  /* ---- 页面端：执行面板转来的播放 / 控制指令 ---- */
  window.addEventListener(
    'message',
    function (ev) {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object') return;

      if (d.__am_play_req__) {
        const req = d.__am_play_req__;
        (async function () {
          const out = { reqId: req.reqId, ok: false, via: '', error: null };
          try {
            if (!tryMusicKit()) throw new Error('网页播放器还没就绪，请先在页面底部播放一次');
            const r = await playSongIds(req.ids || [], req.startWith);
            if (typeof r === 'string' && r.indexOf('失败') === 0) out.error = r;
            else { out.ok = true; out.via = r; }
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          try { window.postMessage({ __am_play_res__: out }, '*'); } catch (e) {}
        })();
        return;
      }

      if (d.__am_transport_req__) {
        const req = d.__am_transport_req__;
        (async function () {
          const out = { reqId: req.reqId, ok: false, error: null, via: null };
          try {
            const inst = tryMusicKit();
            if (!inst) throw new Error('网页播放器还没就绪，请先在页面底部播放一次');
            const a = req.action;

            if (a === 'toggle') {
              if (inst.isPlaying) await inst.pause(); else await inst.play();
              out.ok = true; out.via = 'MusicKit';
            } else if (a === 'next' || a === 'prev') {
              // ★ 不再无条件报成功：记录调用前的曲目，调用后【验证是否真的换了】
              const before = (inst.nowPlayingItem && inst.nowPlayingItem.id) || '';
              // ★ 优先走「自己算下标 + 单曲队列 + 验证起点」的换歌逻辑：
              //   原生 skipToNextItem 遇到坏曲目会回卷到第 1 首（实测），
              //   而且单曲队列里它根本没得跳。绝不因为一首歌坏了就回到队首。
              const step = await goAdjacent(a === 'next' ? 1 : -1,
                (a === 'next' ? '下一首' : '上一首') + '（面板或悬浮球）');
              if (step && step.ok) {
                out.ok = true;
                out.via = step.via;
              } else {
                out.error = (step && step.error) || '';
                if (step && step.noCtx) {
                  // 没有曲目上下文（例如只在页面手动播了一首）→ 才退回原生 skip + 网页按钮
                  try {
                    if (a === 'next') { if (inst.skipToNextItem) await inst.skipToNextItem(); }
                    else { if (inst.skipToPreviousItem) await inst.skipToPreviousItem(); }
                  } catch (e) { out.error = (out.error ? out.error + '；' : '') + String((e && e.message) || e); }
                  await new Promise((r) => setTimeout(r, 700));

                  const after = (inst.nowPlayingItem && inst.nowPlayingItem.id) || '';
                  if (after && after !== before) { out.ok = true; out.via = 'MusicKit 原生 skip'; }
                  else {
                    // MusicKit 没动 → 直接点网页自己的按钮（最可靠）
                    const el = findTransportBtn(a);
                    if (!el) {
                      out.error = (out.error ? out.error + '；' : '') +
                        'MusicKit 未换歌，且找不到网页的' + (a === 'next' ? '下一首' : '上一首') + '按钮';
                    } else {
                      el.click();
                      await new Promise((r) => setTimeout(r, 700));
                      const a2 = (inst.nowPlayingItem && inst.nowPlayingItem.id) || '';
                      if (a2 && a2 !== before) { out.ok = true; out.via = '网页按钮'; }
                      else out.error = 'MusicKit 和网页按钮都没能换歌（可能已在队列首/尾）';
                    }
                  }
                } else {
                  // 已经到队首/队尾：宁可停在当前曲目，也不回卷到第 1 首
                  out.error = (out.error ? out.error + '；' : '') + '不向前跳也不回到队首，已停在当前曲目';
                }
              }
            } else throw new Error('未知指令 ' + a);
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          try { window.postMessage({ __am_transport_res__: out }, '*'); } catch (e) {}
        })();
        return;
      }
    },
    false
  );

  /* ======================== API 层 ======================== */
  let storefront = LS.get('sf', '') || 'cn';

  async function apiFetch(path, opts) {
    opts = opts || {};
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        Authorization: have.auth || '',
        'Music-User-Token': have.mut || '',
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      const msg = (json && (json.errors && json.errors[0] && json.errors[0].title)) || text.slice(0, 160);
      throw new Error('HTTP ' + res.status + (msg ? ' · ' + msg : ''));
    }
    return json || {};
  }

  async function apiRaw(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      ...opts,
      headers: {
        Authorization: have.auth || '',
        'Music-User-Token': have.mut || '',
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
  }

  // 逐个尝试不同的请求形式，把每一次的真实结果都记进日志
  async function attemptFetch(method, base, path, body, label) {
    log('  ▸ ' + label + ' …', 'info');
    const headers = {
      Authorization: have.auth || '',
      'Music-User-Token': have.mut || '',
      'Content-Type': 'application/json',
    };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    try {
      const res = await fetch(base + path, opts);
      let extra = '';
      if (!res.ok) {
        try {
          const tx = await res.text();
          if (tx) extra = ' · ' + tx.replace(/\s+/g, ' ').slice(0, 500);
        } catch (e) {}
      }
      log('    ' + label + ' → HTTP ' + res.status + extra, res.ok ? 'ok' : 'warn');
      return res.ok;
    } catch (e) {
      log('    ' + label + ' → 抛错 ' + ((e && e.message) || e), 'warn');
      return false;
    }
  }

  async function loadAllPlaylists() {
    let next = '/v1/me/library/playlists?limit=100';
    const out = [];
    for (let i = 0; i < 12 && next; i++) {
      const j = await apiFetch(next);
      (j.data || []).forEach((x) => out.push(x));
      next = j.next || null;
    }
    return out;
  }

  async function loadAllTracks(plId) {
    let next = `/v1/me/library/playlists/${plId}/tracks?limit=100`;
    const out = [];
    for (let i = 0; i < 12 && next; i++) {
      const j = await apiFetch(next);
      (j.data || []).forEach((x) => out.push(x));
      next = j.next || null;
    }
    return out;
  }

  async function searchCatalog(term) {
    const j = await apiFetch(
      `/v1/catalog/${storefront}/search?types=songs&limit=12&term=${encodeURIComponent(term)}`
    );
    return (j.results && j.results.songs && j.results.songs.data) || [];
  }

  const art = (a, size) =>
    a && a.artwork && a.artwork.url ? a.artwork.url.replace('{w}x{h}', size || '60x60') : '';

  const fmtDur = (ms) =>
    ms ? Math.floor(ms / 60000) + ':' + String(Math.floor((ms % 60000) / 1000)).padStart(2, '0') : '';

  // Apple 的约束：只有创建歌单的客户端才能编辑它。
  // 内置歌单（喜爱歌曲 / 喜欢 …）canEdit=false，任何接口写入都会失败。
  function canEditPl(pl) {
    return ((pl && pl.attributes) || {}).canEdit !== false;
  }
  const READONLY_TIP = '这是 Apple 的歌单，只有创建它的客户端才能编辑（接口无法修改）';

  /* ======================== 播放（全部走 MusicKit） ======================== */
  // 从 API 条目里取出可用于播放的「目录歌曲 ID」
  function catalogIdOf(item) {
    const a = (item && item.attributes) || {};
    const pp = a.playParams || {};
    if (pp.catalogId) return String(pp.catalogId);
    if (item && item.type === 'songs' && item.id) return String(item.id);
    return null;
  }

  // ★ 实证记录：播放时被目录接口判定【已失效】的 id。
  //   只用于在面板曲目列表上打 ⚠ 角标，绝不会因此剔除曲目。
  const badIds = new Set();

  // 批量确认这些 id 在目录里是否还存在。
  // 库内 id（i.xxx）无法用目录接口校验 —— 它们不会让 setQueue 失败，先当作有效放行。
  // 返回值里额外带上 names（id → '歌名 / 歌手'）：这份目录响应本来就要发，
  // 顺手留下歌名后，页面侧日志（包括面板转发过来的播放）也能打出歌名而不是一坨 id。
  async function filterPlayableIds(ids) {
    const list = [...new Set((ids || []).filter(Boolean).map(String))];
    const libIds = list.filter((x) => x.indexOf('i.') === 0);
    const catIds = list.filter((x) => x.indexOf('i.') !== 0);
    const okCat = [];
    const bad = [];
    const names = {};
    for (let i = 0; i < catIds.length; i += 100) {      // 接口单次上限约 100 个
      const chunk = catIds.slice(i, i + 100);
      const got = new Set();
      try {
        const j = await apiFetch('/v1/catalog/' + storefront + '/songs?ids=' + chunk.join(','));
        ((j && j.data) || []).forEach((s) => {
          if (!s || !s.id) return;
          got.add(String(s.id));
          const a = s.attributes || {};
          names[String(s.id)] = [a.name, a.artistName].filter(Boolean).join(' / ');
        });
      } catch (e) {
        // 校验请求本身失败（网络/限流）→ 不能因噎废食，全部放行，交给后面的降级逻辑
        log('⚠ 目录校验失败，这批 id 全部按有效处理：' + ((e && e.message) || e), 'warn');
        return { ok: list, bad: [], names: names };
      }
      chunk.forEach((id) => { if (got.has(id)) okCat.push(id); else bad.push(id); });
    }
    // 保险：如果【所有】目录 id 都被判失效，更可能是校验本身不可信
    // （商店区不对 / 接口返回异常），而不是歌真的都没了 → 全部放行，别把整个歌单清空。
    if (catIds.length > 1 && bad.length === catIds.length) {
      log('⚠ 目录里一个都没查到（共 ' + catIds.length + ' 个），判定为校验不可信，全部按有效处理', 'warn');
      return { ok: list, bad: [], names: names };
    }
    return { ok: okCat.concat(libIds), bad: bad, names: names };
  }

  // 「歌名 / 歌手」——只给日志用（拿不到就返回空串）
  function trackNameOf(item) {
    const a = (item && item.attributes) || {};
    return [a.name, a.artistName].filter(Boolean).join(' / ');
  }

  // 用一份曲目列表做「id → 歌名」映射，返回一个 (id) => 歌名 的函数。
  // 只在【本进程】使用：面板模式下它由面板自己的曲目列表生成，不跨进程传递。
  function nameMapperOf(items) {
    const m = new Map();
    (items || []).forEach((it) => {
      const id = catalogIdOf(it);
      if (id && !m.has(id)) m.set(id, trackNameOf(it));
    });
    return (id) => m.get(String(id)) || '';
  }

  function playStateText() {
    if (PANEL_MODE) return '播放由网页播放器执行（暂停/切歌用桌面悬浮球）';
    const inst = tryMusicKit();
    if (!inst) return '播放器未就绪（请先在本页播放一次）';
    try {
      if (inst.isPlaying) {
        const np = inst.nowPlayingItem;
        const nm = np && np.attributes ? np.attributes.name : '';
        return '▶ 正在播放' + (nm ? '：' + nm : '');
      }
      const st = inst.playbackState;
      if (st === 4 || st === 0) return '⏹ 未在播放';
      return '⏸ 已暂停';
    } catch (e) {
      return '状态未知';
    }
  }

  // 拿不到实例时，把实际情况报出来（不冒险 configure，避免破坏页面播放器）
  function mkDiag() {
    try {
      const MK = window.MusicKit;
      if (!MK) return 'window.MusicKit 不存在';
      let inst = null;
      try { inst = MK.getInstance ? MK.getInstance() : null; } catch (e) { inst = null; }
      return 'MusicKit 在, 实例=' + (inst ? '有' : 'null') +
        ', devToken=' + (have.auth ? '有' : '无') +
        ', userToken=' + (have.mut ? '有' : '无');
    } catch (e) {
      return '诊断异常：' + e.message;
    }
  }

  // 播放控制（播放/暂停/上一首/下一首）
  function ctrl(fn, action) {
    /* 独立面板窗口没有 MusicKit —— 把控制指令转给网页执行 */
    if (PANEL_MODE) {
      pageTransport(action).then((r) => {
        if (!r || !r.ok) log('播放控制失败：' + ((r && r.error) || '网页端未响应'), 'err');
        else log('播放控制：' + action + (r.via ? '（' + r.via + '）' : ''), 'ok');
        setTimeout(() => {
          const el = $('npText');
          if (el) el.textContent = playStateText();
        }, 400);
      });
      return;
    }
    const inst = tryMusicKit();
    if (!inst) {
      log('播放器未就绪。请先用页面底部播放条手动播放一次，再回来控制。', 'warn');
      log('诊断：' + mkDiag(), 'warn');
      return;
    }
    try { fn(inst); } catch (e) { log('播放控制失败：' + e.message, 'err'); }
  }

  // 上一首 / 下一首（挂件按钮）：
  //   面板模式 → 照旧转发给网页（网页侧现在也走下面这套自管切歌逻辑）
  //   网页模式 → 自己算下标 + 单曲队列 + 验证起点，不再用原生 skipToNextItem
  //              （原生 skip 遇到坏曲目会回卷到第 1 首，单曲队列里更是无从下手）
  function ctrlStep(delta, action) {
    if (PANEL_MODE) {
      ctrl(function () {}, action);
      return;
    }
    const inst = tryMusicKit();
    if (!inst) {
      log('播放器未就绪。请先用页面底部播放条手动播放一次，再回来控制。', 'warn');
      log('诊断：' + mkDiag(), 'warn');
      return;
    }
    goAdjacent(delta, action === 'next' ? '下一首（挂件按钮）' : '上一首（挂件按钮）').then((r) => {
      if (!r || !r.ok) log('播放控制失败：' + ((r && r.error) || '网页端未响应'), 'err');
      else log('播放控制：' + action + (r.via ? '（' + r.via + '）' : ''), 'ok');
      setTimeout(() => {
        const el = $('npText');
        if (el) el.textContent = playStateText();
      }, 400);
    });
  }

  // MusicKit 的 Promise 有时永不 settle，必须加超时，否则调用方会永久卡住
  function withTimeout(promise, ms) {
    return Promise.race([
      Promise.resolve(promise).then(
        () => 'ok',
        (e) => 'err:' + ((e && e.message) || e)
      ),
      new Promise((r) => setTimeout(() => r('timeout'), ms)),
    ]);
  }

  async function tryQueue(inst, opt, label) {
    log('  ▸ ' + label + ' …', 'info');
    let r;
    try {
      r = await withTimeout(inst.setQueue(opt), 6000);
    } catch (e) {
      log('    ' + label + ' 抛错：' + ((e && e.message) || e), 'warn');
      return false;
    }
    log('    ' + label + ' → ' + r, r === 'ok' ? 'ok' : 'warn');
    return r === 'ok';
  }

  /* ============ 队列播放上下文（页面模式）· 起点必须自己说了算 ============
   * 实测结论（用户日志）：
   *   setQueue({ songs: [...N首] }) → 起点总落在第 1 首
   *   setQueue({ song: 单首 })      → 起点永远正确
   * 所以这里保存一份「经过校验的曲目列表 + 当前下标」：
   *   起点校正 / 下一首 / 上一首 / 自动续播 / 跳过坏曲目 全部由我们自己按下标算，
   *   再用单曲队列播放并【验证 nowPlayingItem.id】，绝不依赖多曲队列的起点。
   * API 依据：MusicKit JS v3 的公开实例上确实有
   *   queue.items / queue.indexForItem(id) / changeToMediaAtIndex(i) / changeToMediaItem(item)
   *   （已直接从 js-cdn.music.apple.com/musickit/v3/musickit.js 源码里核对过）。
   * ===================================================================== */
  const pbCtx = { ids: [], idx: -1, nameOf: null };
  let pbSkipStreak = 0;              // 连续跳过（坏曲目）次数，防无限循环
  let pbSkipAt = 0;                  // 最近一次跳过的时刻
  let pbWrapLogged = '';             // 「回卷到队首」日志去重
  let pbAdvancing = false;           // 自动续播防重入
  let pbListenersMounted = false;    // MusicKit 事件是否已挂
  const runtimeBadIds = new Set();   // 运行时实测播不起来的 id（与目录校验的 badIds 分开）

  function setPlayCtx(ids, idx, nameOf) {
    pbCtx.ids = (ids || []).filter(Boolean).map(String);
    pbCtx.idx = typeof idx === 'number' && idx >= 0 ? idx : -1;
    pbCtx.nameOf = typeof nameOf === 'function' ? nameOf : null;
  }

  // 当前播放曲目的 id / 歌名（读不到返回空串）
  function npId(inst) {
    try {
      const np = inst && inst.nowPlayingItem;
      return np && np.id ? String(np.id) : '';
    } catch (e) { return ''; }
  }

  function npTitle(inst) {
    try {
      const np = inst && inst.nowPlayingItem;
      const a = (np && np.attributes) || {};
      return [a.name, a.artistName].filter(Boolean).join(' / ');
    } catch (e) { return ''; }
  }

  function queueLen(inst) {
    try {
      const q = inst && inst.queue;
      if (!q) return -1;
      const items = q.items;
      if (items && typeof items.length === 'number') return items.length;
      return typeof q.length === 'number' ? q.length : -1;
    } catch (e) { return -1; }
  }

  // 某个 id 在【MusicKit 真实队列】里的下标（找不到返回 -1）
  function queueIndexOf(inst, id) {
    const want = String(id || '');
    if (!want) return -1;
    try {
      const q = inst && inst.queue;
      if (!q) return -1;
      if (typeof q.indexForItem === 'function') {
        const i = q.indexForItem(want);
        if (typeof i === 'number' && i >= 0) return i;
      }
      const items = q.items || [];
      for (let i = 0; i < items.length; i++) {
        if (items[i] && String(items[i].id) === want) return i;
      }
    } catch (e) {}
    return -1;
  }

  // 曲名：优先用调用方传进来的 nameOf，拿不到再退回落当前播放项
  function pbTitleOf(id, inst) {
    let nm = '';
    try { if (pbCtx.nameOf) nm = String(pbCtx.nameOf(id) || ''); } catch (e) { nm = ''; }
    if (!nm && id && String(id) === npId(inst)) nm = npTitle(inst);
    return nm || String(id);
  }

  // 等 nowPlayingItem 稳定下来（MusicKit 起播是异步的，立刻读会读到空）
  async function waitNowPlaying(inst, ms) {
    const t0 = Date.now();
    let last = '';
    let same = 0;
    while (Date.now() - t0 < ms) {
      const id = npId(inst);
      if (id && id === last) {
        same += 1;
        if (same >= 2) return id;
      } else same = 0;
      last = id;
      await new Promise((r) => setTimeout(r, 220));
    }
    return last;
  }

  // play() + 校验起点：只有 nowPlayingItem.id === 目标才算成功（不假设成功）
  async function playAndVerify(inst, target) {
    const want = String(target);
    let r;
    try {
      r = await withTimeout(inst.play(), 6000);
    } catch (e) {
      log('    play 抛错 ' + ((e && e.message) || e), 'warn');
      return false;
    }
    log('    play → ' + r, r === 'ok' ? 'ok' : 'warn');
    const cur = await waitNowPlaying(inst, 3200);
    const good = cur === want;
    log('起点校验：实际 nowPlaying=' + (cur || '(读不到)') + '，目标 ' + want + (good ? ' ✓' : ' ✗'), good ? 'ok' : 'warn');
    if (good) {
      // ★ 起点对了不等于真的出声了（坏曲目常常"id 换上了但播不动"）。
      //   这里把状态也写进日志，随后由看门狗在约 6 秒后接管、跳到下一首。
      let ip = false;
      let pos = 0;
      let st = -1;
      try {
        ip = inst.isPlaying === true;
        pos = Number(inst.currentPlaybackTime) || 0;
        st = inst.playbackState;
      } catch (e) {}
      if (ip || pos > 0) log('    （已出声：isPlaying=' + ip + '，位置=' + pos.toFixed(1) + '）', 'ok');
      else log('    ⚠ 起点对了但还没出声（isPlaying=false，位置 0，playbackState=' + st + '）——约 6 秒仍无进展就跳到下一首', 'warn');
    }
    return good;
  }

  // 单曲队列 + 校验（这个项目里历史上最稳的路径）
  async function playSingleVerified(inst, id, label) {
    const ok = await tryQueue(inst, { song: String(id) }, label || '单曲队列');
    if (!ok) return false;
    return await playAndVerify(inst, id);
  }

  // 多曲队列建好后：试着把起点「校正」到目标曲目。
  //   ① changeToMediaAtIndex(目标在真实队列里的下标)
  //   ② changeToMediaItem(队列里的那个 item 对象)
  // 每一步都读 nowPlayingItem.id 验证；能力不存在时【如实记日志】，不静默跳过。
  async function correctQueueStart(inst, target) {
    const want = String(target);
    const idx = queueIndexOf(inst, want);
    log('    真实队列：长度=' + queueLen(inst) + '，目标下标=' + (idx < 0 ? '不在队列里' : idx), idx < 0 ? 'warn' : 'info');
    if (idx < 0) {
      log('    ⚠ 目标不在 MusicKit 的真实队列里（多是被判定不可播放/受地区限制而被剔除）', 'err');
      return false;
    }

    if (typeof inst.changeToMediaAtIndex === 'function') {
      log('  ▸ 起点校正：changeToMediaAtIndex(' + idx + ') …', 'info');
      const r1 = await withTimeout(inst.changeToMediaAtIndex(idx), 6000);
      log('    changeToMediaAtIndex(' + idx + ') → ' + r1, r1 === 'ok' ? 'ok' : 'warn');
      const cur = await waitNowPlaying(inst, 2600);
      const good = cur === want;
      log('起点校正：changeToMediaAtIndex(' + idx + ') → 实际 nowPlaying=' + (cur || '(读不到)') + (good ? ' ✓' : ' ✗'), good ? 'ok' : 'warn');
      if (good) return true;
    } else {
      log('  ▸ 起点校正：本版 MusicKit 没有 changeToMediaAtIndex，跳过这一步', 'warn');
    }

    if (typeof inst.changeToMediaItem === 'function') {
      let item = null;
      try {
        const items = inst.queue && inst.queue.items;
        item = items ? items[idx] : null;
      } catch (e) { item = null; }
      if (!item) {
        log('  ▸ 起点校正：拿不到队列里的 item 对象，跳过 changeToMediaItem', 'warn');
        return false;
      }
      log('  ▸ 起点校正：changeToMediaItem(' + (item.id || '?') + ') …', 'info');
      const r2 = await withTimeout(inst.changeToMediaItem(item), 6000);
      log('    changeToMediaItem → ' + r2, r2 === 'ok' ? 'ok' : 'warn');
      const cur2 = await waitNowPlaying(inst, 2600);
      const good2 = cur2 === want;
      log('起点校正：changeToMediaItem → 实际 nowPlaying=' + (cur2 || '(读不到)') + (good2 ? ' ✓' : ' ✗'), good2 ? 'ok' : 'warn');
      if (good2) return true;
    } else {
      log('  ▸ 起点校正：本版 MusicKit 没有 changeToMediaItem，跳过这一步', 'warn');
    }
    return false;
  }

  // 实际 nowPlaying 在我们列表里的下标（-1 = 不在列表里）
  function actualIdxIn(inst) {
    const id = npId(inst);
    return id ? pbCtx.ids.indexOf(id) : -1;
  }

  // 把实际播放同步进上下文：
  //   往前走（含原生自动续播、原生跳过坏曲目）→ 认；
  //   正好退一首 → 认（用户点了上一首）；
  //   明显往回跳（坏曲目导致 MusicKit 回卷到第 1 首）→ 只记日志，【不改我们的进度】。
  function syncCtxIdx(inst) {
    const a = actualIdxIn(inst);
    if (a < 0 || pbCtx.idx < 0 || a === pbCtx.idx) return;
    if (a > pbCtx.idx || a === pbCtx.idx - 1) { pbCtx.idx = a; return; }
    const key = a + '>' + pbCtx.idx;
    if (pbWrapLogged === key) return;
    pbWrapLogged = key;
    log('⚠ 播放位置往回跳到第 ' + (a + 1) + ' 首（我们记录的进度是第 ' + (pbCtx.idx + 1) + ' 首），已忽略这次回卷', 'warn');
  }

  // 「下一首」的锚点：取我们记录的进度和实际位置里【更靠前】的那个 ——
  // 这样即使 MusicKit 自己回卷到第 1 首，下一首也不会跟着跑到第 2 首。
  function anchorNext(inst) {
    const a = actualIdxIn(inst);
    if (a < 0) return pbCtx.idx;
    if (pbCtx.idx < 0) { pbCtx.idx = a; return a; }
    if (a > pbCtx.idx) { pbCtx.idx = a; return a; }
    return pbCtx.idx;
  }

  // 「上一首」的锚点：默认从我们记录的进度往回；若原生已经正好退了一首，就认它。
  function anchorPrev(inst) {
    const a = actualIdxIn(inst);
    if (pbCtx.idx < 0) return a;
    if (a === pbCtx.idx - 1) { pbCtx.idx = a; return a; }
    return pbCtx.idx;
  }

  // 换歌（+1 下一首 / -1 上一首）：自己算下标 → 单曲队列 → 验证起点。
  // 遇到坏曲目继续往前/往后找；连续 5 首都没播起来就停（防无限循环）。
  // 返回 { ok, via, error, noCtx, atEnd }
  async function goAdjacent(delta, reason) {
    const inst = tryMusicKit();
    if (!inst) return { ok: false, via: '', error: '网页播放器还没就绪', noCtx: true, atEnd: false };
    const ids = pbCtx.ids;
    if (!ids.length) return { ok: false, via: '', error: '没有可用的曲目列表（请先播一个歌单）', noCtx: true, atEnd: false };

    // ★ 当前播的这首不在我们的列表里（用户在 Apple 页面自己点的歌）→ 不拿旧进度硬算，
    //   交给调用方退回原生 skip，免得"下一首"突然跳回上一个歌单。
    const curId = npId(inst);
    if (curId && actualIdxIn(inst) < 0) {
      return { ok: false, via: '', error: '当前曲目不在我们的曲目列表里（' + curId + '）', noCtx: true, atEnd: false };
    }

    const anchor = delta > 0 ? anchorNext(inst) : anchorPrev(inst);
    if (anchor < 0) return { ok: false, via: '', error: '当前曲目不在曲目列表里，算不出' + (delta > 0 ? '下一首' : '上一首'), noCtx: true, atEnd: false };

    let i = anchor + delta;
    if (i < 0 || i >= ids.length) {
      log('⚠ 已经到' + (delta > 0 ? '最后' : '最前') + '一首了，没有' + (delta > 0 ? '下一首' : '上一首'), 'warn');
      return { ok: false, via: '', error: '已经到' + (delta > 0 ? '队尾' : '队首') + '了', noCtx: false, atEnd: true };
    }

    let tries = 0;
    let lastErr = '';
    while (i >= 0 && i < ids.length && tries < 5) {
      const id = String(ids[i]);
      if (badIds.has(id) || runtimeBadIds.has(id)) {
        log('    跳过已知无效曲目：' + pbTitleOf(id, inst), 'warn');
        i += delta;
        tries += 1;
        continue;
      }
      log('  ▸ ' + (reason || (delta > 0 ? '下一首' : '上一首')) + ' → 第 ' + (i + 1) + '/' + ids.length + ' 首：' + pbTitleOf(id, inst), 'info');
      if (await playSingleVerified(inst, id, '单曲队列(第 ' + (i + 1) + '/' + ids.length + ' 首)')) {
        pbCtx.idx = i;
        pbWrapLogged = '';
        log('  ✓ 已切到第 ' + (i + 1) + '/' + ids.length + ' 首：' + pbTitleOf(id, inst), 'ok');
        return { ok: true, via: '单曲队列·自管切歌', error: '', noCtx: false, atEnd: false };
      }
      lastErr = 'id ' + id + ' 没播起来';
      log('    ⚠ 这首没播起来，记为播不动并继续：' + pbTitleOf(id, inst), 'err');
      runtimeBadIds.add(id);
      i += delta;
      tries += 1;
    }
    if (tries >= 5) log('⚠ 连续试了 5 首都没播起来，停止继续找（防无限循环）', 'err');
    return { ok: false, via: '', error: lastErr || '没有可播的曲目', noCtx: false, atEnd: false };
  }

  // 看门狗 / MusicKit 报错时调用：只向前跳一首，
  // 绝不 setQueue 重来、绝不回到队首；连续跳过上限 5 首。
  async function skipBadTrack(reason) {
    const now = Date.now();
    if (now - pbSkipAt > 60000) pbSkipStreak = 0;   // 距上次跳过超过 1 分钟 → 重新计数
    if (pbSkipStreak >= 5) {
      log('⚠ 已连续跳过 ' + pbSkipStreak + ' 首仍未恢复播放，停止自动跳过（避免无限循环）', 'err');
      return;
    }
    pbSkipStreak += 1;
    pbSkipAt = now;
    const inst = tryMusicKit();
    const cur = npId(inst);
    const nm = npTitle(inst);
    log('⚠ 曲目无法播放，已跳到下一首：' + (nm || cur || '(未知曲目)') +
      '（原因：' + reason + '，连续第 ' + pbSkipStreak + ' 首）', 'warn');
    if (cur) runtimeBadIds.add(cur);
    const r = await goAdjacent(1, '跳过无法播放的曲目');
    if (r.ok) log('    跳过已确认：现在播的是 ' + (npTitle(inst) || npId(inst)), 'ok');
    else log('    ⚠ 跳过没有成功：' + (r.error || '未知原因'), 'err');
  }

  // playSongIds(ids, startWith, nameOf)
  //   nameOf：可选，(id) => '歌名 / 歌手'，只用于把「跳过的失效曲目」打成歌名。
  //           它只在【本进程】里使用，不会被转发（不会跨 sendChrome 传函数）。
  async function playSongIds(ids, startWith, nameOf) {
    const list0 = ids.filter(Boolean).map(String);
    if (!list0.length) return '失败：没有可播放的曲目（可能都是本地上传）';

    // ★ 先剔除目录里已失效的 id —— 否则 MusicKit 会拒绝【整个队列】(mk-007 NOT_FOUND)。
    //   这一步放在 PANEL_MODE 转发【之前】：
    //   面板侧自己就能过滤并在面板日志里打出歌名，页面侧收到的是已经过滤过的列表。
    const v = await filterPlayableIds(list0);
    const list = v.ok.length ? v.ok : list0;
    // ★ 面板转发过来的播放没有 nameOf（函数不能跨进程传）→ 用目录校验顺手留下的名字补上，
    //   这样"坏曲目跳过"那类日志在页面侧也能打出歌名而不是一坨 id。
    const nameOfAll = (typeof nameOf === 'function')
      ? nameOf
      : function (id) { return (v.names && v.names[String(id)]) || ''; };
    if (v.bad.length) {
      v.bad.forEach((id) => badIds.add(String(id)));
      log('⚠ 跳过 ' + v.bad.length + ' 首目录已失效的曲目：', 'err');
      v.bad.forEach((id) => {
        let nm = '';
        try { nm = String(nameOfAll(id) || ''); } catch (e) { nm = ''; }
        log('    ' + (nm || id), 'err');
      });
    }

    // ★ 调用方【显式指定了起点】，但那一首不在可播放列表里 → 直接提示，什么都不播。
    //   绝不退回 list[0]：那会让"点坏歌"变成"从第 1 首开始播整个歌单"——
    //   日志里还写着播的是你点的那首（本项目栽过多次的"报告成功但行为错误"）。
    //   startWith 为空（= 点歌单的播放按钮）才允许从第 1 首开始。
    //   位置在 PANEL_MODE 转发【之前】：面板模式没有 MusicKit，
    //   放后面的话面板会先白跑一次跨进程请求，而且拿回来的日志没有歌名。
    function nameOrId(id) {
      let nm = '';
      try { nm = String(nameOfAll(id) || ''); } catch (e) { nm = ''; }
      return nm || String(id);
    }
    if (startWith && list.indexOf(String(startWith)) < 0) {
      log('⚠ 这首不在可播放目录里（未播放任何曲目）：' + nameOrId(startWith), 'err');
      return '失败：这首已不在 Apple Music 目录里（可能已下架或不在当前区），换下一首试试（' +
        nameOrId(startWith) + '）';
    }

    /* 独立面板窗口没有 MusicKit —— 把播放指令转给网页执行（转的是过滤后的列表） */
    if (PANEL_MODE) return await playViaPage(list, startWith);

    const inst = tryMusicKit();
    if (!inst) return '失败：播放器未就绪（' + mkDiag() + '）';

    const target = startWith ? String(startWith) : list[0];

    // ★ 记下这一份「经过校验的曲目列表 + 起点下标」：
    //   起点校正 / 下一首 / 上一首 / 自动续播 / 跳过坏曲目，全都按这个列表算。
    const ti = list.indexOf(target);
    setPlayCtx(list, ti < 0 ? 0 : ti, nameOfAll);
    log('准备播放：队列 ' + list.length + ' 首，起点索引 ' + (ti < 0 ? 0 : ti) + ' → ' + target, 'info');
    // ★ startWith 才是 MusicKit JS v3 真正认的参数名（源码里 startWithSong 一次都没出现，
    //   传了等于没传 —— 这也解释了"去掉 startWithSong 没变化"）。
    log('    （起点用 startWith 指定；整单队列起点若验证不过会自动改走单曲队列）', 'info');

    // ★ 三条路按顺序试，每一步都用 nowPlayingItem.id 验证，不过就继续往下走：
    //   ① 整单队列（保留完整队列语义：原生自动续播、Apple 自己的上一首/下一首都好用）
    //   ② 起点校正：changeToMediaAtIndex(目标在【真实队列】里的下标)
    //   ③ 单曲队列：起点完全由我们掌控（实测这条路径从未播错过歌）
    // 不再把目标旋转到数组最前面 —— 那会让「下一首」变成歌单第 1 首。
    let via = '';
    let built = false;
    if (list.length > 1) {
      built = await tryQueue(inst, { songs: list, startWith: target }, '整单队列(' + list.length + '首, startWith)');
      if (!built) built = await tryQueue(inst, { songs: list }, '整单队列(不带 startWith 重试)');
      if (built && await playAndVerify(inst, target)) via = '整单队列';
      if (!via && built) {
        log('  ▸ 整单队列起点不对 → 用 changeToMediaAtIndex 校正起点 …', 'warn');
        if (await correctQueueStart(inst, target)) via = '整单队列(已校正起点)';
      }
    }

    if (!via) {
      if (list.length > 1) {
        log('  ▸ 整单队列' + (built ? '起点无法校正' : '没建成') +
          ' → 改用单曲队列（起点优先，代价是失去整单队列）', 'warn');
      }
      if (await playSingleVerified(inst, target, '单曲队列')) via = '单曲队列(自管下一首)';
    }

    if (!via) {
      const cur = npId(inst);
      return '失败：起点未落在目标曲目（目标 ' + target + '，实际 ' + (cur || '读不到') + '）';
    }
    pbCtx.idx = ti < 0 ? 0 : ti;
    pbWrapLogged = '';
    log('播放已确认：nowPlaying=' + target + '（路径：' + via + '）' +
      (via.indexOf('单曲') === 0 ? '；下一首/上一首由本扩展接管' : ''), 'ok');
    return 'MusicKit · ' + via;
  }

  // 播放一首（条目来自 API）
  async function playItem(item) {
    const cid = catalogIdOf(item);
    if (!cid) return '失败：这首没有目录 ID（可能是本地上传，接口无法播放）';
    return playSongIds([cid], null, nameMapperOf([item]));
  }

  // 给返回值也加超时（防止 fetch / MusicKit 永不 settle）
  function timeoutValue(promise, ms) {
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + ms + 'ms')), ms)),
    ]);
  }

  // 播放整个歌单（先取曲目列表，再用目录 ID 建队列）
  async function playPlaylist(pl) {
    let tracks = tracksCache[pl.id];
    if (!tracks) {
      setCred('⏳ 正在读取歌单曲目…');
      try {
        tracks = await timeoutValue(loadAllTracks(pl.id), 15000);
        tracksCache[pl.id] = tracks;
      } catch (e) {
        return '失败：读取曲目失败 ' + ((e && e.message) || e);
      }
    }
    const ids = tracks.map(catalogIdOf).filter(Boolean);
    if (!ids.length) return '失败：这个歌单没有可播放的曲目';
    return playSongIds(ids, null, nameMapperOf(tracks));
  }

  /* ============== 播放卡死看门狗（只在网页模式跑） ==============
   * 有些曲目（例如只有库内 id、没有 catalogId 的）队列能建成功，
   * 但播到它就一直卡住：currentPlaybackTime 不前进。
   * 这里每 3 秒看一眼：
   *   a) 处于「应该正在播」状态、位置连续 2 次（约 6 秒）都没动 → 跳到下一首，并记一笔日志。
   *   b) ★ 新增：曲目换了但【一直没起播】（isPlaying=false、位置 0，约 9 秒）
   *      → 同样判定播不动。旧版这里直接 return，所以"坏曲目根本没起播"永远跳不过去。
   * 跳转一律走 skipBadTrack → goAdjacent(+1)：自己算下标 + 单曲队列 + 验证起点，
   * 绝不 setQueue 重来、绝不回到队首，连续跳过上限 5 首。
   * ★ 暂停/未播放时位置本来就不动，只在 isPlaying === true 或状态明确时才判定。
   * ========================================================== */
  let stallTimer = null;

  /* 挂 MusicKit 事件（坏曲目最可靠的检测方式，而且比 3 秒轮询快）
   * 事件名 / 回调签名都来自 MusicKit JS v3 源码：
   *   mediaPlaybackError  → 回调收到一个 MKError（.message）
   *   playbackStateDidChange → 回调收到 { oldState, state, nowPlayingItem }
   *   PlaybackStates: 5=ended 10=completed 3=paused
   * MusicKit 实例可能到得比看门狗晚，所以在轮询里补挂。 */
  function mountPlaybackListeners(inst) {
    if (pbListenersMounted || !inst || typeof inst.addEventListener !== 'function') return false;
    pbListenersMounted = true;

    try {
      inst.addEventListener('mediaPlaybackError', function (e) {
        const msg = (e && (e.message || e.description)) || String(e || '');
        log('⚠ MusicKit 报播放错误：' + msg, 'err');
        skipBadTrack('mediaPlaybackError');
      });
      log('已监听 MusicKit 事件：mediaPlaybackError（坏曲目即时跳到下一首）', 'info');
    } catch (e) {
      log('监听 mediaPlaybackError 失败：' + ((e && e.message) || e), 'warn');
    }

    try {
      inst.addEventListener('playbackStateDidChange', function (ev) {
        let st = -1;
        try { st = ev && typeof ev.state === 'number' ? ev.state : inst.playbackState; } catch (e) { st = -1; }
        if (st !== 5 && st !== 10) return;        // 只关心 5=ended / 10=completed
        if (!pbCtx.ids.length) return;
        if (queueLen(inst) > 1) return;           // 整单队列：MusicKit 自己会接下一首，别抢
        if (pbAdvancing) return;
        const before = npId(inst);
        pbAdvancing = true;
        setTimeout(async () => {
          try {
            let playingNow = false;
            try { playingNow = inst.isPlaying === true; } catch (e) {}
            const idNow = npId(inst);
            // ★ state=5 是明确的「这首歌播完了」：即使 isPlaying 还没翻成 false（状态回读有延迟），
            //   也应该续播；state=10(completed) 则要确认确实没在播、曲目也没变。
            const ended = st === 5 && idNow === before;
            if (!ended && (playingNow || (idNow && idNow !== before))) return;   // 已经自己续上了
            log('▶ 当前曲目已播完（playbackState=' + st + '），自动续播下一首', 'info');
            await goAdjacent(1, '自动续播');
          } finally {
            pbAdvancing = false;
          }
        }, 800);
      });
      log('已监听 MusicKit 事件：playbackStateDidChange（单曲队列播完自动续下一首）', 'info');
    } catch (e) {
      log('监听 playbackStateDidChange 失败：' + ((e && e.message) || e), 'warn');
    }
    return true;
  }

  function startStallWatchdog() {
    if (PANEL_MODE || stallTimer) return;
    let lastPos = -1;
    let still = 0;
    let lastSkip = 0;
    let lastId = '';
    let notStarted = 0;
    stallTimer = setInterval(() => {
      let inst = null;
      try { inst = tryMusicKit(); } catch (e) { inst = null; }
      if (!inst) { lastPos = -1; still = 0; notStarted = 0; return; }
      mountPlaybackListeners(inst);      // MusicKit 可能到得比看门狗晚，这里补挂事件
      let playing = false;
      let pos = 0;
      let np = null;
      let st = -1;
      try {
        playing = inst.isPlaying === true;
        pos = Number(inst.currentPlaybackTime) || 0;
        np = inst.nowPlayingItem || null;
        st = inst.playbackState;
      } catch (e) { return; }
      const id = np && np.id ? String(np.id) : '';
      syncCtxIdx(inst);                  // 让我们的进度跟上实际播放（会忽略"回卷到第 1 首"）

      // 用户主动暂停（3=paused）→ 位置本来就不动，绝不能误判成坏曲目
      if (st === 3) { lastPos = -1; still = 0; notStarted = 0; return; }

      // 没在播放（暂停/停止/没队列）→ 位置本来就不动，绝不能误判
      if (!playing || !np) {
        if (!id) { lastPos = -1; still = 0; notStarted = 0; return; }
        if (id !== lastId) { lastId = id; notStarted = 0; lastPos = -1; still = 0; return; }
        // 队尾不跳：整张歌单播完后 isPlaying 也会变 false，那不是坏曲目。
        // ★ 判据用【我们自己的曲目列表下标】：单曲队列模式下 MusicKit 的 queue 长度永远是 1，
        //   拿它判断会永远命中"队尾"，坏曲目就再也跳不了了（这个坑是回归测试抓出来的）。
        const ai = actualIdxIn(inst);
        const curIdx = ai >= 0 ? ai : pbCtx.idx;
        if (pbCtx.ids.length && curIdx >= pbCtx.ids.length - 1) { notStarted = 0; lastPos = -1; still = 0; return; }
        if (!pbCtx.ids.length) {
          // 没有我们的列表（用户在网页自己点的歌）→ 退回看真实队列的位置
          const qi = queueIndexOf(inst, id);
          const ql = queueLen(inst);
          if (qi >= 0 && ql > 0 && qi >= ql - 1) { notStarted = 0; lastPos = -1; still = 0; return; }
        }
        if (st === 0) { lastPos = -1; still = 0; return; }   // 压根没有队列 / 没在播放
        // ★ 曲目已经换到这首、却一直没起播 → 典型是"坏到根本没播放资源"
        notStarted += 1;
        // 1=loading / 8=waiting / 9=stalled 有可能是网络慢，多给两个周期（约 12 秒）再判死
        const need = (st === 1 || st === 8 || st === 9) ? 4 : 2;
        if (notStarted < need) return;   // 一般约 6 秒，卡在缓冲时约 12 秒
        notStarted = 0;
        lastPos = -1;
        still = 0;
        if (Date.now() - lastSkip < 8000) return;
        lastSkip = Date.now();
        log('⚠ 当前曲目一直没起播（isPlaying=false，位置 ' + pos.toFixed(1) + '，playbackState=' + st + '）', 'warn');
        skipBadTrack('一直没有起播');
        return;
      }

      // 已经播起来了 → 清掉「未起播」计数
      notStarted = 0;
      if (id && id !== lastId) lastId = id;
      if (pbSkipStreak > 0 && pos > 1) {
        log('播放已恢复，连续跳过计数清零（之前连续跳过了 ' + pbSkipStreak + ' 首）', 'info');
        pbSkipStreak = 0;
      }

      if (lastPos >= 0 && Math.abs(pos - lastPos) < 0.05) still += 1;
      else still = 0;
      lastPos = pos;
      if (still < 2) return;
      still = 0;
      lastPos = -1;
      if (Date.now() - lastSkip < 8000) return;   // 刚跳过，给新曲目留出起播时间
      lastSkip = Date.now();
      const nm = (np.attributes && np.attributes.name) || '';
      log('⚠ 当前曲目卡住，已跳到下一首' + (nm ? '（' + nm + '）' : ''), 'warn');
      // ★ 走自己算下标的跳过逻辑：绝不 setQueue 重来，也绝不回到队首
      skipBadTrack('播放位置长时间不动');
    }, 3000);
  }

  // 检测是否停在失效地址：把「资料库歌单 ID」(p.xxx) 当公开歌单地址用，
  // Apple 的 SPA 会一直 404，播放器也会挂住。
  function checkBadRoute() {
    try {
      const m = location.pathname.match(/\/playlist\/(p\.[A-Za-z0-9]+)/);
      if (!m) return;
      log('⚠ 当前地址是 /playlist/' + m[1], 'err');
      log('  这是「资料库歌单 ID」被当成了公开歌单地址，Apple 的 SPA 会一直 404，', 'err');
      log('  播放器也会卡住。请点下面的按钮把页面状态修好。', 'err');
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:9px';
      const b = document.createElement('button');
      b.className = 'pri';
      b.style.cssText = 'width:100%';
      b.textContent = '↩ 修复页面状态（回到 Apple Music 首页）';
      b.onclick = () => { location.href = 'https://music.apple.com/' + storefront + '/'; };
      wrap.appendChild(b);
      if (credEl && credEl.parentNode) credEl.parentNode.insertBefore(wrap, credEl.nextSibling);
      setCred('⚠ 页面地址异常，请先修复', 'bad');
    } catch (e) {}
  }

  // 把顶部的状态框复位（播放流程会临时占用它）
  function restoreCred() {
    if (playlistsCache.length) setCred('✅ 已获取 ' + playlistsCache.length + ' 个歌单', 'ok');
    else if (have.auth && have.mut) setCred('✅ 已获取登录凭证', 'ok');
    else setCred('正在检测登录凭证…');
  }

  // 现在播放状态轮询
  let npTimer = null;
  function startNowPlayingPoll() {
    if (npTimer) return;
    npTimer = setInterval(() => {
      const el = $('npText');
      if (el) el.textContent = playStateText();
    }, 1200);
  }

  /* ======================== 样式 ======================== */
  const CSS_TEXT = `
  *{box-sizing:border-box}
  .fab{position:fixed;right:20px;bottom:20px;width:48px;height:48px;border-radius:50%;
    border:0;padding:0;cursor:grab;pointer-events:auto;overflow:hidden;
    display:flex;align-items:center;justify-content:center;
    background:radial-gradient(132% 132% at 30% 12%,
      rgba(255,255,255,.97) 0%,
      rgba(255,255,255,.55) 30%,
      rgba(var(--tint),var(--tintA)) 66%,
      rgba(var(--tint),calc(var(--tintA) * 1.35)) 100%);
    -webkit-backdrop-filter:blur(18px) saturate(200%);
    backdrop-filter:blur(18px) saturate(200%);
    box-shadow:
      inset 0 1.5px 1.5px rgba(255,255,255,.98),
      inset 0 -4px 8px rgba(255,255,255,.32),
      inset 0 0 0 1px rgba(255,255,255,.62),
      0 10px 26px rgba(0,0,0,.42),
      0 2px 6px rgba(0,0,0,.26);
    transition:transform .18s ease,box-shadow .18s ease,opacity .18s ease;
    opacity:.94}
  .fab::after{content:'';position:absolute;left:14%;top:8%;width:42%;height:30%;
    border-radius:50%;pointer-events:none;
    background:radial-gradient(closest-side,rgba(255,255,255,.98),rgba(255,255,255,0))}
  .fab:hover{transform:translateY(-1px) scale(1.06);opacity:1;
    box-shadow:
      inset 0 1.5px 1.5px #fff,
      inset 0 0 0 1px rgba(255,255,255,.78),
      0 14px 34px rgba(0,0,0,.5),
      0 2px 8px rgba(0,0,0,.28)}
  .fab:active{cursor:grabbing;transform:scale(.97)}
  .fab svg{width:25px;height:25px;display:block;pointer-events:none;
    filter:drop-shadow(0 1px 1.2px rgba(0,0,0,.34)) drop-shadow(0 -.5px .5px rgba(255,255,255,.55))}
  .tintbar{display:flex;align-items:center;gap:7px;padding:7px 10px;flex:none;
    border-top:1px solid #26262f;background:#131320;font-size:11px;color:#6f6f7c}
  .dot{width:17px;height:17px;border-radius:50%;padding:0;flex:none;cursor:pointer;
    border:1px solid rgba(255,255,255,.32);transition:transform .14s}
  .dot:hover{transform:scale(1.18)}
  .dot.on{box-shadow:0 0 0 2px #0a84ff}
  .tintbar input[type=color]{width:26px;height:19px;padding:0;margin-left:auto;flex:none;
    border:1px solid #3a3a4a;border-radius:5px;background:#1b1b26;cursor:pointer}
  .panel{position:fixed;top:16px;right:16px;width:520px;height:78vh;display:flex;flex-direction:column;
    background:#16161c;color:#e8e8ea;border:1px solid #33333d;border-radius:14px;
    box-shadow:0 16px 48px rgba(0,0,0,.65);overflow:hidden;pointer-events:auto;
    font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .panel.hide{display:none}
  .panel.min{height:auto}
  .panel.min .bd{display:none}
  .hd{display:flex;align-items:center;gap:8px;padding:10px 13px;background:#1d1d25;
    border-bottom:1px solid #2c2c36;cursor:move;user-select:none;flex:none}
  .ttl{font-weight:700;font-size:13.5px;color:#67b0ff}
  .sp{flex:1}
  .ico{width:24px;height:24px;border:0;border-radius:6px;background:#2a2a34;color:#bbb;
    cursor:pointer;font-size:12px;padding:0}
  .ico:hover{background:#3a3a46;color:#fff}
  .tabs{display:flex;gap:2px;padding:0 10px;background:#1a1a22;border-bottom:1px solid #2c2c36;flex:none}
  .tab{padding:9px 14px;font-size:12.5px;color:#9a9aa8;cursor:pointer;border:0;background:0;
    border-bottom:2px solid transparent;font-family:inherit}
  .tab.on{color:#67b0ff;border-bottom-color:#0a84ff;font-weight:700}
  .bd{flex:1;overflow:auto;padding:12px 14px}
  .cred{margin-bottom:9px;padding:8px 10px;border-radius:9px;background:#101018;
    border:1px solid #2b2b38;font-size:12px;color:#ffd166}
  .cred.ok{color:#4ade80;border-color:#285c3a}
  .cred.bad{color:#f87171;border-color:#5c2a2a}
  .row{display:flex;gap:8px;align-items:center}
  .inp{width:100%;padding:8px 11px;border-radius:9px;border:1px solid #38384a;background:#0f0f14;
    color:#eee;font:inherit;outline:none}
  .inp:focus{border-color:#4a8fe0}
  .ta{height:120px;resize:vertical;white-space:pre;font-family:ui-monospace,Consolas,monospace;font-size:12px}
  .lb{display:block;margin:11px 0 5px;font-weight:600;color:#c9c9d1;font-size:12px}
  .hint{font-weight:400;color:#7b7b88}
  button.pri,button.sec,button.dan{border:0;border-radius:8px;padding:8px 13px;font:inherit;
    font-weight:700;cursor:pointer;font-size:12px;white-space:nowrap}
  button.pri{background:#0a84ff;color:#fff}
  button.pri:hover{background:#2b95ff}
  button.sec{background:#2a2a34;color:#c2c2cc}
  button.sec:hover{background:#3a3a46}
  button.dan{background:#3a2226;color:#e78a8a}
  button.dan:hover{background:#4d2a2f}
  button:disabled{opacity:.45;cursor:not-allowed}
  .ck{display:flex;align-items:center;gap:7px;margin:10px 0;color:#b9b9c4;font-size:12px;cursor:pointer}
  .plist{margin-top:4px}
  .pitem{border:1px solid #2a2a36;border-radius:10px;background:#101018;margin-bottom:8px;overflow:hidden}
  .prow{display:flex;align-items:center;gap:10px;padding:9px 11px}
  .prow img{width:44px;height:44px;border-radius:7px;flex:none;background:#242430;object-fit:cover}
  .prow .m{flex:1;min-width:0}
  .prow .nm{font-weight:600;font-size:12.5px;color:#eee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .prow .sub{color:#82828f;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pbody{border-top:1px solid #23232e;padding:9px 11px;background:#0c0c12}
  .trk{display:flex;align-items:center;gap:8px;padding:5px 4px;border-radius:6px}
  .trk:hover{background:#15151d}
  .trk img{width:32px;height:32px;border-radius:5px;flex:none;background:#242430;object-fit:cover}
  .trk .m{flex:1;min-width:0}
  .trk .nm{font-size:12px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .trk .sub{color:#7d7d8a;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mini{border:0;background:#22222c;color:#bbb;border-radius:6px;padding:4px 8px;font-size:11px;
    cursor:pointer;font-family:inherit}
  .mini:hover{background:#31313e;color:#fff}
  .mini.dan{background:#33222a;color:#e08a8a}
  .mini.dan:hover{background:#482c36}
  .transport{display:flex;align-items:center;gap:6px;margin-bottom:10px;padding:7px 9px;
    border-radius:9px;background:#101018;border:1px solid #2a2a36}
  .transport .mini{font-size:14px;padding:3px 10px;line-height:1.25}
  .np{margin-left:auto;color:#8a8a98;font-size:11px;max-width:260px;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  .logbar{flex:none;border-top:1px solid #2c2c36;background:#111119;padding:7px 10px 9px;
    display:flex;flex-direction:column;gap:5px}
  .logbar-hd{display:flex;align-items:center;gap:8px;color:#6f6f7c;font-size:10.5px}
  .logbar-hd button{margin-left:auto}
  .log{max-height:120px;overflow:auto;font:11.5px/1.65 ui-monospace,Consolas,monospace;
    white-space:pre-wrap;word-break:break-word}
  .log:empty::before{content:'（暂无日志）';color:#4a4a56}
  .lg{color:#9aa0ad}.lg.ok{color:#4ade80}.lg.warn{color:#ffd166}.lg.err{color:#f87171}.lg.info{color:#67b0ff}
  .card{border:1px solid #3a3a4a;border-radius:10px;background:#101018;padding:11px 12px;margin-bottom:10px}
  .card h4{margin:0 0 9px;font-size:12.5px;color:#ffd166;font-weight:700}
  .opt{display:flex;align-items:center;gap:10px;padding:7px;border-radius:8px;cursor:pointer}
  .opt:hover{background:#181822}
  .opt input{accent-color:#0a84ff;flex:none}
  .opt img{width:38px;height:38px;border-radius:6px;flex:none;object-fit:cover;background:#26262f}
  .opt .m{min-width:0;flex:1}
  .opt .nm{font-weight:600;color:#eee;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .opt .sub{color:#82828f;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:5px;font-size:10px;
    background:#2b3d2b;color:#7dd88b}
  .tag.rec{background:#2b3550;color:#8ab6ff}
  .tag.pub{background:#3a3320;color:#e0c37a}
  .tag.bad{background:#4a2a2a;color:#f0a0a0}
  .prog{margin-top:10px;height:5px;border-radius:3px;background:#242430;overflow:hidden;display:none}
  .prog.on{display:block}
  .prog i{display:block;height:100%;width:0;background:#0a84ff;transition:width .25s}
  .result{margin-top:10px;padding:10px 12px;border-radius:10px;background:#101018;
    border:1px solid #2b3d2b;font-size:12px;display:none}
  .result.on{display:block}
  .result h4{margin:0 0 6px;font-size:12.5px;color:#4ade80}
  .result .li{color:#8b8b98;font-size:11.5px;margin-top:2px}
  .result .li b{color:#e0a0a0}
  .empty{color:#6f6f7c;font-size:12px;padding:14px 4px;text-align:center}
  .sec-title{color:#8a8a98;font-size:11px;font-weight:700;margin:12px 0 6px;letter-spacing:.5px}
  `;

  /* ======================== UI ======================== */
  let host, panelEl;
  let credEl, logEl, tabsEl, bodyEl, progEl, progBar;
  let playlistsCache = [];
  const openState = {};   // plId -> bool
  const tracksCache = {}; // plId -> [items]
  let cancelled = false;
  let autoAll = false;

  const $ = (id) => (host ? host.shadowRoot.getElementById(id) : null);

  function log(msg, cls) {
    if (!logEl) {
      // 页面侧（网页挂件关闭时 logEl 为空）：把日志中继回面板窗口，
      // 否则页面里发生了什么完全看不到，排查只能靠猜。
      if (!PANEL_MODE) {
        try { window.postMessage({ __am_log__: { msg: String(msg), cls: cls || '' } }, '*'); } catch (e) {}
      }
      return;
    }
    const d = document.createElement('div');
    d.className = 'lg ' + (cls || '');
    d.textContent = msg;
    logEl.appendChild(d);
    // ★ 上限 300 行：日志回传后会持续 append，不裁剪的话 DOM 节点会一直堆积
    while (logEl.childNodes.length > 300) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function clearLog() { if (logEl) logEl.innerHTML = ''; }
  function setCred(t, cls) {
    if (!credEl) return;
    credEl.textContent = t;
    credEl.className = 'cred ' + (cls || '');
  }
  function setProgress(done, total) {
    if (!progEl) return;
    if (!total) { progEl.classList.remove('on'); return; }
    progEl.classList.add('on');
    progBar.style.width = Math.round((done / total) * 100) + '%';
  }

  function buildUI() {
    if (document.getElementById('__am_pb_host__')) return;
    host = document.createElement('div');
    host.id = '__am_pb_host__';
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;';
    host.style.setProperty('--tint', LS.get('tint', '168,200,240'));
    host.style.setProperty('--tintA', '0.5');
    const root = host.attachShadow({ mode: 'open' });

    const st = document.createElement('style');
    st.textContent = CSS_TEXT + (PANEL_MODE ? PMODE_CSS : '');
    root.appendChild(st);

    const APPLE_D =
      'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014' +
      '-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039' +
      ' 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48' +
      ' 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857' +
      '-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376' +
      '-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83' +
      '-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714' +
      ' 1.338.104 2.715-.688 3.559-1.701';

    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.title = 'Apple Music 歌单管家（可拖动）';
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><defs>' +
      '<linearGradient id="amgA" x1="0.2" y1="0" x2="0.8" y2="1">' +
      '<stop offset="0%" stop-color="#ffffff" stop-opacity="0.99"/>' +
      '<stop offset="36%" stop-color="#ffffff" stop-opacity="0.80"/>' +
      '<stop offset="72%" stop-color="#ffffff" stop-opacity="0.58"/>' +
      '<stop offset="100%" stop-color="#ffffff" stop-opacity="0.90"/>' +
      '</linearGradient>' +
      '<radialGradient id="amgS" cx="0.5" cy="0.5" r="0.5">' +
      '<stop offset="0%" stop-color="#ffffff" stop-opacity="0.92"/>' +
      '<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>' +
      '</radialGradient>' +
      '<clipPath id="amgC"><path d="' + APPLE_D + '"/></clipPath>' +
      '</defs>' +
      '<path d="' + APPLE_D + '" fill="url(#amgA)" stroke="#ffffff" stroke-opacity="0.92"' +
      ' stroke-width="0.45" stroke-linejoin="round"/>' +
      '<g clip-path="url(#amgC)">' +
      '<ellipse cx="8.4" cy="7.4" rx="5.6" ry="3.8" fill="url(#amgS)"/>' +
      '</g></svg>';
    root.appendChild(fab);

    panelEl = document.createElement('div');
    panelEl.className = 'panel';
    panelEl.innerHTML = `
      <div class="hd" id="hd">
        <span class="ttl">🎵 Apple Music 歌单管家</span>
        <span class="sp"></span>
        <button class="ico" id="btnMin" title="收起/展开">–</button>
        <button class="ico" id="btnClose" title="关闭（右下角圆钮召回）">✕</button>
      </div>
      <div class="tabs" id="tabs">
        <button class="tab on" data-tab="pl">我的歌单</button>
        <button class="tab" data-tab="new">创建歌单</button>
      </div>
      <div class="bd" id="bd">
        <div class="cred" id="cred">正在检测登录凭证…</div>
        <div id="pane-pl"></div>
        <div id="pane-new" style="display:none">
          <label class="lb">歌单名称</label>
          <input class="inp" id="plName" />
          <label class="lb">歌曲列表 <span class="hint">每行一首，格式：歌名 - 歌手</span></label>
          <textarea class="inp ta" id="songs" spellcheck="false"></textarea>
          <label class="ck"><input type="checkbox" id="autoPick" /> 遇到多个版本时自动选最匹配的（不弹窗询问）</label>
          <div class="row">
            <button class="pri" id="btnRun">开始建歌单</button>
            <button class="sec" id="btnFill">填入示例</button>
            <button class="sec" id="btnStop" disabled>停止</button>
          </div>
          <div class="prog" id="prog"><i id="progBar"></i></div>
          <div id="choice"></div>
          <div id="result" class="result"></div>
        </div>
      </div>
      <div class="tintbar" id="tintbar">
        <span>悬浮球颜色</span>
        <input type="color" id="tintCustom" title="自定义颜色" value="#a8c8f0" />
      </div>
      <div class="tintbar" id="wgbar" style="display:none">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;width:100%">
          <input type="checkbox" id="wgOn" style="width:auto;margin:0" />
          <span>在 Apple Music 网页上也显示挂件球</span>
        </label>
      </div>
      <div class="tintbar" id="hintbar" style="display:none">
        <span style="font-size:11px;line-height:1.4">配色在桌面悬浮球上设置：右键球 →「悬浮球颜色」</span>
      </div>
      <div class="logbar">
        <div class="logbar-hd"><span>运行日志</span><button class="mini" id="btnCopyLog">复制</button></div>
        <div class="log" id="log"></div>
      </div>`;
    root.appendChild(panelEl);
    document.body.appendChild(host);

    credEl = $('cred');
    logEl = $('log');
    progEl = $('prog');
    progBar = $('progBar');

    $('plName').value = LS.get('name', '我的歌单');
    $('songs').value = LS.get('songs', SAMPLE);
    $('autoPick').checked = LS.get('autoPick', '0') === '1';
    $('plName').addEventListener('change', () => LS.set('name', $('plName').value));
    $('songs').addEventListener('change', () => LS.set('songs', $('songs').value));
    $('autoPick').addEventListener('change', () => LS.set('autoPick', $('autoPick').checked ? '1' : '0'));
    $('btnFill').onclick = () => { $('songs').value = SAMPLE; LS.set('songs', SAMPLE); };
    $('btnCopyLog').onclick = () => {
      const btn = $('btnCopyLog');
      const txt = logEl ? logEl.textContent || '' : '';
      const done = () => {
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, () => {});
      } else {
        const ta = document.createElement('textarea');
        ta.value = txt;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        ta.remove();
      }
    };
    $('btnRun').onclick = runCreateFlow;
    $('btnStop').onclick = () => { cancelled = true; log('已请求停止…', 'warn'); $('btnStop').disabled = true; };

    // 悬浮球：可拖动，位置记忆；未拖动则视为点击
    (() => {
      const saved = LS.get('fabPos', '');
      if (saved) {
        try {
          const p = JSON.parse(saved);
          if (typeof p.l === 'number' && typeof p.t === 'number') {
            fab.style.right = 'auto';
            fab.style.bottom = 'auto';
            fab.style.left = Math.max(0, Math.min(p.l, innerWidth - 44)) + 'px';
            fab.style.top = Math.max(0, Math.min(p.t, innerHeight - 44)) + 'px';
          }
        } catch (e) {}
      }
      let sx = 0, sy = 0, ox = 0, oy = 0, drag = false, moved = false;
      fab.addEventListener('mousedown', (e) => {
        drag = true; moved = false;
        const r = fab.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        e.preventDefault();
        e.stopPropagation();
      });
      window.addEventListener('mousemove', (e) => {
        if (!drag) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        if (!moved) return;
        fab.style.left = Math.max(0, Math.min(ox + dx, innerWidth - 44)) + 'px';
        fab.style.top = Math.max(0, Math.min(oy + dy, innerHeight - 44)) + 'px';
      });
      window.addEventListener('mouseup', () => {
        if (!drag) return;
        drag = false;
        if (moved) {
          const r = fab.getBoundingClientRect();
          LS.set('fabPos', JSON.stringify({ l: Math.round(r.left), t: Math.round(r.top) }));
        } else {
          panelEl.classList.toggle('hide');
        }
      });
    })();
    $('btnClose').onclick = () => {
      // 独立窗口模式下，"关闭"就是关掉这个窗口
      if (PANEL_MODE) { try { window.close(); } catch (e) {} return; }
      panelEl.classList.add('hide');
    };
    $('btnMin').onclick = () => panelEl.classList.toggle('min');

    tabsEl = $('tabs');
    bodyEl = $('bd');
    tabsEl.addEventListener('click', (e) => {
      const b = e.target.closest('.tab');
      if (!b) return;
      [...tabsEl.querySelectorAll('.tab')].forEach((x) => x.classList.toggle('on', x === b));
      $('pane-pl').style.display = b.dataset.tab === 'pl' ? '' : 'none';
      $('pane-new').style.display = b.dataset.tab === 'new' ? '' : 'none';
      if (b.dataset.tab === 'pl') renderPlaylists();
    });

    // 拖动
    (() => {
      let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
      $('hd').addEventListener('mousedown', (e) => {
        if (e.target.classList && e.target.classList.contains('ico')) return;
        drag = true;
        const r = panelEl.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        panelEl.style.right = 'auto';
        panelEl.style.left = ox + 'px';
        panelEl.style.top = oy + 'px';
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!drag) return;
        panelEl.style.left = ox + (e.clientX - sx) + 'px';
        panelEl.style.top = oy + (e.clientY - sy) + 'px';
      });
      window.addEventListener('mouseup', () => { drag = false; });
    })();

    // ---- 悬浮球颜色 ----
    const TINTS = [
      ['冰蓝', '168,200,240'],
      ['水青', '150,224,216'],
      ['琥珀', '224,170,96'],
      ['粉紫', '226,110,176'],
      ['石墨', '150,156,166'],
      ['曜石', '52,58,72'],
    ];
    const applyTint = (rgb, mark) => {
      const p = String(rgb).split(',').map((n) => parseInt(n, 10) || 0);
      const lum = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
      // 深色玻璃要更实，否则在黑页面上一团糊
      const alpha = lum < 90 ? 0.82 : lum < 150 ? 0.62 : 0.5;
      host.style.setProperty('--tint', rgb);
      host.style.setProperty('--tintA', String(alpha));
      LS.set('tint', rgb);
      if (mark !== false) {
        root.querySelectorAll('.dot').forEach((d) => {
          d.classList.toggle('on', d.dataset.tint === rgb);
        });
      }
    };
    const hexOf = (rgb) => {
      const p = String(rgb).split(',').map((n) => Math.max(0, Math.min(255, parseInt(n, 10) || 0)));
      return '#' + p.map((n) => n.toString(16).padStart(2, '0')).join('');
    };
    const tintbar = $('tintbar');
    const custom = $('tintCustom');
    TINTS.forEach(([name, rgb]) => {
      const d = document.createElement('button');
      d.className = 'dot';
      d.dataset.tint = rgb;
      d.title = name;
      d.style.background =
        'radial-gradient(120% 120% at 30% 25%, #fff 0%, rgba(' + rgb + ',.95) 60%, rgba(' + rgb + ',1) 100%)';
      d.onclick = () => applyTint(rgb);
      tintbar.insertBefore(d, custom);
    });
    custom.value = hexOf(LS.get('tint', '168,200,240'));
    custom.oninput = () => {
      const h = custom.value;
      applyTint(
        parseInt(h.slice(1, 3), 16) + ',' + parseInt(h.slice(3, 5), 16) + ',' + parseInt(h.slice(5, 7), 16),
        false
      );
      root.querySelectorAll('.dot').forEach((d) => d.classList.remove('on'));
    };

    /* ---- 独立面板窗口：不提供任何颜色 / 挂件控件 ----
     * 颜色只有一个入口：右键桌面悬浮球 →「悬浮球颜色」。
     * （面板里的取色条本来就只影响网页挂件的渐变，面板模式下它是死控件。）
     * 网页挂件已彻底移除：桌面球 + 独立面板已经够用。
     * ------------------------------------------------ */
    if (PANEL_MODE) {
      const tb = $('tintbar');
      if (tb) tb.style.display = 'none';
      const wb = $('wgbar');
      if (wb) wb.style.display = 'none';
      const hb = $('hintbar');
      if (hb) hb.style.display = 'flex';

      // 接收【页面侧】中继过来的日志，加上 [网页] 前缀，方便区分来源
      try {
        chrome.runtime.onMessage.addListener((m) => {
          if (m && m.type === 'am-log') log('[网页] ' + m.msg, m.cls || 'info');
        });
      } catch (e) {}
    }
    /* 独立窗口：优先采用桌面悬浮球通过 URL 传来的颜色，做到两处一致 */
    let initTint = LS.get('tint', '168,200,240');
    if (PANEL_MODE) {
      try {
        const q = new URLSearchParams(location.search).get('tint');
        if (q && /^\d{1,3},\d{1,3},\d{1,3}$/.test(q)) {
          initTint = q;
          log('已采用桌面悬浮球的颜色：' + q, 'info');
        }
      } catch (e) {}
    }
    applyTint(initTint);

    if (have.auth && have.mut) setCred('✅ 已获取登录凭证', 'ok');
    log('歌单管家已就绪 ✓', 'info');
    renderPlaylists();
    // 启动后自动拉歌单；若还没凭证则引导获取（会显示授权按钮）
    setTimeout(() => {
      if (PANEL_MODE) return;   // 独立窗口由 boot() 负责拉取，避免重复请求
      if (have.auth && have.mut) refreshPlaylists(true);
      else refreshPlaylists(false);
    }, 1200);
  }

  /* ======================== 歌单视图 ======================== */
  function skeleton() {
    const c = LS.get('plCache', '');
    if (!c) return null;
    try { return JSON.parse(c); } catch (e) { return null; }
  }

  function renderPlaylists() {
    const pane = $('pane-pl');
    if (!pane) return;
    if (!playlistsCache.length) {
      const s = skeleton();
      if (s && s.length) {
        playlistsCache = s;
      }
    }
    pane.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'row';
    bar.style.marginBottom = '9px';
    const refresh = document.createElement('button');
    refresh.className = 'sec';
    refresh.textContent = '🔄 刷新歌单';
    refresh.onclick = () => refreshPlaylists(false);
    const cnt = document.createElement('span');
    cnt.style.cssText = 'color:#7d7d8a;font-size:11.5px;margin-left:auto';
    cnt.textContent = playlistsCache.length ? `共 ${playlistsCache.length} 个` : '';
    bar.appendChild(refresh);
    bar.appendChild(cnt);
    pane.appendChild(bar);

    // 挂件自带的播放控制条（由 MusicKit 驱动，不依赖页面按钮）
    const tp = document.createElement('div');
    tp.className = 'transport';
    const mkBtn = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = label;
      b.title = title;
      b.onclick = fn;
      return b;
    };
    tp.appendChild(mkBtn('⏮', '上一首', () => ctrlStep(-1, 'prev')));
    tp.appendChild(mkBtn('⏯', '播放 / 暂停', () => ctrl((i) => { if (i.isPlaying) i.pause(); else i.play(); }, 'toggle')));
    tp.appendChild(mkBtn('⏭', '下一首', () => ctrlStep(1, 'next')));
    const np = document.createElement('div');
    np.className = 'np';
    np.id = 'npText';
    np.textContent = playStateText();
    tp.appendChild(np);
    pane.appendChild(tp);
    startNowPlayingPoll();
    pane.appendChild(bar);

    if (!playlistsCache.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '还没有数据，点「刷新歌单」拉取你的歌单';
      pane.appendChild(e);
      return;
    }

    const list = document.createElement('div');
    list.className = 'plist';
    playlistsCache.forEach((pl) => list.appendChild(renderPlaylistItem(pl)));
    pane.appendChild(list);
  }

  function renderPlaylistItem(pl) {
    const a = pl.attributes || {};
    const wrap = document.createElement('div');
    wrap.className = 'pitem';

    const row = document.createElement('div');
    row.className = 'prow';

    const img = document.createElement('img');
    const au = art(a, '60x60');
    if (au) img.src = au;

    const meta = document.createElement('div');
    meta.className = 'm';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = a.name || '(未命名歌单)';
    if (a.isPublic) {
      const t = document.createElement('span');
      t.className = 'tag pub';
      t.textContent = '公开';
      nm.appendChild(t);
    }
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = [a.trackCount ? a.trackCount + ' 首' : '', a.dateAdded ? a.dateAdded.slice(0, 10) : '']
      .filter(Boolean).join(' · ');
    meta.appendChild(nm);
    meta.appendChild(sub);

    const btnOpen = document.createElement('button');
    btnOpen.className = 'mini';
    btnOpen.textContent = openState[pl.id] ? '收起' : '展开';
    btnOpen.onclick = async () => {
      openState[pl.id] = !openState[pl.id];
      renderPlaylists();
      if (openState[pl.id] && !tracksCache[pl.id]) await loadTracksInto(pl.id);
    };

    const btnPlay = document.createElement('button');
    btnPlay.className = 'mini';
    btnPlay.textContent = '▶ 播放';
    btnPlay.onclick = async () => {
      if (btnPlay.disabled) return;
      btnPlay.disabled = true;
      try {
        const kind = await playPlaylist(pl);
        log(`播放歌单「${a.name}」→ ${kind}`, kind.indexOf('失败') === 0 ? 'err' : 'ok');
      } catch (e) {
        log('播放歌单出错：' + ((e && e.message) || e), 'err');
      } finally {
        btnPlay.disabled = false;
        restoreCred();
      }
    };

    const btnDel = document.createElement('button');
    btnDel.className = 'mini dan';
    btnDel.textContent = '删除';
    const ro = !canEditPl(pl);
    if (ro) {
      btnDel.disabled = true;
      btnDel.title = READONLY_TIP;
    }
    btnDel.onclick = async () => {
      if (btnDel.disabled) return;
      if (!confirm(`确定删除歌单「${a.name}」？此操作不可撤销。`)) return;
      btnDel.disabled = true;
      try {
        const path = `/v1/me/library/playlists/${pl.id}`;
        const withIds = path + '?ids%5Blibrary-playlists%5D=' + encodeURIComponent(pl.id);
        let ok = false;
        for (const q of [
          [ALT_HOST, path, 'amp-api · 路径式'],
          [ALT_HOST, withIds, 'amp-api · ?ids[library-playlists]'],
          [API, path, 'api · 路径式'],
        ]) {
          ok = await attemptFetch('DELETE', q[0], q[1], null, q[2]);
          if (ok) break;
        }
        if (ok) {
          log(`已删除歌单「${a.name}」`, 'ok');
          playlistsCache = playlistsCache.filter((x) => x.id !== pl.id);
          saveCache();
          renderPlaylists();
        } else {
          log('删除歌单失败：Apple 拒绝了 DELETE（服务端 401）', 'err');
          log('替代做法：在 Apple Music 左侧栏右键该歌单 →「删除」。', 'warn');
        }
      } catch (e) {
        log('删除歌单出错：' + ((e && e.message) || e), 'err');
      } finally {
        btnDel.disabled = false;
      }
    };

    row.appendChild(img);
    row.appendChild(meta);
    row.appendChild(btnOpen);
    row.appendChild(btnPlay);
    row.appendChild(btnDel);
    wrap.appendChild(row);

    if (openState[pl.id]) {
      const body = document.createElement('div');
      body.className = 'pbody';
      body.id = 'pb_' + pl.id;
      const tr = tracksCache[pl.id];
      if (!tr) {
        body.textContent = '加载曲目中…';
      } else {
        fillTrackBody(body, pl, tr);
      }
      wrap.appendChild(body);
    }
    return wrap;
  }

  function fillTrackBody(body, pl, tracks) {
    body.innerHTML = '';
    const ro = !canEditPl(pl);

    // id → 歌名：播放时若需要跳过失效曲目，日志里就能直接打歌名（而不是数字 id）。
    // 这里只做映射，不额外发任何请求。
    const nameOfId = nameMapperOf(tracks);

    if (ro) {
      const w = document.createElement('div');
      w.className = 'empty';
      w.style.color = '#e0c37a';
      w.style.padding = '6px 2px 10px';
      w.textContent = '🔒 ' + READONLY_TIP;
      body.appendChild(w);
    }

    // 搜索添加
    const addRow = document.createElement('div');
    addRow.className = 'row';
    addRow.style.marginBottom = '9px';
    const inp = document.createElement('input');
    inp.className = 'inp';
    inp.placeholder = '搜索歌曲加入本歌单…';
    const sb = document.createElement('button');
    sb.className = 'pri';
    sb.textContent = '搜索';
    addRow.appendChild(inp);
    addRow.appendChild(sb);
    body.appendChild(addRow);

    const results = document.createElement('div');
    body.appendChild(results);

    const doSearch = async () => {
      const term = inp.value.trim();
      if (!term) return;
      results.innerHTML = '';
      const tip = document.createElement('div');
      tip.className = 'empty';
      tip.textContent = '搜索中…';
      results.appendChild(tip);
      try {
        const songs = await searchCatalog(term);
        results.innerHTML = '';
        if (!songs.length) {
          tip.textContent = '没有结果';
          results.appendChild(tip);
          return;
        }
        songs.forEach((s) => {
          const a = s.attributes || {};
          const o = document.createElement('div');
          o.className = 'opt';
          const im = document.createElement('img');
          const u = art(a, '60x60');
          if (u) im.src = u;
          const m = document.createElement('div');
          m.className = 'm';
          const n1 = document.createElement('div');
          n1.className = 'nm';
          n1.textContent = a.name || '';
          const n2 = document.createElement('div');
          n2.className = 'sub';
          n2.textContent = [a.artistName, a.albumName, fmtDur(a.durationInMillis)].filter(Boolean).join(' · ');
          m.appendChild(n1);
          m.appendChild(n2);
          const add = document.createElement('button');
          add.className = 'mini';
          add.textContent = '+ 添加';
          if (ro) {
            add.disabled = true;
            add.title = READONLY_TIP;
          }
          add.onclick = async () => {
            if (ro) return;
            add.disabled = true;
            add.textContent = '添加中…';
            try {
              const r = await apiRaw(`/v1/me/library/playlists/${pl.id}/tracks`, {
                method: 'POST',
                body: JSON.stringify({ data: [{ id: s.id, type: 'songs' }] }),
              });
              if (!r.ok) throw new Error('HTTP ' + r.status);
              add.textContent = '已添加 ✓';
              log(`+ ${a.name} → 「${(pl.attributes || {}).name}」`, 'ok');
              delete tracksCache[pl.id];
              await loadTracksInto(pl.id);
              renderPlaylists();
            } catch (e) {
              add.disabled = false;
              add.textContent = '+ 添加';
              log(`添加失败：${e.message}`, 'err');
            }
          };
          o.appendChild(im);
          o.appendChild(m);
          o.appendChild(add);
          results.appendChild(o);
        });
      } catch (e) {
        results.innerHTML = '';
        tip.textContent = '搜索失败：' + e.message;
        results.appendChild(tip);
      }
    };
    sb.onclick = doSearch;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

    // 曲目列表
    const title = document.createElement('div');
    title.className = 'sec-title';
    title.textContent = `本歌单曲目（${tracks.length}）`;
    body.appendChild(title);

    if (!tracks.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '这个歌单还没有歌曲';
      body.appendChild(e);
      return;
    }

    tracks.forEach((t, idx) => {
      const a = t.attributes || {};
      const row = document.createElement('div');
      row.className = 'trk';
      const im = document.createElement('img');
      const u = art(a, '60x60');
      if (u) im.src = u;

      // ★ 可疑曲目标记（只标记，不剔除，也不为此多发任何请求）：
      //   ① 实证：播放时被目录接口判定失效、已经跳过过 → 记在 badIds
      //   ② 启发式：没有 artwork，很可能没有目录封面 → 可能无法播放
      const cid0 = catalogIdOf(t);
      const warnText = cid0 && badIds.has(String(cid0))
        ? '⚠ 目录已失效（播放时已跳过）'
        : (!u ? '⚠ 目录封面缺失，可能无法播放' : '');
      if (warnText) row.title = warnText;

      const m = document.createElement('div');
      m.className = 'm';
      const n1 = document.createElement('div');
      n1.className = 'nm';
      n1.textContent = idx + 1 + '. ' + (a.name || '');
      if (warnText) {
        const wt = document.createElement('span');
        wt.className = 'tag bad';
        wt.textContent = '⚠';
        wt.title = warnText;
        n1.appendChild(wt);
      }
      const n2 = document.createElement('div');
      n2.className = 'sub';
      n2.textContent = [a.artistName, a.albumName].filter(Boolean).join(' · ');
      m.appendChild(n1);
      m.appendChild(n2);

      const play = document.createElement('button');
      play.className = 'mini';
      play.textContent = '▶';
      play.onclick = async () => {
        if (play.disabled) return;
        play.disabled = true;
        try {
          const cid = catalogIdOf(t);
          // ★ 没有目录 ID：这首播不了 → 只记日志，【绝不碰播放队列】。
          //   旧代码走 playItem（失败）后不 return，仍会走到下面的 playSongIds，
          //   于是拿整个歌单建队列 → 从第 1 首开始播。
          if (!cid) {
            const nm = [a.name, a.artistName].filter(Boolean).join(' / ');
            log('⚠ 这首无法播放（没有目录 ID，可能是本地上传）：' + (nm || '（未知曲目）') +
              '（未播放任何曲目）', 'err');
            return;
          }
          const ids = (tracks || []).map(catalogIdOf).filter(Boolean);
          const kind = cid && ids.length ? await playSongIds(ids, cid, nameOfId) : await playItem(t);
          const failed = kind.indexOf('失败') === 0;
          log(`播放 ${a.name} → ${kind}`, failed ? 'err' : 'ok');
        } catch (e) {
          log('播放出错：' + ((e && e.message) || e), 'err');
        } finally {
          play.disabled = false;
        }
      };

      const rm = document.createElement('button');
      rm.className = 'mini dan';
      rm.textContent = '移除';
      if (ro) {
        rm.disabled = true;
        rm.title = READONLY_TIP;
      }
      rm.onclick = async () => {
        if (rm.disabled) return;
        rm.disabled = true;
        try {
          const base = `/v1/me/library/playlists/${pl.id}/tracks`;
          const q = '?ids%5Blibrary-songs%5D=' + encodeURIComponent(t.id) + '&mode=all';
          const plans = [
            [ALT_HOST, base + q, null, 'amp-api · ids[library-songs]&mode=all'],
            [API, base + q, null, 'api · ids[library-songs]&mode=all'],
          ];
          let ok = false;
          for (const q of plans) {
            ok = await attemptFetch('DELETE', q[0], q[1], q[2], q[3]);
            if (ok) break;
          }
          if (ok) {
            log('已移除 ' + a.name, 'ok');
            delete tracksCache[pl.id];
            await loadTracksInto(pl.id);
            renderPlaylists();
          } else {
            log('移除失败：四种形式全被拒绝，请把日志（点「复制」）发我', 'err');
            log('替代做法：在左侧 Apple Music 打开该歌单，右键歌曲 →「从歌单中移除」。', 'warn');
          }
        } catch (e) {
          log('移除出错：' + ((e && e.message) || e), 'err');
        } finally {
          rm.disabled = false;
        }
      };

      row.appendChild(im);
      row.appendChild(m);
      row.appendChild(play);
      row.appendChild(rm);
      body.appendChild(row);
    });
  }

  async function loadTracksInto(plId) {
    const body = $('pb_' + plId);
    if (body) body.textContent = '加载曲目中…';
    try {
      const tracks = await loadAllTracks(plId);
      tracksCache[plId] = tracks;
      const pl = playlistsCache.find((x) => x.id === plId);
      if (body && pl) fillTrackBody(body, pl, tracks);
      log(`载入曲目 ${tracks.length} 首`, 'info');
    } catch (e) {
      if (body) body.textContent = '加载失败：' + e.message;
      log('加载曲目失败：' + e.message, 'err');
    }
  }

  function saveCache() {
    try {
      const slim = playlistsCache.map((p) => ({
        id: p.id,
        type: p.type,
        attributes: {
          name: (p.attributes || {}).name,
          artwork: (p.attributes || {}).artwork,
          dateAdded: (p.attributes || {}).dateAdded,
          isPublic: (p.attributes || {}).isPublic,
          canEdit: (p.attributes || {}).canEdit,
          playParams: (p.attributes || {}).playParams,
        },
      }));
      LS.set('plCache', JSON.stringify(slim));
    } catch (e) {}
  }

  async function refreshPlaylists(silent) {
    if (!have.auth || !have.mut) {
      if (silent) return;
      const ok = await ensureCreds();
      if (!ok) return;
    }
    try {
      tryMusicKit();
      const sfRes = await apiFetch('/v1/me/storefront');
      const sf = sfRes.data && sfRes.data[0] && sfRes.data[0].id;
      if (sf) { storefront = sf; LS.set('sf', sf); }
    } catch (e) {}
    if (!silent) setCred('⏳ 正在拉取歌单…');
    try {
      const list = await loadAllPlaylists();
      // 保留已知的 trackCount
      playlistsCache = list;
      saveCache();
      renderPlaylists();
      setCred(`✅ 已获取 ${list.length} 个歌单`, 'ok');
      log(`拉取到 ${list.length} 个歌单`, 'ok');
    } catch (e) {
      setCred('❌ 拉取歌单失败：' + e.message, 'bad');
      log('拉取歌单失败：' + e.message, 'err');
    }
  }

  /* ======================== 创建歌单流程 ======================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) =>
    String(s || '').toLowerCase()
      .replace(/[（(【\[][^)）】\]]*[)）】\]]/g, '')
      .replace(/[\s·・,，.。!！?？'"“”‘’_\-—–~]/g, '');
  const NOISE = /(live|现场|伴奏|instrumental|remix|翻唱|cover|demo|remaster|重制|重置|纯音乐|伴唱|和声|karaoke)/i;

  function scoreTrack(t, title, artist) {
    const a = t.attributes || {};
    let s = 0;
    if (artist && a.artistName && a.artistName.includes(artist)) s += 100;
    const nt = norm(title), nn = norm(a.name);
    if (nt && nn === nt) s += 50;
    else if (nt && nn && (nn.includes(nt) || nt.includes(nn))) s += 22;
    if (NOISE.test(String(a.name || ''))) s -= 18;
    if (a.isStreamable === false) s -= 300;
    return s;
  }

  function parseSongs(text) {
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
      let parts = line.split(/\s+[-–—|]\s+/);
      if (parts.length < 2) parts = line.split(/\s*[-–—|]\s*/);
      return { title: (parts[0] || '').trim(), artist: (parts[1] || '').trim() };
    }).filter((x) => x.title);
  }

  function askChoice(no, song, cands, suggestedId) {
    return new Promise((resolve) => {
      const box = $('choice');
      const card = document.createElement('div');
      card.className = 'card';
      const h = document.createElement('h4');
      h.textContent = `第 ${no} 首「${song.title}${song.artist ? ' - ' + song.artist : ''}」找到 ${cands.length} 个版本：`;
      card.appendChild(h);

      cands.forEach((c, i) => {
        const lab = document.createElement('label');
        lab.className = 'opt';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'pick_' + no;
        radio.value = c.id;
        if (c.id === suggestedId || (i === 0 && !suggestedId)) radio.checked = true;
        const img = document.createElement('img');
        if (c.art) img.src = c.art;
        const m = document.createElement('div');
        m.className = 'm';
        const n1 = document.createElement('div');
        n1.className = 'nm';
        n1.textContent = c.name;
        if (c.id === suggestedId) {
          const tg = document.createElement('span');
          tg.className = 'tag rec';
          tg.textContent = '推荐';
          n1.appendChild(tg);
        }
        const n2 = document.createElement('div');
        n2.className = 'sub';
        n2.textContent = [c.artist, c.album, c.dur].filter(Boolean).join(' · ');
        m.appendChild(n1); m.appendChild(n2);
        lab.appendChild(radio); lab.appendChild(img); lab.appendChild(m);
        card.appendChild(lab);
      });

      const sk = document.createElement('label');
      sk.className = 'opt';
      const sr = document.createElement('input');
      sr.type = 'radio';
      sr.name = 'pick_' + no;
      sr.value = '__skip__';
      const sm = document.createElement('div');
      sm.className = 'm';
      const sn = document.createElement('div');
      sn.className = 'nm';
      sn.textContent = '跳过这一首';
      sm.appendChild(sn);
      sk.appendChild(sr); sk.appendChild(sm);
      card.appendChild(sk);

      const row = document.createElement('div');
      row.className = 'row';
      row.style.marginTop = '9px';
      const ok = document.createElement('button');
      ok.className = 'pri';
      ok.textContent = '确认';
      const all = document.createElement('button');
      all.className = 'sec';
      all.textContent = '其余全部用推荐项';
      row.appendChild(ok); row.appendChild(all);
      card.appendChild(row);
      box.appendChild(card);
      try { card.scrollIntoView({ block: 'nearest' }); } catch (e) {}

      const fin = (v) => { card.remove(); resolve(v); };
      ok.onclick = () => {
        const s = card.querySelector('input[name="pick_' + no + '"]:checked');
        fin(!s || s.value === '__skip__' ? null : s.value);
      };
      all.onclick = () => {
        autoAll = true;
        const s = card.querySelector('input[name="pick_' + no + '"]:checked');
        fin(!s || s.value === '__skip__' ? null : s.value);
      };
    });
  }

  async function ensureCreds() {
    // 独立窗口模式：凭证只能从扩展后台取，没有页面可抓
    if (PANEL_MODE) {
      setCred('⏳ 正在从扩展后台取凭证…');
      for (let i = 0; i < 8; i++) {
        if (await loadCredsFromExtension()) {
          setCred('✅ 已从扩展后台取得凭证', 'ok');
          return true;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      setCred('❌ 扩展后台没有凭证', 'bad');
      log('后台没有凭证。请先在浏览器打开 music.apple.com 播放一首歌，再回来重试。', 'err');
      return false;
    }

    return new Promise((resolve) => {
      tryMusicKit(); scanStorage();
      if (have.auth && have.mut) { setCred('✅ 已获取登录凭证', 'ok'); resolve(true); return; }
      setCred('⏳ 等待登录凭证…请在本页面播放任意一首歌');
      log('等待凭证：请点开一首歌播放，或点下方授权按钮', 'warn');

      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:9px';
      const btn = document.createElement('button');
      btn.className = 'pri';
      btn.style.cssText = 'width:100%';
      btn.textContent = '▶ 用 MusicKit 授权获取 user token';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = '授权中…若弹出窗口请在窗口里确认';
        try {
          const MK = window.MusicKit;
          if (!MK) throw new Error('window.MusicKit 不存在');
          let inst = null;
          try { inst = MK.getInstance && MK.getInstance(); } catch (e) { inst = null; }
          if (!inst && have.auth) {
            MK.configure({
              developerToken: String(have.auth).replace(/^Bearer\s+/i, ''),
              app: { name: 'PlaylistManager', build: '1.0' },
            });
            inst = MK.getInstance();
          }
          if (!inst) throw new Error('拿不到 MusicKit 实例');
          await inst.authorize();
          if (!inst.musicUserToken) throw new Error('authorize 未返回 musicUserToken');
          have.mut = inst.musicUserToken;
          log('授权成功 ✓', 'ok');
          wrap.remove();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '▶ 重试 MusicKit 授权';
          log('授权失败：' + e.message, 'err');
        }
      };
      wrap.appendChild(btn);
      if (credEl && credEl.parentNode) credEl.parentNode.insertBefore(wrap, credEl.nextSibling);

      let el = 0;
      const iv = setInterval(() => {
        el += 1.5;
        if (cancelled || el > 150) {
          clearInterval(iv); wrap.remove();
          if (el > 150) { setCred('❌ 等待凭证超时', 'bad'); log('等待凭证超时。请播放一首歌后重试。', 'err'); }
          resolve(false);
          return;
        }
        tryMusicKit(); scanStorage();
        if (have.auth && !have.mut) { setCred('⚠ 有 developer token，仍缺 user token —— 请点授权按钮'); return; }
        if (have.auth && have.mut) {
          clearInterval(iv); wrap.remove();
          setCred('✅ 已获取登录凭证', 'ok');
          log('已获取登录凭证 ✓', 'ok');
          resolve(true);
        }
      }, 1500);
    });
  }

  async function runCreateFlow() {
    cancelled = false; autoAll = false;
    clearLog();
    const choiceBox = $('choice');
    const resultEl = $('result');
    choiceBox.innerHTML = '';
    resultEl.classList.remove('on');
    resultEl.innerHTML = '';
    setProgress(0, 0);
    $('btnRun').disabled = true;
    $('btnStop').disabled = false;

    const playlistName = ($('plName').value || '').trim() || '我的歌单';
    const songs = parseSongs($('songs').value);
    if (!songs.length) {
      log('歌曲列表为空，请每行填一首「歌名 - 歌手」', 'err');
      $('btnRun').disabled = false;
      return;
    }
    LS.set('name', playlistName);
    LS.set('songs', $('songs').value);
    log(`准备处理 ${songs.length} 首，歌单名「${playlistName}」`, 'info');

    try {
      setCred('⏳ 正在准备登录凭证…');
      if (!(await ensureCreds())) throw new Error('未能获取登录凭证：请播放一首歌后重试');

      const sfRes = await apiFetch('/v1/me/storefront');
      const sf = sfRes.data && sfRes.data[0] && sfRes.data[0].id;
      if (!sf) throw new Error('无法获取商店区');
      storefront = sf; LS.set('sf', sf);
      log('商店区：' + sf, 'info');

      const picked = [];
      const skipped = [];

      for (let i = 0; i < songs.length; i++) {
        if (cancelled) break;
        const s = songs[i];
        const no = i + 1;
        setProgress(i, songs.length);
        setCred(`⏳ 搜索中 ${no}/${songs.length}…`);

        const terms = [];
        if (s.artist) terms.push(s.title + ' ' + s.artist);
        terms.push(s.title);

        let cands = [];
        for (const term of terms) {
          try {
            const data = await searchCatalog(term);
            if (data.length) {
              cands = data.map((t) => {
                const a = t.attributes || {};
                return {
                  id: t.id, name: a.name || '', artist: a.artistName || '', album: a.albumName || '',
                  dur: fmtDur(a.durationInMillis), art: art(a, '60x60'),
                  streamable: a.isStreamable !== false, score: scoreTrack(t, s.title, s.artist),
                };
              }).sort((x, y) => y.score - x.score);
              break;
            }
          } catch (e) { log(`  搜索「${term}」出错：${e.message}`, 'err'); }
          await sleep(180);
        }

        const usable = cands.filter((c) => c.streamable);
        if (!usable.length) {
          skipped.push({ ...s, reason: cands.length ? '曲库中该曲不可播放（版权/地区限制）' : '曲库中未找到' });
          log(`${String(no).padStart(2, '0')}. ✘ 跳过：${s.title}（${cands.length ? '不可播放' : '未找到'}）`, 'err');
          continue;
        }

        const best = usable[0];
        const ru = usable[1];
        const ambiguous = ru && ru.score >= best.score - 25 && ru.id !== best.id;
        let chosenId = best.id;
        if (!$('autoPick').checked && !autoAll && ambiguous) {
          setCred('⏳ 等待你选择版本…');
          const ans = await askChoice(no, s, usable.slice(0, 6), best.id);
          if (ans === null) {
            skipped.push({ ...s, reason: '你在选择时跳过了这一首' });
            log(`${String(no).padStart(2, '0')}. ⤼ 手动跳过：${s.title}`, 'warn');
            continue;
          }
          chosenId = ans;
        }
        const chosen = usable.find((c) => c.id === chosenId) || best;
        picked.push({ title: s.title, artist: s.artist, id: chosen.id, name: chosen.name, artistName: chosen.artist });
        log(`${String(no).padStart(2, '0')}. ✔ ${s.title} → ${chosen.name} / ${chosen.artistName}`, 'ok');
        await sleep(200);
      }

      setProgress(songs.length, songs.length);
      if (cancelled) { setCred('⏹ 已停止（未创建歌单）', 'bad'); log('已停止。', 'warn'); return; }
      if (!picked.length) throw new Error('没有任何可添加的歌曲，已中止');

      setCred('⏳ 正在创建歌单…');
      const cj = await apiFetch('/v1/me/library/playlists', {
        method: 'POST',
        body: JSON.stringify({ attributes: { name: playlistName, description: '由歌单管家创建' } }),
      });
      const plId = cj.data && cj.data[0] && cj.data[0].id;
      if (!plId) throw new Error('创建歌单未返回 id');
      log('歌单已创建：' + playlistName, 'ok');

      const added = [];
      for (let i = 0; i < picked.length; i++) {
        if (cancelled) break;
        const p = picked[i];
        setProgress(i, picked.length);
        setCred(`⏳ 添加中 ${i + 1}/${picked.length}…`);
        try {
          const r = await apiRaw(`/v1/me/library/playlists/${plId}/tracks`, {
            method: 'POST',
            body: JSON.stringify({ data: [{ id: p.id, type: 'songs' }] }),
          });
          if (!r.ok) {
            skipped.push({ title: p.title, artist: p.artist, reason: `添加失败 HTTP ${r.status}（可能版权/地区限制）` });
            log(`   ✘ ${p.name} 添加失败 HTTP ${r.status}`, 'err');
          } else {
            added.push(p);
            log(`   + ${p.name} / ${p.artistName}`, 'ok');
          }
        } catch (e) {
          skipped.push({ title: p.title, artist: p.artist, reason: '添加异常：' + e.message });
          log(`   ✘ ${p.name} 添加异常：${e.message}`, 'err');
        }
        await sleep(300);
      }
      setProgress(picked.length, picked.length);

      setCred(`🎉 完成：成功 ${added.length} 首，跳过 ${skipped.length} 首`, 'ok');
      resultEl.innerHTML = '';
      const h = document.createElement('h4');
      h.textContent = `🎉 歌单「${playlistName}」创建完成`;
      resultEl.appendChild(h);
      const l1 = document.createElement('div');
      l1.className = 'li';
      l1.textContent = `成功添加 ${added.length} 首` + (skipped.length ? `，跳过 ${skipped.length} 首` : '');
      resultEl.appendChild(l1);
      skipped.forEach((k) => {
        const d = document.createElement('div');
        d.className = 'li';
        const b = document.createElement('b');
        b.textContent = k.title + (k.artist ? ' - ' + k.artist : '');
        d.appendChild(b);
        d.appendChild(document.createTextNode(' —— ' + k.reason));
        resultEl.appendChild(d);
      });
      resultEl.classList.add('on');
      log(`🎉 完成：成功 ${added.length} 首，跳过 ${skipped.length} 首`, 'ok');
      // 刷新歌单列表
      setTimeout(() => refreshPlaylists(true), 800);
    } catch (e) {
      setCred('❌ ' + e.message, 'bad');
      log('❌ ' + e.message, 'err');
    } finally {
      $('btnRun').disabled = false;
      $('btnStop').disabled = true;
      setProgress(0, 0);
      progEl.classList.remove('on');
    }
  }

  /* ======================== 启动 ======================== */
  /* ========== 独立面板模式：从扩展后台取凭证 ========== */
  async function loadCredsFromExtension() {
    try {
      const o = await chrome.storage.local.get('am_cred_v1');
      const c = o && o.am_cred_v1;
      if (c && c.auth && c.mut) {
        have.auth = c.auth;
        have.mut = c.mut;
        return true;
      }
    } catch (e) {}
    return false;
  }

  function boot() {
    /* ---- 独立面板窗口：取凭证 → 拉歌单 ---- */
    if (PANEL_MODE) {
      if (!document.body) return setTimeout(boot, 100);
      buildUI();
      document.title = 'Apple Music 歌单管家';
      (async function () {
        const ok = await ensureCreds();
        if (ok) {
          log('凭证就绪（来自扩展后台）', 'ok');
          refreshPlaylists(true);
        }
      })();
      return;
    }

    /* ---- 页面模式：只做后台支持，不画任何界面 ----
     * 内容脚本仍然必须运行：
     *   ① 从页面请求头里抓登录凭证（后台和面板都靠它）
     *   ② 代面板执行播放 / 控制指令
     * 但不再建 UI —— 桌面悬浮球 + 独立面板已经够用，
     * 网页里再挂一颗球只是重复。
     * --------------------------------------------- */
    maybeOpenPanelFromHash();
    // 播放卡死看门狗：只在网页侧跑（面板窗口没有 MusicKit）
    startStallWatchdog();
  }

  /* ============ 桌面悬浮球用 #am-panel 请求打开面板窗口 ============
   * 球只打开一个带 hash 的网址（不直接启动浏览器，避免权限级别冲突），
   * 页面加载/收到 hashchange 时把请求转给 bridge → 后台 → 开窗口。
   * ============================================================== */
  function maybeOpenPanelFromHash() {
    if (PANEL_MODE) return;
    try {
      if (location.hash !== '#am-panel') return;
      window.postMessage({ __am_open_panel__: true }, '*');
      // 清掉 hash，避免刷新或返回时重复触发
      try {
        history.replaceState(null, '', location.pathname + location.search);
      } catch (e) {}
      log('收到打开面板的请求，正在唤起…', 'info');
    } catch (e) {}
  }
  window.addEventListener('hashchange', maybeOpenPanelFromHash, false);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();