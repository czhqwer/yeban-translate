import '../ui/base.css';
import { send, SELECTION_LIMIT, type Preferences, type PublicSettings, type TranslationSelection } from '../shared/types';
import { languageName } from '../shared/languages';
import { defaultSelection, resolvePreferences } from '../shared/services';
import { element, feedback } from '../ui/common';
import { populateLanguageSelect } from '../ui/languages';
import { RequestVersion, unicodeLength } from '../ui/state';
import { PanelChannel } from './channel';

interface TranslationSnapshot { preferences: Preferences; text: string; }
const source = element<HTMLSelectElement>('panel-source');
const target = element<HTMLSelectElement>('panel-target');
populateLanguageSelect(source, true);
populateLanguageSelect(target, false);
const textInput = element<HTMLTextAreaElement>('panel-input');
const translateButton = element<HTMLButtonElement>('panel-translate');
const stopButton = element<HTMLButtonElement>('panel-stop');
const clearButton = element<HTMLButtonElement>('panel-clear');
const copyButton = element<HTMLButtonElement>('panel-copy');
const retryButton = element<HTMLButtonElement>('panel-retry');
const output = element('panel-translated');
const message = element('panel-feedback');
const versions = new RequestVersion();
const channel = new PanelChannel();
let settings: PublicSettings | undefined;
let busy = false;
let disposed = false;
let activeRequest: { id: string; version: number; preferences: Preferences } | undefined;
let failedSnapshot: TranslationSnapshot | undefined;
let resultSnapshot: TranslationSnapshot | undefined;
let translated = '';
let refreshTimer: ReturnType<typeof setInterval> | undefined;

/** 侧栏选择只属于此侧栏，不通过保存设置改写全局偏好。 */
function selection(): TranslationSelection {
  return { provider: 'auto', source: source.value as TranslationSelection['source'], target: target.value as TranslationSelection['target'] };
}

/** 纯文本渲染结果与反馈，服务返回内容不能创建可执行节点。 */
function render(): void {
  const count = unicodeLength(textInput.value);
  const overLimit = count > SELECTION_LIMIT;
  const resolved = settings ? resolvePreferences(selection(), settings) : undefined;
  const accepted = Boolean(settings?.dataNoticeAccepted);
  source.disabled = target.disabled = busy || !settings;
  textInput.disabled = busy;
  translateButton.disabled = busy || !settings || !resolved || !accepted || !textInput.value.trim() || overLimit;
  translateButton.textContent = busy ? activeRequest ? '正在翻译…' : '准备翻译…' : '翻译文本';
  stopButton.disabled = !busy;
  clearButton.disabled = !busy && !textInput.value && !translated && !failedSnapshot;
  copyButton.disabled = busy || !translated;
  retryButton.hidden = !failedSnapshot;
  retryButton.disabled = busy;
  element('panel-count').textContent = `${count} / ${SELECTION_LIMIT} 字符`;
  element('panel-count').dataset.over = String(overLimit);
  textInput.setAttribute('aria-invalid', String(overLimit));
  element('panel-input-hint').hidden = !overLimit;
  element('panel-input-hint').textContent = overLimit ? `已超出 ${count - SELECTION_LIMIT} 个字符，请缩短后翻译。` : '';
  element('panel-setup').hidden = !settings || (accepted && Boolean(resolved));
  element('panel-setup-title').textContent = !accepted ? '先了解文本如何使用' : '先配置翻译服务';
  element('panel-setup-detail').textContent = !accepted ? '请在设置页确认数据使用说明后开始翻译。' : '请先在设置中配置一个翻译服务。';
  output.textContent = translated;
  output.hidden = !translated;
  element('panel-empty').hidden = !busy || Boolean(translated);
  element('panel-empty').textContent = busy ? '正在翻译…' : '';
  element('panel-output').setAttribute('aria-busy', String(busy));
  const snapshot = resultSnapshot || failedSnapshot;
  element('panel-result-footer').hidden = !snapshot;
  element('panel-result-meta').textContent = snapshot ? `翻译为 ${languageName(snapshot.preferences.target)}` : '';
  retryButton.title = failedSnapshot ? `沿用此次文本和${languageName(failedSnapshot.preferences.target)}重试` : '沿用此次文本和目标语言重试';
}

/** 刷新公开配置；正在运行的翻译不因配置优先级变化而改换服务。 */
async function refreshSettings(initial = false): Promise<void> {
  if (busy || disposed) return;
  const response = await send<PublicSettings>({ type: 'GET_SETTINGS' });
  if (busy || disposed) return;
  if (!response.ok) { feedback(message, response.error.message, 'error'); return; }
  settings = response.value;
  if (initial) {
    const chosen = defaultSelection(settings);
    source.value = chosen.source;
    target.value = chosen.target;
  }
  render();
}

/** 新任务先读取最新配置，失败重试则保留原文本与服务快照。 */
async function translate(snapshot?: TranslationSnapshot): Promise<void> {
  if (busy || disposed) return;
  const rawText = snapshot?.text ?? textInput.value;
  const chosen = selection();
  if (!rawText.trim()) { feedback(message, '请先输入需要翻译的文本。', 'error'); return; }
  if (unicodeLength(rawText) > SELECTION_LIMIT) { feedback(message, `文本不能超过 ${SELECTION_LIMIT} 个字符，请缩短后重试。`, 'error'); return; }
  const version = versions.begin();
  busy = true;
  translated = '';
  resultSnapshot = undefined;
  failedSnapshot = undefined;
  feedback(message, '');
  render();
  const current = await send<PublicSettings>({ type: 'GET_SETTINGS' });
  if (!versions.isCurrent(version)) return;
  if (!current.ok) { busy = false; failedSnapshot = snapshot; feedback(message, current.error.message, 'error'); render(); return; }
  settings = current.value;
  if (!settings.dataNoticeAccepted) { busy = false; failedSnapshot = snapshot; feedback(message, '请先在设置中确认数据使用说明。', 'error'); render(); return; }
  const preferences = snapshot?.preferences ?? resolvePreferences(chosen, settings);
  if (!preferences || !settings.services[preferences.provider].configured) {
    busy = false;
    failedSnapshot = snapshot;
    feedback(message, snapshot ? '原服务配置已删除或不可用。请先恢复该配置，或开始一次新的翻译。' : '尚未配置可用的翻译服务，请打开设置。', 'error');
    render();
    return;
  }
  const captured: TranslationSnapshot = { preferences: { ...preferences }, text: rawText.trim() };
  const requestId = crypto.randomUUID();
  activeRequest = { id: requestId, version, preferences: captured.preferences };
  render();
  const response = await channel.send({ type: 'TRANSLATE_PANEL', requestId, preferences: captured.preferences, text: captured.text });
  if (!versions.isCurrent(version) || activeRequest?.id !== requestId) return;
  activeRequest = undefined;
  busy = false;
  if (!response.ok) {
    failedSnapshot = captured;
    feedback(message, response.error.message, 'error');
  } else if (!response.value || typeof response.value.translated !== 'string' || !response.value.translated.trim()) {
    failedSnapshot = captured;
    feedback(message, '服务未返回有效译文，请重试。', 'error');
  } else {
    translated = response.value.translated;
    resultSnapshot = captured;
    feedback(message, '');
  }
  render();
}

/** 停止先令展示代次失效，再尽力取消后台请求；不承诺撤销服务计费。 */
function stop(showMessage = true): void {
  const requestId = activeRequest?.id;
  versions.invalidate();
  activeRequest = undefined;
  busy = false;
  if (requestId) void channel.send({ type: 'CANCEL_PANEL', requestId });
  if (showMessage) feedback(message, '已停止等待。');
  render();
}

translateButton.addEventListener('click', () => void translate());
stopButton.addEventListener('click', () => stop());
retryButton.addEventListener('click', () => { if (failedSnapshot) void translate(failedSnapshot); });
clearButton.addEventListener('click', () => {
  stop(false);
  textInput.value = '';
  translated = '';
  failedSnapshot = resultSnapshot = undefined;
  feedback(message, '');
  render();
  textInput.focus();
});
textInput.addEventListener('input', () => {
  translated = '';
  failedSnapshot = resultSnapshot = undefined;
  feedback(message, '');
  render();
});
for (const field of [source, target]) field.addEventListener('change', () => {
  // 改选仅影响下一次翻译；失败快照仍保留以便按原条件重试。
  render();
});
copyButton.addEventListener('click', () => {
  if (!translated) return;
  void navigator.clipboard.writeText(translated).then(() => feedback(message, '译文已复制。', 'success')).catch(() => feedback(message, '复制失败，请选中译文后手动复制。', 'error'));
});
for (const id of ['panel-settings', 'panel-setup-button']) element(id).addEventListener('click', () => void chrome.runtime.openOptionsPage().catch(() => feedback(message, '设置页暂时无法打开，请从扩展管理页打开。', 'error')));
const refreshOnFocus = (): void => { void refreshSettings(); };
const refreshOnVisible = (): void => {
  if (document.hidden) {
    // 原生侧栏收起时不一定卸载文档；准备中和已发出的任务都必须立即失效。
    if (busy) {
      stop(false);
      feedback(message, '侧栏已隐藏，翻译已停止。再次打开不会自动重试。');
    }
    channel.disconnect();
    return;
  }
  void refreshSettings();
};
window.addEventListener('focus', refreshOnFocus);
document.addEventListener('visibilitychange', refreshOnVisible);
window.addEventListener('pagehide', () => {
  disposed = true;
  versions.invalidate();
  const requestId = activeRequest?.id;
  activeRequest = undefined;
  if (requestId) void channel.send({ type: 'CANCEL_PANEL', requestId });
  channel.dispose();
  if (refreshTimer) clearInterval(refreshTimer);
  window.removeEventListener('focus', refreshOnFocus);
  document.removeEventListener('visibilitychange', refreshOnVisible);
}, { once: true });
render();
void refreshSettings(true);
refreshTimer = setInterval(() => { if (!document.hidden && !busy) void refreshSettings(); }, 2500);
