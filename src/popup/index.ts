import '../ui/base.css';
import { send, type ContentMessage, type PageStatus, type TranslationSelection, type PublicSettings, type Reply, type SidePanelState } from '../shared/types';
import { defaultSelection, resolvePreferences } from '../shared/services';
import { element, feedback } from '../ui/common';
import { websiteFeatures } from '../ui/state';
import { populateLanguageSelect } from '../ui/languages';

const source = element<HTMLSelectElement>('source');
const target = element<HTMLSelectElement>('target');
populateLanguageSelect(source, true);
populateLanguageSelect(target, false);
const start = element<HTMLButtonElement>('start');
const stop = element<HTMLButtonElement>('stop');
const restore = element<HTMLButtonElement>('restore');
const retry = element<HTMLButtonElement>('retry');
const siteToggle = element<HTMLButtonElement>('site-toggle');
const acceptNotice = element<HTMLButtonElement>('accept-notice');
const actionFeedback = element('action-feedback');
const sidePanelButton = element<HTMLButtonElement>('open-sidepanel');
let settings: PublicSettings | undefined;
let tabId: number | undefined;
let windowId: number | undefined;
let sidePanel: SidePanelState | undefined;
let sidePanelReadError = '';
let lastActionError = '';
let lastActionMessage = '';
let origin = '';
let busy = false;
let operationVersion = 0;
let readVersion = 0;
let initialized = false;
let disposed = false;
let pageStatus: PageStatus = { state: 'idle', completed: 0, failed: 0, pending: 0 };
let pollTimer: ReturnType<typeof setInterval> | undefined;

/** 弹窗只调整当前页语言；服务始终按设置页的最新优先级自动选择。 */
function selection(): TranslationSelection {
  return { provider: 'auto', source: source.value as TranslationSelection['source'], target: target.value as TranslationSelection['target'] };
}

/** 本页快照优先于全局默认值，重开弹窗仍展示当前任务实际使用的设置。 */
function applyStatus(status: PageStatus): void {
  pageStatus = status;
  if (status.sidePanel) applySidePanel(status.sidePanel);
  const actionError = status.actionError ? JSON.stringify(status.actionError) : '';
  if (status.actionError && actionError !== lastActionError) feedback(actionFeedback, status.actionError.message, 'error');
  else if (!status.actionError && lastActionMessage && actionFeedback.textContent === lastActionMessage) feedback(actionFeedback, '');
  lastActionError = actionError;
  lastActionMessage = status.actionError?.message ?? '';
  if (status.selection) {
    source.value = status.selection.source;
    target.value = status.selection.target;
  } else if (status.preferences) {
    source.value = status.preferences.source;
    target.value = status.preferences.target;
  }
}

/** 状态必须来自当前窗口；忽略旧版本回复，不把启用配置当作已打开。 */
function applySidePanel(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<SidePanelState>;
  if (typeof state.open !== 'boolean' || typeof state.ready !== 'boolean' || typeof state.canOpen !== 'boolean' || typeof state.canToggle !== 'boolean' || typeof state.version !== 'number' || !Number.isInteger(state.version) || state.version < 0) return false;
  if (state.windowId !== undefined && (!Number.isInteger(state.windowId) || windowId !== undefined && state.windowId !== windowId)) return false;
  if (sidePanel && state.windowId === sidePanel.windowId && state.version < sidePanel.version) return false;
  sidePanel = { windowId: state.windowId, open: state.open, ready: state.ready, canOpen: state.canOpen, canToggle: state.canToggle, version: state.version };
  sidePanelReadError = '';
  return true;
}

/** 侧栏开关与正文状态独立，旧浏览器的关闭限制使用明确提示。 */
function renderSidePanel(): void {
  const ready = sidePanel?.ready === true && !sidePanelReadError;
  const openOnly = sidePanel?.ready === true && !sidePanel.canToggle;
  sidePanelButton.disabled = busy || tabId === undefined || !ready || (!sidePanel?.canOpen && (openOnly || !sidePanel?.open));
  element('sidepanel-label').textContent = !sidePanel?.ready ? '正在读取侧栏状态…' : openOnly ? '打开侧栏（请用原生 × 关闭）' : sidePanel.open ? '关闭文本翻译侧栏' : '打开文本翻译侧栏';
  if (sidePanel?.ready && sidePanel.canToggle) {
    sidePanelButton.setAttribute('aria-expanded', String(sidePanel.open));
    sidePanelButton.setAttribute('aria-pressed', String(sidePanel.open));
  } else {
    sidePanelButton.removeAttribute('aria-expanded');
    sidePanelButton.removeAttribute('aria-pressed');
  }
  sidePanelButton.title = openOnly ? '仅支持打开侧栏；请使用原生 × 关闭，完整开关需要 Chrome 142+ 或支持此能力的新版 Edge。' : element('sidepanel-label').textContent ?? '';
  element('sidepanel-hint').textContent = sidePanelReadError || (!sidePanel?.ready ? '正在确认当前窗口的侧栏状态，请稍候。' : !sidePanel.canOpen ? '当前浏览器不支持打开原生侧栏，请升级 Chrome / Edge。' : openOnly ? '此浏览器仅支持打开；关闭请用侧栏原生 ×。完整开关需要 Chrome 142+ / 支持此能力的新版 Edge。' : sidePanel.open ? '当前窗口侧栏已打开，可再次点击关闭。' : '打开独立文本翻译；不会开始网页翻译。');
}

/** 页面消息失败时使用固定中文提示，不展示底层异常或网页内容。 */
async function pageMessage(message: ContentMessage): Promise<Reply<PageStatus>> {
  if (tabId === undefined) return { ok: false, error: { code: 'UNAVAILABLE', message: '当前页面无法使用翻译，请打开普通网页后重试。', retryable: false } };
  try {
    const response = await chrome.tabs.sendMessage(tabId, message) as Reply<PageStatus> | undefined;
    if (response && typeof response.ok === 'boolean') return response;
  } catch {
    // 页面尚未注入或已经导航，不回显浏览器内部异常。
  }
  return { ok: false, error: { code: 'PAGE_DISCONNECTED', message: '暂时无法连接此页面。请刷新网页，重新打开扩展后再试。', retryable: true } };
}

/** 同步按钮可用性，运行中的任务设置保持不变。 */
function render(): void {
  const running = ['running', 'waiting', 'partial'].includes(pageStatus.state);
  const resolved = settings ? resolvePreferences(selection(), settings) : undefined;
  const ready = Boolean(resolved);
  const accepted = Boolean(settings?.dataNoticeAccepted);
  const features = settings ? websiteFeatures(settings, origin) : { authorized: false, selection: false, floating: false };
  const enabled = features.authorized;
  const available = Boolean(origin && tabId !== undefined && pageStatus.state !== 'unavailable');
  source.disabled = target.disabled = busy || !settings || running;
  start.disabled = busy || !settings || !available || !ready || !accepted || running;
  stop.disabled = busy || !available || !running;
  restore.disabled = busy || !available || (!running && pageStatus.completed === 0 && pageStatus.failed === 0 && !enabled);
  retry.disabled = busy || !available || !accepted || pageStatus.failed === 0;
  siteToggle.disabled = busy || !settings || !available;
  element<HTMLButtonElement>('grant-all-sites').disabled = busy || !settings;
  renderSidePanel();
  acceptNotice.disabled = busy || !settings;
  element('data-notice').hidden = !settings || accepted;
  start.textContent = running ? '网页翻译已开启' : pageStatus.state === 'stopped' ? '继续翻译当前页面' : '翻译当前页面';
  siteToggle.textContent = enabled ? '停用此网站' : '在此网站启用划词';
  element('site-host').textContent = origin ? `${new URL(origin).host}${features.selection ? ' · 划词已启用' : enabled ? ' · 浮球已启用' : ''}` : '当前页面不支持';
  element('site-feature-hint').textContent = settings?.selectionEnabled === false ? '划词功能已关闭；网站授权仍可用于悬浮球。可在设置中开启划词。' : features.selection ? '选中文字后，点击翻译按钮才会发送请求。' : '划词功能已开启；此网站仍需访问授权才能使用。';
  element('all-sites-guide').hidden = !settings || (settings.allSitesEnabled === true && settings.allSitesGranted === true);
  const titles: Record<PageStatus['state'], string> = { idle: '准备好，读下一页', running: '正在分批翻译已展开文字', waiting: '当前已展开内容已完成', partial: '部分段落翻译失败', stopped: '翻译已停止', unavailable: '当前页面不支持' };
  const missingService = Boolean(settings && !ready && !running && pageStatus.state !== 'unavailable');
  element('status-title').textContent = missingService ? '尚未配置翻译服务' : titles[pageStatus.state];
  element('status-dot').dataset.state = missingService ? 'unavailable' : pageStatus.state;
  let detail = pageStatus.message || '点击开始后，将分批翻译页面当前已展开的文字。';
  if (missingService) detail = '请点击右上角设置，配置服务并调整使用优先级。';
  if (!pageStatus.message && pageStatus.state === 'running') detail = '正在分批翻译页面已展开文字，无需滚动触发。';
  if (!pageStatus.message && pageStatus.state === 'waiting') detail = '展开菜单或折叠内容后，会继续补译新显示的文字。';
  if (!pageStatus.message && pageStatus.state === 'stopped') detail = '已完成译文保留，已提交请求仍可能计入用量。';
  if (pageStatus.completed || pageStatus.failed || pageStatus.pending) detail = `已译 ${pageStatus.completed} 段${pageStatus.failed ? ` · 失败 ${pageStatus.failed} 段` : ''}${pageStatus.pending ? ` · 待处理 ${pageStatus.pending} 段` : ''}。${detail}`;
  element('status-detail').textContent = detail;
}

/** 操作期间禁止重复提交，完成后恢复真实状态。 */
async function perform(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  operationVersion += 1;
  feedback(actionFeedback, '');
  render();
  try {
    await action();
  } catch {
    feedback(actionFeedback, '操作未完成，请重新打开扩展后重试。', 'error');
  } finally {
    busy = false;
    render();
  }
}

/** 接收操作回复后统一刷新状态。 */
async function control(message: ContentMessage): Promise<void> {
  const response = await pageMessage(message);
  if (response.ok) applyStatus(response.value);
  else feedback(actionFeedback, response.error.message, 'error');
}

/** 用户主动操作本页时注入脚本，受限页面直接显示可理解的原因。 */
async function ensureContent(): Promise<boolean> {
  if (tabId === undefined) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch {
    pageStatus = { state: 'unavailable', completed: 0, failed: 0, pending: 0, message: '浏览器内部页、扩展商店或其他受限页面无法注入翻译。请在普通文章网页使用。' };
    return false;
  }
}

/** 用户主动开始后分批处理已展开内容；弹窗生命周期不控制正文任务。 */
start.addEventListener('click', () => void perform(async () => {
  if (tabId === undefined) return;
  const chosen = selection();
  if (!await refreshSettings()) return;
  if (!settings?.dataNoticeAccepted) { feedback(actionFeedback, '请先确认文本发送说明。', 'error'); return; }
  const resolved = resolvePreferences(chosen, settings);
  if (!resolved) {
    feedback(actionFeedback, '还没有可用服务，请先在设置中配置。', 'error');
    return;
  }
  if (!await ensureContent()) return;
  await control({ type: 'PAGE_START', preferences: resolved, selection: chosen });
}));
stop.addEventListener('click', () => void perform(() => control({ type: 'PAGE_STOP' })));
restore.addEventListener('click', () => void perform(() => control({ type: 'RESTORE' })));
retry.addEventListener('click', () => void perform(() => control({ type: 'PAGE_RETRY' })));
for (const field of [source, target]) field.addEventListener('change', () => {
  const selected = selection();
  if (busy || !settings || !origin) return;
  void perform(async () => {
    if (!await ensureContent()) return;
    await control({ type: 'SET_SELECTION', selection: selected });
  });
});
element('open-settings').addEventListener('click', () => void chrome.runtime.openOptionsPage().catch(() => feedback(actionFeedback, '设置页暂时无法打开，请在扩展管理页打开设置。', 'error')));
sidePanelButton.addEventListener('click', () => {
  if (busy || !sidePanel?.ready || sidePanelReadError || tabId === undefined) return;
  if (!sidePanel.canOpen && (!sidePanel.canToggle || !sidePanel.open)) return;
  // 点击调用栈中直接发送命令，不先等待状态查询而丢失原生侧栏所需手势。
  // 旧浏览器缺少原生关闭事件，缓存的 open 可能过时，因此始终只发打开命令。
  const desiredOpen = sidePanel.canToggle ? !sidePanel.open : true;
  const responsePromise = send<SidePanelState>({ type: 'SET_SIDE_PANEL', open: desiredOpen, tabId, windowId: sidePanel.windowId });
  void perform(async () => {
    const response = await responsePromise;
    if (!response.ok) { feedback(actionFeedback, response.error.message, 'error'); return; }
    if (!applySidePanel(response.value)) { feedback(actionFeedback, '无法确认当前窗口的侧栏状态，请稍后重试。', 'error'); return; }
    if (!sidePanel?.ready) { feedback(actionFeedback, '侧栏状态尚未确认，请稍候。'); return; }
    if (sidePanel.open !== desiredOpen) { feedback(actionFeedback, '侧栏状态已同步，操作尚未生效，请稍后再试。'); return; }
    feedback(actionFeedback, sidePanel?.open ? '当前窗口的文本翻译侧栏已打开。' : '当前窗口的文本翻译侧栏已关闭。', 'success');
  });
});

acceptNotice.addEventListener('click', () => void perform(async () => {
  const response = await send<PublicSettings>({ type: 'SAVE_SETTINGS', dataNoticeAccepted: true });
  if (!response.ok) { feedback(actionFeedback, response.error.message, 'error'); return; }
  settings = response.value;
  feedback(actionFeedback, '已确认。配置翻译服务后即可开始。', 'success');
}));

/** 主机权限请求直接由点击触发，不能在初始化或后台静默申请。 */
siteToggle.addEventListener('click', () => {
  if (busy || !origin || !settings) return;
  const enabled = websiteFeatures(settings, origin).authorized;
  // 在任何异步存储或页面调用之前发起权限请求，保留本次用户手势。
  let permissionRequest: Promise<boolean> | undefined;
  if (!enabled && !(settings.allSitesEnabled && settings.allSitesGranted)) {
    try { permissionRequest = chrome.permissions.request({ origins: [`${origin}/*`] }); }
    catch { feedback(actionFeedback, '无法请求此网站的访问权限，请在普通网页重试。', 'error'); return; }
  }
  void perform(async () => {
    if (permissionRequest && !await permissionRequest) {
      feedback(actionFeedback, '未获得网站权限，划词翻译保持关闭。');
      return;
    }
    const response = await send<PublicSettings>({ type: enabled ? 'DISABLE_SITE' : 'ENABLE_SITE', origin });
    if (!response.ok) { feedback(actionFeedback, response.error.message, 'error'); return; }
    const updated = await send<PublicSettings>({ type: 'GET_SETTINGS' });
    if (updated.ok) settings = updated.value;
    feedback(actionFeedback, enabled ? '已停用此网站的划词与悬浮球。' : settings?.selectionEnabled === false ? '已启用此网站的悬浮球；划词功能可在设置中开启。' : '已启用此网站的划词与悬浮球。选中文字后点击按钮才会翻译。', 'success');
  });
});

element('grant-all-sites').addEventListener('click', () => {
  if (busy || !settings) return;
  const permissionRequest = chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
  void perform(async () => {
    if (!await permissionRequest) { feedback(actionFeedback, '未授予全站权限，原有网站功能保持不变。'); return; }
    const response = await send<unknown>({ type: 'ENABLE_ALL_SITES' });
    if (!response.ok) { feedback(actionFeedback, response.error.message, 'error'); return; }
    if (await refreshSettings()) feedback(actionFeedback, settings?.allSitesEnabled && settings.allSitesGranted ? '已启用所有普通网站的网页工具；浏览器受限页面除外。' : '尚未获得完整网站权限，请在设置中查看。', settings?.allSitesEnabled && settings.allSitesGranted ? 'success' : 'neutral');
  });
});

/** 每个新任务重新读取公开服务状态，自动选择不使用打开弹窗时的旧配置。 */
async function refreshSettings(): Promise<boolean> {
  const response = await send<PublicSettings>({ type: 'GET_SETTINGS' });
  if (!response.ok) { feedback(actionFeedback, response.error.message, 'error'); return false; }
  settings = response.value;
  return true;
}

/** 重新打开弹窗只读取状态，不主动创建任务或申请权限。 */
async function initialize(): Promise<void> {
  render();
  const [settingsResult, tabsResult] = await Promise.allSettled([send<PublicSettings>({ type: 'GET_SETTINGS' }), chrome.tabs.query({ active: true, currentWindow: true })]);
  if (disposed) return;
  if (settingsResult.status === 'fulfilled' && settingsResult.value.ok) {
    settings = settingsResult.value.value;
    const initial = defaultSelection(settings);
    source.value = initial.source;
    target.value = initial.target;
  } else {
    feedback(actionFeedback, settingsResult.status === 'fulfilled' && !settingsResult.value.ok ? settingsResult.value.error.message : '设置读取失败，请重新打开扩展。', 'error');
  }
  if (tabsResult.status === 'fulfilled') {
    const tab = tabsResult.value[0];
    tabId = tab?.id;
    windowId = tab?.windowId;
    try { const url = new URL(tab?.url || ''); if (['https:', 'http:'].includes(url.protocol)) origin = url.origin; } catch { /* 无网页地址时使用受限页状态。 */ }
  }
  if (!origin || tabId === undefined) pageStatus = { state: 'unavailable', completed: 0, failed: 0, pending: 0, message: '请打开普通 HTTP / HTTPS 网页后使用。浏览器内部页面不支持翻译。' };
  if (tabId !== undefined) {
    const [pageResponse, panelResponse] = await Promise.all([origin ? pageMessage({ type: 'STATUS' }) : Promise.resolve(undefined), send<SidePanelState>({ type: 'GET_SIDE_PANEL_STATE', tabId })]);
    if (disposed) return;
    if (pageResponse?.ok) applyStatus(pageResponse.value);
    if (!panelResponse.ok || !applySidePanel(panelResponse.value)) sidePanelReadError = '侧栏状态暂时无法读取，请稍候或重新打开扩展。';
  }
  initialized = true;
  document.body.dataset.ready = 'true';
  if (tabId !== undefined) pollTimer = setInterval(() => void pollStatus(), 1800);
  render();
}

/** 仅对已经存在的页面任务轮询状态；不存在内容脚本时保持就绪。 */
async function pollStatus(): Promise<void> {
  if (!initialized || disposed || busy || document.hidden || tabId === undefined) return;
  const version = operationVersion;
  const currentRead = ++readVersion;
  const [response, settingsResponse, panelResponse] = await Promise.all([origin ? pageMessage({ type: 'STATUS' }) : Promise.resolve(undefined), send<PublicSettings>({ type: 'GET_SETTINGS' }), send<SidePanelState>({ type: 'GET_SIDE_PANEL_STATE', tabId })]);
  if (disposed || busy || version !== operationVersion || currentRead !== readVersion) return;
  if (settingsResponse.ok) settings = settingsResponse.value;
  if (response?.ok) applyStatus(response.value);
  if (!panelResponse.ok) sidePanelReadError = '侧栏状态暂时无法刷新，请稍候重试。';
  else applySidePanel(panelResponse.value);
  render();
}
const refreshOnFocus = (): void => { void pollStatus(); };
window.addEventListener('focus', refreshOnFocus);
window.addEventListener('pagehide', () => { disposed = true; if (pollTimer) clearInterval(pollTimer); window.removeEventListener('focus', refreshOnFocus); }, { once: true });
void initialize();
