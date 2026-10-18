/**
 * YouTube 实时字幕跟随 —— 页面世界（MAIN）脚本
 *
 * 只有运行在页面世界才能：
 *   1. 拿到 player 对象上的 getPlayerResponse() / getOption() / setOption()
 *   2. hook 页面自己的 fetch / XHR，截获播放器发出的 timedtext 请求
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
