import { type ContentMessage, type PageStatus, type Reply } from '../shared/types';
import { ContentController } from './controller';
import { FrameSelectionController } from './frame';

declare global { interface Window { __yebanTranslationInstalled?: boolean } }

/** 同一文档重复注入只注册一次，弹窗关闭不影响页面队列。 */
if (!window.__yebanTranslationInstalled) {
  window.__yebanTranslationInstalled = true;
  const childFrame = window.top !== window;
  const controller = childFrame ? new FrameSelectionController(document) : new ContentController(document);
  const known = new Set(['PAGE_START', 'PAGE_STOP', 'PAGE_RETRY', 'RESTORE', 'STATUS', 'SITE_CHANGED', 'SERVICE_REMOVED', 'SET_PREFERENCES', 'SET_SELECTION', 'FEATURES_CHANGED', 'SIDE_PANEL_STATE']);
  chrome.runtime.onMessage.addListener((message: ContentMessage, sender, respond: (reply: Reply<PageStatus>) => void) => {
    if (sender.id !== chrome.runtime.id || !message || !known.has(message.type)) return false;
    if (controller instanceof FrameSelectionController) {
      // 子页面不回复 STATUS 等顶层命令，避免 tabs.sendMessage 取到错误的响应。
      void controller.handle(message);
      return false;
    }
    void controller.handle(message).then(respond);
    return true;
  });
  window.addEventListener('pagehide', () => { void controller.suspend(); });
  // 从浏览器往返缓存恢复时重新核实全局开关和站点授权。
  window.addEventListener('pageshow', event => { if (event.persisted) void controller.refreshContext(); });
}
