/**
 * YouTube 实时字幕跟随 —— 隔离世界（ISOLATED）内容脚本
 *
 * 职责：
 *   1. 向页面世界索取字幕轨道列表
 *   2. 取字幕数据，两条路：
 *      a. 直连 timedtext（没启用 PO Token 的视频，快且完整）
 *      b. 直连拿到空 body 时，让播放器自己去请求对应字幕轨道，截获它的响应
 *         —— 播放器的请求自带有效 pot，这是目前唯一可靠的兜底
 *   3. 渲染浮动面板，用 requestAnimationFrame 实时高亮 + 平滑跟随滚动
 *   4. 处理划词、点击跳转、拖拽、缩放、SPA 路由切换
 */
(() => {
  'use strict';

  const TAG = 'ytt-follow';
  if (window.__yttFollowInjected) return;
  window.__yttFollowInjected = true;

  // ---------------------------------------------------------------- 状态

  const state = {
    videoId: null,
    tracks: [],
    activeCode: null,          // 播放器当前开启的字幕语言
    originalActiveCode: undefined, // 进入视频时的原始 CC 状态，用于抓取后还原
    userCode: null,            // 用户手动选择的语言（持久化）
    selectedCode: null,        // 当前加载的语言
    loadedKey: '',             // 已加载字幕的唯一键，避免重复请求
    cues: [],                  // 渲染用的列表（合并后的文本块）
    rawCues: [],               // 原始字幕行
    nodes: [],
    activeIndex: -1,
    captures: new Map(),       // lang -> Map(startMs -> cue)，累积从播放器截获的字幕
    follow: true,              // 用户是否希望自动跟随（意图）
    pausedUntil: 0,            // 手动滚动后的临时暂停截止时间戳
    hover: false,              // 鼠标是否停在面板上
    needJump: false,           // 渲染完成后需要先落位一次
    visible: true,
    showTime: true,            // 是否显示时间戳
    clickSeek: false,          // 点击字幕是否跳转视频（默认关闭，避免误触）
    search: '',                // 当前搜索关键词
    searchOpen: false,         // 搜索栏是否展开
    searchHits: [],            // 命中位置 [{ cue, start, end }]
    searchIndex: -1,           // 当前命中序号
    composing: false,          // 输入法是否正在组词
    hasTracks: false,
    video: null,
    reqId: 0,
    langSig: '',
    pos: { left: null, top: 76, width: 380, height: 0 },
    mode: 'embed',          // 'embed' 嵌入页面布局 | 'float' 浮动窗口
    embedded: null,         // 当前是否真的挂载进了页面布局
    drag: null,
    resize: null,
    suppressClick: false,
    clickTimer: 0,
  };

  const PAUSE_MS = 6000;     // 手动滚动后多久恢复跟随
  const CAPTURE_TIMEOUT = 8000; // 等待播放器返回字幕的最长时间

  // ---------------------------------------------------------------- 工具

  const $ = (sel, root = document) => root.querySelector(sel);

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const hs = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return hs ? `${hs}:${mm}:${ss}` : `${m}:${ss}`;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function waitFor(pred, timeout) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const iv = setInterval(() => {
        if (pred()) { clearInterval(iv); resolve(true); return; }
        if (performance.now() - t0 > timeout) { clearInterval(iv); resolve(false); }
      }, 150);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const store = {
    async load() {
      try {
        const d = await chrome.storage.local.get([
          'yttPos', 'yttCode', 'yttFollow', 'yttVisible', 'yttMode', 'yttShowTime', 'yttClickSeek',
        ]);
        if (d.yttPos && typeof d.yttPos === 'object') Object.assign(state.pos, d.yttPos);
        if (typeof d.yttCode === 'string') state.userCode = d.yttCode;
        if (typeof d.yttFollow === 'boolean') state.follow = d.yttFollow;
        if (typeof d.yttVisible === 'boolean') state.visible = d.yttVisible;
        if (d.yttMode === 'float' || d.yttMode === 'embed') state.mode = d.yttMode;
        if (typeof d.yttShowTime === 'boolean') state.showTime = d.yttShowTime;
        if (typeof d.yttClickSeek === 'boolean') state.clickSeek = d.yttClickSeek;
      } catch (_) {}
    },
    save(patch) {
      try { chrome.storage.local.set(patch); } catch (_) {}
    },
  };

  // ---------------------------------------------------------------- DOM

  let root, panel, head, langSel, searchBtn, searchBar, searchInput, searchCount,
    searchPrev, searchNext, searchClose, followBtn, hideBtn, modeBtn, timeBtn,
    jumpBtn, list, statusEl, grip, fab;

  function buildUI() {
    root = h('div');
    root.id = 'ytt-root';

    panel = h('div');
    panel.id = 'ytt-panel';

    head = h('div');
    head.id = 'ytt-head';
    head.appendChild(h('span', 'ytt-dot'));
    const title = h('span', null, '字幕');
    title.id = 'ytt-title';
    head.appendChild(title);

    langSel = h('select');
    langSel.id = 'ytt-lang';
    langSel.title = '选择字幕语言';

    searchBtn = h('button', 'ytt-btn ytt-icon');
    searchBtn.id = 'ytt-search-btn';
    searchBtn.type = 'button';
    searchBtn.textContent = '🔍';

    followBtn = h('button', 'ytt-btn');
    followBtn.id = 'ytt-follow';
    followBtn.type = 'button';

    hideBtn = h('button', 'ytt-btn ytt-icon');
    hideBtn.id = 'ytt-hide';
    hideBtn.type = 'button';
    hideBtn.textContent = '✕';

    modeBtn = h('button', 'ytt-btn ytt-mode');
    modeBtn.id = 'ytt-mode';
    modeBtn.type = 'button';

    timeBtn = h('button', 'ytt-btn ytt-icon');
    timeBtn.id = 'ytt-time';
    timeBtn.type = 'button';
    timeBtn.textContent = '⏱';

    jumpBtn = h('button', 'ytt-btn ytt-jump');
    jumpBtn.id = 'ytt-jump';
    jumpBtn.type = 'button';
    jumpBtn.textContent = '跳转';

    head.append(langSel, searchBtn, followBtn, jumpBtn, timeBtn, modeBtn, hideBtn);

    // 搜索栏单独一行，避免把可拖拽的顶栏挤得太满
    searchBar = h('div');
    searchBar.id = 'ytt-search';

    searchInput = h('input');
    searchInput.id = 'ytt-search-input';
    // 用 text 而不是 search：原生 search 输入框在 Esc 时会把内容清空，
    // 万一 keydown 被别的扩展先拦走，我们想保留关键词也留不住
    searchInput.type = 'text';
    searchInput.inputMode = 'search';
    searchInput.placeholder = '搜索字幕…';
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    searchInput.setAttribute('aria-label', '搜索字幕');

    searchCount = h('span', 'ytt-count');
    searchCount.id = 'ytt-search-count';

    searchPrev = h('button', 'ytt-btn ytt-icon');
    searchPrev.id = 'ytt-search-prev';
    searchPrev.type = 'button';
    searchPrev.textContent = '↑';
    searchPrev.title = '上一个匹配（Shift+Enter）';

    searchNext = h('button', 'ytt-btn ytt-icon');
    searchNext.id = 'ytt-search-next';
    searchNext.type = 'button';
    searchNext.textContent = '↓';
    searchNext.title = '下一个匹配（Enter）';

    searchClose = h('button', 'ytt-btn ytt-icon');
    searchClose.id = 'ytt-search-close';
    searchClose.type = 'button';
    searchClose.textContent = '✕';
    searchClose.title = '关闭搜索';

    searchBar.append(searchInput, searchCount, searchPrev, searchNext, searchClose);

    list = h('div');
    list.id = 'ytt-list';

    statusEl = h('div', 'ytt-status');
    statusEl.id = 'ytt-status';

    grip = h('div');
    grip.id = 'ytt-grip';
    grip.title = '拖动右下角调整大小';

    panel.append(head, searchBar, list, statusEl, grip);

    fab = h('button');
    fab.id = 'ytt-fab';
    fab.type = 'button';
    fab.title = '显示字幕面板';
    fab.textContent = 'CC';

    root.append(panel, fab);
    document.body.appendChild(root);

    // 事件绑定
    head.addEventListener('pointerdown', onDragStart);
    grip.addEventListener('pointerdown', onResizeStart);
    hideBtn.addEventListener('click', () => setVisible(false, true));
    fab.addEventListener('click', () => setVisible(true, true));
    followBtn.addEventListener('click', () => setFollow(!state.follow, true));
    modeBtn.addEventListener('click', () => {
      state.mode = state.mode === 'embed' ? 'float' : 'embed';
      store.save({ yttMode: state.mode });
      refreshMount();
      syncModeBtn(); // 万一没有可嵌入的容器（状态没变），也要把按钮文字刷新过来
    });
    timeBtn.addEventListener('click', () => {
      state.showTime = !state.showTime;
      store.save({ yttShowTime: state.showTime });
      applyShowTime();
    });
    jumpBtn.addEventListener('click', () => {
      state.clickSeek = !state.clickSeek;
      store.save({ yttClickSeek: state.clickSeek });
      applyClickSeek();
    });
    langSel.addEventListener('change', () => {
      state.userCode = langSel.value || null;
      store.save({ yttCode: state.userCode });
      loadCaptions(state.userCode);
    });

    searchBtn.addEventListener('click', () => setSearchOpen(!state.searchOpen));
    searchClose.addEventListener('click', () => setSearchOpen(false));
    searchPrev.addEventListener('click', () => moveSearch(-1));
    searchNext.addEventListener('click', () => moveSearch(1));
    searchInput.addEventListener('input', (e) => {
      if (state.composing || e.isComposing) return; // 中文输入法组词中先不跳
      applySearch(true);
    });
    searchInput.addEventListener('compositionstart', () => { state.composing = true; });
    searchInput.addEventListener('compositionend', () => {
      state.composing = false;
      applySearch(true);
    });
    searchInput.addEventListener('keydown', onSearchKeyDown);

    // 划词保护：mousedown 时若已有选区，则这一次点击不当作跳转
    list.addEventListener('mousedown', () => {
      const sel = window.getSelection();
      state.suppressClick = !!(sel && sel.toString().trim());
    });
    list.addEventListener('dblclick', () => {
      clearTimeout(state.clickTimer);
      state.clickTimer = 0;
    });
    list.addEventListener('click', onListClick);
    list.addEventListener('wheel', onUserScroll, { passive: true });
    list.addEventListener('touchstart', onUserScroll, { passive: true });
    list.addEventListener('touchmove', onUserScroll, { passive: true });
    list.addEventListener('keydown', onUserScroll);

    window.addEventListener('resize', keepInViewport);

    // 鼠标停在面板上就暂停跟随，方便回头精读 / 取词
    panel.addEventListener('mouseenter', () => { state.hover = true; });
    panel.addEventListener('mouseleave', () => { state.hover = false; });

    syncFollowBtn();
    syncModeBtn();
    syncSearchBtn();
    updateSearchCount();
    applyShowTime();
    applyClickSeek();
    refreshMount();
    applyVisibility();
  }

  function applyClickSeek() {
    root.classList.toggle('no-jump', !state.clickSeek);
    if (jumpBtn) {
      jumpBtn.classList.toggle('ytt-on', state.clickSeek);
      jumpBtn.title = state.clickSeek
        ? '点击字幕会跳转视频，点击关闭（关闭后可以随意划词复制）'
        : '点击字幕不会跳转视频，点击开启跳转';
    }
  }

  function applyShowTime() {
    root.classList.toggle('no-time', !state.showTime);
    if (timeBtn) {
      timeBtn.classList.toggle('ytt-on', state.showTime);
      timeBtn.title = state.showTime ? '隐藏时间戳' : '显示时间戳';
    }
  }

  // ---------------------------------------------------------------- 字幕搜索

  function setSearchOpen(open) {
    state.searchOpen = !!open;
    root.classList.toggle('search-open', state.searchOpen);
    syncSearchBtn();

    if (state.searchOpen) {
      searchInput.focus();
      searchInput.select();
      // 关键词会保留，重新打开时继续按上次的词搜索
      if (searchInput.value.trim()) applySearch(true);
      return;
    }

    // 关闭只退出搜索状态，不清空输入框里的关键词；然后回到当前播放位置
    state.composing = false;
    clearAppliedSearch();
    searchInput.blur();
    if (state.cues.length) state.needJump = true;
  }

  /** 退出搜索状态：保留输入框内容，只清除高亮和命中，恢复自动跟随 */
  function clearAppliedSearch() {
    state.search = '';
    state.searchHits = [];
    state.searchIndex = -1;
    paintSearchText();
    updateSearchCount();
    syncSearchBtn();
  }

  function syncSearchBtn() {
    if (!searchBtn) return;
    searchBtn.classList.toggle('ytt-on', state.searchOpen || !!state.search);
    searchBtn.title = state.searchOpen ? '关闭字幕搜索' : '搜索字幕';
  }

  function onSearchKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      moveSearch(e.shiftKey ? -1 : 1);
    }
  }

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** 重新计算命中位置，并重绘所有文本块里的高亮 */
  function applySearch(scrollToFirst) {
    if (!searchInput) return;

    state.search = searchInput.value.trim();
    state.searchHits = [];
    state.searchIndex = -1;

    if (state.search) {
      // 直接在原文上做不区分大小写的匹配：正则给出的下标天然对应原文。
      // 不能先 toLowerCase() 再 indexOf —— 有些字符转小写后长度会变（如 İ），
      // 用转换后的下标去切原文就会错位。
      const re = new RegExp(escapeRegExp(state.search), 'gi');
      state.cues.forEach((c, cueIndex) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(c.text))) {
          state.searchHits.push({ cue: cueIndex, start: m.index, end: m.index + m[0].length });
        }
      });
    }

    paintSearchText();

    if (state.searchHits.length) {
      state.searchIndex = 0;
      paintCurrentHit();
      if (scrollToFirst) centerOn(state.searchHits[0].cue);
    }
    updateSearchCount();
    syncSearchBtn();
  }

  /** 按当前关键词重建每个 .ytt-text 的内容（命中处用 <mark> 包起来） */
  function paintSearchText() {
    const query = state.search;
    const byCue = new Map();
    if (query) {
      state.searchHits.forEach((hit, index) => {
        if (!byCue.has(hit.cue)) byCue.set(hit.cue, []);
        byCue.get(hit.cue).push(Object.assign({ index }, hit));
      });
    }

    state.cues.forEach((c, cueIndex) => {
      const node = state.nodes[cueIndex];
      const span = node && node.querySelector('.ytt-text');
      if (!span) return;

      const hits = byCue.get(cueIndex);
      if (!query || !hits) {
        span.textContent = c.text;
        return;
      }

      span.textContent = '';
      let from = 0;
      for (const hit of hits) {
        if (hit.start > from) span.appendChild(document.createTextNode(c.text.slice(from, hit.start)));
        const mark = document.createElement('mark');
        mark.className = 'ytt-mark';
        mark.dataset.hit = String(hit.index);
        mark.textContent = c.text.slice(hit.start, hit.end);
        if (hit.index === state.searchIndex) mark.classList.add('is-current');
        span.appendChild(mark);
        from = hit.end;
      }
      if (from < c.text.length) span.appendChild(document.createTextNode(c.text.slice(from)));
    });
  }

  function paintCurrentHit() {
    list.querySelectorAll('mark[data-hit]').forEach((mark) => {
      mark.classList.toggle('is-current', Number(mark.dataset.hit) === state.searchIndex);
    });
  }

  function moveSearch(dir) {
    const n = state.searchHits.length;
    if (!n) return;
    state.searchIndex = (state.searchIndex + dir + n) % n;
    paintCurrentHit();
    updateSearchCount();
    // 搜索期间不自动跟随，这里负责把当前命中滚到视野中间
    centerOn(state.searchHits[state.searchIndex].cue);
  }

  function updateSearchCount() {
    if (!searchCount) return;
    const n = state.searchHits.length;
    if (!state.search) {
      searchCount.textContent = '';
      searchCount.title = '';
    } else if (!n) {
      searchCount.textContent = '无匹配';
      searchCount.title = '没有找到匹配的字幕';
    } else {
      searchCount.textContent = `${state.searchIndex + 1}/${n}`;
      searchCount.title = `共 ${n} 处匹配，Enter 下一个，Shift+Enter 上一个`;
    }
    const empty = !n;
    if (searchPrev) searchPrev.disabled = empty;
    if (searchNext) searchNext.disabled = empty;
  }

  // ------------------------------------------------- 挂载方式：嵌入页面 / 浮动窗口

  // YouTube 右侧栏（相关视频上方）→ 次选二级栏 → 再退到主栏下方
  const EMBED_TARGETS = ['#secondary-inner', '#secondary', '#primary-inner', '#primary'];

  function findEmbedTarget() {
    for (const sel of EMBED_TARGETS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /**
   * 把 root 挂到目标容器里。root 是 display:contents，本身不产生盒子，
   * 所以面板会成为目标容器的直接子元素，自然融入页面布局。
   * YouTube 是 SPA，会重建这段 DOM，所以要定期重挂。
   */
  function refreshMount() {
    const target = state.mode === 'embed' ? findEmbedTarget() : null;
    if (target) {
      if (root.parentElement !== target) target.prepend(root);
    } else if (root.parentElement !== document.body) {
      document.body.appendChild(root);
    }
    const changed = !!target !== state.embedded;
    state.embedded = !!target;
    root.classList.toggle('is-embed', state.embedded);
    if (state.embedded) observePlayer();
    if (changed) {
      applyLayout();
      syncModeBtn();
    }
  }

  function applyLayout() {
    if (state.embedded) {
      // 嵌入模式：位置交给页面流，高度对齐播放窗口
      panel.style.left = '';
      panel.style.top = '';
      panel.style.width = '';
      const h = playerBox();
      panel.style.height = (h > 140 ? Math.round(h) : 480) + 'px';
    } else {
      panel.style.height = '';
      applyPosition();
    }
  }

  /** 播放器区域（含控制栏）的高度，用来让字幕面板和它一样高 */
  function playerBox() {
    const p = document.querySelector('#movie_player') || document.querySelector('ytd-player');
    if (!p) return 0;
    return p.getBoundingClientRect().height;
  }

  // 播放器尺寸会随窗口 / 影院模式变化，用 ResizeObserver 跟住
  let playerRO = null;
  let observedPlayer = null;

  function observePlayer() {
    if (!window.ResizeObserver) return;
    const p = document.querySelector('#movie_player') || document.querySelector('ytd-player');
    if (!p || p === observedPlayer) return;
    if (playerRO) playerRO.disconnect();
    observedPlayer = p;
    playerRO = new ResizeObserver(() => {
      if (state.embedded) applyLayout();
    });
    playerRO.observe(p);
  }

  function syncModeBtn() {
    if (!modeBtn) return;
    // 按钮显示「点击后会发生什么」而不是当前状态：
    // 当前是嵌入 → 显示「浮窗」；当前是浮窗 → 显示「嵌入」
    // 用实际挂载状态而不是用户意图，避免文字和眼前看到的对不上
    const embedded = !!state.embedded;
    modeBtn.textContent = embedded ? '浮窗' : '嵌入';
    modeBtn.title = embedded
      ? '当前嵌在页面里，点击切换为浮动窗口'
      : '当前是浮动窗口，点击嵌回页面布局';
    if (hideBtn) {
      hideBtn.title = embedded
        ? '隐藏面板（点扩展图标可重新显示）'
        : '隐藏面板（右下角按钮可重新打开）';
    }
  }

  // ---------------------------------------------------------------- 面板位置

  function applyPosition() {
    const p = state.pos;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = clamp(p.width || 380, 240, vw - 24);
    const height = p.height ? clamp(p.height, 160, vh - 24) : Math.min(vh * 0.7, 720);

    // 默认贴右侧
    let left = p.left == null ? vw - width - 16 : p.left;
    let top = p.top == null ? 76 : p.top;

    left = clamp(left, 8, Math.max(8, vw - width - 8));
    top = clamp(top, 8, Math.max(8, vh - height - 8));

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.width = width + 'px';
    panel.style.height = height + 'px';

    state.pos.left = left;
    state.pos.top = top;
    state.pos.width = width;
    state.pos.height = height;
  }

  function keepInViewport() {
    if (!panel) return;
    applyLayout();
  }

  function onDragStart(e) {
    if (e.button !== 0) return;
    if (state.embedded) return; // 嵌入模式下位置由页面布局决定
    if (e.target.closest('button, select')) return;
    const rect = panel.getBoundingClientRect();
    state.drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    head.setPointerCapture(e.pointerId);
    head.addEventListener('pointermove', onDragMove);
    head.addEventListener('pointerup', onDragEnd);
    head.addEventListener('pointercancel', onDragEnd);
    e.preventDefault();
  }

  function onDragMove(e) {
    const d = state.drag;
    if (!d) return;
    const rect = panel.getBoundingClientRect();
    const left = clamp(e.clientX - d.dx, 8, window.innerWidth - rect.width - 8);
    const top = clamp(e.clientY - d.dy, 8, window.innerHeight - rect.height - 8);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    state.pos.left = left;
    state.pos.top = top;
  }

  function onDragEnd() {
    head.removeEventListener('pointermove', onDragMove);
    head.removeEventListener('pointerup', onDragEnd);
    head.removeEventListener('pointercancel', onDragEnd);
    state.drag = null;
    store.save({ yttPos: { ...state.pos } });
  }

  function onResizeStart(e) {
    if (e.button !== 0) return;
    if (state.embedded) return; // 嵌入模式高度对齐播放器，不手动调
    const rect = panel.getBoundingClientRect();
    state.resize = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    grip.setPointerCapture(e.pointerId);
    grip.addEventListener('pointermove', onResizeMove);
    grip.addEventListener('pointerup', onResizeEnd);
    grip.addEventListener('pointercancel', onResizeEnd);
    e.preventDefault();
    e.stopPropagation();
  }

  function onResizeMove(e) {
    const r = state.resize;
    if (!r) return;
    const w = clamp(r.w + (e.clientX - r.x), 240, window.innerWidth - state.pos.left - 8);
    const hgt = clamp(r.h + (e.clientY - r.y), 160, window.innerHeight - state.pos.top - 8);
    panel.style.width = w + 'px';
    panel.style.height = hgt + 'px';
    state.pos.width = w;
    state.pos.height = hgt;
  }

  function onResizeEnd() {
    grip.removeEventListener('pointermove', onResizeMove);
    grip.removeEventListener('pointerup', onResizeEnd);
    grip.removeEventListener('pointercancel', onResizeEnd);
    state.resize = null;
    store.save({ yttPos: { ...state.pos } });
  }

  // ---------------------------------------------------------------- 可见性 / 跟随

  function setVisible(v, persist) {
    state.visible = v;
    applyVisibility();
    if (persist) store.save({ yttVisible: v });
  }

  function applyVisibility() {
    root.classList.toggle('is-hidden', !state.visible);
    root.classList.toggle('no-tracks', !state.hasTracks);
  }

  function setFollow(v, persist) {
    state.follow = v;
    if (v) state.pausedUntil = 0;
    syncFollowBtn();
    if (persist) store.save({ yttFollow: v });
  }

  /** 用户意图上是否在跟随（只看开关和手动滚动造成的临时暂停） */
  function intentFollowing() {
    return state.follow && performance.now() >= state.pausedUntil;
  }

  /** 面板里有非空选区（正在划词） */
  function hasPanelSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    let node = sel.getRangeAt(0).commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    return !!(node && panel.contains(node));
  }

  /** 实际是否在自动滚动：意图 + 没被“正在阅读”打断 */
  function isFollowing() {
    if (!intentFollowing()) return false;
    if (state.search) return false;         // 正在搜索：让用户停在命中位置
    if (state.hover) return false;          // 鼠标停在面板上
    if (hasPanelSelection()) return false;  // 正在划词
    return true;
  }

  function syncFollowBtn() {
    if (!followBtn) return;
    // 注意：按钮反映的是用户意图，不含「悬停/划词」造成的临时暂停，
    // 否则鼠标停在面板上时按钮会显示「已暂停」，点它反而永远点不亮
    const on = intentFollowing();
    followBtn.textContent = on ? '跟随中' : '已暂停';
    followBtn.classList.toggle('ytt-on', on);
    followBtn.title = state.follow
      ? '自动跟随当前字幕（手动滚动、鼠标停在面板上、或正在划词时会临时暂停，之后自动恢复）'
      : '已关闭自动跟随，点击重新开启';
  }

  function onUserScroll() {
    if (!state.follow) return;
    state.pausedUntil = performance.now() + PAUSE_MS;
    syncFollowBtn();
    clearTimeout(onUserScroll._t);
    onUserScroll._t = setTimeout(() => {
      state.pausedUntil = 0;
      syncFollowBtn();
    }, PAUSE_MS + 50);
  }

  // ---------------------------------------------------------------- 与页面世界通信

  function post(type, extra) {
    window.postMessage(Object.assign({ source: TAG, type }, extra), '*');
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.source !== TAG) return;
    if (m.type === 'tracks') onTracks(m.payload);
    else if (m.type === 'caption-data') onCaptionData(m.payload);
    else if (m.type === 'close-search') setSearchOpen(false);
  });

  // ---------------------------------------------------------------- 轨道处理

  function onTracks(p) {
    if (!p || !Array.isArray(p.tracks)) return;

    if (p.videoId && p.videoId !== state.videoId) {
      state.videoId = p.videoId;
      state.originalActiveCode = undefined;
      state.captures = new Map();
      resetCues();
      state.loadedKey = '';
      state.langSig = '';
    }
    state.tracks = p.tracks;
    state.activeCode = p.activeCode || null;
    // 记住进入视频时用户自己的 CC 状态，抓取完要还原回去
    if (state.originalActiveCode === undefined) state.originalActiveCode = state.activeCode;
    state.hasTracks = p.tracks.length > 0;
    applyVisibility();

    if (!p.tracks.length) {
      setStatus('该视频没有可用字幕');
      return;
    }

    buildLangOptions();

    const code = pickCode();
    const key = `${state.videoId}||${code}`;
    if (code && key !== state.loadedKey) {
      loadCaptions(code);
    }
  }

  function pickCode() {
    const t = state.tracks;
    if (!t.length) return null;
    if (state.userCode && t.some((x) => x.languageCode === state.userCode)) return state.userCode;
    if (state.activeCode && t.some((x) => x.languageCode === state.activeCode)) return state.activeCode;
    const manual = t.find((x) => x.kind !== 'asr');
    return (manual || t[0]).languageCode;
  }

  function buildLangOptions() {
    const sig = state.tracks.map((t) => t.languageCode + ':' + t.kind + ':' + t.name).join(',');
    if (sig === state.langSig) return;
    state.langSig = sig;

    langSel.textContent = '';
    for (const t of state.tracks) {
      const opt = h('option');
      opt.value = t.languageCode;
      const auto = t.kind === 'asr' ? '（自动）' : '';
      opt.textContent = `${t.name}${auto}`;
      langSel.appendChild(opt);
    }
    const code = pickCode();
    if (code) langSel.value = code;
  }

  function resetCues() {
    state.cues = [];
    state.nodes = [];
    state.activeIndex = -1;
    state.searchHits = [];
    state.searchIndex = -1;
    list.textContent = '';
    updateSearchCount();
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  // ---------------------------------------------------------------- 字幕解析

  /** 合并自动字幕的滚动窗口：后一条是前一条的延长 */
  function cleanup(cues) {
    const out = [];
    for (const c of cues) {
      const prev = out[out.length - 1];
      if (prev) {
        if (c.text === prev.text) { prev.end = Math.max(prev.end, c.end); continue; }
        const contiguous = c.start <= prev.end + 0.4;
        if (contiguous && c.text.startsWith(prev.text)) { prev.text = c.text; prev.end = Math.max(prev.end, c.end); continue; }
        if (contiguous && prev.text.startsWith(c.text)) { prev.end = Math.max(prev.end, c.end); continue; }
      }
      out.push(c);
    }
    return out;
  }

  function parseJsonText(txt) {
    let data;
    try { data = JSON.parse(txt); } catch (_) { return null; }
    const cues = [];
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const start = (ev.tStartMs || 0) / 1000;
      const end = ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000;
      cues.push({ start, end: Math.max(end, start + 0.2), text });
    }
    return cleanup(cues);
  }

  function parseXmlText(txt) {
    let doc;
    try { doc = new DOMParser().parseFromString(txt, 'text/xml'); } catch (_) { return null; }
    if (!doc || doc.querySelector('parsererror')) return null;
    const cues = [];

    // srv3: <p t="ms" d="ms"><s>词</s>...</p>
    const ps = doc.querySelectorAll('p[t]');
    if (ps.length) {
      for (const p of ps) {
        const t = Number(p.getAttribute('t')) || 0;
        const d = Number(p.getAttribute('d')) || 0;
        const text = p.textContent.replace(/\s+/g, ' ').trim();
        if (text) cues.push({ start: t / 1000, end: Math.max((t + d) / 1000, t / 1000 + 0.2), text });
      }
      return cleanup(cues);
    }

    // srv1: <text start="s" dur="s">
    for (const n of doc.querySelectorAll('text')) {
      const t = Number(n.getAttribute('start')) || 0;
      const d = Number(n.getAttribute('dur')) || 0;
      const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) cues.push({ start: t, end: Math.max(t + d, t + 0.2), text });
    }
    return cleanup(cues);
  }

  function parseCaptionText(txt) {
    const t = (txt || '').trim();
    if (!t) return null;
    if (t[0] === '{' || t[0] === '[') {
      const j = parseJsonText(t);
      if (j && j.length) return j;
    }
    return parseXmlText(t);
  }

  // ---------------------------------------------------------------- 文本分块

  const BLOCK_MIN = 10;    // 一个文本块最短时长（秒）
  const BLOCK_MAX = 20;    // 一个文本块最长时长（秒）
  const PAUSE_BREAK = 2.0; // 停顿超过这么久也算一个段落边界

  const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

  const endsSentence = (t) => /[.!?。！？…:：;；]["'”’)\]）】»]?\s*$/.test(t);

  function joinText(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (/\s$/.test(a) || /^\s/.test(b)) return (a + b).trim();
    // 中日韩文本之间不加空格
    if (CJK.test(a.slice(-1)) && CJK.test(b[0])) return a + b;
    return a + ' ' + b;
  }

  /**
   * 把逐条字幕合并成按句子分段的文本块（约 10~20 秒一块）。
   *
   * 断句优先级：
   *   1. 块够长了（>= BLOCK_MIN）且正好落在句末 → 断开
   *   2. 块够长了且遇到明显停顿（>= PAUSE_BREAK）→ 也断开（当作段落边界）
   *   3. 到 BLOCK_MAX 还没等到上面两种机会 → 回退到窗口内**停顿最大**的位置断开
   *
   * 第 3 条很关键：自动字幕（尤其中文）经常完全没有标点，单句又可能很长，
   * 这时如果傻乎乎地切在「正好第 20 秒」那个 cue 上，就会看起来像从句子中间
   * 随机切断。改成挑最大的停顿，观感会自然很多。
   */
  function buildBlocks(cues) {
    if (!cues.length) return [];
    const out = [];
    let from = 0;
    let bestCut = -1;  // 窗口内最大停顿所在的下标（新块从这里开始）
    let bestGap = 0;

    const flush = (to) => {
      let text = cues[from].text;
      for (let i = from + 1; i <= to; i++) text = joinText(text, cues[i].text);
      out.push({ start: cues[from].start, end: cues[to].end, text, lines: to - from + 1 });
    };

    for (let i = 1; i < cues.length; i++) {
      const prev = cues[i - 1];
      const cur = cues[i];
      const dur = prev.end - cues[from].start;
      const gap = cur.start - prev.end;

      if (dur >= BLOCK_MIN) {
        if (gap > bestGap) { bestGap = gap; bestCut = i; }

        if (endsSentence(prev.text) || gap >= PAUSE_BREAK) {
          flush(i - 1);
          from = i;
          bestCut = -1;
          bestGap = 0;
          continue;
        }
      }

      if (dur >= BLOCK_MAX) {
        const cut = bestCut > from ? bestCut : i;
        flush(cut - 1);
        from = cut;
        bestCut = -1;
        bestGap = 0;
      }
    }

    flush(cues.length - 1);
    return out;
  }

  function langFromUrl(url) {
    try { return new URL(url, location.origin).searchParams.get('lang'); } catch (_) { return null; }
  }

  function langMatches(urlLang, code) {
    if (!urlLang || !code) return true;
    const a = urlLang.toLowerCase();
    const b = code.toLowerCase();
    return a === b || a.startsWith(b + '-') || b.startsWith(a + '-');
  }

  // ---------------------------------------------------------------- 字幕抓取

  async function loadCaptions(code) {
    const track = state.tracks.find((t) => t.languageCode === code);
    if (!track || !track.baseUrl) return;

    state.loadedKey = `${state.videoId}||${code}`;
    state.selectedCode = code;
    const id = ++state.reqId;
    if (langSel.value !== code) langSel.value = code;

    // 之前可能已经通过播放器被动截获过这个语言的字幕
    refreshFromCaptures();
    renderCues();
    if (state.cues.length) setStatus(`${state.cues.length} 段`);

    // 路径 1：直连 timedtext。baseUrl 带 exp=xpe 的必然返回空 body，直接跳过
    if (!track.needsPot) {
      setStatus('正在获取字幕…');
      try {
        const cues = await fetchTimedText(track.baseUrl);
        if (id !== state.reqId) return;
        if (cues && cues.length) {
          mergeCues(code, cues);
          refreshFromCaptures();
          renderCues();
          setStatus(`${state.cues.length} 段`);
          return;
        }
      } catch (_) {
        if (id !== state.reqId) return;
      }
    }

    // 可能已经通过播放器被动截获过这个语言的字幕了
    if (state.cues.length) {
      setStatus(`${state.cues.length} 段`);
      return;
    }

    // 路径 2：让播放器自己去请求，截获它的响应（自带有效 pot）
    await captureViaPlayer(track, id);
  }

  async function fetchTimedText(baseUrl) {
    const viaJson = await fetchAs(baseUrl, 'json3');
    if (viaJson) {
      const cues = parseJsonText(viaJson);
      if (cues && cues.length) return cues;
    }
    const viaXml = await fetchAs(baseUrl, null);
    if (viaXml) {
      const cues = parseXmlText(viaXml);
      if (cues && cues.length) return cues;
    }
    return null;
  }

  async function fetchAs(baseUrl, fmt) {
    try {
      const u = new URL(baseUrl, location.origin);
      if (fmt) u.searchParams.set('fmt', fmt);
      else u.searchParams.delete('fmt');
      const res = await fetch(u.toString(), { credentials: 'include' });
      if (!res.ok) return null;
      const txt = await res.text();
      return txt.trim() ? txt : null;
    } catch (_) {
      return null;
    }
  }

  /** 打开播放器的对应字幕轨道，触发它自己去请求，然后等我们 hook 到的数据 */
  async function captureViaPlayer(track, id) {
    const before = state.cues.length;
    setStatus('正在通过播放器获取字幕…');

    post('set-captions', { track: { languageCode: track.languageCode, kind: track.kind, vssId: track.vssId } });

    const got = await waitFor(() => state.cues.length > before, CAPTURE_TIMEOUT);
    if (id !== state.reqId) return;

    if (got) {
      renderCues();
      setStatus(`${state.cues.length} 段（通过播放器获取）`);
    } else if (state.cues.length) {
      renderCues();
      setStatus(`${state.cues.length} 段（可能不完整）`);
    } else {
      resetCues();
      setStatus('没拿到字幕数据：请确认该视频有字幕，或手动打开 CC 后重试');
    }

    // 稍等一下再还原用户原本的 CC 状态，避免打断正在进行的请求
    await sleep(got ? 2500 : 500);
    if (id !== state.reqId) return;
    restorePlayerCaptions();
  }

  function restorePlayerCaptions() {
    const code = state.originalActiveCode;
    if (code && code === state.selectedCode) return; // 本来就是开着的，不用动
    post('set-captions', { track: code ? { languageCode: code } : null });
  }

  function captureMap(lang) {
    if (!state.captures.has(lang)) state.captures.set(lang, new Map());
    return state.captures.get(lang);
  }

  function mergeCues(lang, cues) {
    const map = captureMap(lang);
    let added = 0;
    for (const c of cues) {
      const k = Math.round(c.start * 1000);
      if (!map.has(k)) { map.set(k, c); added++; }
    }
    return added;
  }

  /** 把已截获的所有匹配当前语言的字幕合并成有序列表，再按句子分块 */
  function refreshFromCaptures() {
    const code = state.selectedCode;
    const byStart = new Map();
    for (const [key, map] of state.captures) {
      if (code && !langMatches(key, code)) continue;
      for (const [k, c] of map) if (!byStart.has(k)) byStart.set(k, c);
    }
    state.rawCues = [...byStart.values()].sort((a, b) => a.start - b.start);
    state.cues = buildBlocks(state.rawCues);
  }

  /** 页面世界截获到的 timedtext 响应 */
  function onCaptionData(payload) {
    if (!payload || !payload.text) return;
    const lang = langFromUrl(payload.url);
    const target = state.selectedCode;
    if (!langMatches(lang, target)) return;

    const cues = parseCaptionText(payload.text);
    if (!cues || !cues.length) return;
    if (!mergeCues(lang || target || 'unknown', cues)) return;

    refreshFromCaptures();
    renderCues();
    setStatus(`${state.cues.length} 段`);
  }

  // ---------------------------------------------------------------- 渲染

  function renderCues() {
    const wasEmpty = state.nodes.length === 0;
    list.textContent = '';
    state.nodes = [];
    const frag = document.createDocumentFragment();
    state.cues.forEach((c, i) => {
      const node = h('div', 'ytt-cue');
      node.dataset.i = String(i);
      node.append(h('span', 'ytt-time', fmtTime(c.start)), h('span', 'ytt-text', c.text));
      frag.appendChild(node);
      state.nodes.push(node);
    });
    list.appendChild(frag);

    // 重建后立刻定位到当前时间，但不要强行滚动（交给跟随循环）
    state.activeIndex = -1;
    const v = state.video;
    if (v && state.cues.length) setActive(findCue(v.currentTime), true);
    // 列表原本是空的（首次加载 / 换语言）→ 至少落位一次；只是增量补数据就不动，
    // 免得把正在回头精读的用户拽走
    if (wasEmpty) state.needJump = true;

    // 重新渲染后保留搜索高亮（增量补字幕、切换语言时都适用）
    if (state.search) applySearch(false);
  }

  function setActive(idx, force) {
    if (idx === state.activeIndex && !force) return;
    const prev = state.nodes[state.activeIndex];
    if (prev) prev.classList.remove('is-active');
    state.activeIndex = idx;
    const cur = state.nodes[idx];
    if (cur) {
      cur.classList.add('is-active');
      if (state.video) setStatus(`${fmtTime(state.video.currentTime)} · 第 ${idx + 1}/${state.cues.length} 段`);
    }
  }

  function findCue(t) {
    const c = state.cues;
    let lo = 0;
    let hi = c.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].start <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  // ---------------------------------------------------------------- 点击跳转

  function onListClick(e) {
    // 点击跳转默认关闭：关闭状态下点字幕只当普通文本处理，随便划词复制
    if (!state.clickSeek) return;
    const cue = e.target.closest('.ytt-cue');
    if (!cue) return;
    if (state.suppressClick) { state.suppressClick = false; return; }
    const i = Number(cue.dataset.i);
    if (!Number.isFinite(i)) return;

    // 延迟一点再跳转，给「双击选词」留出取消的机会
    clearTimeout(state.clickTimer);
    state.clickTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (sel && sel.toString().trim()) return;
      seekTo(i);
    }, 180);
  }

  function seekTo(i) {
    const v = state.video;
    const cue = state.cues[i];
    if (!v || !cue) return;
    try { v.currentTime = cue.start + 0.01; } catch (_) {}
    setActive(i, true);
    state.pausedUntil = 0;
    syncFollowBtn();
    centerOn(i);
  }

  // ---------------------------------------------------------------- 主循环

  function pickVideo() {
    const v = $('#movie_player video.html5-main-video') || document.querySelector('video');
    return v && v.tagName === 'VIDEO' ? v : null;
  }

  function scrollTarget(node) {
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    return clamp(node.offsetTop - list.clientHeight / 2 + node.offsetHeight / 2, 0, max);
  }

  function centerOn(idx) {
    const node = state.nodes[idx];
    if (!node || !list.clientHeight) return;
    list.scrollTop = scrollTarget(node);
  }

  function tick() {
    requestAnimationFrame(tick);

    let v = state.video;
    if (!v || !v.isConnected) {
      v = pickVideo();
      state.video = v;
    }
    if (!v || !state.cues.length) return;

    const idx = findCue(v.currentTime);
    if (idx !== state.activeIndex) setActive(idx);

    if (!state.visible || !list.clientHeight) return;

    // 首次渲染后先落位一次（此时可能因为鼠标悬停而不处于跟随状态）
    // 搜索期间不要抢走用户正在查看的命中位置
    if (!state.search && state.needJump && state.nodes[state.activeIndex]) {
      centerOn(state.activeIndex);
      state.needJump = false;
    }

    if (!isFollowing()) return;

    const node = state.nodes[idx];
    if (!node) return;
    const target = scrollTarget(node);
    const cur = list.scrollTop;
    const diff = target - cur;
    if (Math.abs(diff) < 0.5) return;
    // 跳转幅度很大时直接落位，避免长距离动画
    if (Math.abs(diff) > list.clientHeight * 1.5) list.scrollTop = target;
    else list.scrollTop = cur + diff * 0.18;
  }

  // ---------------------------------------------------------------- 生命周期

  function resetForNewVideo() {
    state.videoId = null;
    state.loadedKey = '';
    state.langSig = '';
    state.tracks = [];
    state.activeCode = null;
    state.originalActiveCode = undefined;
    state.selectedCode = null;
    state.captures = new Map();
    state.hasTracks = false;
    state.video = null;
    // 换视频时收起搜索，避免旧关键词把新视频的自动跟随一直憋着
    if (state.searchOpen || state.search) setSearchOpen(false);
    resetCues();
    applyVisibility();
    setStatus('等待字幕信息…');
  }

  function currentVideoId() {
    const fromQuery = new URLSearchParams(location.search).get('v');
    if (fromQuery) return fromQuery;
    const m = location.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : null;
  }

  function onNavigate() {
    const id = currentVideoId();
    // 同一个视频的页面数据更新不要重置，否则会反复重新拉取字幕
    if (id && id === state.videoId) {
      refreshMount();
      return;
    }
    resetForNewVideo();
    refreshMount();
    scheduleRequests();
  }

  let requestTimers = [];
  function scheduleRequests() {
    requestTimers.forEach(clearTimeout);
    requestTimers = [];
    [0, 400, 1200, 2600, 5000].forEach((ms) => {
      requestTimers.push(setTimeout(() => post('request-tracks', { reason: 'retry' }), ms));
    });
  }

  async function init() {
    await store.load();
    buildUI();

    document.addEventListener('yt-navigate-finish', onNavigate);
    document.addEventListener('yt-page-data-updated', onNavigate);

    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'ytt-toggle') setVisible(!state.visible, true);
      });
    } catch (_) {}

    scheduleRequests();
    requestAnimationFrame(tick);
    // YouTube 是 SPA，会重建右侧栏的 DOM，定期确认面板还挂在页面上
    setInterval(refreshMount, 1000);
  }

  const ready = () =>
    new Promise((res) => {
      if (document.body) return res();
      document.addEventListener('DOMContentLoaded', () => res(), { once: true });
    });

  ready().then(init);
})();
