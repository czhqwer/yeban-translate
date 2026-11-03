import { RegionOverlay } from './region';
import type { RegionEvent, RegionReply } from '../shared/region';

declare global { interface Window { __yebanRegionInstalled?: boolean } }
if (!window.__yebanRegionInstalled && window === window.top) {
  window.__yebanRegionInstalled = true;
  let overlay: RegionOverlay | undefined;
  chrome.runtime.onMessage.addListener((message: RegionEvent, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !message || !['REGION_START', 'REGION_LOADING', 'REGION_DISPOSE'].includes(message.type)) return false;
    if (message.type === 'REGION_START') {
      overlay?.dispose(false);
      overlay = new RegionOverlay(message.token, command => chrome.runtime.sendMessage(command) as Promise<RegionReply>, message.problem);
    } else if (overlay?.token === message.token) {
      if (message.type === 'REGION_LOADING') overlay.loading();
      else { overlay.dispose(false); overlay = undefined; }
    }
    reply({ ok: true }); return false;
  });
}
