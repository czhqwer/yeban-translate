import { PROVIDER_NAMES, SELECTION_LIMIT, send, type PageContext, type Preferences, type ProviderId, type Reply, type TranslationMode, type TranslationSelection } from '../shared/types';
import { resolvePreferences } from '../shared/services';
import { canWriteSelection, createHost, isInViewport, OWNED, readElementSelection, readSelection, selectionUnchanged, writeSelection, type SelectionSnapshot } from './dom';
import { createIcon } from './icons';
import { defaultTargetForText, LANGUAGE_OPTIONS } from '../shared/languages';

interface SelectionTask {
  generation: number; requestVersion: number; snapshot: SelectionSnapshot; mode: Extract<TranslationMode, 'selection' | 'hover'>;
  selection: TranslationSelection; preferences?: Preferences; jobId?: string; translated?: string; running: boolean;
}

const OFFSCREEN_TRIGGER_GRACE_MS = 1500;
const SELECTION_PANEL_STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel {
    --paper: #f7f5ef; --surface: #fffefb; --ink: #20382f; --muted: #748078;
    --line: #e3e7df; --accent: #22644e; --accent-hover: #174d3b; --wash: #edf4ee;
    --scrollbar: #a8b7af; --scrollbar-hover: #789185; --resize: #8fa99d;
    width: 340px; min-width: min(280px, calc(100vw - 24px)); min-height: min(160px, calc(100vh - 24px));
    max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); padding: 1px;
    overflow: hidden; resize: both;
    color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 18px 50px #263d2924;
    font: 14px/1.65 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .panel-content {
    width: 100%; height: 100%; min-height: inherit; padding: 15px 17px 21px 15px;
    overflow: auto; overflow-wrap: anywhere; scrollbar-gutter: stable;
    scrollbar-width: thin; scrollbar-color: var(--scrollbar) transparent;
  }
  .panel-content::-webkit-scrollbar { width: 10px; height: 10px; }
  .panel-content::-webkit-scrollbar-track { background: transparent; }
  .panel-content::-webkit-scrollbar-thumb { background: var(--scrollbar); border: 3px solid transparent; border-radius: 999px; background-clip: padding-box; }
  .panel-content::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-hover); border: 3px solid transparent; background-clip: padding-box; }
  .panel-content::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
  .panel-content::-webkit-scrollbar-corner { background: var(--wash); border-radius: 0 0 12px; }
  .panel::-webkit-resizer {
    border-radius: 6px 0 11px;
    background: linear-gradient(135deg, transparent 0 48%, var(--resize) 49% 57%, transparent 58% 66%, var(--accent) 67% 75%, transparent 76%) right bottom / 15px 15px no-repeat, var(--wash);
  }
  .compact { width: 24px; height: 24px; min-width: 24px; min-height: 24px; max-width: 24px; padding: 0; overflow: visible; resize: none; background: transparent; border: 0; box-shadow: none; }
  .compact .panel-content { width: 24px; height: 24px; min-height: 0; padding: 0; overflow: visible; scrollbar-gutter: auto; }
  .compact[data-detached="true"] { opacity: .65; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 11px; color: var(--ink); font-size: 16px; font-weight: 700; letter-spacing: -.015em; }
  button { min-height: 33px; padding: 6px 10px; cursor: pointer; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 9px; font: inherit; font-weight: 550; transition: background .15s, border-color .15s; }
  button:hover { background: var(--wash); border-color: #98b0a1; }
  button:focus-visible, select:focus-visible { outline: 3px solid #91bba6; outline-offset: 2px; }
  .close { color: var(--accent); background: var(--wash); border-color: transparent; font-weight: 650; }
  .trigger { display: grid; place-items: center; width: 24px; height: 24px; min-height: 24px; padding: 0; color: #fff; background: var(--accent); border: 0; border-radius: 7px; box-shadow: 0 3px 10px #263d2924; line-height: 0; }
  .trigger:hover { background: var(--accent-hover); border: 0; }
  .trigger svg { display: block; }
  .language-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
  .language-row span, .meta { color: var(--muted); font-size: 11px; }
  .language-row select { width: 130px; height: 32px; min-height: 32px; padding: 4px 8px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; font: 12px/1.4 system-ui, -apple-system, "Microsoft YaHei", sans-serif; }
  .text { margin: 0; white-space: pre-wrap; }
  .original, .result { padding: 11px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
  .original { margin-bottom: 9px; color: var(--muted); }
  .result { color: var(--ink); font-size: 15px; }
  .result-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 10px; }
  .result-actions button:first-child { color: var(--accent); background: var(--wash); border-color: transparent; }
  .copy-state { margin-top: 6px; color: var(--muted); font-size: 11px; }
  @media (prefers-color-scheme: dark) {
    .panel { --paper: #17201b; --surface: #202b24; --ink: #e2eadf; --muted: #a1afa3; --line: #36443b; --accent: #9bcdb1; --accent-hover: #b8ddc6; --wash: #2b3b2f; --scrollbar: #63756a; --scrollbar-hover: #91ad9c; --resize: #789184; box-shadow: 0 18px 50px #0000004d; }
    .trigger { color: #183624; }
  }
`;

/** 点击后才发送所选文本，正文与划词的任务和缓存相互隔离。 */
export class SelectionTranslator {
  private enabled = false;
  private hoverEnabled = false;
  private panelListeners = false;
  private generation = 0;
  private task?: SelectionTask;
  private host?: HTMLSpanElement;
  private shadow?: ShadowRoot;
  private panel?: HTMLElement;
  private content?: HTMLElement;
  private cache = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private offscreenTimer?: ReturnType<typeof setTimeout>;
  private resizeObserver?: ResizeObserver;
  private resizing = false;
  private panelSize?: { width: number; height: number };
  constructor(private readonly doc: Document, private readonly getSelection: () => TranslationSelection | undefined = () => undefined) {}

  /** 只有已启用网站才注册选区监听，撤销时立即取消付费任务。 */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    const method = enabled ? 'addEventListener' : 'removeEventListener';
    this.doc[method]('mouseup', this.onSelectionEvent, true);
    this.doc[method]('select', this.onSelectionEvent, true);
    this.doc[method]('keyup', this.onKeyUp, true);
    this.syncPanelListeners();
    if (!enabled && !this.hoverEnabled) await this.close();
  }

  /** 悬停翻译与划词开关独立，但共用同一安全结果窗和缓存。 */
  async setHoverEnabled(enabled: boolean): Promise<void> {
    this.hoverEnabled = enabled;
    this.syncPanelListeners();
    if (!enabled && !this.enabled) await this.close();
  }

  private syncPanelListeners(): void {
    const active = this.enabled || this.hoverEnabled;
    if (this.panelListeners === active) return;
    this.panelListeners = active;
    const method = active ? 'addEventListener' : 'removeEventListener';
    this.doc[method]('pointerdown', this.onPointerDown, true);
    this.doc[method]('pointerup', this.onPointerUp, true);
    this.doc[method]('pointercancel', this.onPointerUp, true);
    this.doc[method]('keydown', this.onKeyDown, true);
    this.doc[method]('scroll', this.onScroll, true);
    window[method]('resize', this.onScroll);
  }

  /** 关闭只取消划词，不影响正文任务。 */
  async close(): Promise<void> {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.cancelOffscreenClose();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.resizing = false;
    const task = this.task;
    this.task = undefined;
    this.host?.remove();
    this.host = undefined;
    this.shadow = undefined;
    this.panel = undefined;
    this.content = undefined;
    if (task?.jobId) await send({ type: 'CANCEL_JOB', mode: task.mode, jobId: task.jobId });
  }

  /** 服务删除后关闭相关结果，禁止旧重试继续使用已删除配置。 */
  async serviceRemoved(provider: ProviderId): Promise<void> {
    if (this.task?.preferences?.provider !== provider) return;
    const snapshot = this.task.snapshot;
    await this.close();
    if (!this.enabled && !this.hoverEnabled) return;
    this.createPanel(snapshot, false);
    this.appendText('翻译服务配置已删除，请到扩展设置页重新配置。');
  }

  private inside(event: Event): boolean { return !!this.host && event.composedPath().includes(this.host); }

  private onSelectionEvent = (event: Event): void => {
    if (event.composedPath().some(node => node instanceof Element && node.hasAttribute(OWNED))) return;
    if (this.timer) clearTimeout(this.timer);
    const target = event.target;
    this.timer = setTimeout(() => { void this.capture(target); }, 0);
  };

  private onKeyUp = (event: Event): void => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === 'Escape' || this.inside(event)) return;
    if (keyboard.shiftKey || keyboard.key.startsWith('Arrow')) this.onSelectionEvent(event);
  };

  private onKeyDown = (event: Event): void => { if ((event as KeyboardEvent).key === 'Escape') void this.close(); };
  private onPointerDown = (event: Event): void => { if (this.host && !this.inside(event)) void this.close(); };
  private onPointerUp = (): void => {
    if (!this.resizing || !this.panel || this.panel.classList.contains('compact')) return;
    this.rememberPanelSize();
    this.resizing = false;
    this.keepPanelInViewport();
  };
  private onScroll = (event: Event): void => {
    if (this.inside(event)) return;
    const task = this.task;
    if (!task || !this.panel) return;
    if (isInViewport(this.anchor(task.snapshot))) {
      this.cancelOffscreenClose();
      this.panel.removeAttribute('data-detached');
      this.panel.removeAttribute('aria-description');
      this.position(task.snapshot);
      return;
    }
    this.panel.dataset.detached = 'true';
    if (!this.panel.classList.contains('compact')) {
      this.cancelOffscreenClose();
      this.panel.setAttribute('aria-description', '原选区已离开视口，翻译结果仍固定在当前窗口内。');
      this.keepPanelInViewport();
      return;
    }
    // 快速滚动可能只是短暂越过选区，小入口留出宽限时间；完整结果窗始终由用户主动关闭。
    this.keepPanelInViewport();
    if (this.offscreenTimer) return;
    const generation = this.generation;
    this.offscreenTimer = setTimeout(() => {
      this.offscreenTimer = undefined;
      if (generation === this.generation && this.task === task && this.panel?.classList.contains('compact')
        && !isInViewport(this.anchor(task.snapshot))) void this.close();
    }, OFFSCREEN_TRIGGER_GRACE_MS);
  };

  private async capture(target?: EventTarget | null): Promise<void> {
    if (!this.enabled) return;
    // 只检查实际选区；浮球保留焦点不能阻挡用户刚选中的网页正文。
    const snapshot = readSelection(this.doc.getSelection(), this.doc, target);
    if (!snapshot || !isInViewport(this.anchor(snapshot))) return;
    if (this.task && this.sameSelection(this.task.snapshot, snapshot)) return;
    const closing = this.close();
    const generation = this.generation;
    await closing;
    if (!this.enabled || generation !== this.generation || !selectionUnchanged(snapshot, this.doc)) return;
    const selected = this.initialSelection(snapshot.text);
    const task: SelectionTask = { generation: this.generation, requestVersion: 0, snapshot, mode: 'selection', selection: selected, running: false };
    this.task = task;
    const tooLong = Array.from(snapshot.text).length > SELECTION_LIMIT;
    this.createPanel(snapshot, !tooLong);
    if (tooLong) {
      this.appendText(`选中文本超过 ${SELECTION_LIMIT} 字，请缩小选区后翻译。`);
      return;
    }
    const button = this.button('', () => { void this.translate(task); });
    button.append(createIcon(this.doc, 'translate', 16));
    button.setAttribute('aria-label', '使用页伴翻译选中文字');
    button.title = '点击翻译所选文字';
    button.className = 'trigger';
    // 固定的选文快照在按钮获得焦点、浏览器清除选区后仍然有效。
    this.content?.append(button);
  }

  /** 悬停快捷键属于明确用户操作：打开完整结果窗并立即翻译当前段落。 */
  async translateElement(element: HTMLElement): Promise<void> {
    if (!this.hoverEnabled) return;
    const snapshot = readElementSelection(element, this.doc);
    if (!snapshot || !isInViewport(element)) return;
    const closing = this.close();
    const generation = this.generation;
    await closing;
    if (!this.hoverEnabled || generation !== this.generation || !selectionUnchanged(snapshot, this.doc)) return;
    const task: SelectionTask = { generation: this.generation, requestVersion: 0, snapshot, mode: 'hover', selection: this.initialSelection(snapshot.text), running: false };
    this.task = task;
    this.createPanel(snapshot, false);
    if (Array.from(snapshot.text).length > SELECTION_LIMIT) {
      this.renderResult(task, `当前段落超过 ${SELECTION_LIMIT} 字，请改用划词翻译较小范围。`);
      return;
    }
    await this.translate(task);
  }

  private initialSelection(text: string): TranslationSelection {
    const current = this.getSelection();
    return { provider: current?.provider ?? 'auto', source: 'auto', target: defaultTargetForText(text) };
  }

  private valid(task: SelectionTask): boolean {
    const enabled = task.mode === 'selection' ? this.enabled : this.hoverEnabled;
    if (!enabled || this.task !== task || task.generation !== this.generation || !this.host?.isConnected) return false;
    if (!selectionUnchanged(task.snapshot, this.doc)) { void this.close(); return false; }
    return true;
  }

  private async translate(task: SelectionTask): Promise<void> {
    if (!this.valid(task) || task.running) return;
    const requestVersion = ++task.requestVersion;
    task.running = true;
    this.renderResult(task, '正在准备翻译…');
    const context = await send<PageContext>({ type: 'GET_CONTEXT' });
    if (!this.validRequest(task, requestVersion)) return;
    if (!context.ok) { this.renderError(task, context); return; }
    if (task.mode === 'selection' && !context.value.selectionEnabled) { await this.setEnabled(false); return; }
    if (task.mode === 'hover' && !context.value.hoverTranslationEnabled) { await this.setHoverEnabled(false); return; }
    if (!task.preferences) task.preferences = resolvePreferences(task.selection, context.value);
    if (!context.value.dataNoticeAccepted || !task.preferences || !context.value.services[task.preferences.provider].configured) {
      task.running = false;
      this.renderResult(task, '请点击扩展工具栏图标，在设置页配置翻译服务并确认文本发送说明。');
      return;
    }
    const oldJobId = task.jobId;
    if (oldJobId) await send({ type: 'CANCEL_JOB', mode: task.mode, jobId: oldJobId });
    if (!this.validRequest(task, requestVersion)) return;
    task.jobId = crypto.randomUUID();
    const begin = await send<{ revision: number }>({ type: 'BEGIN_JOB', mode: task.mode, jobId: task.jobId, preferences: task.preferences });
    if (!this.validRequest(task, requestVersion)) return;
    if (!begin.ok) { this.renderError(task, begin); return; }
    const key = JSON.stringify([task.mode, task.preferences, begin.value.revision, task.snapshot.text]);
    const cached = this.cache.get(key);
    this.renderResult(task, '正在翻译…');
    const reply = cached === undefined ? await send<{ translated: string }>({ type: 'TRANSLATE', mode: task.mode, jobId: task.jobId, itemId: 'selected-text', text: task.snapshot.text }) : { ok: true as const, value: { translated: cached } };
    if (!this.validRequest(task, requestVersion)) return;
    task.running = false;
    if (!reply.ok) { this.renderError(task, reply); return; }
    if (!reply.value.translated?.trim()) { this.renderError(task, { ok: false, error: { code: 'INVALID_RESULT', message: '服务未返回有效译文，请重试。', retryable: true } }); return; }
    task.translated = reply.value.translated;
    this.cache.set(key, task.translated);
    this.renderResult(task);
  }

  private validRequest(task: SelectionTask, requestVersion: number): boolean {
    return task.requestVersion === requestVersion && this.valid(task);
  }

  private renderError(task: SelectionTask, reply: Exclude<Reply<unknown>, { ok: true }>): void {
    task.running = false;
    this.renderResult(task, reply.error.message);
    if (reply.error.retryable) this.content?.append(this.button('重试', () => { void this.translate(task); }));
    else this.appendText('请在扩展设置页检查服务配置与授权。');
  }

  private createPanel(snapshot: SelectionSnapshot, compact: boolean): void {
    this.cancelOffscreenClose();
    this.resizeObserver?.disconnect();
    this.host?.remove();
    const { host, shadow } = createHost(this.doc);
    this.host = host;
    this.shadow = shadow;
    host.style.cssText = 'position:fixed!important;z-index:2147483647!important;display:block!important;margin:0!important;padding:0!important;outline:none!important;box-shadow:none!important;border:0!important;';
    const style = this.doc.createElement('style');
    style.textContent = SELECTION_PANEL_STYLE;
    const panel = this.doc.createElement('section');
    panel.className = compact ? 'panel compact' : 'panel';
    panel.setAttribute('aria-label', '页伴划词翻译');
    panel.setAttribute('aria-live', 'polite');
    panel.title = compact ? '点击翻译所选文字' : '拖动右下角可调整窗口大小';
    panel.addEventListener('pointerdown', event => {
      if (panel.classList.contains('compact') || event.button !== 0) return;
      const bounds = panel.getBoundingClientRect();
      this.resizing = event.clientX >= bounds.right - 20 && event.clientY >= bounds.bottom - 20;
    });
    const content = this.doc.createElement('div');
    content.className = 'panel-content';
    panel.append(content);
    this.panel = panel;
    this.content = content;
    shadow.append(style, panel);
    this.doc.documentElement.append(host);
    if (!compact) this.applyPanelSize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.panel === panel && !panel.classList.contains('compact')) this.keepPanelInViewport();
      });
      this.resizeObserver.observe(panel);
    }
    this.position(snapshot);
  }

  private renderResult(task: SelectionTask, message?: string): void {
    if (!this.valid(task)) return;
    this.content!.replaceChildren();
    this.panel!.className = 'panel';
    this.panel!.title = '拖动右下角可调整窗口大小';
    this.cancelOffscreenClose();
    this.applyPanelSize();
    const header = this.doc.createElement('header');
    const title = this.doc.createElement('span');
    title.textContent = task.mode === 'hover' ? '悬停翻译' : '页伴翻译';
    const close = this.button('关闭', () => { void this.close(); });
    close.className = 'close';
    header.append(title, close);
    this.content!.append(header);
    const languageRow = this.doc.createElement('div');
    languageRow.className = 'language-row';
    const service = this.doc.createElement('span');
    service.textContent = task.preferences ? PROVIDER_NAMES[task.preferences.provider] : '自动选择服务';
    const target = this.doc.createElement('select');
    target.setAttribute('aria-label', '划词翻译目标语言');
    for (const language of LANGUAGE_OPTIONS) {
      const option = this.doc.createElement('option');
      option.value = language.code;
      option.textContent = language.name;
      target.append(option);
    }
    target.value = task.selection.target;
    target.addEventListener('change', () => { void this.changeTarget(task, target.value as TranslationSelection['target']); });
    languageRow.append(service, target);
    this.content!.append(languageRow);
    this.appendText(task.snapshot.text, 'text original');
    this.appendText(message ?? task.translated ?? '', 'text result');
    if (!message && task.translated) {
      const actions = this.doc.createElement('div');
      actions.className = 'result-actions';
      const copyStatus = this.doc.createElement('div');
      copyStatus.className = 'copy-state';
      const copy = this.button('复制译文', () => {
        if (!task.translated) return;
        void navigator.clipboard?.writeText(task.translated).then(() => { copyStatus.textContent = '已复制译文'; }, () => { copyStatus.textContent = '复制失败，请选中译文后手动复制。'; });
        if (!navigator.clipboard) copyStatus.textContent = '当前网页不支持自动复制，请选中译文后手动复制。';
      });
      actions.append(copy);
      if (canWriteSelection(task.snapshot)) {
        actions.append(
          this.button('替换选中', () => { this.writeBack(task, 'replace'); }),
          this.button('插入译文', () => { this.writeBack(task, 'insert'); }),
        );
      }
      this.content!.append(actions, copyStatus);
    }
    this.position(task.snapshot);
  }

  private async changeTarget(task: SelectionTask, target: TranslationSelection['target']): Promise<void> {
    if (!this.valid(task) || task.selection.target === target) return;
    task.requestVersion++;
    task.selection = { ...task.selection, source: 'auto', target };
    task.preferences = undefined;
    task.translated = undefined;
    task.running = false;
    const jobId = task.jobId;
    task.jobId = undefined;
    this.renderResult(task, '正在切换目标语言…');
    if (jobId) await send({ type: 'CANCEL_JOB', mode: task.mode, jobId });
    if (this.valid(task)) await this.translate(task);
  }

  private writeBack(task: SelectionTask, action: 'replace' | 'insert'): void {
    if (!task.translated) return;
    if (!writeSelection(task.snapshot, task.translated, action, this.doc)) {
      this.renderResult(task, '编辑区内容已经变化，未执行写入；请重新选择文字后再试。');
      return;
    }
    void this.close();
  }

  private appendText(text: string, className = 'text'): void {
    const node = this.doc.createElement('div');
    node.className = className;
    node.textContent = text;
    this.content?.append(node);
  }

  private button(text: string, click: () => void): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', click);
    return button;
  }

  private cancelOffscreenClose(): void {
    if (!this.offscreenTimer) return;
    clearTimeout(this.offscreenTimer);
    this.offscreenTimer = undefined;
  }

  private rememberPanelSize(): void {
    if (!this.panel) return;
    const bounds = this.panel.getBoundingClientRect();
    const width = bounds.width || this.panel.offsetWidth;
    const height = bounds.height || this.panel.offsetHeight;
    if (width > 0 && height > 0) this.panelSize = { width, height };
  }

  private applyPanelSize(): void {
    if (!this.panel || !this.panelSize || this.panel.classList.contains('compact')) return;
    const maxWidth = Math.max(0, window.innerWidth - 24);
    const maxHeight = Math.max(0, window.innerHeight - 24);
    this.panel.style.width = `${Math.min(this.panelSize.width, maxWidth)}px`;
    this.panel.style.height = `${Math.min(this.panelSize.height, maxHeight)}px`;
  }

  /** 用户放大窗口或视口缩小时，平移而不丢弃结果，并限制已记忆尺寸。 */
  private keepPanelInViewport(): void {
    if (!this.host) return;
    this.applyPanelSize();
    const width = Math.min(this.host.offsetWidth || this.panel?.offsetWidth || (this.panel?.classList.contains('compact') ? 24 : 340), Math.max(0, window.innerWidth - 24));
    const height = Math.min(this.host.offsetHeight || this.panel?.offsetHeight || (this.panel?.classList.contains('compact') ? 24 : 48), Math.max(0, window.innerHeight - 24));
    const currentLeft = Number.parseFloat(this.host.style.left);
    const currentTop = Number.parseFloat(this.host.style.top);
    const left = Math.max(12, Math.min(Number.isFinite(currentLeft) ? currentLeft : 12, window.innerWidth - width - 12));
    const top = Math.max(12, Math.min(Number.isFinite(currentTop) ? currentTop : 12, window.innerHeight - height - 12));
    this.host.style.setProperty('left', `${left}px`, 'important');
    this.host.style.setProperty('top', `${top}px`, 'important');
  }

  private position(snapshot: SelectionSnapshot): void {
    if (!this.host) return;
    const anchor = this.anchor(snapshot);
    const rect = anchor.getBoundingClientRect();
    if (this.panel?.classList.contains('compact')) {
      const point = this.triggerPosition(snapshot.kind === 'range' ? Array.from(snapshot.range.getClientRects?.() ?? []) : [rect], rect);
      this.host.style.setProperty('left', `${point.left}px`, 'important');
      this.host.style.setProperty('top', `${point.top}px`, 'important');
      return;
    }
    // 结果窗使用自身尺寸；尚未布局时也遵守 CSS 的窄视口最大宽高。
    const width = Math.min(this.host.offsetWidth || 340, Math.max(0, window.innerWidth - 24));
    const height = Math.min(this.host.offsetHeight || 48, Math.max(0, window.innerHeight - 24));
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const preferredTop = rect.bottom + 8;
    const top = preferredTop + height < window.innerHeight - 12 ? preferredTop : Math.max(12, Math.min(rect.top - height - 8, window.innerHeight - height - 12));
    this.host.style.setProperty('left', `${left}px`, 'important');
    this.host.style.setProperty('top', `${top}px`, 'important');
  }

  /** 小按钮跟随文字末行右端，方向取自规范化 Range，不受正反向拖选影响。 */
  private triggerPosition(clientRects: DOMRect[], bounds: DOMRect): { left: number; top: number } {
    const size = 24;
    const gap = 6;
    const margin = 12;
    const rightLimit = window.innerWidth - size - margin;
    const bottomLimit = window.innerHeight - size - margin;
    const rects = clientRects.filter(rect =>
      [rect.left, rect.right, rect.top, rect.bottom, rect.width, rect.height].every(Number.isFinite)
      && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth);
    const visible = rects.length ? rects : [bounds];
    const last = visible[visible.length - 1];
    const left = Math.max(margin, Math.min(last.right - size, rightLimit));
    const candidates = [
      { left: last.right + gap, top: Math.max(margin, Math.min(last.top + (last.height - size) / 2, bottomLimit)) },
      { left, top: last.bottom + gap },
      { left, top: Math.min(...visible.map(rect => rect.top)) - size - gap }
    ];
    return candidates.find(point => point.left >= margin && point.left <= rightLimit && point.top >= margin && point.top <= bottomLimit
      && !visible.some(rect => point.left < rect.right && point.left + size > rect.left && point.top < rect.bottom && point.top + size > rect.top))
      // 整屏选区没有空位时允许局部覆盖，仍把可点击入口留在视口右边缘。
      ?? { left: Math.max(0, rightLimit), top: Math.max(0, Math.min(last.bottom + gap, bottomLimit)) };
  }

  private anchor(snapshot: SelectionSnapshot): Range | Element {
    return snapshot.kind === 'range' ? snapshot.range : snapshot.control;
  }

  private sameSelection(left: SelectionSnapshot, right: SelectionSnapshot): boolean {
    if (left.kind !== right.kind || left.text !== right.text) return false;
    if (left.kind === 'control' && right.kind === 'control') return left.control === right.control && left.start === right.start && left.end === right.end;
    return left.kind === 'range' && right.kind === 'range' && left.range.startContainer === right.range.startContainer && left.range.startOffset === right.range.startOffset && left.range.endContainer === right.range.endContainer && left.range.endOffset === right.range.endOffset;
  }
}
