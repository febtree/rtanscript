/**
 * 本地测试服务器：模拟 YouTube，用于验证扩展的完整取字幕链路。
 *   node tools/test-hook/server.js
 *
 * /e2e/direct  直连 timedtext（不需要 PO Token）
 * /e2e/pot     baseUrl 带 exp=xpe，必须靠播放器自己去请求
 * /hook        单独验证 fetch / XHR 截获
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

const JSON3 = {
  events: [
    { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: 'hello there' }] },
    { tStartMs: 1200, dDurationMs: 1600, segs: [{ utf8: 'this is the second line' }] },
    { tStartMs: 3200, dDurationMs: 2000, segs: [{ utf8: 'nice to meet you' }] },
  ],
};

const SRV3 = `<?xml version="1.0" encoding="utf-8"?><timedtext>
<p t="0" d="1200"><s>hello there</s></p>
<p t="1200" d="1600"><s>this is the second line</s></p>
<p t="3200" d="2000"><s>nice to meet you</s></p>
</timedtext>`;

/** 无标点字幕：模拟中文自动字幕（完全没有句末标点），停顿有大小之分 */
const NOPUNCT_JSON3 = (() => {
  const frag = ['这一段完全没有标点', '所以只能靠停顿来判断断句', '自动字幕经常就是这样'];
  const events = [];
  let t = 0;
  for (let i = 0; i < 40; i++) {
    events.push({ tStartMs: t, dDurationMs: 2500, segs: [{ utf8: frag[i % 3] }] });
    t += 2500 + (i % 4 === 0 ? 1500 : 300); // 每 4 条一个明显停顿
  }
  return { events };
})();

/** 长字幕：48 条 × 2.5s = 120s，每 3 条凑一个完整句子（用于验证分块） */
const LONG_JSON3 = (() => {
  const frag = [
    'This is the beginning of a thought',
    'that carries on for a little while',
    'and then comes to a full stop.',
  ];
  const events = [];
  for (let i = 0; i < 48; i++) {
    events.push({
      tStartMs: i * 2500,
      dDurationMs: 2500,
      segs: [{ utf8: (i % 3 === 0 ? '' : ' ') + frag[i % 3] }],
    });
  }
  return { events };
})();

/** 假播放器页面；NEEDS_POT 时模拟“必须播放器自己带 pot 去请求” */
const page = (needsPot) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>e2e</title></head><body>
<div id="movie_player"></div>
<script>
  window.__seen = [];
  window.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'ytt-follow') window.__seen.push(e.data.type);
  });
  const track = {
    languageCode: 'en', kind: 'asr', vssId: 'a.en',
    name: { simpleText: 'English (auto-generated)' },
    baseUrl: location.origin + '/api/timedtext?v=TESTID&lang=en&caps=asr${needsPot ? '&exp=xpe' : ''}',
  };
  const p = document.getElementById('movie_player');
  p.getPlayerResponse = () => ({
    videoDetails: { videoId: 'TESTID', title: 'Test' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [track] } },
  });
  let active = null;
  p.getOption = () => (active ? { languageCode: active.languageCode } : null);
  p.setOption = (mod, name, value) => {
    if (mod !== 'captions' || name !== 'track') return;
    const code = value && value.languageCode;
    if (code && (!active || active.languageCode !== code)) {
      active = value;
      // 模拟播放器自己去拉字幕：真正带上了 pot
      fetch(track.baseUrl + '&pot=FAKEPOT&fmt=json3&c=WEB');
    } else if (!code) {
      active = null;
    }
  };
  ${EXPORT_SNIPPET}
</script>
<script src="/src/inject.js"></script>
</body></html>`;

const EXPORT_SNIPPET = `
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);

  // ?notime=1 自动关掉时间戳
  if (params.has('notime')) {
    setTimeout(() => { const b = $('ytt-time'); if (b) b.click(); }, 3000);
  }

  // ?search=关键词 自动展开搜索并输入；?next=1 再按一次 Enter 跳到下一处
  if (params.has('search')) {
    setTimeout(() => {
      const b = $('ytt-search-btn');
      if (b) b.click();
      const inp = $('ytt-search-input');
      if (inp) {
        inp.value = params.get('search');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        if (params.has('next')) {
          setTimeout(() => {
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }, 200);
        }
        if (params.has('esc')) {
          setTimeout(() => {
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          }, 200);
        }
      }
    }, 3000);
  }

  // ?sim=1 模拟「视频在播放」并悬停在面板上，验证悬停/划词会暂停跟随
  if (params.has('sim')) {
    const panelEl = $('ytt-panel');
    let vt = 0;
    setInterval(() => { vt += 0.5; window.__setCT(vt); }, 200); // 2.5 倍速推进
    setTimeout(() => {
      if (params.has('nopause')) {
        // 对照组：既不悬停也不划词
      } else if (params.has('sel')) {
        // 选中面板里的一段文字，模拟「正在取词/翻译」
        const target = document.querySelector('.ytt-cue .ytt-text');
        if (target) {
          const range = document.createRange();
          range.selectNodeContents(target);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } else {
        panelEl.dispatchEvent(new MouseEvent('mouseenter'));
      }
    }, 3000);
    setTimeout(() => {
      window.__A = { scroll: Math.round($('ytt-list').scrollTop), status: $('ytt-status').textContent, videoTime: vt };
    }, 9000);
    setTimeout(() => {
      if (params.has('nopause')) return;
      if (params.has('sel')) {
        const sel = getSelection();
        if (sel) sel.removeAllRanges();   // 相当于用户点了别处，选区消失
      } else {
        panelEl.dispatchEvent(new MouseEvent('mouseleave'));
      }
    }, 9200);
    // 采样一系列时间点，方便看清到底是「一直没滚动」还是「根本没跑主循环」
    window.__raf = 0;
    (function rafLoop() { window.__raf++; requestAnimationFrame(rafLoop); })();
    window.__series = [];
    for (const ms of [2000, 4000, 6000, 8000, 9000, 10000, 11000, 12000, 13000, 14000]) {
      setTimeout(() => {
        window.__series.push({
          at: ms,
          scroll: Math.round($('ytt-list').scrollTop),
          status: $('ytt-status').textContent,
          videoTime: vt,
          sel: String(getSelection()).slice(0, 12),
          raf: window.__raf,
        });
      }, ms);
    }
    setTimeout(() => {
      window.__B = { scroll: Math.round($('ytt-list').scrollTop), status: $('ytt-status').textContent, videoTime: vt };
    }, 14000);
  }

  function snapshot() {
    const list = $('ytt-list');
    const status = $('ytt-status');
    const panel = $('ytt-panel');
    const rootEl = $('ytt-root');
    const searchInput = $('ytt-search-input');
    const searchCount = $('ytt-search-count');
    const marks = list ? [...list.querySelectorAll('.ytt-text mark')] : [];
    const currentMark = list ? list.querySelector('.ytt-text mark.is-current') : null;
    const rect = (el) => (el ? { top: Math.round(el.getBoundingClientRect().top), bottom: Math.round(el.getBoundingClientRect().bottom), height: Math.round(el.getBoundingClientRect().height), display: getComputedStyle(el).display } : null);
    return {
      messages: window.__seen,
      status: status ? status.textContent : null,
      cues: list ? [...list.querySelectorAll('.ytt-cue')].map((n) => n.querySelector('.ytt-time').textContent + ' | ' + n.querySelector('.ytt-text').textContent) : null,
      search: {
        open: rootEl.classList.contains('search-open'),
        value: searchInput ? searchInput.value : null,
        count: searchCount ? searchCount.textContent : null,
        marks: marks.map((m) => m.textContent),
        hits: marks.length,
        current: currentMark ? currentMark.textContent : null,
        currentCue: currentMark ? Number(currentMark.closest('.ytt-cue').dataset.i) : null,
      },
      geometry: {
        viewport: { w: innerWidth, h: innerHeight },
        rootParent: rootEl.parentElement.id || rootEl.parentElement.tagName,
        embedded: rootEl.classList.contains('is-embed'),
        panel: rect(panel), list: rect(list), status: rect(status),
      },
      before: window.__A || null,
      after: window.__B || null,
      series: window.__series || null,
    };
  }

  // 验证「点击字幕跳转」开关：点一下第 2 段，看 video.currentTime 有没有被写
  const delay = params.has('sim') ? 15000 : 9000;
  setTimeout(async () => {
    if (params.has('clickseek')) {
      const b = $('ytt-jump');
      if (b) b.click();
    }
    const cue = document.querySelectorAll('.ytt-cue')[1] || document.querySelector('.ytt-cue');
    if (cue) cue.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const pre = document.createElement('pre');
    pre.id = 'result';
    pre.textContent = JSON.stringify(Object.assign(snapshot(), { seeks: window.__seeks || [] }), null, 1);
    document.body.appendChild(pre);
  }, delay);
`;

/**
 * 测试外壳：把 inject.js / content.js 当普通页面脚本加载，stub 掉 chrome.* API。
 * （headless Chrome 155 禁用了 --load-extension，所以没法直接加载扩展本体）
 */
const harness = ({ needsPot = false, forceXml = false, ytLayout = false, dark = false, long = false, nopunct = false } = {}) => {
  const body = ytLayout
    ? `<div id="columns">
    <div id="primary"><div id="primary-inner">
      <div id="movie_player" style="height:300px;background:#333;border-radius:8px"></div>
      <h1 style="font-size:18px">Video title</h1>
    </div></div>
    <div id="secondary"><div id="secondary-inner">
      <div style="padding:12px;border:1px solid #555;border-radius:8px">相关视频占位</div>
    </div></div>
  </div>
  <style>
    body { margin:0; }
    #columns { display:flex; gap:24px; padding:24px; align-items:flex-start; }
    #primary { flex:1 1 auto; min-width:0; }
    #primary-inner { padding-bottom:24px; }
    #secondary { flex:0 0 402px; }
    body.yt { background:#0f0f0f; color:#f1f1f1; font-family:Roboto,sans-serif; }
  </style>`
    : `<div id="movie_player"></div>`;

  return `<!DOCTYPE html><html${dark ? ' dark' : ''}><head><meta charset="utf-8">
<title>harness</title>
<link rel="stylesheet" href="/src/content.css">
</head><body class="${ytLayout ? 'yt' : ''}">
${body}
<script>
  // ---- headless 的虚拟时间下 requestAnimationFrame 不会触发，
  //      用 setTimeout 顶替，让扩展的主循环真正跑起来（仅测试用）----
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  // ---- chrome API stub ----
  window.chrome = {
    storage: { local: { get: async () => ({}), set: () => {} } },
    runtime: { onMessage: { addListener: () => {} } },
  };

  // ---- 假播放器 ----
  window.__seen = [];
  window.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'ytt-follow') window.__seen.push(e.data.type);
  });
  const track = {
    languageCode: 'en', kind: 'asr', vssId: 'a.en',
    name: { simpleText: 'English (auto-generated)' },
    baseUrl: location.origin + '/api/timedtext?v=TESTID&lang=en&caps=asr'
      + '${needsPot ? '&exp=xpe' : ''}${forceXml ? '&nojson=1' : ''}${long ? '&long=1' : ''}${nopunct ? '&nopunct=1' : ''}',
  };
  var player = document.getElementById('movie_player');

  // 假的 <video>：记录 currentTime 的写入，用来验证「点击跳转」开关
  window.__seeks = [];
  var vid = document.createElement('video');
  vid.className = 'html5-main-video';
  var ct = 0;
  Object.defineProperty(vid, 'currentTime', {
    get: () => ct,
    set: (x) => { ct = x; window.__seeks.push(x); },
    configurable: true,
  });
  player.appendChild(vid);
  window.__setCT = (v) => { ct = v; };

  player.getPlayerResponse = () => ({
    videoDetails: { videoId: 'TESTID', title: 'Test' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [track] } },
  });
  let active = null;
  player.getOption = () => (active ? { languageCode: active.languageCode } : null);
  player.setOption = (mod, name, value) => {
    if (mod !== 'captions' || name !== 'track') return;
    const code = value && value.languageCode;
    if (code && (!active || active.languageCode !== code)) {
      active = value;
      fetch(track.baseUrl + '&pot=FAKEPOT&fmt=json3&c=WEB');  // 模拟播放器自己带 pot 去请求
    } else if (!code) {
      active = null;
    }
  };
</script>
<script src="/src/inject.js"></script>
<script src="/src/content.js"></script>
<script>${EXPORT_SNIPPET}</script>
</body></html>`;
};


const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/timedtext') {
    const payload = url.searchParams.get('nopunct')
      ? NOPUNCT_JSON3
      : url.searchParams.get('long')
        ? LONG_JSON3
        : JSON3;
    // nojson=1：模拟 json3 拿不到、只能回退 XML
    if (url.searchParams.get('fmt') === 'json3' && !url.searchParams.get('nojson')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } else if (url.searchParams.get('fmt') === 'json3') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(SRV3);
    }
    return;
  }

  const html = (body) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };

  if (url.pathname === '/harness/direct') return html(harness());
  if (url.pathname === '/harness/xml') return html(harness({ forceXml: true }));
  if (url.pathname === '/harness/pot') return html(harness({ needsPot: true }));
  if (url.pathname === '/harness/embed') return html(harness({ needsPot: true, ytLayout: true, dark: true }));
  if (url.pathname === '/harness/blocks') return html(harness({ needsPot: true, ytLayout: true, dark: true, long: true }));
  if (url.pathname === '/harness/nopunct') return html(harness({ needsPot: true, ytLayout: true, dark: true, nopunct: true }));
  if (url.pathname === '/e2e/direct') return html(page(false));
  if (url.pathname === '/e2e/pot') return html(page(true));
  if (url.pathname === '/' || url.pathname === '/watch') return html(page(false));

  const file = path.join(ROOT, url.pathname);
  if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const type = url.pathname.endsWith('.css')
      ? 'text/css'
      : url.pathname.endsWith('.png')
        ? 'image/png'
        : 'application/javascript';
    res.writeHead(200, { 'Content-Type': type });
    res.end(fs.readFileSync(file));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const PORT = 8971;
server.listen(PORT, () => console.log('listening on http://127.0.0.1:' + PORT));
