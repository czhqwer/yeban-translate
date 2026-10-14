import { send, type AppError, type PageStatus, type Reply, type SidePanelState } from '../shared/types';
import { createHost } from './dom';
import { createIcon } from './icons';

export interface FloatingActions {
  start: () => Promise<Reply<PageStatus>>;
  restore: () => Promise<Reply<PageStatus>>;
  status: () => PageStatus;
  reportError: (error: AppError | undefined) => void;
  updateSidePanel: (state: SidePanelState) => void;
}

interface DragState {
  pointerId: number;
  button: HTMLButtonElement;
  startX: number;
  startY: number;
  startTop: number;
  startPosition: number;
  dragging: boolean;
  selectionStyle?: { value: string; priority: string };
}

/** 两个图标分别切换按滚动翻译与原生侧栏，整组可沿页面右侧上下拖动。 */
export class FloatingTranslator {
  private host?: HTMLSpanElement;
  private primary?: HTMLButtonElement;
  private sidePanel?: HTMLButtonElement;
  private statusText?: HTMLElement;
  private interval?: ReturnType<typeof setInterval>;
  private restoring = false;
  private actionGeneration = 0;
  private sideGeneration = 0;
  private sidePending = false;
  private position = 0.5;
  private positionRestored = false;
  private positionGeneration = 0;
  private drag?: DragState;
  private suppressedClick?: HTMLButtonElement;
  private suppressionTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly doc: Document, private readonly actions: FloatingActions) {}

  /** 只恢复首份位置；迟到上下文不能覆盖用户已拖动的位置。 */
  setInitialPosition(position?: number): void {
    if (this.positionRestored) return;
    this.positionRestored = true;
    if (typeof position === 'number' && Number.isFinite(position) && position >= 0 && position <= 1) this.position = position;
    this.place();
  }

  /** 只有后台确认具备页面访问权限时才显示；关闭功能立即移除。 */
  setEnabled(enabled: boolean): void {
    if (!enabled) { this.destroy(); return; }
    if (this.host?.isConnected) return;
    const { host, shadow } = createHost(this.doc);
    host.setAttribute('data-yeban-floating', '');
    host.style.cssText = 'position:fixed!important;right:12px!important;transform:none!important;width:32px!important;height:64px!important;padding:0!important;margin:0!important;z-index:2147483645!important;display:block!important;outline:none!important;box-shadow:none!important;border:0!important;touch-action:none!important;';
    const style = this.doc.createElement('style');
    style.textContent = ':host{all:initial}*{box-sizing:border-box}.dock{font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;display:flex;flex-direction:column;align-items:center;gap:4px}button{display:grid;place-items:center;border:1px solid #d8e8e3;cursor:pointer;background:#fff;color:#176751;border-radius:8px;padding:0;box-shadow:0 2px 8px #183a241c}button:hover{background:#edf8f3}button:focus-visible{outline:1px solid #167266;outline-offset:1px}button:disabled{cursor:default;opacity:.6}svg{display:block;pointer-events:none}.primary{position:relative;width:32px;height:32px;background:#19745d;color:white;border:0;border-radius:50%}.primary:hover{background:#145b49}.primary[data-state="error"]::after{content:"";position:absolute;right:-1px;top:-1px;width:8px;height:8px;border:2px solid white;border-radius:50%;background:#b5472c}.primary[data-state="loading"]::before{content:"";position:absolute;inset:2px;border:1px solid #ffffff50;border-top-color:white;border-radius:50%;animation:loading 1s linear infinite}.side-panel{width:28px;height:28px}.side-panel[aria-pressed="true"]{background:#dbefe7;border-color:#19745d}.sr-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap}@keyframes loading{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.primary[data-state="loading"]::before{animation:none}}';
    const dock = this.doc.createElement('div');
    style.textContent += ':host([data-dragging]) button{cursor:grabbing}';
    dock.className = 'dock';
    dock.setAttribute('aria-label', '页伴翻译快捷入口');
    dock.style.touchAction = 'none';
    dock.addEventListener('pointerdown', event => this.beginDrag(event), true);
    this.primary = this.button('翻译当前页', () => { void this.toggleTranslation(); });
    this.primary.className = 'primary';
    this.primary.append(createIcon(this.doc, 'translate', 18));
    this.sidePanel = this.button('侧栏状态正在就绪', () => this.toggleSidePanel());
    this.sidePanel.className = 'side-panel';
    this.sidePanel.append(createIcon(this.doc, 'side-panel', 16));
    this.statusText = this.doc.createElement('span');
    this.statusText.className = 'sr-status';
    this.statusText.setAttribute('aria-live', 'polite');
    dock.append(this.primary, this.sidePanel, this.statusText);
    shadow.append(style, dock);
    this.doc.documentElement.append(host);
    this.host = host;
    this.place();
    this.doc.defaultView?.addEventListener('resize', this.place);
    this.refresh();
    this.interval = setInterval(() => this.refresh(), 500);
  }

  /** 状态刷新只读取当前文档内存，不查询后台或触发付费请求。 */
  refresh(): void {
    if (!this.statusText || !this.primary || !this.sidePanel) return;
    const status = this.actions.status();
    const canRestore = status.canRestore === true;
    const hasError = !!status.actionError || status.failed > 0 || status.state === 'unavailable';
    this.primary.disabled = this.restoring;
    this.primary.dataset.state = hasError ? 'error' : this.restoring || status.state === 'running' ? 'loading' : 'idle';
    this.primary.setAttribute('aria-pressed', String(canRestore));
    this.primary.setAttribute('aria-busy', String(this.restoring || status.state === 'running'));
    const primaryLabel = canRestore ? '恢复原文' : '翻译当前页';
    this.primary.setAttribute('aria-label', primaryLabel);
    this.primary.title = hasError ? `${primaryLabel}；错误详情见扩展工具栏` : primaryLabel;
    const panel = status.sidePanel;
    this.sidePanel.disabled = this.sidePending || !panel?.ready || !panel.canOpen && (!panel.open || !panel.canToggle);
    if (panel?.canToggle) this.sidePanel.setAttribute('aria-pressed', String(panel.open));
    else this.sidePanel.removeAttribute('aria-pressed');
    const sideLabel = !panel?.ready ? '侧栏状态正在就绪' : !panel.canToggle ? '打开侧栏（用原生×关闭）' : panel.open ? '关闭页伴翻译侧栏' : '打开页伴翻译侧栏';
    this.sidePanel.setAttribute('aria-label', sideLabel);
    this.sidePanel.title = panel?.ready && !panel.open && !panel.canOpen ? '当前浏览器不支持打开侧栏，请升级浏览器。' : sideLabel;
    const message = status.actionError?.message ?? (this.restoring ? '正在恢复原文…' : status.message ?? (canRestore ? '再次点击主按钮恢复原文。' : '点击主按钮开始按滚动翻译。'));
    if (this.statusText.textContent !== message) this.statusText.textContent = message;
  }

  destroy(): void {
    this.finishDrag(false);
    this.clearClickSuppression();
    this.doc.defaultView?.removeEventListener('resize', this.place);
    ++this.positionGeneration;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.host?.remove();
    this.host = undefined;
    this.primary = undefined;
    this.sidePanel = undefined;
    this.statusText = undefined;
  }

  /** 比例只映射到可移动区间；窗口过矮时优先保证按钮组顶部可见。 */
  private verticalBounds(): { min: number; travel: number } {
    const height = this.doc.defaultView?.innerHeight ?? this.doc.documentElement.clientHeight;
    const available = Math.max(0, height - 64);
    const min = Math.min(12, available / 2);
    return { min, travel: Math.max(0, available - min * 2) };
  }

  /** 状态刷新不参与定位，窗口缩放按记住的比例重新计算位置。 */
  private place = (): void => {
    const { min, travel } = this.verticalBounds();
    this.host?.style.setProperty('top', `${min + travel * this.position}px`, 'important');
  };

  /** 捕获原始按钮以保留轻点击目标，只有主指针左键可以发起拖动。 */
  private beginDrag(event: PointerEvent): void {
    if (this.drag || !event.isPrimary || event.button !== 0) return;
    const button = event.composedPath().find(node => node === this.primary || node === this.sidePanel) as HTMLButtonElement | undefined;
    if (!button || !this.host) return;
    this.clearClickSuppression();
    this.drag = { pointerId: event.pointerId, button, startX: event.clientX, startY: event.clientY, startTop: Number.parseFloat(this.host.style.top), startPosition: this.position, dragging: false };
    this.doc.addEventListener('pointermove', this.moveDrag, true);
    this.doc.addEventListener('pointerup', this.endDrag, true);
    this.doc.addEventListener('pointercancel', this.cancelDrag, true);
    this.doc.addEventListener('selectstart', this.preventSelection, true);
    this.doc.defaultView?.addEventListener('blur', this.cancelDrag);
    button.addEventListener('lostpointercapture', this.cancelDrag);
    try { button.setPointerCapture(event.pointerId); } catch { /* 捕获失败时仍通过文档监听收尾。 */ }
  }

  /** 超过阈值后仅更新内存与视觉位置，移动事件不会写入存储。 */
  private moveDrag = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    if (!drag.dragging) {
      drag.dragging = true;
      this.positionRestored = true;
      ++this.positionGeneration;
      const style = this.doc.documentElement.style;
      drag.selectionStyle = { value: style.getPropertyValue('user-select'), priority: style.getPropertyPriority('user-select') };
      style.setProperty('user-select', 'none', 'important');
      this.host?.setAttribute('data-dragging', '');
    }
    event.preventDefault();
    const { min, travel } = this.verticalBounds();
    if (travel > 0) this.position = Math.min(1, Math.max(0, (drag.startTop + event.clientY - drag.startY - min) / travel));
    this.place();
  };

  /** 松手时才保存一次；兼容 click 留给同步拦截，避免误触付费翻译。 */
  private endDrag = (event: PointerEvent): void => {
    if (this.drag?.pointerId === event.pointerId) this.finishDrag(true);
  };

  /** 取消、失去捕获或离开窗口都恢复拖动前位置，并释放全局临时监听。 */
  private cancelDrag = (event: Event): void => {
    if ('pointerId' in event && this.drag?.pointerId !== event.pointerId) return;
    this.finishDrag(false);
  };

  private preventSelection = (event: Event): void => {
    if (this.drag?.dragging) event.preventDefault();
  };

  /** 先清空拖动状态再释放捕获，避免 lostpointercapture 二次收尾。 */
  private finishDrag(commit: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    this.doc.removeEventListener('pointermove', this.moveDrag, true);
    this.doc.removeEventListener('pointerup', this.endDrag, true);
    this.doc.removeEventListener('pointercancel', this.cancelDrag, true);
    this.doc.removeEventListener('selectstart', this.preventSelection, true);
    this.doc.defaultView?.removeEventListener('blur', this.cancelDrag);
    drag.button.removeEventListener('lostpointercapture', this.cancelDrag);
    try { if (drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId); } catch { /* 已失效的指针无须再次释放。 */ }
    this.host?.removeAttribute('data-dragging');
    const style = this.doc.documentElement.style;
    if (drag.selectionStyle && style.getPropertyValue('user-select') === 'none' && style.getPropertyPriority('user-select') === 'important') {
      if (drag.selectionStyle.value) style.setProperty('user-select', drag.selectionStyle.value, drag.selectionStyle.priority);
      else style.removeProperty('user-select');
    }
    if (drag.dragging || !commit) this.suppressClick(drag.button);
    if (!drag.dragging) return;
    if (!commit) { this.position = drag.startPosition; this.place(); return; }
    const generation = ++this.positionGeneration;
    void send<number>({ type: 'SET_FLOATING_POSITION', position: this.position }).then(reply => {
      if (!this.host || generation !== this.positionGeneration || reply.ok) return;
      this.actions.reportError({ code: 'STORAGE', message: '悬浮按钮位置暂未保存，刷新后可能恢复原位置。', retryable: true });
      this.refresh();
    });
  }

  /** 新 pointerdown 会解除抑制；超时只防止未产生兼容 click 的设备留下旧标记。 */
  private suppressClick(button: HTMLButtonElement): void {
    this.clearClickSuppression();
    this.suppressedClick = button;
    this.suppressionTimer = setTimeout(() => this.clearClickSuppression(), 500);
  }

  private clearClickSuppression(): void {
    if (this.suppressionTimer) clearTimeout(this.suppressionTimer);
    this.suppressionTimer = undefined;
    this.suppressedClick = undefined;
  }

  /** 准备和运行期间都允许第二击恢复，只有恢复清理本身短暂禁用。 */
  private async toggleTranslation(): Promise<void> {
    if (this.restoring) return;
    const generation = ++this.actionGeneration;
    const restore = this.actions.status().canRestore === true;
    this.restoring = restore;
    this.actions.reportError(undefined);
    try {
      const operation = restore ? this.actions.restore() : this.actions.start();
      this.refresh();
      const reply = await operation;
      if (!reply.ok && generation === this.actionGeneration) this.actions.reportError(reply.error);
    } catch {
      if (generation === this.actionGeneration) this.actions.reportError({ code: 'PAGE_ERROR', message: '当前页面暂时无法处理翻译，请稍后重试。', retryable: true });
    } finally {
      if (generation === this.actionGeneration) this.restoring = false;
      this.refresh();
    }
  }

  /** 点击时直接使用已同步状态发消息，不能在 native open 前异步查询状态。 */
  private toggleSidePanel(): void {
    const state = this.actions.status().sidePanel;
    if (this.sidePending || !state?.ready) return;
    this.actions.reportError(undefined);
    const generation = ++this.sideGeneration;
    this.sidePending = true;
    // 旧浏览器缺少关闭事件，原生 X 后缓存可能过期；降级入口每次只请求打开。
    const changing = send<SidePanelState>({ type: 'SET_SIDE_PANEL', open: state.canToggle ? !state.open : true, windowId: state.windowId });
    this.refresh();
    void changing.then(reply => {
      if (reply.ok) this.actions.updateSidePanel(reply.value);
      else if (generation === this.sideGeneration) this.actions.reportError(reply.error);
    }).finally(() => {
      if (generation === this.sideGeneration) this.sidePending = false;
      this.refresh();
    });
  }

  private button(label: string, click: () => void): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.style.touchAction = 'none';
    // 鼠标不把焦点留在整个 Shadow DOM 宿主；键盘依然可以正常聚焦按钮。
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => {
      // 键盘 click 的 detail 为 0，不能被上一轮拖动的兼容点击标记吞掉。
      if (event.detail !== 0 && this.suppressedClick === button) {
        this.clearClickSuppression();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      click();
    });
    return button;
  }
}
