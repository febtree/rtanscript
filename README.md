# YouTube 实时字幕跟随

> 名字的来历：**rt** = realtime，**anscript** 取自 transcript —— 实时 + transcript = **rtanscript**。
> 不是拼写错误 🙂

一个 Chrome 扩展（Manifest V3）：把 YouTube 字幕做成一栏**可滚动的文稿**，实时高亮并平滑跟随当前播放位置；字幕可以自由**划选复制**（方便取词翻译），点击某一行可跳转到对应时间。

## 功能

- **两种挂载方式**
  - **嵌入页面**（默认）：像 YouTube 自带的文稿那样插进右侧栏（相关视频上方），跟随页面布局，**高度自动对齐播放窗口**（ResizeObserver 跟住窗口缩放和影院模式切换）。
  - **浮窗**：可拖动、可缩放的浮动面板，默认贴右侧。
  - 顶栏右侧的模式按钮显示的是**点击后会切换到的目标**：当前嵌在页面里时按钮显示「浮窗」，当前是浮窗时显示「嵌入」—— 一眼就知道点下去会变成什么。选择会被记住。YouTube 是 SPA、会重建右侧栏 DOM，扩展每秒确认一次并自动重挂。
- **按句子分段的文本块**：不是两三秒一行的碎片，而是把连续字幕合并成**约 10~20 秒一段**的完整段落。断句优先级：
  1. 块够长了（≥10s）且正好落在句末（`.` `。` `！` `？` 等）→ 在这里断开
  2. 块够长了且遇到明显停顿（≥2s）→ 也断开（当作段落边界）
  3. 到 20 秒还没等到上面两种机会 → **回退到窗口内停顿最大的位置**断开

  第 3 条是给自动字幕准备的：中文 ASR 经常**完全没有标点**，单句又可能超过 20 秒，这时如果硬切在第 20 秒那个 cue 上，就会看起来像从句子中间随机断开；挑最大的停顿切，观感自然得多。
  中英文混排时中文之间不会插入多余空格。粒度想调就改 `src/content.js` 里的 `BLOCK_MIN` / `BLOCK_MAX` / `PAUSE_BREAK`。
- **时间戳可开关**：顶栏的 `⏱` 按钮一键隐藏/显示每段前面的时间戳，纯读文本时更清爽。状态会被记住。
- **实时高亮 + 自动跟随**：基于 `requestAnimationFrame` 每帧定位当前段落，滚动带缓动，连续跟手。
- **手动滚动暂停**：手动滚动（滚轮 / 触摸 / 方向键）时暂停跟随，停止 6 秒后自动恢复；顶栏的「跟随中 / 已暂停」按钮可随时切换。
- **悬停 / 划词时暂停跟随**：鼠标停在面板上、或者面板里有文本选区时，自动滚动会让路 —— 回头精读、划词翻译、查单词时不会读到一半被拽回当前播放位置；鼠标移开或选区消失后立刻追上。
  （注意：顶栏那个「跟随中」按钮反映的是**用户意图**，不含悬停/划词造成的临时暂停 —— 否则鼠标停在面板上时按钮会显示「已暂停」，点它反而永远点不亮。）
- **点击跳转可开关（默认关闭）**：顶栏的「跳转」按钮控制「点击某段 → 视频跳到该时间点」。默认关闭，这样在面板里可以随便划词、拖选、双击选词，绝不会误触把视频跳走；需要快速定位时再打开。关闭时光标也变成文本光标。
- **划词不误触**：即便打开跳转，也做了三重保护（`mousedown` 时已有选区则跳过、`dblclick` 取消待执行跳转、跳转延迟 180ms 再复查选区），双击选词、拖拽选句都不会把视频跳走。
- **多语言轨道**：读取播放器已有的字幕轨道列表，支持切换（含自动生成字幕）。
- **偏好持久化**：模式、浮窗位置与大小、可见性、跟随开关、时间戳开关、点击跳转开关、语言选择都会记住。

## 安装（开发者模式）

1. 打开 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录
4. 打开任意带字幕的 YouTube 视频，右侧栏会出现字幕面板

要求 Chrome 111+（用了 MV3 的 `world: "MAIN"` 内容脚本）。

## 字幕是怎么拿到的（重点）

`captionTracks[].baseUrl` 挂在播放器对象上，**只有页面世界**能拿到，所以拆成两个脚本：

```
inject.js (MAIN)                       content.js (ISOLATED)
  ├─ movie_player.getPlayerResponse()    ├─ 收到 tracks
  ├─ .getOption / .setOption             ├─ 路径 1：直连 baseUrl + &fmt=json3
  ├─ hook fetch / XMLHttpRequest         │    └─ 拿到就完事（快且完整）
  └─ window.postMessage(...)  ─────────► ├─ 路径 2：直连为空 or 带 exp=xpe
                                         │    ├─ 让播放器 setOption 打开该字幕轨道
                                         │    ├─ 播放器自己去请求 timedtext（自带 pot）
                                         │    ├─ 我们 hook 到响应 → 解析 → 渲染
                                         │    └─ 之后再还原用户原本的 CC 状态
                                         └─ rAF 循环：二分查找当前 cue，高亮 + 缓动居中
```

**为什么要走路径 2**：2025 年起，`baseUrl` 里带 `exp=xpe` 的视频，`timedtext` 接口必须带 **PO Token**（`pot=`）才返回内容，否则是 **HTTP 200 + 空 body**。pot 由播放器内部的 BotGuard 运行时生成，扩展拿不到，也无法伪造。唯一可靠的办法就是让播放器自己去请求 —— 它的请求天然带着有效 pot，我们把响应截下来即可。这也是 yt-dlp / FreeTube 等社区项目共同确认的结论。

截获到的多份响应会按时间戳合并去重，所以即使播放器是分段拉取的也能逐步补全。

自动生成的字幕（ASR）在 json3 里是逐词/滚动窗口式的，解析时会做连续片段合并（前缀增长合并、完全重复去重），结果和 YouTube 自己的文稿面板接近。

## 已知限制

- 只匹配 `www.youtube.com`（不含 `m.youtube.com`、`music.youtube.com`、嵌入播放器）。
- 路径 2 会**短暂打开一次播放器的 CC 字幕**（约 2.5 秒）来触发请求，拿到数据后会还原成你原本的设置。如果你本来就开着 CC，则不会有任何变化。
- 如果你的视频本来就没有任何字幕轨道，面板不会显示。
- 嵌入模式下高度固定对齐播放窗口，不能手动拖高（右下角的缩放手柄只在浮窗模式可用）；隐藏后重新显示要点扩展工具栏图标（浮窗模式则是右下角的 `CC` 按钮）。

## 目录结构

```
manifest.json              扩展清单
src/inject.js              MAIN 世界：播放器信息 + fetch/XHR 截获
src/content.js             隔离世界：取字幕、渲染面板、高亮跟随、挂载管理
src/content.css            面板样式（全部限定在 #ytt-root 内，不污染页面）
src/background.js          service worker：工具栏图标开关面板
icons/                     图标（由 tools/make_icons.py 生成）
tools/make_icons.py        纯标准库生成 PNG 图标
tools/pack.sh              打包成 zip
tools/test-hook/           本地端到端测试（见下）
```

## 测试

`tools/test-hook/` 里有一个本地测试服务器和一个 headless Chrome 跑测脚本，覆盖四条链路：

```sh
node tools/test-hook/server.js &      # 起本地假 YouTube
./tools/test-hook/run-e2e.sh          # 跑 /harness/{direct,xml,pot,embed,blocks}
```

- `/harness/direct` —— 直连 `timedtext`（json3）
- `/harness/xml` —— json3 为空，回退 XML 解析
- `/harness/pot` —— 需要 PO Token，走「让播放器自己去请求 + 截获」
- `/harness/embed` —— 嵌进右侧栏，校验挂载点与高度对齐
- `/harness/blocks` —— 48 条 × 2.5s 的长字幕（每 3 条一个整句），校验分块结果（预期 8 段，每段 15s，全部断在句末）
- `/harness/nopunct` —— 40 条 × 2.5s 的**无标点**字幕（模拟中文 ASR，停顿有大小之分），校验第 3 条回退逻辑（预期边界全部落在 1.5s 的大停顿上）
- `/harness/pot?clickseek=1` —— 校验「点击跳转」开关：默认点击**不应**写入 `video.currentTime`，开启后应写入一次
- `/harness/blocks?sim=1[&sel=1|&nopause=1]` —— 模拟视频播放，对比「不暂停 / 悬停 / 划词」时列表的滚动时机，校验暂停跟随

> 注意：headless 的虚拟时间下 `requestAnimationFrame` 不会触发，所以测试外壳里用 `setTimeout` 顶替了 `requestAnimationFrame`，否则主循环压根不跑，测出来的结论都是假的。

`tools/test-hook/server.js` 用假播放器模拟 YouTube，`run-e2e.sh` 把 `inject.js` + `content.js` 当普通页面脚本加载（stub 掉 `chrome.*`）后截图/导出 DOM。
注意：Chrome 155 已禁用 `--load-extension`，所以没法在 headless 里直接加载扩展本体，只能这样测。

## License

[MIT](LICENSE) —— 随便用，包括商用、修改、再分发，保留版权声明即可。
