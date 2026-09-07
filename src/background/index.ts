import { BackgroundApp } from './app';

const app = new BackgroundApp(chrome);

// 返回 true 保留异步回复通道；具体结果由统一边界校验后发出。
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  void app.handle(message, sender).then(reply);
  return true;
});

chrome.runtime.onConnect.addListener(port => { app.connectPanel(port); });

chrome.permissions.onRemoved.addListener(() => { void app.permissionsRemoved().catch(() => undefined); });
chrome.tabs.onRemoved.addListener(tabId => { app.panelTabDetached(tabId); void app.invalidateTab(tabId).catch(() => undefined); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') void app.invalidateTab(tabId).catch(() => undefined);
});
chrome.tabs.onAttached?.addListener((tabId, info) => { app.panelTabAttached(tabId, info.newWindowId); });
chrome.tabs.onDetached?.addListener(tabId => { app.panelTabDetached(tabId); });
chrome.tabs.onActivated?.addListener(info => { app.panelTabAttached(info.tabId, info.windowId); });
chrome.windows?.onRemoved?.addListener(windowId => { void app.panelWindowRemoved(windowId).catch(() => undefined); });

// 安装时即初始化安全存储；失败时所有消息返回结构化错误，不继续读取配置。
void app.ready.catch(() => undefined);
