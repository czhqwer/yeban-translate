import { BackgroundApp } from './app';
import { ReadingBridge, READING_CAPTURE_COMMAND, READING_SELECTION_MENU } from './reading';

const app = new BackgroundApp(chrome);
const reading = new ReadingBridge(chrome, app);
chrome.runtime.onInstalled.addListener(() => reading.install());
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === READING_SELECTION_MENU) reading.selection(info, tab);
});
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== READING_CAPTURE_COMMAND) return;
  if (tab) void reading.capture(tab);
  else void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => { if (tabs[0]) void reading.capture(tabs[0]); });
});

// 返回 true 保留异步回复通道；具体结果由统一边界校验后发出。
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const bridge = message?.type === 'TAKE_READING_DRAFT' || message?.type === 'CAPTURE_READING' || ['REGION_CAPTURE', 'REGION_CANCEL', 'REGION_SETTINGS'].includes(message?.type);
  void (bridge ? reading.handle(message, sender) : app.handle(message, sender)).then(reply);
  return true;
});

chrome.runtime.onConnect.addListener(port => { app.connectPanel(port); });

chrome.permissions.onAdded.addListener(permissions => { void app.permissionsAdded(permissions).catch(() => undefined); });
chrome.permissions.onRemoved.addListener(() => { reading.cancelAll(); void app.permissionsRemoved().catch(() => undefined); });
chrome.tabs.onRemoved.addListener(tabId => { reading.tabChanged(tabId); app.panelTabDetached(tabId); void app.invalidateTab(tabId).catch(() => undefined); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') { reading.tabChanged(tabId); void app.invalidateTab(tabId).catch(() => undefined); }
});
chrome.tabs.onAttached?.addListener((tabId, info) => { app.panelTabAttached(tabId, info.newWindowId); });
chrome.tabs.onDetached?.addListener(tabId => { reading.tabChanged(tabId); app.panelTabDetached(tabId); });
chrome.tabs.onActivated?.addListener(info => { reading.tabActivated(info.windowId, info.tabId); app.panelTabAttached(info.tabId, info.windowId); });
chrome.windows?.onRemoved?.addListener(windowId => { reading.removeWindow(windowId); void app.panelWindowRemoved(windowId).catch(() => undefined); });

// 安装时即初始化安全存储；失败时所有消息返回结构化错误，不继续读取配置。
void app.ready.catch(() => undefined);
