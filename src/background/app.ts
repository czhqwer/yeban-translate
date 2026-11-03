import { DEFAULT_HOVER_SHORTCUT, DEFAULT_PAGE_DISPLAY_MODE, DEFAULT_PREFERENCES, DEFAULT_SERVICES, SELECTION_LIMIT } from '../shared/types';
import type { BackgroundMessage, ContentMessage, PageContext, PageDisplayMode, Preferences, ProviderId, PublicSettings, Reply, ServiceInput, SidePanelState, TranslationMode } from '../shared/types';
import { cancelled, failure, invalid, TranslationError } from './errors';
import { isConfigured, mergeService, translate, translateImage, type ServiceConfig } from './providers';
import { imageDimensions } from '../shared/image';
import { RequestPool } from './pool';
import { DEFAULT_PRIORITY, normalizePriority, resolveProvider } from '../shared/services';
import { PANEL_PORT_NAME, type PanelCommand, type PanelResponse } from '../shared/panel';
import { SidePanelManager } from './side-panel-state';
import { FloatingPositionStore } from './floating-position';
import { isLanguageCode, isSourceLanguage } from '../shared/languages';
import { normalizeShortcut } from '../shared/shortcuts';

interface StoredSettings {
  visionDefaultMigrated?: boolean;
  preferences: Preferences;
  services: Record<ProviderId, ServiceConfig>;
  sites: string[];
  dataNoticeAccepted: boolean;
  providerPriority: ProviderId[];
  selectionEnabled: boolean;
  allSitesEnabled: boolean;
  blockedSites: string[];
  pageDisplayMode: PageDisplayMode;
  hoverTranslationEnabled: boolean;
  hoverShortcut: string;
}
interface DocumentIdentity { tabId: number; frameId: number; documentId: string; origin: string }
interface Job extends DocumentIdentity {
  id: string;
  mode: TranslationMode;
  preferences: Preferences;
  version: number;
  stopped: boolean;
  reason?: string;
}
interface ControlState { jobs: Record<string, Job>; cooldown: Record<ProviderId, number>; revisions: Record<ProviderId, number> }
interface PendingResult { text: string; promise: Promise<{ translated: string }> }
interface PanelRequest { name: string; ownerId: string; id: string; provider: ProviderId; version: number; text: string; stopped: boolean; promise: Promise<{ translated: string }> }
const STORE = 'yebanSettings';
const CONTROL = 'yebanControl';
const providers: ProviderId[] = [...DEFAULT_PRIORITY];
const ALL_SITES = ['http://*/*', 'https://*/*'];
const ALL_REGISTRATION = 'yeban-all-sites';
const ALL_SITE_ALIASES = new Set([...ALL_SITES, '*://*/*', '<all_urls>']);

function provider(value: unknown): ProviderId {
  if (value !== 'bailian' && value !== 'aliyun') invalid();
  return value;
}
function preferences(value: unknown): Preferences {
  if (!value || typeof value !== 'object') invalid();
  const input = value as Preferences;
  if (!isSourceLanguage(input.source) || !isLanguageCode(input.target)) invalid('请选择支持的语言选项。');
  return { provider: provider(input.provider), source: input.source, target: input.target };
}
function mode(value: unknown): TranslationMode {
  if (value !== 'page' && value !== 'selection' && value !== 'hover') invalid();
  return value;
}
function pageDisplayMode(value: unknown): PageDisplayMode {
  if (value !== 'bilingual' && value !== 'translation' && value !== 'hover' && value !== 'parallel') invalid('请选择支持的页面展示模式。');
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/.test(value)) invalid();
  return value;
}
function siteOrigin(value: unknown): string {
  if (typeof value !== 'string') invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid('当前网站地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) invalid('只支持标准 HTTP / HTTPS 网站来源。');
  return url.origin;
}
function matches(origin: string): string { return `${origin}/*`; }
function originFromMatchPattern(value: unknown): string | undefined {
  if (typeof value !== 'string' || ALL_SITE_ALIASES.has(value) || !value.endsWith('/*')) return undefined;
  try { return siteOrigin(value.slice(0, -2)); } catch { return undefined; }
}
function registration(origin: string): string { return `yeban-site-${Array.from(new TextEncoder().encode(origin), n => n.toString(16).padStart(2, '0')).join('')}`; }
function jobName(doc: DocumentIdentity, kind: TranslationMode, id: string): string { return `${doc.tabId}/${doc.frameId}/${doc.documentId}/${kind}/${id}`; }
function sameDocument(a: DocumentIdentity, b: DocumentIdentity): boolean { return a.tabId === b.tabId && a.frameId === b.frameId && a.documentId === b.documentId; }

/** 唯一配置持有者；网页只能获得公开状态与其自身文档的任务结果。 */
export class BackgroundApp {
  readonly ready: Promise<void>;
  private settings!: StoredSettings;
  private controls!: ControlState;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly pools = { bailian: new RequestPool(), aliyun: new RequestPool() };
  private readonly snapshots = new Map<string, ServiceConfig>();
  private readonly pending = new Map<string, PendingResult>();
  private readonly testControllers = new Map<string, AbortController>();
  private readonly panels = new Map<string, PanelRequest>();
  private readonly panelPorts = new WeakSet<chrome.runtime.Port>();
  private allSitesGranted = false;
  private readonly sidePanels: SidePanelManager;
  private readonly floatingPosition: FloatingPositionStore;
  private floatingPositionWrites: Promise<unknown> = Promise.resolve();
  private readonly panelWindows = new Map<number, number>();
  private readonly panelWindowEpochs = new Map<number, number>();
  private readonly panelDetachedTabs = new Set<number>();
  private readonly panelRemovedWindows = new Set<number>();

  constructor(private readonly api: typeof chrome, private readonly fetcher: typeof fetch = fetch) {
    this.sidePanels = new SidePanelManager(api);
    this.floatingPosition = new FloatingPositionStore(api.storage.local);
    this.ready = this.initialize();
    // 初始化完成后再注入现有标签页，避免内容脚本的 GET_CONTEXT 等待初始化形成循环。
    void this.ready.then(() => this.injectEligibleTabs()).catch(() => undefined);
  }

  private async initialize(): Promise<void> {
    // 必须先限制访问级别，再读取本地配置、恢复状态或接受消息。
    await this.api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await this.api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await this.floatingPosition.initialize();
    await this.sidePanels.initialize();
    const stored = (await this.api.storage.local.get(STORE))[STORE] as StoredSettings | undefined;
    this.settings = stored ?? { preferences: { ...DEFAULT_PREFERENCES }, services: {
      bailian: { endpoint: DEFAULT_SERVICES.bailian.endpoint, model: DEFAULT_SERVICES.bailian.model, version: 0 },
      aliyun: { endpoint: DEFAULT_SERVICES.aliyun.endpoint, version: 0 },
    }, sites: [], dataNoticeAccepted: false, providerPriority: [...DEFAULT_PRIORITY], selectionEnabled: true, allSitesEnabled: false, blockedSites: [], pageDisplayMode: DEFAULT_PAGE_DISPLAY_MODE, hoverTranslationEnabled: false, hoverShortcut: DEFAULT_HOVER_SHORTCUT };
    this.settings.providerPriority = normalizePriority(stored?.providerPriority, stored?.preferences.provider);
    this.settings.selectionEnabled = stored?.selectionEnabled !== false;
    this.settings.allSitesEnabled = stored?.allSitesEnabled === true;
    this.settings.blockedSites = Array.isArray(stored?.blockedSites) ? stored.blockedSites.filter(origin => { try { return siteOrigin(origin) === origin; } catch { return false; } }) : [];
    this.settings.pageDisplayMode = stored?.pageDisplayMode && ['bilingual', 'translation', 'hover', 'parallel'].includes(stored.pageDisplayMode) ? stored.pageDisplayMode : DEFAULT_PAGE_DISPLAY_MODE;
    this.settings.hoverTranslationEnabled = stored?.hoverTranslationEnabled === true;
    this.settings.hoverShortcut = normalizeShortcut(stored?.hoverShortcut ?? '') ?? DEFAULT_HOVER_SHORTCUT;
    // 仅迁移旧版默认值一次；其他自定义模型和迁移后主动选回的模型均保留。
    if (!this.settings.visionDefaultMigrated) {
      if (!this.settings.services.bailian.model || this.settings.services.bailian.model === 'qwen-plus') {
        this.settings.services.bailian.model = DEFAULT_SERVICES.bailian.model;
        this.settings.services.bailian.version++;
      }
      this.settings.visionDefaultMigrated = true;
    }
    const prior = (await this.api.storage.session.get(CONTROL))[CONTROL] as ControlState | undefined;
    this.controls = prior ?? { jobs: {}, cooldown: { bailian: 0, aliyun: 0 }, revisions: { bailian: 0, aliyun: 0 } };
    // Worker 重启不恢复请求正文，也不重放结果未知的请求。
    for (const job of Object.values(this.controls.jobs)) { job.stopped = true; job.reason = 'DISCONNECTED'; }
    for (const id of providers) this.controls.revisions[id] = this.settings.services[id].version;
    await this.persistControl();
    await this.reconcileSites();
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation);
    this.serial = next.catch(() => undefined);
    return next;
  }

  private persistControl(): Promise<void> { return this.api.storage.session.set({ [CONTROL]: this.controls }); }
  private persistSettings(): Promise<void> { return this.api.storage.local.set({ [STORE]: this.settings }); }

  private trusted(sender: chrome.runtime.MessageSender): 'options' | 'popup' | 'sidepanel' | null {
    if (sender.id !== this.api.runtime.id) return null;
    if (sender.url?.split('#')[0] === this.api.runtime.getURL('options.html')) return 'options';
    if (sender.url === this.api.runtime.getURL('popup.html')) return 'popup';
    if (sender.url === this.api.runtime.getURL('sidepanel.html')) return 'sidepanel';
    return null;
  }

  /** 扩展协议的 URL.origin 可能是字符串 null，因此显式比较协议与主机。 */
  private trustedPanel(sender: chrome.runtime.MessageSender | undefined, cleanup = false): boolean {
    if (!sender || this.trusted(sender) !== 'sidepanel' || !cleanup && sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') return false;
    if (sender.origin === undefined) return true;
    try {
      const expected = new URL(this.api.runtime.getURL('sidepanel.html'));
      const origin = new URL(sender.origin);
      return origin.protocol === expected.protocol && origin.hostname === expected.hostname && !origin.port && !origin.username && !origin.password && !origin.search && !origin.hash && (origin.pathname === '' || origin.pathname === '/');
    } catch { return false; }
  }

  /** 每个原生 Port 取得独立身份；可选文档字段不参与身份兜底或跨窗口共享。 */
  connectPanel(port: chrome.runtime.Port): void {
    if (port.name !== PANEL_PORT_NAME || !this.trustedPanel(port.sender)) {
      try { port.disconnect(); } catch { /* 已断开的不可信连接无需再次处理。 */ }
      return;
    }
    if (this.panelPorts.has(port)) return;
    this.panelPorts.add(port);
    const ownerId = `port:${crypto.randomUUID()}`;
    const pending = new Set<string>();
    const controlsPending = new Set<string>();
    let closed = false;
    const close = (disconnect: boolean) => {
      if (closed) return;
      closed = true;
      this.cancelPanel(ownerId);
      pending.clear();
      controlsPending.clear();
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      this.panelPorts.delete(port);
      if (disconnect) try { port.disconnect(); } catch { /* 接收方关闭后无需再发送错误。 */ }
    };
    const send = (messageId: string, reply: PanelResponse['reply']) => {
      if (closed) return;
      try { port.postMessage({ messageId, reply } satisfies PanelResponse); } catch { close(true); }
    };
    const process = async (messageId: string, message: PanelCommand) => {
      try {
        await this.ready;
        if (closed) return;
        if (message.type === 'CANCEL_PANEL') {
          await this.exclusive(async () => { if (!closed) this.cancelPanel(ownerId, message.requestId); });
          send(messageId, { ok: true, value: null });
        } else {
          const request = await this.exclusive(async () => {
            if (closed) throw cancelled();
            return this.enqueuePanel(message, ownerId, () => !closed);
          });
          const value = await request.promise;
          send(messageId, { ok: true, value });
        }
      } catch (error) { send(messageId, failure(error)); }
      finally { pending.delete(messageId); controlsPending.delete(messageId); }
    };
    const onMessage = (value: unknown) => {
      if (closed) return;
      let messageId: string;
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
        const envelope = value as Record<string, unknown>;
        messageId = identifier(envelope.messageId);
        if (Object.keys(envelope).some(field => field !== 'messageId' && field !== 'message')) invalid();
      } catch { close(true); return; }
      if (pending.has(messageId)) { close(true); return; }
      try {
        const raw = (value as { message?: unknown }).message;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
        const command = raw as Record<string, unknown>;
        if (command.type !== 'TRANSLATE_PANEL' && command.type !== 'TRANSLATE_IMAGE' && command.type !== 'CANCEL_PANEL') throw new TranslationError('FORBIDDEN', '侧栏连接仅允许翻译和取消操作。');
        const fields = command.type === 'TRANSLATE_PANEL' ? ['type', 'requestId', 'preferences', 'text'] : command.type === 'TRANSLATE_IMAGE' ? ['type', 'requestId', 'image', 'target', 'operation', 'imageConsent'] : ['type', 'requestId'];
        if (Object.keys(command).some(field => !fields.includes(field))) invalid();
        const requestId = identifier(command.requestId);
        let message: PanelCommand = { type: 'CANCEL_PANEL', requestId };
        if (command.type === 'TRANSLATE_PANEL') {
          if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > SELECTION_LIMIT * 2 || Array.from(command.text).length > SELECTION_LIMIT) invalid('请输入 1 至 2000 个字符的待翻译文本。');
          message = { type: 'TRANSLATE_PANEL', requestId, text: command.text, preferences: preferences(command.preferences) };
        } else if (command.type === 'TRANSLATE_IMAGE') {
          try { imageDimensions(command.image); } catch { invalid('图片无效或过大，请重新选择。'); }
          if (command.target !== 'auto' && !isLanguageCode(command.target) || !['translate', 'recognize'].includes(String(command.operation))) invalid();
          if (command.imageConsent !== true) throw new TranslationError('CONSENT', '请确认图片发送说明。');
          message = command as unknown as Extract<PanelCommand, { type: 'TRANSLATE_IMAGE' }>;
        }
        // 翻译等待者不能占用取消通道；控制消息单独限额，滥用时断连清理全部请求。
        if (message.type !== 'CANCEL_PANEL' && pending.size - controlsPending.size >= 16) {
          send(messageId, failure(new TranslationError('QUEUE_FULL', '侧栏待处理翻译过多，请稍后重试。', true)));
          return;
        }
        if (message.type === 'CANCEL_PANEL') {
          if (controlsPending.size >= 4) { close(true); return; }
          controlsPending.add(messageId);
        }
        pending.add(messageId);
        void process(messageId, message);
      } catch (error) { send(messageId, failure(error)); }
    };
    const onDisconnect = () => close(false);
    // 监听器在等待存储初始化之前同步安装，断连立即禁止迟到处理器发起新请求。
    port.onDisconnect.addListener(onDisconnect);
    port.onMessage.addListener(onMessage);
  }

  private document(sender: chrome.runtime.MessageSender, allowChild = false): DocumentIdentity {
    if (sender.id !== this.api.runtime.id || !Number.isInteger(sender.tab?.id) || sender.tab!.id! < 0 || !Number.isInteger(sender.frameId) || sender.frameId! < 0 || !allowChild && sender.frameId !== 0 || typeof sender.documentId !== 'string' || !sender.documentId || sender.documentLifecycle && sender.documentLifecycle !== 'active') throw new TranslationError('FORBIDDEN', '当前页面无权执行此操作。');
    let url: URL;
    try { url = new URL(sender.url ?? ''); } catch { throw new TranslationError('FORBIDDEN', '当前页面地址不可用。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TranslationError('FORBIDDEN', '当前页面不支持翻译。');
    if (sender.origin && sender.origin !== url.origin) throw new TranslationError('FORBIDDEN', '页面来源校验失败，请刷新后重试。');
    return { tabId: sender.tab!.id!, frameId: sender.frameId!, documentId: sender.documentId, origin: url.origin };
  }

  private publicSettings(): PublicSettings {
    const result: PublicSettings = {
      preferences: { ...this.settings.preferences }, sites: [...this.settings.sites], dataNoticeAccepted: this.settings.dataNoticeAccepted,
      providerPriority: [...this.settings.providerPriority], selectionEnabled: this.settings.selectionEnabled,
      allSitesEnabled: this.settings.allSitesEnabled, allSitesGranted: this.allSitesGranted, blockedSites: [...this.settings.blockedSites],
      pageDisplayMode: this.settings.pageDisplayMode, hoverTranslationEnabled: this.settings.hoverTranslationEnabled, hoverShortcut: this.settings.hoverShortcut,
      services: {
        bailian: { endpoint: this.settings.services.bailian.endpoint, model: this.settings.services.bailian.model, configured: isConfigured('bailian', this.settings.services.bailian) },
        aliyun: { endpoint: this.settings.services.aliyun.endpoint, configured: isConfigured('aliyun', this.settings.services.aliyun) },
      },
    };
    result.preferences.provider = resolveProvider('auto', result.services, result.providerPriority) ?? this.settings.providerPriority[0];
    return result;
  }

  private async pageContext(doc: DocumentIdentity, sender: chrome.runtime.MessageSender): Promise<PageContext> {
    if (doc.frameId !== 0) await this.assertChildAccess(doc);
    const state = this.publicSettings();
    const enabled = await this.siteEnabled(doc.origin);
    const floatingEnabled = doc.frameId === 0 && await this.canUseFloating(doc, enabled);
    const sidePanel = doc.frameId === 0 ? await this.getSidePanelState({ tabId: doc.tabId }, sender) : undefined;
    return {
      preferences: state.preferences, services: state.services, providerPriority: state.providerPriority,
      dataNoticeAccepted: state.dataNoticeAccepted, selectionEnabled: this.settings.selectionEnabled && enabled,
      floatingEnabled, floatingPosition: this.floatingPosition.value(), sidePanel,
      pageDisplayMode: this.settings.pageDisplayMode,
      hoverTranslationEnabled: this.settings.hoverTranslationEnabled && enabled,
      hoverShortcut: this.settings.hoverShortcut,
    };
  }

  /** 浮球位置操作沿用浮球显示权限，兼容工具栏授予的当前文档临时权限。 */
  private async canUseFloating(doc: DocumentIdentity, enabled: boolean): Promise<boolean> {
    if (enabled) return true;
    if (this.settings.blockedSites.includes(doc.origin)) return false;
    try {
      const result = await this.api.scripting.executeScript({ target: { tabId: doc.tabId, documentIds: [doc.documentId] }, func: () => true });
      return result.some(item => item.documentId === doc.documentId && item.result === true);
    } catch { return false; }
  }

  /** 授权检查也按消息顺序执行，避免慢检查让较早的拖动覆盖新位置。 */
  private setFloatingPosition(doc: DocumentIdentity, position: number): Promise<number> {
    const operation = this.floatingPositionWrites.then(async () => {
      if (!await this.canUseFloating(doc, await this.siteEnabled(doc.origin))) throw new TranslationError('PERMISSION', '当前页面尚未授权使用浮球，请刷新或通过工具栏重新打开。');
      return this.floatingPosition.set(position);
    });
    this.floatingPositionWrites = operation.catch(() => undefined);
    return operation;
  }

  private async siteEnabled(origin: string): Promise<boolean> {
    if (this.settings.blockedSites.includes(origin) || (!this.settings.allSitesEnabled && !this.settings.sites.includes(origin))) return false;
    return this.api.permissions.contains({ origins: [matches(origin)] });
  }

  /** 子页面只使用已授权顶层网站的同源权限；跨站嵌入和不透明来源继续拒绝。 */
  private async assertChildAccess(doc: DocumentIdentity): Promise<void> {
    let tab: chrome.tabs.Tab;
    try { tab = await this.api.tabs.get(doc.tabId); } catch { throw new TranslationError('FORBIDDEN', '当前笔记页面已关闭。'); }
    let topOrigin: string;
    try { topOrigin = new URL(tab.url ?? '').origin; } catch { throw new TranslationError('FORBIDDEN', '无法核实笔记所在网站。'); }
    if (topOrigin !== doc.origin || !await this.siteEnabled(doc.origin)) throw new TranslationError('FORBIDDEN', '内嵌页面需要与已授权的网站同源。');
  }

  /** 页面只能操作浏览器 sender 对应标签；UI 使用先前核实的 tab → window 缓存。 */
  private sidePanelTarget(message: { tabId?: number }, sender: chrome.runtime.MessageSender, legacy = false): { tabId: number; windowId?: number } {
    if (sender.id !== this.api.runtime.id) throw new TranslationError('FORBIDDEN', '消息来源不受信任。');
    const trusted = this.trusted(sender);
    let tabId: number;
    if (trusted === 'popup' || trusted === 'sidepanel' || legacy && trusted === 'options') {
      tabId = message.tabId ?? sender.tab?.id ?? -1;
      if (!Number.isInteger(tabId) || tabId < 0) invalid('无法确定当前标签页，请从网页或工具栏重试。');
    } else {
      const doc = this.document(sender);
      tabId = doc.tabId;
      if (message.tabId !== undefined && message.tabId !== tabId) throw new TranslationError('FORBIDDEN', '页面不能操作其他标签页的侧栏。');
    }
    const actualWindow = sender.tab?.id === tabId ? sender.tab.windowId : undefined;
    // 已到达的原生移动事件比旧消息的 sender 快照更新，不能反向覆盖窗口归属。
    if (!this.panelWindows.has(tabId) && !this.panelDetachedTabs.has(tabId) && Number.isInteger(actualWindow) && actualWindow! >= 0 && !this.panelRemovedWindows.has(actualWindow!)) {
      this.panelWindows.set(tabId, actualWindow!);
      this.panelWindowEpochs.set(tabId, (this.panelWindowEpochs.get(tabId) ?? 0) + 1);
    }
    return { tabId, windowId: this.panelWindows.get(tabId) };
  }

  /** 预取实际窗口归属，点击时不再等待 tabs.get 或存储而丢失用户手势。 */
  private async getSidePanelState(message: { tabId?: number }, sender: chrome.runtime.MessageSender): Promise<SidePanelState> {
    const target = this.sidePanelTarget(message, sender);
    const epoch = (this.panelWindowEpochs.get(target.tabId) ?? 0) + 1;
    this.panelWindowEpochs.set(target.tabId, epoch);
    let tab: chrome.tabs.Tab | undefined;
    try { tab = await this.api.tabs.get(target.tabId); } catch { /* 仅在本次查询仍有效时清理缓存。 */ }
    if (this.panelWindowEpochs.get(target.tabId) !== epoch) return this.sidePanels.state(this.panelWindows.get(target.tabId));
    let windowId = tab?.windowId;
    if (this.panelDetachedTabs.has(target.tabId) || windowId !== undefined && this.panelRemovedWindows.has(windowId)) windowId = undefined;
    if (Number.isInteger(windowId) && windowId! >= 0) this.panelWindows.set(target.tabId, windowId!);
    else { this.panelWindows.delete(target.tabId); windowId = undefined; }
    return this.sidePanels.state(windowId);
  }

  /** 首个 await 前调用窗口级 API，payload 的 windowId 仅用于校验而非定位目标。 */
  private async setSidePanel(message: Extract<BackgroundMessage, { type: 'SET_SIDE_PANEL' }>, sender: chrome.runtime.MessageSender): Promise<Reply<SidePanelState>> {
    try {
      if (typeof message.open !== 'boolean') invalid();
      const target = this.sidePanelTarget(message, sender);
      if (target.windowId === undefined) throw new TranslationError('SIDE_PANEL_NOT_READY', '请先刷新当前窗口的侧栏状态，再点击操作。', true);
      if (message.windowId !== undefined && message.windowId !== target.windowId) throw new TranslationError('FORBIDDEN', '页面不能操作其他窗口的侧栏。');
      const operation = this.sidePanels.set(target.windowId, message.open);
      return { ok: true, value: await operation };
    } catch (error) { return failure(error); }
  }

  /** 保留旧打开入口；存在可信窗口归属时也采用窗口级打开。 */
  private async openSidePanel(message: Extract<BackgroundMessage, { type: 'OPEN_SIDE_PANEL' }>, sender: chrome.runtime.MessageSender): Promise<Reply<unknown>> {
    try {
      const target = this.sidePanelTarget(message, sender, true);
      const opening = target.windowId === undefined ? this.sidePanels.openLegacy(target.tabId) : this.sidePanels.set(target.windowId, true);
      await opening;
      return { ok: true, value: null };
    } catch (error) {
      if (error instanceof TranslationError) return failure(error);
      return failure(new TranslationError('SIDE_PANEL', '侧栏未能打开，请再次点击打开按钮或升级浏览器。', true));
    }
  }

  /** 所有入口等待初始化；任何未知消息与跨上下文操作均默认拒绝。 */
  async handle(input: unknown, sender: chrome.runtime.MessageSender): Promise<Reply<unknown>> {
    try {
      if (input && typeof input === 'object' && (input as BackgroundMessage).type === 'OPEN_SIDE_PANEL') return this.openSidePanel(input as Extract<BackgroundMessage, { type: 'OPEN_SIDE_PANEL' }>, sender);
      if (input && typeof input === 'object' && (input as BackgroundMessage).type === 'SET_SIDE_PANEL') return this.setSidePanel(input as Extract<BackgroundMessage, { type: 'SET_SIDE_PANEL' }>, sender);
      await this.ready;
      if (!input || typeof input !== 'object' || sender.id !== this.api.runtime.id) throw new TranslationError('FORBIDDEN', '消息来源不受信任。');
      const message = input as BackgroundMessage;
      const trusted = this.trusted(sender);
      const administration = ['GET_SETTINGS', 'SAVE_SETTINGS', 'DELETE_SERVICE', 'TEST_SERVICE', 'ENABLE_SITE', 'DISABLE_SITE', 'ENABLE_ALL_SITES', 'DISABLE_ALL_SITES'];
      if (administration.includes(message.type) && !trusted) throw new TranslationError('FORBIDDEN', '请在扩展界面执行此操作。');
      if (trusted === 'sidepanel' && !['GET_SETTINGS', 'GET_SIDE_PANEL_STATE', 'TRANSLATE_PANEL', 'CANCEL_PANEL'].includes(message.type)) throw new TranslationError('FORBIDDEN', '侧栏仅支持文本翻译，请在设置页管理服务。');
      if (message.type === 'SAVE_SETTINGS' && message.config !== undefined && trusted !== 'options') throw new TranslationError('FORBIDDEN', '请在设置页修改服务配置。');
      let value: unknown;
      switch (message.type) {
        case 'GET_SETTINGS': this.allSitesGranted = await this.api.permissions.contains({ origins: ALL_SITES }); value = this.publicSettings(); break;
        case 'GET_CONTEXT': value = await this.pageContext(this.document(sender, true), sender); break;
        case 'SET_FLOATING_POSITION': value = await this.setFloatingPosition(this.document(sender), message.position); break;
        case 'GET_SIDE_PANEL_STATE': value = await this.getSidePanelState(message, sender); break;
        case 'SAVE_SETTINGS': value = await this.exclusive(() => this.save(message)); await this.notifyAll({ type: 'FEATURES_CHANGED' }); break;
        case 'DELETE_SERVICE': {
          const id = provider(message.provider);
          value = await this.exclusive(() => this.removeService(id));
          // 页面收到通知会回调 CANCEL_JOB；必须先释放控制锁再等待页面回执。
          await this.notifyAll({ type: 'SERVICE_REMOVED', provider: id });
          await this.notifyAll({ type: 'FEATURES_CHANGED' });
          break;
        }
        case 'TEST_SERVICE': value = await this.testService(provider(message.provider)); break;
        case 'TRANSLATE_PANEL': {
          const request = await this.exclusive(() => this.enqueuePanel(message, this.panelDocument(sender)));
          value = await request.promise;
          break;
        }
        case 'CANCEL_PANEL': value = await this.exclusive(async () => { this.cancelPanel(this.panelDocument(sender, true), identifier(message.requestId)); return null; }); break;
        case 'ENABLE_ALL_SITES': {
          value = await this.exclusive(() => this.enableAllSites());
          await this.injectEligibleTabs();
          await this.notifyAll({ type: 'FEATURES_CHANGED' });
          break;
        }
        case 'DISABLE_ALL_SITES': {
          await this.exclusive(async () => {
            this.settings.allSitesEnabled = false;
            for (const [name, job] of Object.entries(this.controls.jobs)) if (job.mode === 'selection' || job.mode === 'hover') this.stopJob(name, job, 'PERMISSION');
            await this.persistControl();
            await this.reconcileSites();
          });
          // remove 会触发 onRemoved，不能在控制锁内等待事件的后台回调。
          await this.api.permissions.remove({ origins: ALL_SITES });
          await this.permissionsRemoved();
          value = this.publicSettings();
          break;
        }
        case 'ENABLE_SITE': {
          const origin = siteOrigin(message.origin);
          value = await this.exclusive(() => this.enableSite(origin));
          await this.injectSite(origin);
          break;
        }
        case 'DISABLE_SITE': {
          const origin = siteOrigin(message.origin);
          value = await this.exclusive(() => this.disableSite(origin));
          await this.notifyAll({ type: 'SITE_CHANGED', enabled: false }, origin);
          break;
        }
        case 'BEGIN_JOB': value = await this.exclusive(() => this.begin(this.document(sender, message.mode === 'selection' || message.mode === 'hover'), mode(message.mode), identifier(message.jobId), preferences(message.preferences))); break;
        case 'CANCEL_JOB': value = await this.exclusive(() => this.cancel(this.document(sender, message.mode === 'selection' || message.mode === 'hover'), mode(message.mode), message.jobId === undefined ? undefined : identifier(message.jobId))); break;
        case 'TRANSLATE': {
          const document = this.document(sender, message.mode === 'selection' || message.mode === 'hover');
          const request = await this.exclusive(() => this.enqueue(document, mode(message.mode), identifier(message.jobId), identifier(message.itemId), message.text));
          value = await request.promise;
          break;
        }
        default: throw new TranslationError('FORBIDDEN', '不支持此操作。');
      }
      return { ok: true, value };
    } catch (error) { return failure(error); }
  }

  private async save(message: Extract<BackgroundMessage, { type: 'SAVE_SETTINGS' }>): Promise<PublicSettings> {
    const next: StoredSettings = structuredClone(this.settings);
    if (message.preferences !== undefined) next.preferences = preferences(message.preferences);
    if (message.providerPriority !== undefined) {
      if (!Array.isArray(message.providerPriority) || message.providerPriority.length !== 2 || new Set(message.providerPriority).size !== 2 || message.providerPriority.some(id => !providers.includes(id))) invalid('服务优先级必须包含两种服务，且不能重复。');
      next.providerPriority = [...message.providerPriority];
    }
    if (message.selectionEnabled !== undefined) {
      if (typeof message.selectionEnabled !== 'boolean') invalid();
      next.selectionEnabled = message.selectionEnabled;
    }
    if (message.pageDisplayMode !== undefined) next.pageDisplayMode = pageDisplayMode(message.pageDisplayMode);
    if (message.hoverTranslationEnabled !== undefined) {
      if (typeof message.hoverTranslationEnabled !== 'boolean') invalid();
      next.hoverTranslationEnabled = message.hoverTranslationEnabled;
    }
    if (message.hoverShortcut !== undefined) {
      if (typeof message.hoverShortcut !== 'string') invalid();
      const shortcut = normalizeShortcut(message.hoverShortcut);
      if (!shortcut) invalid('快捷键需要包含 Ctrl、Alt 或 Meta，并搭配一个字母、数字或功能键。');
      next.hoverShortcut = shortcut;
    }
    if (message.dataNoticeAccepted !== undefined) {
      if (typeof message.dataNoticeAccepted !== 'boolean') invalid();
      next.dataNoticeAccepted = message.dataNoticeAccepted;
    }
    let changed: ProviderId | undefined;
    if (message.config !== undefined) {
      changed = provider(message.provider);
      next.services[changed] = mergeService(changed, next.services[changed], message.config as ServiceInput);
    }
    if (changed) this.stopProvider(changed, 'CONFIG_CHANGED');
    if (!next.dataNoticeAccepted) for (const id of providers) this.stopProvider(id, 'CONSENT');
    if (!next.selectionEnabled) for (const [name, job] of Object.entries(this.controls.jobs)) if (job.mode === 'selection') this.stopJob(name, job, 'FEATURE_DISABLED');
    if (!next.hoverTranslationEnabled) for (const [name, job] of Object.entries(this.controls.jobs)) if (job.mode === 'hover') this.stopJob(name, job, 'FEATURE_DISABLED');
    this.settings = next;
    if (changed) this.controls.revisions[changed] = next.services[changed].version;
    await this.persistControl();
    await this.persistSettings();
    return this.publicSettings();
  }

  private stopJob(name: string, job: Job, reason: string, error?: TranslationError): void {
    job.stopped = true;
    job.reason = reason;
    this.snapshots.delete(name);
    this.pools[job.preferences.provider].cancel(name, error);
    for (const pending of this.pending.keys()) if (pending.startsWith(`${name}/`)) this.pending.delete(pending);
  }

  private stopProvider(id: ProviderId, reason: string, error?: TranslationError): void {
    for (const [name, job] of Object.entries(this.controls.jobs)) if (job.preferences.provider === id) this.stopJob(name, job, reason, error);
    for (const [name, controller] of this.testControllers) if (name.startsWith(`${id}/`)) { controller.abort(); this.pools[id].cancel(name, error); }
    for (const panel of this.panels.values()) if (panel.provider === id) { panel.stopped = true; this.pools[id].cancel(panel.name, error); }
  }

  private async removeService(id: ProviderId): Promise<PublicSettings> {
    const version = this.settings.services[id].version + 1;
    this.stopProvider(id, 'SERVICE_REMOVED');
    this.settings.services[id] = { endpoint: DEFAULT_SERVICES[id].endpoint, model: DEFAULT_SERVICES[id].model, version };
    this.controls.revisions[id] = version;
    await this.persistControl();
    await this.persistSettings();
    return this.publicSettings();
  }

  private async assertJob(name: string): Promise<Job> {
    const job = this.controls.jobs[name];
    if (!job || job.stopped || !this.snapshots.has(name)) throw cancelled();
    const config = this.settings.services[job.preferences.provider];
    if (config.version !== job.version || this.controls.revisions[job.preferences.provider] !== job.version) throw cancelled();
    if (!this.settings.dataNoticeAccepted) throw new TranslationError('CONSENT', '请先在扩展界面确认文本发送说明。');
    if (this.controls.cooldown[job.preferences.provider] > Date.now()) throw new TranslationError('RATE_LIMIT', '服务正在冷却，请稍后重试。', true);
    let tab: chrome.tabs.Tab;
    try { tab = await this.api.tabs.get(job.tabId); } catch { throw cancelled(); }
    if (!tab.url) throw new TranslationError('PERMISSION', '当前页面访问授权已失效，请重新点击扩展。');
    let currentOrigin: string;
    try { currentOrigin = new URL(tab.url).origin; } catch { throw cancelled(); }
    if (currentOrigin !== job.origin) throw cancelled();
    if (job.mode === 'selection' && (!this.settings.selectionEnabled || !await this.siteEnabled(job.origin))) throw new TranslationError('PERMISSION', '此网站尚未启用划词翻译，请先授权。');
    if (job.mode === 'hover' && (!this.settings.hoverTranslationEnabled || !await this.siteEnabled(job.origin))) throw new TranslationError('PERMISSION', '此网站尚未启用鼠标悬停翻译，请先在设置页开启并授权。');
    // 在准确的 documentId 上做无数据脚本探测，同时验证 activeTab / 站点授权与文档仍然存活。
    try {
      const result = await this.api.scripting.executeScript({ target: { tabId: job.tabId, documentIds: [job.documentId] }, func: () => true });
      if (!result.some(item => item.documentId === job.documentId && item.result === true)) throw cancelled();
    } catch { throw new TranslationError('PERMISSION', '当前文档或页面授权已变化，请重新开始。'); }
    if (job.stopped || this.controls.jobs[name] !== job || config.version !== this.settings.services[job.preferences.provider].version) throw cancelled();
    return job;
  }

  private async begin(doc: DocumentIdentity, kind: TranslationMode, id: string, prefs: Preferences): Promise<{ revision: number }> {
    if (!this.settings.dataNoticeAccepted) throw new TranslationError('CONSENT', '请先在扩展界面确认文本发送说明。');
    const config = this.settings.services[prefs.provider];
    if (!isConfigured(prefs.provider, config)) throw new TranslationError('CONFIG', '请先在设置页配置当前翻译服务。');
    const name = jobName(doc, kind, id);
    const current = this.controls.jobs[name];
    if (current && !current.stopped && this.snapshots.has(name)) { await this.assertJob(name); return { revision: current.version }; }
    for (const [otherName, job] of Object.entries(this.controls.jobs)) {
      if (sameDocument(job, doc) && job.mode === kind) this.stopJob(otherName, job, 'REPLACED');
    }
    this.controls.jobs[name] = { ...doc, id, mode: kind, preferences: { ...prefs }, version: config.version, stopped: false };
    this.snapshots.set(name, { ...config });
    try { await this.assertJob(name); } catch (error) { this.stopJob(name, this.controls.jobs[name], 'INVALID'); await this.persistControl(); throw error; }
    this.trimStopped();
    await this.persistControl();
    return { revision: config.version };
  }

  private trimStopped(): void {
    const entries = Object.entries(this.controls.jobs);
    if (entries.length <= 500) return;
    let excess = entries.length - 500;
    for (const [name, job] of entries) if (job.stopped && excess-- > 0) delete this.controls.jobs[name];
  }

  private async cancel(doc: DocumentIdentity, kind: TranslationMode, id?: string): Promise<null> {
    for (const [name, job] of Object.entries(this.controls.jobs)) {
      if (sameDocument(job, doc) && job.mode === kind && (id === undefined || job.id === id)) this.stopJob(name, job, 'CANCELED');
    }
    await this.persistControl();
    return null;
  }

  private async enqueue(doc: DocumentIdentity, kind: TranslationMode, id: string, itemId: string, text: unknown): Promise<{ promise: Promise<{ translated: string }> }> {
    if (typeof text !== 'string' || !text.trim()) invalid('没有可翻译的文本。');
    const length = Array.from(text).length;
    if (length > (kind === 'page' ? 4999 : SELECTION_LIMIT)) invalid(kind === 'selection' ? '选中文本过长，请缩小到 2000 个字符以内。' : '当前段落过长，请缩小翻译范围。');
    const name = jobName(doc, kind, id);
    const job = this.controls.jobs[name];
    if (!job || !sameDocument(job, doc) || job.origin !== doc.origin || job.stopped) throw cancelled();
    const config = this.snapshots.get(name);
    if (!config) throw new TranslationError('DISCONNECTED', '后台已重新启动，请重新开始翻译。', true);
    const pendingId = `${name}/${itemId}`;
    const existing = this.pending.get(pendingId);
    if (existing) {
      if (existing.text !== text) invalid('同一文本标识对应的内容已变化，请重新开始。');
      return { promise: existing.promise };
    }
    if (this.pending.size >= 1000) throw new TranslationError('QUEUE_FULL', '待翻译内容过多，请等待当前请求完成。', true);
    const promise = this.pools[job.preferences.provider].enqueue(name, kind, async signal => {
      try {
        const translated = await translate(config, job.preferences, text, { signal, fetcher: this.fetcher, beforeRequest: async () => { await this.assertJob(name); } });
        await this.assertJob(name);
        if (signal.aborted) throw cancelled();
        return { translated };
      } catch (error) {
        await this.serviceFailure(job.preferences.provider, error);
        throw error;
      }
    });
    this.pending.set(pendingId, { text, promise });
    void promise.finally(() => { if (this.pending.get(pendingId)?.promise === promise) this.pending.delete(pendingId); }).catch(() => undefined);
    return { promise };
  }

  private async serviceFailure(id: ProviderId, error: unknown): Promise<void> {
    if (!(error instanceof TranslationError) || !['AUTH', 'CONFIG', 'QUOTA', 'RATE_LIMIT'].includes(error.code)) return;
    await this.exclusive(async () => {
      if (error.code === 'RATE_LIMIT') this.controls.cooldown[id] = Date.now() + 30000;
      this.stopProvider(id, error.code, error);
      await this.persistControl();
    });
  }

  private async testService(id: ProviderId): Promise<{ translated: string }> {
    const config = { ...this.settings.services[id] };
    if (!isConfigured(id, config)) throw new TranslationError('CONFIG', '请先保存当前服务配置。');
    const name = `${id}/${crypto.randomUUID()}`;
    const controller = new AbortController();
    this.testControllers.set(name, controller);
    try {
      return await this.pools[id].enqueue(name, 'selection', async signal => {
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        const check = async () => {
          if (controller.signal.aborted || this.settings.services[id].version !== config.version) throw cancelled();
          if (this.controls.cooldown[id] > Date.now()) throw new TranslationError('RATE_LIMIT', '服务正在冷却，请稍后重试。', true);
        };
        try {
          const translated = await translate(config, { provider: id, source: 'en', target: 'zh' }, 'Hello, world.', { signal: controller.signal, fetcher: this.fetcher, beforeRequest: check });
          await check();
          return { translated };
        } finally { signal.removeEventListener('abort', abort); }
      });
    } catch (error) { await this.serviceFailure(id, error); throw error; }
    finally { this.testControllers.delete(name); }
  }

  private panelDocument(sender: chrome.runtime.MessageSender, cleanup = false): string {
    // 旧消息入口只兼容具有真实文档标识的调用；缺字段应改用独立 Port。
    if (!this.trustedPanel(sender, cleanup) || typeof sender.documentId !== 'string' || !sender.documentId) throw new TranslationError('FORBIDDEN', '请重新打开原生侧栏，通过独立连接进行文本翻译。');
    return `document:${sender.documentId}`;
  }

  private cancelPanel(ownerId: string, id?: string): void {
    for (const panel of this.panels.values()) {
      if (panel.ownerId !== ownerId || id !== undefined && panel.id !== id) continue;
      panel.stopped = true;
      this.pools[panel.provider].cancel(panel.name);
    }
  }

  /** 侧栏翻译只依赖自身文档和服务配置，不读取网页，也不要求网页主机授权。 */
  /** 只由后台建立的框选会话调用；网页消息不能直接调用此入口。 */
  async imageReadiness(): Promise<void> {
    await this.ready;
    if (!this.settings.dataNoticeAccepted) throw new TranslationError('CONSENT', '请先在设置页确认数据使用说明。');
    if (!isConfigured('bailian', this.settings.services.bailian)) throw new TranslationError('CONFIG', '请先在设置页配置百炼，默认模型为 qwen3-vl-plus。');
  }

  async translateRegion(image: string, signal: AbortSignal, guard: () => Promise<void>): Promise<{ translated: string }> {
    await this.imageReadiness();
    imageDimensions(image);
    const ownerId = `region:${crypto.randomUUID()}`;
    const cancel = () => this.cancelPanel(ownerId);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const request = await this.exclusive(() => this.enqueuePanel({ type: 'TRANSLATE_IMAGE', requestId: crypto.randomUUID(), image, target: 'auto', operation: 'translate', imageConsent: true }, ownerId, () => !signal.aborted, guard));
      return await request.promise;
    } finally { signal.removeEventListener('abort', cancel); }
  }

  private async enqueuePanel(message: Exclude<PanelCommand, { type: 'CANCEL_PANEL' }>, ownerId: string, ownerActive: () => boolean = () => true, guard?: () => Promise<void>): Promise<{ promise: Promise<{ translated: string }> }> {
    if (!ownerActive()) throw cancelled();
    const id = identifier(message.requestId);
    const prefs: Preferences = message.type === 'TRANSLATE_IMAGE' ? { provider: 'bailian', source: 'auto', target: message.target === 'auto' ? 'zh' : message.target } : preferences(message.preferences);
    if (message.type === 'TRANSLATE_PANEL' && (typeof message.text !== 'string' || !message.text.trim() || Array.from(message.text).length > SELECTION_LIMIT)) invalid('请输入 1 至 2000 个字符的待翻译文本。');
    const identity = JSON.stringify(message);
    if (!this.settings.dataNoticeAccepted) throw new TranslationError('CONSENT', '请先在设置页确认文本发送说明。');
    const config = { ...this.settings.services[prefs.provider] };
    if (!isConfigured(prefs.provider, config)) throw new TranslationError('CONFIG', '请先在设置页配置当前翻译服务。');
    const name = `panel/${ownerId}/${id}`;
    const existing = this.panels.get(name);
    if (existing && !existing.stopped) {
      if (existing.text !== identity) invalid('同一请求标识的内容已变化，请重新翻译。');
      return { promise: existing.promise };
    }
    this.cancelPanel(ownerId);
    if (this.panels.size >= 100) throw new TranslationError('QUEUE_FULL', '侧栏待翻译请求过多，请稍后重试。', true);
    const entry = { name, ownerId, id, provider: prefs.provider, version: config.version, text: identity, stopped: false } as PanelRequest;
    const check = async () => {
      await guard?.();
      if (!ownerActive() || entry.stopped || this.panels.get(name) !== entry || this.settings.services[prefs.provider].version !== config.version) throw cancelled();
      if (!this.settings.dataNoticeAccepted) throw new TranslationError('CONSENT', '文本发送授权已关闭，请重新确认。');
      if (this.controls.cooldown[prefs.provider] > Date.now()) throw new TranslationError('RATE_LIMIT', '服务正在冷却，请稍后重试。', true);
    };
    entry.promise = this.pools[prefs.provider].enqueue(name, 'selection', async signal => {
      try {
        const options = { signal, fetcher: this.fetcher, beforeRequest: check };
        const result = message.type === 'TRANSLATE_IMAGE' ? await translateImage(config, message, options) : { translated: await translate(config, prefs, message.text, options) };
        await check();
        if (signal.aborted) throw cancelled();
        return result;
      } catch (error) { await this.serviceFailure(prefs.provider, error); throw error; }
    });
    this.panels.set(name, entry);
    void entry.promise.finally(() => { if (this.panels.get(name) === entry) this.panels.delete(name); }).catch(() => undefined);
    return { promise: entry.promise };
  }

  private async enableSite(origin: string): Promise<PublicSettings> {
    if (!await this.api.permissions.contains({ origins: [matches(origin)] })) throw new TranslationError('PERMISSION', '尚未获得此网站权限，请先在弹窗中授权。');
    this.settings.blockedSites = this.settings.blockedSites.filter(site => site !== origin);
    if (!this.settings.allSitesEnabled && !this.settings.sites.includes(origin)) this.settings.sites.push(origin);
    await this.reconcileSites();
    return this.publicSettings();
  }

  private async enableAllSites(): Promise<PublicSettings> {
    this.allSitesGranted = await this.api.permissions.contains({ origins: ALL_SITES });
    if (!this.allSitesGranted) throw new TranslationError('PERMISSION', '尚未获得全部 HTTP / HTTPS 网站权限，请先主动授权。');
    this.settings.allSitesEnabled = true;
    await this.reconcileSites();
    return this.publicSettings();
  }

  /** 注入脚本与页面通知放在控制锁外，允许内容脚本回调后台。 */
  private async injectSite(origin: string): Promise<void> {
    for (const tab of await this.api.tabs.query({ url: matches(origin) })) {
      if (tab.id === undefined) continue;
      if (!await this.siteEnabled(origin)) return;
      try {
        await this.api.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
        await this.api.tabs.sendMessage(tab.id, { type: 'SITE_CHANGED', enabled: await this.siteEnabled(origin) } satisfies ContentMessage);
      } catch { /* 尚在导航或不可注入的标签页，在下次加载时使用注册脚本。 */ }
    }
  }

  /** 全站启用后同步当前已打开网页，屏蔽站点和浏览器内置页不注入。 */
  private async injectEligibleTabs(): Promise<void> {
    for (const tab of await this.api.tabs.query({})) {
      if (tab.id === undefined || !tab.url) continue;
      let origin: string;
      try { const url = new URL(tab.url); origin = siteOrigin(url.origin); } catch { continue; }
      if (!await this.siteEnabled(origin)) continue;
      try { await this.api.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] }); } catch { /* 不可注入的标签页下次导航时重试。 */ }
    }
  }

  private async disableSite(origin: string): Promise<PublicSettings> {
    this.settings.sites = this.settings.sites.filter(site => site !== origin);
    if (!this.settings.blockedSites.includes(origin)) this.settings.blockedSites.push(origin);
    for (const [name, job] of Object.entries(this.controls.jobs)) if (job.origin === origin && (job.mode === 'selection' || job.mode === 'hover')) this.stopJob(name, job, 'PERMISSION');
    await this.persistControl();
    await this.reconcileSites();
    return this.publicSettings();
  }

  private async reconcileSites(): Promise<void> {
    this.allSitesGranted = await this.api.permissions.contains({ origins: ALL_SITES });
    if (!this.allSitesGranted) this.settings.allSitesEnabled = false;
    const valid: string[] = [];
    for (const origin of this.settings.sites) {
      try { if (siteOrigin(origin) === origin && await this.api.permissions.contains({ origins: [matches(origin)] })) valid.push(origin); } catch { /* 忽略旧版或损坏的站点记录。 */ }
    }
    const registered = await this.api.scripting.getRegisteredContentScripts();
    const desired: chrome.scripting.RegisteredContentScript[] = this.settings.allSitesEnabled
      ? [{ id: ALL_REGISTRATION, js: ['content.js'], matches: [...ALL_SITES], excludeMatches: this.settings.blockedSites.map(matches), persistAcrossSessions: true, allFrames: true, runAt: 'document_idle' }]
      : valid.filter(origin => !this.settings.blockedSites.includes(origin)).map(origin => ({ id: registration(origin), js: ['content.js'], matches: [matches(origin)], persistAcrossSessions: true, allFrames: true, runAt: 'document_idle' }));
    const identical = (a: chrome.scripting.RegisteredContentScript, b: chrome.scripting.RegisteredContentScript) => JSON.stringify(a.matches ?? []) === JSON.stringify(b.matches ?? []) && JSON.stringify(a.excludeMatches ?? []) === JSON.stringify(b.excludeMatches ?? []) && a.allFrames === b.allFrames && a.runAt === b.runAt && JSON.stringify(a.js ?? []) === JSON.stringify(b.js ?? []);
    const obsolete = registered.filter(script => (script.id.startsWith('yeban-site-') || script.id === ALL_REGISTRATION) && !desired.some(wanted => wanted.id === script.id && identical(wanted, script))).map(script => script.id);
    if (obsolete.length) await this.api.scripting.unregisterContentScripts({ ids: obsolete });
    const missing = desired.filter(script => !registered.some(existing => existing.id === script.id && identical(existing, script)));
    if (missing.length) await this.api.scripting.registerContentScripts(missing);
    this.settings.sites = valid;
    await this.persistSettings();
  }

  private async notifyAll(message: ContentMessage, origin?: string): Promise<void> {
    for (const tab of await this.api.tabs.query({})) {
      if (tab.id === undefined) continue;
      if (origin) { try { if (!tab.url || new URL(tab.url).origin !== origin) continue; } catch { continue; } }
      try { await this.api.tabs.sendMessage(tab.id, message); } catch { /* 未加载页面脚本的标签页没有接收方。 */ }
    }
  }

  /** Chrome 的授权框会关闭工具栏弹窗；后台在权限新增后完成启用，避免用户再次点击。 */
  async permissionsAdded(permissions: chrome.permissions.Permissions): Promise<void> {
    await this.ready;
    const patterns = Array.isArray(permissions.origins) ? permissions.origins : [];
    const activated = await this.exclusive(async () => {
      const allGranted = await this.api.permissions.contains({ origins: ALL_SITES });
      if (allGranted && patterns.some(pattern => ALL_SITE_ALIASES.has(pattern))) {
        this.settings.allSitesEnabled = true;
        await this.reconcileSites();
        return { allSites: true, origins: [] as string[] };
      }
      const candidates = [...new Set(patterns.map(originFromMatchPattern).filter((origin): origin is string => Boolean(origin)))];
      const origins: string[] = [];
      for (const origin of candidates) {
        if (!await this.api.permissions.contains({ origins: [matches(origin)] })) continue;
        origins.push(origin);
        this.settings.blockedSites = this.settings.blockedSites.filter(blocked => blocked !== origin);
        if (!this.settings.allSitesEnabled && !this.settings.sites.includes(origin)) this.settings.sites.push(origin);
      }
      if (origins.length) await this.reconcileSites();
      return { allSites: false, origins };
    });
    if (activated.allSites) await this.injectEligibleTabs();
    else for (const origin of activated.origins) await this.injectSite(origin);
    if (activated.allSites || activated.origins.length) await this.notifyAll({ type: 'FEATURES_CHANGED' });
  }

  /** 权限撤销事件必须撤销任务和注册；不申请新权限。 */
  async permissionsRemoved(): Promise<void> {
    await this.ready;
    const removed = await this.exclusive(async () => {
      const origins: string[] = [];
      const previousSites = [...this.settings.sites];
      await this.reconcileSites();
      for (const [name, job] of Object.entries(this.controls.jobs)) {
        const granted = await this.api.permissions.contains({ origins: [matches(job.origin)] });
        if (!granted || job.mode === 'selection' && (!this.settings.selectionEnabled || !await this.siteEnabled(job.origin)) || job.mode === 'hover' && (!this.settings.hoverTranslationEnabled || !await this.siteEnabled(job.origin))) {
          this.stopJob(name, job, 'PERMISSION');
          if (!origins.includes(job.origin)) origins.push(job.origin);
        }
      }
      for (const origin of previousSites) if (!this.settings.sites.includes(origin) && !origins.includes(origin)) origins.push(origin);
      await this.persistControl();
      return origins;
    });
    for (const origin of removed) await this.notifyAll({ type: 'SITE_CHANGED', enabled: false }, origin);
    await this.notifyAll({ type: 'FEATURES_CHANGED' });
  }

  /** 导航与标签关闭让旧文档任务失效，正文与划词均不继承。 */
  async invalidateTab(tabId: number): Promise<void> {
    await this.ready;
    await this.exclusive(async () => {
      for (const [name, job] of Object.entries(this.controls.jobs)) if (job.tabId === tabId) this.stopJob(name, job, 'DOCUMENT_CHANGED');
      await this.persistControl();
    });
  }

  /** 原生标签移动事件更新可信窗口归属，不读取或操作用户窗口内容。 */
  panelTabAttached(tabId: number, windowId: number): void {
    if (Number.isInteger(tabId) && tabId >= 0 && Number.isInteger(windowId) && windowId >= 0 && !this.panelRemovedWindows.has(windowId)) {
      this.panelWindowEpochs.set(tabId, (this.panelWindowEpochs.get(tabId) ?? 0) + 1);
      this.panelDetachedTabs.delete(tabId);
      this.panelWindows.set(tabId, windowId);
      const epoch = this.panelWindowEpochs.get(tabId);
      // 标签迁移本身可能没有侧栏开关事件，主动将目标窗口状态交给该标签。
      void this.ready.then(async () => {
        if (this.panelWindowEpochs.get(tabId) !== epoch || this.panelWindows.get(tabId) !== windowId || this.panelDetachedTabs.has(tabId) || this.panelRemovedWindows.has(windowId)) return;
        await this.api.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_STATE', state: this.sidePanels.state(windowId) } satisfies ContentMessage);
      }).catch(() => undefined);
    }
  }

  panelTabDetached(tabId: number): void {
    this.panelWindowEpochs.set(tabId, (this.panelWindowEpochs.get(tabId) ?? 0) + 1);
    this.panelDetachedTabs.add(tabId);
    this.panelWindows.delete(tabId);
  }

  /** 窗口关闭后撤销缓存，拒绝旧页面继续使用该窗口编号。 */
  async panelWindowRemoved(windowId: number): Promise<void> {
    this.panelRemovedWindows.add(windowId);
    for (const [tabId, ownerWindow] of this.panelWindows) if (ownerWindow === windowId) this.panelTabDetached(tabId);
    await this.sidePanels.remove(windowId);
  }
}
