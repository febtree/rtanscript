/**
 * 后台 service worker：点击工具栏图标时通知内容脚本切换面板显示。
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  if (!/^https:\/\/www\.youtube\.com\//.test(tab.url || '')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ytt-toggle' });
  } catch (_) {
    // 内容脚本尚未注入（例如页面还在加载），忽略即可
  }
});
