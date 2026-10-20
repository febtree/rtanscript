/**
 * YouTube 实时字幕跟随 —— 页面世界（MAIN）脚本
 *
 * 只有运行在页面世界才能：
 *   1. 拿到 player 对象上的 getPlayerResponse() / getOption() / setOption()
 *   2. hook 页面自己的 fetch / XHR，截获播放器发出的 timedtext 请求
 *   3. 抢在页面脚本之前处理搜索栏的 Esc（页面会 blur 输入框并吞掉事件）
 *
 * 关于第 2 点：2025 年起，baseUrl 带 `exp=xpe` 的视频，timedtext 接口必须带
 * PO Token（`pot=`）才返回内容，否则是 HTTP 200 + 空 body。pot 由播放器内部的
 * BotGuard 在运行时生成，外部拿不到。所以唯一可靠的办法是让播放器自己去请求，
 * 我们把响应截下来 —— 播放器的请求天然带着有效 pot。
 */
(() => {
  'use strict';

  const TAG = 'ytt-follow';
  let lastSig = '';

  // ============================================================ 搜索栏 Esc
  // YouTube / 键盘插件会在捕获阶段处理 Escape，常常先把输入框 blur 掉再阻止事件
  // 继续传播，导致搜索框自己的 keydown 收不到。这个脚本在 document_start 运行，
  // 注册得比页面脚本早，所以能抢到事件。
  //
  // 只保留两条路径：
  //   1. keydown：正常情况，焦点在搜索栏里时直接拦下
  //   2. focusout：Esc 被页面 / 插件抢先处理、输入框只被 blur 时兜底
  let searchBlurByPointer = false;

  const inSearchBar = (el) => {
    const bar = document.getElementById('ytt-search');
    return !!(bar && el && bar.contains(el));
  };
  const searchIsOpen = () => {
    const rootEl = document.getElementById('ytt-root');
    return !!(rootEl && rootEl.classList.contains('search-open'));
  };
  const closeSearch = () => {
    // 关闭后可能还会收到自身 blur 触发的 focusout，先把标记清掉
    searchBlurByPointer = false;
    window.postMessage({ source: TAG, type: 'close-search' }, '*');
  };

  // 点击到搜索栏外面也会让输入框失焦，但这不代表用户想退出搜索
  document.addEventListener('pointerdown', (e) => {
    searchBlurByPointer = !inSearchBar(e.target);
  }, true);

  // 焦点进入搜索栏时清掉上一次点击留下的标记（比如刚点了 🔍 按钮打开搜索）
  document.addEventListener('focusin', (e) => {
    if (inSearchBar(e.target)) searchBlurByPointer = false;
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    if (!searchIsOpen() || !inSearchBar(document.activeElement)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closeSearch();
  }, true);

  document.addEventListener('focusout', (e) => {
    if (!searchIsOpen() || !inSearchBar(e.target)) return;
    if (e.relatedTarget && inSearchBar(e.relatedTarget)) return; // 焦点还在搜索栏里
    if (searchBlurByPointer) { searchBlurByPointer = false; return; }
    if (e.relatedTarget) return; // Tab 到别的控件，不当作退出搜索
    closeSearch(); // 无 relatedTarget 的失焦：通常是 Esc / 页面脚本主动 blur
  }, true);

  // ============================================================ 播放器信息

  function getPlayer() {
    return document.getElementById('movie_player');
  }

  /** 优先向播放器要，拿不到再退回页面全局变量 */
  function getPlayerResponse() {
    try {
      const p = getPlayer();
      if (p && typeof p.getPlayerResponse === 'function') {
        const r = p.getPlayerResponse();
        if (r) return r;
      }
    } catch (_) {}
    try {
      if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    } catch (_) {}
    return null;
  }

  /** 播放器当前实际开启的字幕语言（没开 CC 时为 null） */
  function getActiveTrack() {
    try {
      const p = getPlayer();
      if (p && typeof p.getOption === 'function') {
        const t = p.getOption('captions', 'track');
        if (t && t.languageCode) return t;
      }
    } catch (_) {}
    return null;
  }

  /** track 传 null 表示关闭字幕 */
  function setActiveTrack(track) {
    try {
      const p = getPlayer();
      if (!p || typeof p.setOption !== 'function') return false;
      if (track) {
        p.setOption('captions', 'track', {
          languageCode: track.languageCode,
          kind: track.kind || '',
          vssId: track.vssId || '',
        });
        // 轨道若已被播放器缓存，强制它重新拉一次，否则我们截不到数据
        try { p.setOption('captions', 'reload', true); } catch (_) {}
      } else {
        p.setOption('captions', 'track', {});
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  const pickName = (v, fallback) => {
    if (!v) return fallback;
    if (typeof v === 'string') return v;
    if (v.simpleText) return v.simpleText;
    if (Array.isArray(v.runs) && v.runs[0]) return v.runs[0].text;
    return fallback;
  };

  function collect() {
    const pr = getPlayerResponse();
    const tl = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    const rawTracks = (tl && tl.captionTracks) || [];
    const active = getActiveTrack();

    return {
      videoId: (pr && pr.videoDetails && pr.videoDetails.videoId) || null,
      title: (pr && pr.videoDetails && pr.videoDetails.title) || null,
      activeCode: (active && active.languageCode) || null,
      tracks: rawTracks.map((t) => ({
        languageCode: t.languageCode,
        name: pickName(t.name, t.languageCode),
        baseUrl: t.baseUrl,
        kind: t.kind || '',
        vssId: t.vssId || '',
        // 带了 exp=xpe 说明这个视频的 timedtext 需要 PO Token，
        // 直连必然拿到空 body，直接走「让播放器去取」的路径
        needsPot: typeof t.baseUrl === 'string' && t.baseUrl.indexOf('exp=xpe') !== -1,
      })),
    };
  }

  function signature(d) {
    return [
      d.videoId || '',
      d.activeCode || '',
      d.tracks.map((t) => t.languageCode + ':' + t.kind).join(','),
    ].join('|');
  }

  function emit(reason) {
    const payload = collect();
    lastSig = signature(payload);
    window.postMessage({ source: TAG, type: 'tracks', reason, payload }, '*');
  }

  // ============================================================ 截获 timedtext

  const isTimedtext = (url) => typeof url === 'string' && url.indexOf('/api/timedtext') !== -1;
  const reported = new Set();

  function reportCaption(url, text) {
    if (!text || !text.trim()) return;
    if (reported.has(url)) return;
    reported.add(url);
    window.postMessage({ source: TAG, type: 'caption-data', payload: { url, text } }, '*');
  }

  // fetch hook（保持完全透传，只对 timedtext 多做一次 clone）
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const p = origFetch.apply(this, arguments);
        if (isTimedtext(url) && p && typeof p.then === 'function') {
          p.then((res) => {
            try {
              res.clone().text().then((t) => reportCaption(url, t), () => {});
            } catch (_) {}
          }, () => {});
        }
        return p;
      };
    }
  } catch (_) {}

  // XHR hook
  try {
    const XP = XMLHttpRequest.prototype;
    const origOpen = XP.open;
    const origSend = XP.send;

    XP.open = function (method, url) {
      try {
        Object.defineProperty(this, '__yttUrl', { value: String(url), configurable: true });
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };

    XP.send = function () {
      let url = '';
      try { url = this.__yttUrl || ''; } catch (_) {}
      if (isTimedtext(url)) {
        this.addEventListener('load', function () {
          try {
            const rt = this.responseType;
            if (!rt || rt === 'text') reportCaption(url, this.responseText);
          } catch (_) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  } catch (_) {}

  // ============================================================ 消息通道

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.source !== TAG) return;

    if (m.type === 'request-tracks') {
      emit(m.reason || 'request');
      return;
    }
    if (m.type === 'set-captions') {
      const ok = setActiveTrack(m.track || null);
      window.postMessage({ source: TAG, type: 'set-captions-result', ok, token: m.token }, '*');
    }
  });

  // 轨道信息不会触发 DOM 事件，用轮询兜底（开销极低）
  setInterval(() => {
    const s = signature(collect());
    if (s !== lastSig) emit('poll');
  }, 1000);
})();
