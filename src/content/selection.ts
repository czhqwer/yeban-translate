import { PROVIDER_NAMES, SELECTION_LIMIT, send, type PageContext, type Preferences, type ProviderId, type Reply, type TranslationSelection } from '../shared/types';
import { resolvePreferences } from '../shared/services';
import { createHost, isInViewport, OWNED, readSelection, selectionUnchanged, type SelectionSnapshot } from './dom';
import { createIcon } from './icons';
import { languageName } from '../shared/languages';

interface SelectionTask { generation: number; snapshot: SelectionSnapshot; preferences?: Preferences; jobId?: string; translated?: string; running: boolean }

/** 点击后才发送所选文本，正文与划词的任务和缓存相互隔离。 */
export class SelectionTranslator {
  private enabled = false;
  private generation = 0;
  private task?: SelectionTask;
  private host?: HTMLSpanElement;
  private shadow?: ShadowRoot;
  private panel?: HTMLElement;
  private cache = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly doc: Document, private readonly getSelection: () => TranslationSelection | undefined = () => undefined) {}

  /** 只有已启用网站才注册选区监听，撤销时立即取消付费任务。 */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    const method = enabled ? 'addEventListener' : 'removeEventListener';
    this.doc[method]('mouseup', this.onSelectionEvent, true);
    this.doc[method]('keyup', this.onKeyUp, true);
    this.doc[method]('pointerdown', this.onPointerDown, true);
    this.doc[method]('keydown', this.onKeyDown, true);
    this.doc[method]('scroll', this.onScroll, true);
    window[method]('resize', this.onScroll);
    if (!enabled) await this.close();
  }

  /** 关闭只取消划词，不影响正文任务。 */
  async close(): Promise<void> {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    const task = this.task;
    this.task = undefined;
    this.host?.remove();
    this.host = undefined;
    this.shadow = undefined;
    this.panel = undefined;
    if (task?.jobId) await send({ type: 'CANCEL_JOB', mode: 'selection', jobId: task.jobId });
  }

  /** 服务删除后关闭相关结果，禁止旧重试继续使用已删除配置。 */
  async serviceRemoved(provider: ProviderId): Promise<void> {
    if (this.task?.preferences?.provider !== provider) return;
    const snapshot = this.task.snapshot;
    await this.close();
    if (!this.enabled) return;
    this.createPanel(snapshot, false);
    this.appendText('翻译服务配置已删除，请到扩展设置页重新配置。');
  }

  private inside(event: Event): boolean { return !!this.host && event.composedPath().includes(this.host); }

  private onSelectionEvent = (event: Event): void => {
    if (event.composedPath().some(node => node instanceof Element && node.hasAttribute(OWNED))) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.capture(); }, 0);
  };

  private onKeyUp = (event: Event): void => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === 'Escape' || this.inside(event)) return;
    if (keyboard.shiftKey || keyboard.key.startsWith('Arrow')) this.onSelectionEvent(event);
  };

  private onKeyDown = (event: Event): void => { if ((event as KeyboardEvent).key === 'Escape') void this.close(); };
  private onPointerDown = (event: Event): void => { if (this.host && !this.inside(event)) void this.close(); };
  private onScroll = (event: Event): void => {
    if (this.inside(event)) return;
    if (this.task && !isInViewport(this.task.snapshot.range)) void this.close();
    else if (this.task) this.position(this.task.snapshot);
  };

  private async capture(): Promise<void> {
    if (!this.enabled) return;
    // 只检查实际选区；浮球保留焦点不能阻挡用户刚选中的网页正文。
    const snapshot = readSelection(this.doc.getSelection(), this.doc);
    if (!snapshot || !isInViewport(snapshot.range)) return;
    if (this.task?.snapshot.text === snapshot.text && this.task.snapshot.range.startContainer === snapshot.range.startContainer && this.task.snapshot.range.startOffset === snapshot.range.startOffset) return;
    const closing = this.close();
    const generation = this.generation;
    await closing;
    if (!this.enabled || generation !== this.generation || !selectionUnchanged(snapshot, this.doc)) return;
    const task: SelectionTask = { generation: this.generation, snapshot, running: false };
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
    this.panel?.append(button);
  }

  private valid(task: SelectionTask): boolean {
    if (!this.enabled || this.task !== task || task.generation !== this.generation || !this.host?.isConnected) return false;
    if (!selectionUnchanged(task.snapshot, this.doc)) { void this.close(); return false; }
    return true;
  }

  private async translate(task: SelectionTask): Promise<void> {
    if (!this.valid(task) || task.running) return;
    task.running = true;
    // 在用户点击时固定本页选择，异步校验和重试均不改用全局默认服务。
    const selection = this.getSelection();
    const selected = selection ? { ...selection } : undefined;
    this.renderResult(task, '正在准备翻译…');
    const context = await send<PageContext>({ type: 'GET_CONTEXT' });
    if (!this.valid(task)) return;
    if (!context.ok) { this.renderError(task, context); return; }
    if (!context.value.selectionEnabled) { await this.setEnabled(false); return; }
    if (!task.preferences) task.preferences = resolvePreferences(selected, context.value);
    if (!context.value.dataNoticeAccepted || !task.preferences || !context.value.services[task.preferences.provider].configured) {
      task.running = false;
      this.renderResult(task, '请点击扩展工具栏图标，在设置页配置翻译服务并确认文本发送说明。');
      return;
    }
    const oldJobId = task.jobId;
    if (oldJobId) await send({ type: 'CANCEL_JOB', mode: 'selection', jobId: oldJobId });
    if (!this.valid(task)) return;
    task.jobId = crypto.randomUUID();
    const begin = await send<{ revision: number }>({ type: 'BEGIN_JOB', mode: 'selection', jobId: task.jobId, preferences: task.preferences });
    if (!this.valid(task)) return;
    if (!begin.ok) { this.renderError(task, begin); return; }
    const key = JSON.stringify(['selection', task.preferences, begin.value.revision, task.snapshot.text]);
    const cached = this.cache.get(key);
    this.renderResult(task, '正在翻译…');
    const reply = cached === undefined ? await send<{ translated: string }>({ type: 'TRANSLATE', mode: 'selection', jobId: task.jobId, itemId: 'selected-text', text: task.snapshot.text }) : { ok: true as const, value: { translated: cached } };
    if (!this.valid(task)) return;
    task.running = false;
    if (!reply.ok) { this.renderError(task, reply); return; }
    if (!reply.value.translated?.trim()) { this.renderError(task, { ok: false, error: { code: 'INVALID_RESULT', message: '服务未返回有效译文，请重试。', retryable: true } }); return; }
    task.translated = reply.value.translated;
    this.cache.set(key, task.translated);
    this.renderResult(task);
  }

  private renderError(task: SelectionTask, reply: Exclude<Reply<unknown>, { ok: true }>): void {
    task.running = false;
    this.renderResult(task, reply.error.message);
    if (reply.error.retryable) this.panel?.append(this.button('重试', () => { void this.translate(task); }));
    else this.appendText('请在扩展设置页检查服务配置与授权。');
  }

  private createPanel(snapshot: SelectionSnapshot, compact: boolean): void {
    this.host?.remove();
    const { host, shadow } = createHost(this.doc);
    this.host = host;
    this.shadow = shadow;
    host.style.cssText = 'position:fixed!important;z-index:2147483647!important;display:block!important;margin:0!important;padding:0!important;outline:none!important;box-shadow:none!important;border:0!important;';
    const style = this.doc.createElement('style');
    style.textContent = ':host{all:initial;}*{box-sizing:border-box}.panel{font:14px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#1c3531;background:#fff;border:1px solid #d8e8e3;border-radius:12px;box-shadow:0 12px 36px #102f3826;padding:16px;width:360px;max-width:calc(100vw - 24px);max-height:min(560px,calc(100vh - 24px));overflow:auto;overflow-wrap:anywhere}.compact{width:24px;height:24px;max-width:24px;padding:0;border:0;background:transparent;box-shadow:none;overflow:visible}header{display:flex;align-items:center;justify-content:space-between;gap:16px;font-weight:700;margin-bottom:10px}button{font:inherit;cursor:pointer;border:0;border-radius:7px;padding:5px 10px;background:#e9f5f1;color:#116851}button:hover{background:#d1eade}button:focus-visible{outline:1px solid #167266;outline-offset:1px}.trigger{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:#19745d;color:white;line-height:0;box-shadow:0 2px 7px #102f3826}.trigger svg{display:block}.original{color:#62756e;border-bottom:1px solid #e5ece9;padding-bottom:10px;margin-bottom:10px}.text{white-space:pre-wrap;margin:8px 0}.meta{font-size:12px;color:#62756e}.result{font-size:15px}.copy-state{font-size:12px;color:#62756e;}';
    const panel = this.doc.createElement('section');
    panel.className = compact ? 'panel compact' : 'panel';
    panel.setAttribute('aria-label', '页伴划词翻译');
    panel.setAttribute('aria-live', 'polite');
    this.panel = panel;
    shadow.append(style, panel);
    this.doc.documentElement.append(host);
    this.position(snapshot);
  }

  private renderResult(task: SelectionTask, message?: string): void {
    if (!this.valid(task)) return;
    this.panel!.replaceChildren();
    this.panel!.className = 'panel';
    const header = this.doc.createElement('header');
    const title = this.doc.createElement('span');
    title.textContent = '页伴翻译';
    header.append(title, this.button('关闭', () => { void this.close(); }));
    this.panel!.append(header);
    if (task.preferences) this.appendText(`${PROVIDER_NAMES[task.preferences.provider]} · ${languageName(task.preferences.target)}`, 'meta');
    this.appendText(task.snapshot.text, 'text original');
    this.appendText(message ?? task.translated ?? '', 'text result');
    if (!message && task.translated) {
      const copyStatus = this.doc.createElement('div');
      copyStatus.className = 'copy-state';
      const copy = this.button('复制译文', () => {
        if (!task.translated) return;
        void navigator.clipboard?.writeText(task.translated).then(() => { copyStatus.textContent = '已复制译文'; }, () => { copyStatus.textContent = '复制失败，请选中译文后手动复制。'; });
        if (!navigator.clipboard) copyStatus.textContent = '当前网页不支持自动复制，请选中译文后手动复制。';
      });
      this.panel!.append(copy, copyStatus);
    }
    this.position(task.snapshot);
  }

  private appendText(text: string, className = 'text'): void {
    const node = this.doc.createElement('div');
    node.className = className;
    node.textContent = text;
    this.panel?.append(node);
  }

  private button(text: string, click: () => void): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', click);
    return button;
  }

  private position(snapshot: SelectionSnapshot): void {
    if (!this.host) return;
    const rect = snapshot.range.getBoundingClientRect();
    if (this.panel?.classList.contains('compact')) {
      const point = this.triggerPosition(snapshot.range, rect);
      this.host.style.setProperty('left', `${point.left}px`, 'important');
      this.host.style.setProperty('top', `${point.top}px`, 'important');
      return;
    }
    // 结果窗使用自身尺寸；尚未布局时也遵守 CSS 的窄视口最大宽高。
    const width = Math.min(this.host.offsetWidth || 360, Math.max(0, window.innerWidth - 24));
    const height = Math.min(this.host.offsetHeight || 48, Math.max(0, window.innerHeight - 24));
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const preferredTop = rect.bottom + 8;
    const top = preferredTop + height < window.innerHeight - 12 ? preferredTop : Math.max(12, Math.min(rect.top - height - 8, window.innerHeight - height - 12));
    this.host.style.setProperty('left', `${left}px`, 'important');
    this.host.style.setProperty('top', `${top}px`, 'important');
  }

  /** 小按钮跟随文字末行右端，方向取自规范化 Range，不受正反向拖选影响。 */
  private triggerPosition(range: Range, bounds: DOMRect): { left: number; top: number } {
    const size = 24;
    const gap = 6;
    const margin = 12;
    const rightLimit = window.innerWidth - size - margin;
    const bottomLimit = window.innerHeight - size - margin;
    const rects = Array.from(range.getClientRects?.() ?? []).filter(rect =>
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
}
