import { SELECTION_LIMIT, type BackgroundMessage, type Reply } from '../shared/types';
import type { ReadingDraft } from '../shared/image';
import { asError, failure, TranslationError } from './errors';
import { sameViewport, validRegion, type RegionCommand, type RegionEvent, type Viewport } from '../shared/region';
import { prepareRegion } from './region-image';

export const READING_SELECTION_MENU = 'yeban-reading-selection';
export const READING_CAPTURE_COMMAND = 'capture-reading';
type DraftBody = ReadingDraft extends infer D ? D extends ReadingDraft ? Omit<D, 'id'> : never : never;
interface RegionService {
  imageReadiness(): Promise<void>;
  translateRegion(image: string, signal: AbortSignal, guard: () => Promise<void>): Promise<{ translated: string }>;
}
interface RegionSession {
  token: string; tabId: number; windowId: number; url?: string; documentId?: string;
  controller: AbortController; phase: 'starting' | 'selecting' | 'working' | 'done'; timer: ReturnType<typeof setTimeout>;
}

/** 仅由浏览器菜单/快捷键或可信工具栏触发，不允许网页通过消息读取屏幕。 */
export class ReadingBridge {
  private drafts = new Map<number, { value: ReadingDraft; expires: number }>();
  private captures = new Map<number, RegionSession>();
  constructor(private readonly api: typeof chrome, private readonly service?: RegionService, private readonly crop = prepareRegion) {}

  install(): void {
    this.api.contextMenus.removeAll(() => {
      if (this.api.runtime.lastError) return;
      for (const item of [
        { id: READING_SELECTION_MENU, title: '使用页伴翻译选中文字', contexts: ['selection'] as [chrome.contextMenus.ContextType] },
      ]) this.api.contextMenus.create(item, () => { void this.api.runtime.lastError; });
    });
  }

  private put(windowId: number, body: DraftBody): void {
    for (const [id, draft] of this.drafts) if (draft.expires < Date.now()) this.drafts.delete(id);
    if (this.drafts.size >= 8) this.drafts.delete(this.drafts.keys().next().value!);
    this.drafts.set(windowId, { value: { ...body, id: crypto.randomUUID() }, expires: Date.now() + 120_000 });
    // 仅通知存在新草稿；正文和图片不广播，不写入磁盘或 URL。
    void this.api.runtime.sendMessage({ type: 'READING_DRAFT_READY', windowId }).catch(() => undefined);
  }

  private async open(windowId: number): Promise<void> {
    try { await this.api.sidePanel.open({ windowId }); }
    catch {
      // 不跳转新页面；保留选区，用户打开侧栏后自动载入。
    }
  }

  selection(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): void {
    if (!tab || !Number.isInteger(tab.windowId) || tab.windowId < 0) return;
    const text = info.selectionText?.trim();
    const body: DraftBody = !text ? { kind: 'error', message: '阅读器没有提供选中文字，请改用选区翻译或粘贴文本。' }
      : Array.from(text).length > SELECTION_LIMIT ? { kind: 'error', message: `选中文字超过 ${SELECTION_LIMIT} 字符，请缩小范围后重试。` }
        : { kind: 'text', text };
    this.put(tab.windowId, body);
    // 直接处于浏览器右键手势中，不能先等待配置初始化。
    void this.open(tab.windowId).catch(() => undefined);
  }

  async capture(tab: chrome.tabs.Tab): Promise<boolean> {
    if (tab.id === undefined || !Number.isInteger(tab.windowId) || tab.windowId < 0) return false;
    const previous = this.captures.get(tab.windowId);
    if (previous) this.dispose(previous);
    const session: RegionSession = { token: crypto.randomUUID(), tabId: tab.id, windowId: tab.windowId, url: tab.url, controller: new AbortController(), phase: 'starting', timer: setTimeout(() => this.dispose(session), 120_000) };
    this.captures.set(tab.windowId, session);
    try {
      await this.guard(session);
      // 只尝试顶层文档，不向 Chrome PDF 内部受保护的扩展帧注入。
      const result = await this.api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['region.js'] });
      session.documentId = result.find(frame => frame.frameId === 0)?.documentId;
      if (!session.documentId) throw new Error('当前文档不支持框选');
      await this.guard(session);
      let problem: string | undefined;
      try { if (!this.service) throw new Error(); await this.service.imageReadiness(); }
      catch (error) { problem = asError(error).message; }
      await this.guard(session);
      session.phase = 'selecting';
      await this.send(session, { type: 'REGION_START', token: session.token, problem });
      await this.api.action?.setBadgeText({ tabId: tab.id, text: '' }).catch(() => undefined);
      await this.api.action?.setTitle({ tabId: tab.id, title: '页伴翻译' }).catch(() => undefined);
      return true;
    } catch {
      if (this.captures.get(tab.windowId) !== session) return false;
      this.dispose(session);
      const message = '当前阅读器禁止显示框选层。可用系统截图后粘贴到页伴侧栏翻译；本地文件请先允许访问文件网址。';
      this.put(tab.windowId, { kind: 'error', message });
      await this.api.action?.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => undefined);
      await this.api.action?.setTitle({ tabId: tab.id, title: message }).catch(() => undefined);
      return false;
    }
  }

  private send(session: RegionSession, message: RegionEvent): Promise<unknown> {
    return this.api.tabs.sendMessage(session.tabId, message, { documentId: session.documentId, frameId: 0 });
  }

  private dispose(session: RegionSession): void {
    session.controller.abort(); clearTimeout(session.timer);
    if (this.captures.get(session.windowId) === session) this.captures.delete(session.windowId);
    if (session.documentId) void this.send(session, { type: 'REGION_DISPOSE', token: session.token }).catch(() => undefined);
  }

  private async guard(session: RegionSession, viewport?: Viewport): Promise<void> {
    const current = () => !session.controller.signal.aborted && this.captures.get(session.windowId) === session;
    if (!current()) throw new TranslationError('CANCELLED', '框选已结束，请重新框选。');
    const tab = (await this.api.tabs.query({ active: true, windowId: session.windowId }))[0];
    if (!current() || tab?.id !== session.tabId || tab.url !== session.url) throw new TranslationError('CANCELLED', '页面已切换，请重新框选。');
    if (viewport) {
      const frames = await this.api.scripting.executeScript({ target: { tabId: session.tabId, documentIds: [session.documentId!] }, func: () => ({ width: innerWidth, height: innerHeight, x: scrollX, y: scrollY, scale: visualViewport?.scale ?? 1 }) });
      if (!current() || !sameViewport(frames[0]?.result as Viewport, viewport)) throw new TranslationError('CANCELLED', '页面位置或缩放已变化，请重新框选。');
    }
  }

  private async region(message: RegionCommand, sender: chrome.runtime.MessageSender): Promise<unknown> {
    const session = sender.tab && this.captures.get(sender.tab.windowId);
    if (!session || sender.tab?.id !== session.tabId || sender.frameId !== 0 || sender.documentId !== session.documentId || message.token !== session.token) throw new TranslationError('FORBIDDEN', '框选会话已失效，请使用快捷键重新框选。');
    if (message.type === 'REGION_CANCEL') { this.dispose(session); return null; }
    if (message.type === 'REGION_SETTINGS') {
      await this.api.tabs.create({ url: `${this.api.runtime.getURL('options.html')}#privacy` });
      this.dispose(session); return null;
    }
    if (message.type !== 'REGION_CAPTURE' || session.phase !== 'selecting' || !validRegion(message.rect, message.viewport)) throw new TranslationError('INVALID', '选区无效，请重新框选。');
    session.phase = 'working';
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.dispose(session), 90_000);
    try {
      if (!this.service) throw new Error();
      await this.service.imageReadiness();
      await this.guard(session, message.viewport);
      let screen = await this.api.tabs.captureVisibleTab(session.windowId, { format: 'jpeg', quality: 95 });
      await this.guard(session, message.viewport);
      // 截图完成后才恢复加载提示，避免将提示或选框一起发送给模型。
      await this.send(session, { type: 'REGION_LOADING', token: session.token });
      const { image, style } = await this.crop(screen, message.rect, message.viewport);
      screen = '';
      await this.guard(session, message.viewport);
      const result = await this.service.translateRegion(image, session.controller.signal, () => this.guard(session, message.viewport));
      await this.guard(session, message.viewport);
      return { ...result, style };
    } finally {
      session.phase = 'done'; clearTimeout(session.timer);
      // 结果无需常驻后台内存；保留短时控制权以便关闭或再次框选。
      session.timer = setTimeout(() => this.dispose(session), 30 * 60_000);
      if (session.controller.signal.aborted) clearTimeout(session.timer);
    }
  }

  cancelAll(): void { for (const session of this.captures.values()) this.dispose(session); }
  removeWindow(windowId: number): void { this.drafts.delete(windowId); const session = this.captures.get(windowId); if (session) this.dispose(session); }
  tabChanged(tabId: number): void { for (const session of this.captures.values()) if (session.tabId === tabId) this.dispose(session); }
  tabActivated(windowId: number, tabId: number): void {
    const capture = this.captures.get(windowId);
    if (capture && capture.tabId !== tabId) this.dispose(capture);
  }

  async handle(input: unknown, sender: chrome.runtime.MessageSender): Promise<Reply<unknown>> {
    try {
      const message = input as Extract<BackgroundMessage, { type: 'TAKE_READING_DRAFT' | 'CAPTURE_READING' }> | RegionCommand;
      if (sender.id !== this.api.runtime.id || sender.documentLifecycle && sender.documentLifecycle !== 'active') throw new TranslationError('FORBIDDEN', '此操作仅可在扩展界面执行。');
      if (message.type.startsWith('REGION_')) return { ok: true, value: await this.region(message as RegionCommand, sender) };
      if (message.type === 'TAKE_READING_DRAFT' && sender.url === this.api.runtime.getURL('sidepanel.html') && Number.isInteger(message.windowId) && message.windowId >= 0) {
        if (sender.tab && sender.tab.windowId !== message.windowId) throw new TranslationError('FORBIDDEN', '不能读取其他窗口的内容。');
        const draft = this.drafts.get(message.windowId);
        this.drafts.delete(message.windowId);
        return { ok: true, value: draft && draft.expires > Date.now() ? draft.value : null };
      }
      if (message.type === 'CAPTURE_READING' && sender.url === this.api.runtime.getURL('popup.html') && Number.isInteger(message.tabId)) {
        if (!await this.capture(await this.api.tabs.get(message.tabId))) throw new TranslationError('CAPTURE_UNAVAILABLE', '当前阅读器禁止显示框选层。请用系统截图后粘贴至侧栏；本地文件请检查文件访问权限。');
        return { ok: true, value: null };
      }
      throw new TranslationError('FORBIDDEN', '此操作仅可在对应的扩展界面执行。');
    } catch (error) { return failure(error); }
  }
}
