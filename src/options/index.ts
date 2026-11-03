import '../ui/base.css';
import { DEFAULT_HOVER_SHORTCUT, DEFAULT_PAGE_DISPLAY_MODE, send, PROVIDER_NAMES, type PageDisplayMode, type Preferences, type ProviderId, type PublicSettings, type ServiceInput } from '../shared/types';
import { DEFAULT_PRIORITY, normalizePriority, resolveProvider } from '../shared/services';
import { element, feedback, validEndpoint } from '../ui/common';
import { websiteFeatures } from '../ui/state';
import { initializeServiceHelp } from './help';
import { populateLanguageSelect } from '../ui/languages';
import { shortcutFromEvent } from '../shared/shortcuts';

const providers: ProviderId[] = [...DEFAULT_PRIORITY];
const globalFeedback = element('global-feedback');
const defaultSource = element<HTMLSelectElement>('default-source');
const defaultTarget = element<HTMLSelectElement>('default-target');
const displayMode = element<HTMLSelectElement>('page-display-mode');
const hoverToggle = element<HTMLInputElement>('hover-toggle');
const hoverShortcut = element<HTMLInputElement>('hover-shortcut');
populateLanguageSelect(defaultSource, true);
populateLanguageSelect(defaultTarget, false);
let settings: PublicSettings | undefined;
let busy = false;
let priority: ProviderId[] = [...DEFAULT_PRIORITY];
let priorityEdited = false;
let renderedNoticeAccepted: boolean | undefined;

function privacyIsTargeted(): boolean { return location.hash === '#privacy'; }

/** 配置卡片与默认优先级保持一致，序号同时按当前默认顺序展示。 */
function orderProviderForms(): void {
  const stack = document.querySelector<HTMLElement>('.provider-stack');
  if (!stack) return;
  providers.forEach((provider, index) => {
    const form = element<HTMLFormElement>(`${provider}-form`);
    const marker = form.querySelector<HTMLElement>('.provider-index');
    if (marker) marker.textContent = String(index + 1).padStart(2, '0');
    stack.append(form);
  });
}

orderProviderForms();
initializeServiceHelp();

/** 敏感输入只由当前表单直接读取，不放入公开设置或状态。 */
function input(id: string): HTMLInputElement { return element<HTMLInputElement>(id); }

/** 保存后的凭据立即从输入框移除，页面仅显示配置是否存在。 */
function clearSensitiveFields(provider: ProviderId): void {
  if (provider === 'bailian') input('bailian-api-key').value = '';
  else { input('aliyun-access-id').value = ''; input('aliyun-access-secret').value = ''; }
}

/** 用户交互期间禁用表单，避免同一配置的保存、测试和删除发生竞争。 */
function renderAvailability(): void {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach(node => {
    // 帮助不读写配置，在读取或保存期间仍允许打开和关闭。
    node.disabled = node.hasAttribute('data-help-control') ? false : busy || !settings;
  });
  for (const provider of providers) {
    const configured = Boolean(settings?.services[provider].configured);
    element<HTMLButtonElement>(`test-${provider}`).disabled = busy || !configured;
    element<HTMLButtonElement>(`delete-${provider}`).disabled = busy || !configured;
  }
  const accepted = Boolean(settings?.dataNoticeAccepted);
  element('accept-notice').hidden = accepted;
  element('notice-accepted').hidden = !accepted;
  if (settings) {
    const details = element<HTMLDetailsElement>('privacy-details');
    // 仅在确认状态变化时设置默认开合，避免刷新覆盖用户手动展开。
    if (privacyIsTargeted()) details.open = true;
    else if (renderedNoticeAccepted !== accepted) details.open = !accepted;
    renderedNoticeAccepted = accepted;
    details.dataset.confirmed = String(accepted);
    element('privacy-summary-state').textContent = accepted ? '已确认' : '待确认';
    element('privacy-summary-state').dataset.ready = String(accepted);
  }
  document.querySelectorAll<HTMLButtonElement>('[data-at-boundary="true"]').forEach(button => { button.disabled = true; });
}

/** 公开状态不包含真实凭据；所有服务和网站文字采用纯文本写入。 */
function renderSettings(refreshFields = false): void {
  if (!settings) return;
  if (refreshFields) {
    defaultSource.value = settings.preferences.source;
    defaultTarget.value = settings.preferences.target;
    displayMode.value = settings.pageDisplayMode ?? DEFAULT_PAGE_DISPLAY_MODE;
    for (const provider of providers) {
      input(`${provider}-endpoint`).value = settings.services[provider].endpoint;
      if (provider === 'bailian') input('bailian-model').value = settings.services.bailian.model || '';
    }
  }
  hoverToggle.checked = settings.hoverTranslationEnabled === true;
  element('hover-toggle-label').textContent = hoverToggle.checked ? '已开启' : '已关闭';
  hoverShortcut.value = settings.hoverShortcut ?? DEFAULT_HOVER_SHORTCUT;
  renderDisplayModeHint();
  if (!priorityEdited || refreshFields) priority = normalizePriority(settings.providerPriority, settings.preferences.provider);
  for (const provider of providers) {
    const configured = settings.services[provider].configured;
    const badge = element(`${provider}-status`);
    badge.textContent = configured ? '已配置' : '未配置';
    badge.dataset.ready = String(configured);
    const initialHint = provider === 'bailian' ? '填写服务商提供的 API Key。' : '同时填写 AccessKey ID 与 AccessKey Secret。';
    element(`${provider}-auth-hint`).textContent = configured ? '留空保留现有值，填写后将替换。' : initialHint;
    if (provider === 'bailian') input('bailian-api-key').placeholder = configured ? '已配置，留空保留现有值' : '输入你的 API Key';
    else {
      input('aliyun-access-id').placeholder = configured ? '已配置，留空保留现有值' : '输入你的 AccessKey ID';
      input('aliyun-access-secret').placeholder = configured ? '已配置，留空保留现有值' : '输入你的 AccessKey Secret';
    }
  }
  renderPriority();
  renderSites();
  renderAvailability();
}

function renderDisplayModeHint(): void {
  const descriptions: Record<PageDisplayMode, string> = {
    bilingual: '双语对照会保留原文，并在原文下方插入译文。',
    translation: '仅显示译文会临时隐藏已翻译的原文，恢复原文后完整还原。',
    hover: '默认只显示译文；鼠标悬停或键盘聚焦译文时显示原文。',
    parallel: '普通宽屏正文左右对照；窄屏、表格和列表等复杂结构会安全回退为上下对照。',
  };
  element('display-mode-hint').textContent = descriptions[(displayMode.value as PageDisplayMode) || DEFAULT_PAGE_DISPLAY_MODE];
}

/** 调整顺序只更新待保存偏好，已有任务仍使用自己的服务快照。 */
function renderPriority(): void {
  if (!settings) return;
  const list = element<HTMLOListElement>('priority-list');
  list.replaceChildren();
  priority.forEach((provider, index) => {
    const row = document.createElement('li');
    row.className = 'priority-row';
    const number = document.createElement('span');
    number.className = 'priority-number';
    number.textContent = String(index + 1);
    const name = document.createElement('span');
    name.className = 'priority-name';
    name.textContent = PROVIDER_NAMES[provider];
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.dataset.ready = String(settings!.services[provider].configured);
    badge.textContent = settings!.services[provider].configured ? '已配置' : '未配置';
    const controls = document.createElement('div');
    controls.className = 'priority-controls';
    for (const [direction, label] of [[-1, '上移'], [1, '下移']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-label', `${label}${PROVIDER_NAMES[provider]}`);
      button.dataset.atBoundary = String(index + direction < 0 || index + direction >= priority.length);
      button.addEventListener('click', () => {
        if (busy || button.dataset.atBoundary === 'true') return;
        [priority[index], priority[index + direction]] = [priority[index + direction], priority[index]];
        priorityEdited = true;
        renderPriority();
        renderAvailability();
      });
      controls.append(button);
    }
    row.append(number, name, badge, controls);
    list.append(row);
  });
  const provider = resolveProvider('auto', settings.services, priority);
  element('priority-summary').textContent = provider ? `按此顺序自动选择：${PROVIDER_NAMES[provider]}。未配置服务会自动跳过。` : '还没有已配置服务，请在下方配置至少一种。';
  element('priority-save-hint').textContent = priorityEdited ? '顺序已调整，点击“保存偏好”后生效。' : '运行中的任务保留开始时选定的服务。';
}

/** 网站记录只展示域名授权，关闭操作不扩大到其他站点。 */
function renderSites(): void {
  if (!settings) return;
  const list = element<HTMLUListElement>('sites-list');
  list.replaceChildren();
  const blocked = settings.blockedSites || [];
  const sites = [...new Set([...settings.sites, ...blocked])];
  const allActive = settings.allSitesEnabled === true && settings.allSitesGranted === true;
  element<HTMLInputElement>('selection-toggle').checked = settings.selectionEnabled !== false;
  element('selection-toggle-label').textContent = settings.selectionEnabled !== false ? '已开启' : '已关闭';
  const state = element('all-sites-state');
  state.textContent = allActive ? '已启用并授权' : settings.allSitesEnabled ? '权限待恢复' : settings.allSitesGranted ? '已授权，尚未启用' : '尚未获得全站权限';
  state.dataset.ready = String(allActive);
  element('all-sites-detail').textContent = allActive ? '普通 HTTP / HTTPS 网页可使用悬浮球；划词与悬停翻译分别遵循上方开关，受限页面除外。' : settings.allSitesEnabled ? '全站偏好仍保留，但浏览器权限已不足。重新授权前只使用仍获授权的单独网站。' : '划词、悬停翻译和悬浮球需要网站访问权限；开启功能本身不会自动获得授权。也可只在需要的网站单独启用。';
  element('grant-all-sites').hidden = allActive;
  element('disable-all-sites').hidden = !settings.allSitesEnabled;
  element('sites-empty').hidden = sites.length > 0;
  element('sites-count').textContent = sites.length ? `${sites.length} 个网站有单独设置` : '功能开关与网站权限分别管理';
  for (const origin of sites) {
    const enabled = websiteFeatures(settings, origin).authorized;
    const row = document.createElement('li');
    row.className = 'site-row';
    const name = document.createElement('span');
    name.textContent = origin;
    const copy = document.createElement('div');
    copy.className = 'site-row-copy';
    const status = document.createElement('small');
    status.textContent = blocked.includes(origin) ? '已停用 · 全站模式下也不启用' : enabled ? '已启用网页工具' : '等待网站授权';
    copy.append(name, status);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = enabled ? '停用' : '启用';
    button.setAttribute('aria-label', `${enabled ? '停用' : '启用'} ${origin} 的网页工具`);
    button.addEventListener('click', () => {
      if (busy || !settings) return;
      const permissionRequest = !enabled && !(settings.allSitesEnabled && settings.allSitesGranted) ? chrome.permissions.request({ origins: [`${origin}/*`] }) : Promise.resolve(true);
      void perform(button, globalFeedback, async () => {
      if (!await permissionRequest) { feedback(globalFeedback, '未获得网站权限，原有设置保持不变。'); return; }
      const response = await send<unknown>({ type: enabled ? 'DISABLE_SITE' : 'ENABLE_SITE', origin });
      if (!response.ok) { feedback(globalFeedback, response.error.message, 'error'); return; }
      await refreshSettings();
      feedback(globalFeedback, enabled ? '已停用该网站的划词与悬浮球。' : '已启用该网站的网页工具；划词仍遵循全局功能开关。', 'success');
    });
    });
    row.append(copy, button);
    list.append(row);
  }
}

/** 读取服务表单并完成必要校验；错误提示不包含用户输入。 */
function serviceInput(provider: ProviderId): ServiceInput | undefined {
  const output = element(`${provider}-feedback`);
  const endpoint = input(`${provider}-endpoint`).value.trim();
  if (!validEndpoint(endpoint)) { feedback(output, '请填写完整的 HTTPS 官方端点，不包含身份信息、查询参数或片段。', 'error'); input(`${provider}-endpoint`).focus(); return; }
  const configured = Boolean(settings?.services[provider].configured);
  if (provider === 'bailian') {
    const model = input('bailian-model').value.trim();
    const apiKey = input('bailian-api-key').value.trim();
    if (!model) { feedback(output, '请填写要使用的百炼模型。', 'error'); input('bailian-model').focus(); return; }
    if (!configured && !apiKey) { feedback(output, '首次配置需要填写 API Key。', 'error'); input('bailian-api-key').focus(); return; }
    return { endpoint, model, ...(apiKey ? { apiKey } : {}) };
  }
  const accessKeyId = input('aliyun-access-id').value.trim();
  const accessKeySecret = input('aliyun-access-secret').value.trim();
  if (!configured && (!accessKeyId || !accessKeySecret)) { feedback(output, '首次配置需要同时填写 AccessKey ID 和 AccessKey Secret。', 'error'); input(!accessKeyId ? 'aliyun-access-id' : 'aliyun-access-secret').focus(); return; }
  return { endpoint, ...(accessKeyId ? { accessKeyId } : {}), ...(accessKeySecret ? { accessKeySecret } : {}) };
}

/** 测试仅使用已保存配置，避免用户误以为正在测试尚未保存的输入。 */
function isServiceDirty(provider: ProviderId): boolean {
  if (!settings) return true;
  const service = settings.services[provider];
  if (input(`${provider}-endpoint`).value.trim() !== service.endpoint) return true;
  return provider === 'bailian'
    ? input('bailian-model').value.trim() !== (service.model || '') || Boolean(input('bailian-api-key').value)
    : Boolean(input('aliyun-access-id').value || input('aliyun-access-secret').value);
}

/** 后台成功返回后只接收公开配置；刷新不覆盖其他表单尚未保存的编辑。 */
async function refreshSettings(): Promise<boolean> {
  const response = await send<PublicSettings>({ type: 'GET_SETTINGS' });
  if (!response.ok) { feedback(globalFeedback, response.error.message, 'error'); return false; }
  settings = response.value;
  renderSettings();
  return true;
}

/** 显示操作中的明确反馈，并在结束后恢复正常按钮状态。 */
async function perform(button: HTMLButtonElement, output: HTMLElement, action: () => Promise<void>): Promise<void> {
  if (busy || !settings) return;
  busy = true;
  const original = button.textContent;
  button.textContent = '处理中…';
  button.setAttribute('aria-busy', 'true');
  feedback(output, '');
  renderAvailability();
  try { await action(); }
  catch { feedback(output, '操作未完成，请稍后重试。', 'error'); }
  finally { busy = false; button.textContent = original; button.removeAttribute('aria-busy'); renderAvailability(); }
}

for (const provider of providers) {
  const form = element<HTMLFormElement>(`${provider}-form`);
  form.noValidate = true;
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !settings) return;
    const config = serviceInput(provider);
    if (!config) return;
    const output = element(`${provider}-feedback`);
    void perform(element<HTMLButtonElement>(`save-${provider}`), output, async () => {
      const response = await send<PublicSettings>({ type: 'SAVE_SETTINGS', provider, config });
      if (!response.ok) { feedback(output, response.error.message, 'error'); return; }
      settings = response.value;
      clearSensitiveFields(provider);
      input(`${provider}-endpoint`).value = settings.services[provider].endpoint;
      if (provider === 'bailian') input('bailian-model').value = settings.services.bailian.model || '';
      renderSettings();
      feedback(output, '配置已保存，可以测试连接。', 'success');
    });
  });
  element(`test-${provider}`).addEventListener('click', () => {
    const output = element(`${provider}-feedback`);
    if (isServiceDirty(provider)) { feedback(output, '配置有未保存的修改，请先保存后再测试连接。', 'error'); return; }
    void perform(element<HTMLButtonElement>(`test-${provider}`), output, async () => {
      feedback(output, '正在使用固定示例测试连接，请稍候…');
      const response = await send<unknown>({ type: 'TEST_SERVICE', provider });
      if (!response.ok) { feedback(output, response.error.message, 'error'); return; }
      feedback(output, `${PROVIDER_NAMES[provider]}连接成功。`, 'success');
    });
  });
  element(`delete-${provider}`).addEventListener('click', () => void perform(element<HTMLButtonElement>(`delete-${provider}`), element(`${provider}-feedback`), async () => {
    const output = element(`${provider}-feedback`);
    const response = await send<PublicSettings>({ type: 'DELETE_SERVICE', provider });
    if (!response.ok) { feedback(output, response.error.message, 'error'); return; }
    settings = response.value;
    clearSensitiveFields(provider);
    input(`${provider}-endpoint`).value = settings.services[provider].endpoint;
    if (provider === 'bailian') input('bailian-model').value = settings.services.bailian.model || '';
    renderSettings();
    feedback(output, '配置已删除，使用此服务的任务已停止。', 'success');
  }));
}

element<HTMLFormElement>('preferences-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!settings) return;
  const preferences: Preferences = { provider: settings.preferences.provider, source: defaultSource.value as Preferences['source'], target: defaultTarget.value as Preferences['target'] };
  void perform(element<HTMLButtonElement>('save-preferences'), globalFeedback, async () => {
    const response = await send<PublicSettings>({ type: 'SAVE_SETTINGS', preferences, providerPriority: priority, pageDisplayMode: displayMode.value as PageDisplayMode });
    if (!response.ok) { feedback(globalFeedback, response.error.message, 'error'); return; }
    settings = response.value;
    priorityEdited = false;
    renderSettings();
    feedback(globalFeedback, '阅读偏好已保存，将用于新任务。', 'success');
  });
});
displayMode.addEventListener('change', renderDisplayModeHint);
element('accept-notice').addEventListener('click', () => void perform(element<HTMLButtonElement>('accept-notice'), globalFeedback, async () => {
  const response = await send<PublicSettings>({ type: 'SAVE_SETTINGS', dataNoticeAccepted: true });
  if (!response.ok) { feedback(globalFeedback, response.error.message, 'error'); return; }
  settings = response.value;
  renderSettings();
  feedback(globalFeedback, '已确认数据使用说明。现在可以从扩展弹窗开始翻译。', 'success');
}));

element<HTMLInputElement>('selection-toggle').addEventListener('change', () => {
  const enabled = element<HTMLInputElement>('selection-toggle').checked;
  void perform(element<HTMLButtonElement>('save-preferences'), globalFeedback, async () => {
    const response = await send<PublicSettings>({ type: 'SAVE_SETTINGS', selectionEnabled: enabled });
    if (!response.ok) { feedback(globalFeedback, response.error.message, 'error'); renderSites(); return; }
    settings = response.value;
    renderSettings();
    feedback(globalFeedback, enabled ? '划词功能已开启；只在有访问权限的网站生效。' : '划词功能已关闭，悬浮球和手动翻译仍可使用。', 'success');
  });
});

hoverToggle.addEventListener('change', () => {
  const enabled = hoverToggle.checked;
  void perform(element<HTMLButtonElement>('save-preferences'), globalFeedback, async () => {
    const response = await send<PublicSettings>({ type: 'SAVE_SETTINGS', hoverTranslationEnabled: enabled });
    if (!response.ok) { feedback(globalFeedback, response.error.message, 'error'); renderSettings(); return; }
    settings = response.value;
    renderSettings();
    feedback(globalFeedback, enabled ? `鼠标悬停翻译已开启；将鼠标放在段落上并按 ${settings.hoverShortcut ?? DEFAULT_HOVER_SHORTCUT}。` : '鼠标悬停翻译已关闭。', 'success');
  });
});

async function saveHoverShortcut(shortcut: string): Promise<void> {
  await perform(element<HTMLButtonElement>('save-preferences'), globalFeedback, async () => {
    const response = await send<PublicSettings>({ type: 'SAVE_SETTINGS', hoverShortcut: shortcut });
    if (!response.ok) { feedback(globalFeedback, response.error.message, 'error'); renderSettings(); return; }
    settings = response.value;
    renderSettings();
    feedback(globalFeedback, `悬停翻译快捷键已保存为 ${settings.hoverShortcut}。`, 'success');
  });
}

hoverShortcut.addEventListener('focus', () => hoverShortcut.select());
hoverShortcut.addEventListener('click', () => hoverShortcut.select());
hoverShortcut.addEventListener('keydown', event => {
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape' || ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
  const shortcut = shortcutFromEvent(event);
  if (!shortcut) { feedback(globalFeedback, '请按包含 Ctrl、Alt 或 Meta 的组合键。', 'error'); return; }
  hoverShortcut.value = shortcut;
  void saveHoverShortcut(shortcut);
});
element('reset-hover-shortcut').addEventListener('click', () => { void saveHoverShortcut(DEFAULT_HOVER_SHORTCUT); });
/** 选区快捷键属于浏览器命令，扩展只能读取，修改由浏览器快捷键页面完成。 */
async function refreshRegionShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    element<HTMLInputElement>('region-shortcut').value = commands.find(command => command.name === 'capture-reading')?.shortcut || '未设置';
  } catch { element<HTMLInputElement>('region-shortcut').value = '无法读取，请打开浏览器快捷键设置'; }
}
element('edit-region-shortcut').addEventListener('click', () => {
  const scheme = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';
  void chrome.tabs.create({ url: `${scheme}://extensions/shortcuts` }).catch(() => feedback(globalFeedback, '无法打开快捷键页面，请从浏览器扩展管理页面进入快捷键设置。', 'error'));
});
window.addEventListener('focus', () => { void refreshRegionShortcut(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshRegionShortcut(); });
void refreshRegionShortcut();
element('grant-all-sites').addEventListener('click', () => {
  if (busy || !settings) return;
  const permissionRequest = chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
  void perform(element<HTMLButtonElement>('grant-all-sites'), globalFeedback, async () => {
    if (!await permissionRequest) { feedback(globalFeedback, '未授予全站权限，原有单独网站功能保持不变。'); return; }
    const response = await send<unknown>({ type: 'ENABLE_ALL_SITES' });
    if (!response.ok) { feedback(globalFeedback, response.error.message, 'error'); return; }
    if (await refreshSettings()) feedback(globalFeedback, settings?.allSitesEnabled && settings.allSitesGranted ? '已启用所有普通网站的网页工具。单独停用的网站继续保持停用。' : '全站访问权限尚未完整生效，请查看权限状态。', settings?.allSitesEnabled && settings.allSitesGranted ? 'success' : 'neutral');
  });
});
element('disable-all-sites').addEventListener('click', () => void perform(element<HTMLButtonElement>('disable-all-sites'), globalFeedback, async () => {
  const response = await send<unknown>({ type: 'DISABLE_ALL_SITES' });
  if (!response.ok) { feedback(globalFeedback, response.error.message, 'error'); return; }
  await refreshSettings();
  feedback(globalFeedback, '已关闭全站启用。单独授权的网站以列表状态为准。', 'success');
}));

/** 首次加载只读取脱敏设置，不触发连接测试或付费请求。 */
async function initialize(): Promise<void> {
  renderAvailability();
  const response = await send<PublicSettings>({ type: 'GET_SETTINGS' });
  if (!response.ok) { feedback(globalFeedback, response.error.message, 'error'); return; }
  settings = response.value;
  renderSettings(true);
  if (privacyIsTargeted()) {
    const privacy = element('privacy');
    privacy.scrollIntoView?.({ block: 'start' });
    privacy.querySelector<HTMLElement>('summary')?.focus();
  }
}
void initialize();
window.addEventListener('focus', () => { if (!busy && settings) void refreshSettings(); });
