import { defaultSelection, resolvePreferences } from '../shared/services';
import { DEFAULT_HOVER_SHORTCUT, DEFAULT_PAGE_DISPLAY_MODE, send, type AppError, type ContentMessage, type PageContext, type PageStatus, type Reply, type SidePanelState, type TranslationSelection } from '../shared/types';
import { FloatingTranslator } from './floating';
import { PageTranslator } from './page';
import { SelectionTranslator } from './selection';
import { HoverTranslator } from './hover';

/** 当前文档只保存用户选择意图；自动服务在每次新任务时按最新顺序解析。 */
export class ContentController {
  readonly ready: Promise<void>;
  private readonly page: PageTranslator;
  private readonly selection: SelectionTranslator;
  private readonly floating: FloatingTranslator;
  private readonly hover: HoverTranslator;
  private selected?: TranslationSelection;
  private taskSelection?: TranslationSelection;
  private context?: PageContext;
  private contextGeneration = 0;
  private pageGeneration = 0;
  private preparingPage?: number;
  private restoringPage?: Promise<void>;
  private actionError?: AppError;
  private panelState?: SidePanelState;
  private panelWindowSync?: Promise<void>;
  private panelNeedsContext = false;
  private checkingForeignWindow?: number;
  private nextForeignWindow?: number;
  private lastPanelWindowCheck = 0;

  constructor(doc: Document) {
    this.page = new PageTranslator(doc);
    this.selection = new SelectionTranslator(doc, () => this.selected);
    this.hover = new HoverTranslator(doc, element => this.selection.translateElement(element));
    this.floating = new FloatingTranslator(doc, {
      start: () => this.startPage(),
      restore: () => this.handle({ type: 'RESTORE' }), status: () => this.status(),
      reportError: error => { this.actionError = error; },
      updateSidePanel: state => this.acceptSidePanel(state),
    });
    this.ready = this.refreshContext();
  }

  /** STATUS 同时返回选择意图及已有任务实际快照，避免把自动选择变成手选。 */
  status(): PageStatus {
    const status = this.page.status();
    const selected = this.selected ?? (this.context ? defaultSelection(this.context) : undefined);
    const actual = status.preferences ?? (this.context ? resolvePreferences(selected, this.context) : undefined);
    const preparing = this.preparingPage !== undefined && this.preparingPage === this.pageGeneration;
    return {
      ...status,
      ...(actual ? { preferences: { ...actual } } : {}),
      ...(selected ? { selection: { ...selected } } : {}),
      ...(preparing ? { state: 'running' as const, message: '正在准备按滚动翻译…' } : {}),
      canRestore: preparing || this.page.canRestore(),
      ...(this.panelState ? { sidePanel: { ...this.panelState, ready: this.panelState.ready && !this.panelNeedsContext } } : {}),
      ...(this.actionError ? { actionError: { ...this.actionError } } : {}),
    };
  }

  /** 工具栏、侧栏与浮球复用同一文档控制路径。 */
  async handle(message: ContentMessage): Promise<Reply<PageStatus>> {
    try {
      if ((message.type === 'SET_SELECTION' || message.type === 'SET_PREFERENCES') && (this.preparingPage !== undefined || this.restoringPage || this.page.isActive())) return this.reject('BUSY', '请先停止正文翻译，再切换当前页的服务或语言。');
      switch (message.type) {
        case 'PAGE_START': {
          const selected = message.selection ?? message.preferences;
          if (this.preparingPage !== undefined || this.restoringPage) return this.reject('BUSY', '当前翻译正在准备或恢复，请稍候。');
          if (this.page.isActive()) {
            if (this.taskSelection && JSON.stringify(selected) !== JSON.stringify(this.taskSelection)) return this.reject('BUSY', '请先停止当前翻译，再使用新的服务或语言。');
            return { ok: true, value: this.status() };
          }
          this.selected = { ...selected };
          return this.startPage();
        }
        case 'SET_SELECTION': this.selected = { ...message.selection }; this.actionError = undefined; break;
        case 'SET_PREFERENCES': this.selected = { ...message.preferences }; this.actionError = undefined; break;
        case 'PAGE_STOP': this.pageGeneration++; this.preparingPage = undefined; this.actionError = undefined; await this.page.stop(); break;
        case 'PAGE_RETRY': {
          const selected = this.selected ?? (this.context ? defaultSelection(this.context) : undefined);
          if (selected && this.taskSelection && JSON.stringify(selected) !== JSON.stringify(this.taskSelection)) return this.reject('CONFIG_CHANGED', '本页服务或语言已变更，请点击翻译此页重新开始。');
          this.actionError = undefined;
          await this.page.retry();
          break;
        }
        case 'RESTORE': {
          this.pageGeneration++;
          this.preparingPage = undefined;
          this.actionError = undefined;
          if (!this.restoringPage) {
            const restoring = Promise.all([this.page.restore(), this.selection.close()]).then(() => { this.taskSelection = undefined; }).finally(() => { if (this.restoringPage === restoring) this.restoringPage = undefined; });
            this.restoringPage = restoring;
          }
          await this.restoringPage;
          break;
        }
        case 'SIDE_PANEL_STATE':
          if (this.panelState?.windowId !== undefined && Number.isInteger(message.state.windowId) && message.state.windowId !== this.panelState.windowId) await this.syncPanelWindow(message.state.windowId!);
          else this.acceptSidePanel(message.state);
          break;
        case 'SITE_CHANGED':
        case 'FEATURES_CHANGED': await this.refreshContext(); break;
        case 'SERVICE_REMOVED':
          await Promise.all([this.page.serviceRemoved(message.provider), this.selection.serviceRemoved(message.provider)]);
          await this.refreshContext();
          break;
      }
      this.floating.refresh();
      return { ok: true, value: this.status() };
    } catch { return this.reject('PAGE_ERROR', '当前页面暂时无法处理翻译，请刷新页面后重试。', true); }
  }

  /** 功能通知始终重新核实后台状态，不直接相信站点级 enabled 字段。 */
  async refreshContext(): Promise<void> { await this.loadContext(); }

  /** 文档离开时停止两类任务，并移除本页浮球定时刷新。 */
  async suspend(): Promise<void> {
    this.pageGeneration++;
    this.preparingPage = undefined;
    this.contextGeneration++;
    this.nextForeignWindow = undefined;
    this.floating.destroy();
    this.hover.destroy();
    await Promise.all([this.page.stop(), this.selection.setEnabled(false), this.selection.setHoverEnabled(false)]);
  }

  private async loadContext(): Promise<Reply<PageContext>> {
    const generation = ++this.contextGeneration;
    const reply = await send<PageContext>({ type: 'GET_CONTEXT' });
    if (generation !== this.contextGeneration) return reply;
    if (!reply.ok) {
      await this.selection.setEnabled(false);
      this.hover.setEnabled(false);
      await this.selection.setHoverEnabled(false);
      if (generation === this.contextGeneration) this.floating.setEnabled(false);
      return reply;
    }
    if (reply.value.sidePanel) {
      this.acceptSidePanel(reply.value.sidePanel, true);
      if (reply.value.sidePanel.windowId !== undefined) this.panelNeedsContext = this.nextForeignWindow !== undefined;
    }
    this.floating.setInitialPosition(reply.value.floatingPosition);
    this.context = { ...reply.value, ...(this.panelState ? { sidePanel: { ...this.panelState } } : {}) };
    await Promise.all([
      this.selection.setEnabled(reply.value.selectionEnabled),
      this.selection.setHoverEnabled(reply.value.hoverTranslationEnabled === true),
    ]);
    this.hover.setEnabled(reply.value.hoverTranslationEnabled === true, reply.value.hoverShortcut ?? DEFAULT_HOVER_SHORTCUT);
    if (generation === this.contextGeneration) this.floating.setEnabled(reply.value.floatingEnabled === true);
    return reply;
  }

  private async startPage(): Promise<Reply<PageStatus>> {
    if (this.restoringPage) return this.reject('BUSY', '正在恢复原文，请稍候。');
    if (this.page.isActive() || this.preparingPage !== undefined) return { ok: true, value: this.status() };
    const generation = ++this.pageGeneration;
    const selected = this.selected ? { ...this.selected } : undefined;
    this.preparingPage = generation;
    this.actionError = undefined;
    try {
      const context = await this.loadContext();
      if (generation !== this.pageGeneration) return { ok: true, value: this.status() };
      if (!context.ok) { this.actionError = context.error; return context; }
      const actual = resolvePreferences(selected, context.value);
      if (!actual) return this.reject('CONFIG', '没有可用的翻译服务，请在页伴翻译设置中配置服务。');
      if (!context.value.dataNoticeAccepted) return this.reject('CONSENT', '请先在页伴翻译设置中确认文本发送说明。');
      this.taskSelection = selected ?? defaultSelection(context.value);
      await this.page.start(actual, 'viewport', context.value.pageDisplayMode ?? DEFAULT_PAGE_DISPLAY_MODE);
      return { ok: true, value: this.status() };
    } catch { return this.reject('PAGE_ERROR', '当前页面暂时无法处理翻译，请刷新页面后重试。', true); }
    finally { if (this.preparingPage === generation) this.preparingPage = undefined; this.floating.refresh(); }
  }

  /** 外窗广播可能代表标签迁移，只作为重新核实的信号，不能直接改操作目标。 */
  private syncPanelWindow(windowId: number): Promise<void> {
    if (this.panelWindowSync) {
      // 相同窗口的重复广播共用一个查询；查询期间再次迁移只保留最新一次核实。
      if (windowId !== this.checkingForeignWindow) this.nextForeignWindow = windowId;
      return this.panelWindowSync;
    }
    this.panelNeedsContext = true;
    const syncing = this.recheckPanelWindow(windowId).finally(() => {
      if (this.panelWindowSync === syncing) this.panelWindowSync = undefined;
      this.checkingForeignWindow = undefined;
      this.floating.refresh();
    });
    this.panelWindowSync = syncing;
    this.floating.refresh();
    return syncing;
  }

  /** 同时最多一个 GET_CONTEXT，连续外窗事件最多每 200ms 核实一次。 */
  private async recheckPanelWindow(windowId: number): Promise<void> {
    let checking: number | undefined = windowId;
    while (checking !== undefined) {
      this.checkingForeignWindow = checking;
      this.nextForeignWindow = undefined;
      this.panelNeedsContext = true;
      // 请求启动前就让旧上下文失效，避免节流等待期间的旧回执写回旧窗口。
      const generation = ++this.contextGeneration;
      const wait = Math.max(0, 200 - (Date.now() - this.lastPanelWindowCheck));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      else await Promise.resolve();
      if (generation === this.contextGeneration) {
        this.lastPanelWindowCheck = Date.now();
        const reply = await send<PageContext>({ type: 'GET_CONTEXT' });
        if (generation === this.contextGeneration) {
          if (reply.ok && reply.value.sidePanel?.windowId !== undefined) {
            this.acceptSidePanel(reply.value.sidePanel, true);
            this.panelNeedsContext = this.nextForeignWindow !== undefined;
          } else if (!reply.ok) this.actionError = reply.error;
        }
      }
      checking = this.nextForeignWindow;
    }
  }

  /** 窗口内按版本合并状态；旧上下文和迟到原生调用回复都不能回滚新广播。 */
  private acceptSidePanel(state: SidePanelState, fromContext = false): void {
    if (!Number.isFinite(state.version) || state.version < 0) return;
    const previous = this.panelState;
    if (previous) {
      const differentWindow = previous.windowId !== undefined && state.windowId !== previous.windowId;
      if (differentWindow && (!fromContext || state.windowId === undefined)) return;
      if (!differentWindow && (state.version < previous.version || state.version === previous.version && state.open !== previous.open)) return;
    }
    this.panelState = { ...state };
    if (this.context) this.context.sidePanel = { ...state };
  }

  private reject(code: string, message: string, retryable = false): Reply<PageStatus> {
    const error = { code, message, retryable };
    if (code !== 'BUSY') this.actionError = error;
    return { ok: false, error };
  }
}
