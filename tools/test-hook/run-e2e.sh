#!/usr/bin/env bash
# 端到端测试：把 inject.js / content.js 当页面脚本跑（stub chrome API），
# 检查面板是否真的渲染出字幕。headless Chrome 155 禁用了 --load-extension，
# 所以走这个外壳而不是加载扩展本体。
# 依赖 tools/test-hook/server.js 已在 8971 端口运行。
set -u
cd "$(dirname "$0")/../.."

run() {
  local path="$1"
  echo "== $path"
  google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --user-data-dir=/tmp/opencode/chrome-h-$RANDOM \
    --virtual-time-budget=25000 \
    --dump-dom "http://127.0.0.1:8971$path" 2>/dev/null \
    | python3 -c '
import sys, re, html
d = sys.stdin.read()
m = re.search(r"<pre id=\"result\">(.*?)</pre>", d, re.S)
print(html.unescape(m.group(1)) if m else "!! 没有结果节点")
'
  echo
}

run /harness/direct   # 直连 timedtext（json3）
run /harness/xml      # json3 为空，回退 XML
run /harness/pot      # 需要 PO Token，靠播放器自己去请求
run /harness/embed    # 嵌入右侧栏模式
run /harness/blocks   # 长字幕：验证 10~20 秒分块
run /harness/nopunct  # 无标点字幕：验证「挑最大停顿」的回退逻辑
run /harness/pot?clickseek=1   # 开启「点击跳转」后点字幕应当 seek
run '/harness/direct?search=the'          # 字幕搜索：2 处命中，高亮并定位第 1 处
run '/harness/unicode?search=stanbul'     # Unicode 大小写：İ 转小写会变长，命中下标必须仍对应原文
run '/harness/direct?search=the&next=1'   # 字幕搜索：Enter 跳到第 2 处
run '/harness/direct?search=the&esc=1'    # 字幕搜索：输入框聚焦时 Esc 关闭搜索栏
run '/harness/blockesc?search=the&esc=1'  # 模拟 Vimium/YouTube 抢走 keydown，靠 keyup 兜底关闭
run '/harness/blockesc?search=the&esc=1&nokeyup=1'  # 只有 keydown 且被 blur：靠失焦兜底关闭
run '/harness/direct?search=the&outside=1'         # 点击搜索栏外面失焦：不应关闭搜索

# ---------------------------------------------------------------- 悬停 / 划词暂停跟随
# 模拟视频播放（2.5 倍速），对比「不暂停 / 悬停 / 划词」三种情况下列表的滚动时机。
# 第 2 块在视频 15s 处切换，对应虚拟时间约 6s：
#   对照组应当在 8s 时就滚到 33；悬停和划词应当等到 9.2s 解除后才滚。
sim() {
  local label="$1" q="$2"
  echo "== $label"
  google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --user-data-dir=/tmp/opencode/chrome-sim-$RANDOM \
    --virtual-time-budget=40000 --window-size=1280,800 \
    --dump-dom "http://127.0.0.1:8971/harness/blocks?sim=1$q" 2>/dev/null \
    | python3 -c '
import sys, re, html, json
d = sys.stdin.read()
m = re.search(r"<pre id=\"result\">(.*?)</pre>", d, re.S)
r = json.loads(html.unescape(m.group(1)))
print("   (秒:scrollTop) " + "  ".join("%s:%s" % (s["at"] // 1000, s["scroll"]) for s in r["series"]))
'
  echo
}

sim "对照组（不悬停不划词）" "&nopause=1"
sim "鼠标悬停" ""
sim "划词选中" "&sel=1"
