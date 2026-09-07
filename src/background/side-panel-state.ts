import type { SidePanelState } from '../shared/types';
import { TranslationError } from './errors';

interface NativeInfo { windowId: number; path: string; tabId?: number }
interface NativeEvent { addListener: (callback: (info: NativeInfo) => void) => void }
interface NativePanelApi {
  open?: (options: { windowId?: number; tabId?: number }) => Promise<void>;
  close?: (options: { windowId: number }) => Promise<void>;
  onOpened?: NativeEvent;
  onClosed?: NativeEvent;
}
interface WindowRecord { open: boolean; version: number; events: number }
const SESSION_ENTRY = 'yebanSidePanels';

/** 按浏览器窗口维护原生可见状态；仅保存窗口编号、开关与版本，不保存翻译内容。 */
export class SidePanelManager {
  private readonly records = new Map<number, WindowRecord>();
  private readonly confirmed = new Set<number>();
  private readonly removed = new Set<number>();
  private readonly pending = new Set<number>();
  private loaded = false;
  private started?: Promise<void>;
  private saving: Promise<void> = Promise.resolve();
  private releaseReady!: () => void;
  readonly ready: Promise<void>;

  constructor(private readonly api: typeof chrome) {
    this.ready = new Promise(resolve => { this.releaseReady = resolve; });
    // 必须同步注册，worker 被原生关闭事件唤醒时不能先等待 session 读取。
    this.native()?.onOpened?.addListener(info => this.nativeChanged(info, true));
    this.native()?.onClosed?.addListener(info => this.nativeChanged(info, false));
  }

  private native(): NativePanelApi | undefined { return this.api.sidePanel as unknown as NativePanelApi | undefined; }

  /** 调用方先完成 storage.setAccessLevel 后再加载窗口记录。 */
  initialize(): Promise<void> {
    if (this.started) return this.started;
    this.started = (async () => {
      const stored = (await this.api.storage.session.get(SESSION_ENTRY))[SESSION_ENTRY] as Record<string, { open?: unknown; version?: unknown }> | undefined;
      if (stored && typeof stored === 'object') {
        for (const [id, value] of Object.entries(stored)) {
          const windowId = Number(id);
          if (!Number.isInteger(windowId) || windowId < 0 || !value || typeof value.open !== 'boolean' || !Number.isSafeInteger(value.version) || Number(value.version) < 0 || this.removed.has(windowId)) continue;
          const current = this.records.get(windowId);
          if (current) {
            // 尝试过但失败的操作不是可见状态证据；恢复时保留对象，避免破坏在途回执归属。
            if (!this.confirmed.has(windowId)) current.open = value.open;
            current.version = Math.max(current.version, Number(value.version) + 1);
          } else this.records.set(windowId, { open: value.open, version: Number(value.version), events: 0 });
        }
      }
      this.loaded = true;
      this.releaseReady();
      await this.persist();
      for (const windowId of this.records.keys()) this.announce(windowId);
    })();
    return this.started;
  }

  /** ready 为当前窗口已完成状态加载且没有原生调用在途，不能用 enabled 推断 open。 */
  state(windowId?: number): SidePanelState {
    const native = this.native();
    const valid = Number.isInteger(windowId) && windowId! >= 0 && !this.removed.has(windowId!);
    const record = valid ? this.records.get(windowId!) : undefined;
    return {
      ...(valid ? { windowId } : {}), open: record?.open ?? false,
      ready: Boolean(valid && this.loaded && !this.pending.has(windowId!)),
      canOpen: typeof native?.open === 'function',
      canToggle: typeof native?.open === 'function' && typeof native?.close === 'function' && typeof native.onOpened?.addListener === 'function' && typeof native.onClosed?.addListener === 'function',
      version: record?.version ?? 0,
    };
  }

  /** 在首个 await 前执行窗口级原生 API；在途期间拒绝重复点击。 */
  async set(windowId: number, open: boolean): Promise<SidePanelState> {
    if (!Number.isInteger(windowId) || windowId < 0 || this.removed.has(windowId)) throw new TranslationError('SIDE_PANEL_NOT_READY', '窗口状态已变化，请刷新侧栏状态后重试。', true);
    const capability = this.state(windowId);
    if (!capability.canOpen) throw new TranslationError('UNSUPPORTED', '当前浏览器不支持原生侧栏，请升级至 Chrome / Edge 116 或以上版本。');
    if (!open && !capability.canToggle) throw new TranslationError('UNSUPPORTED', '当前浏览器缺少完整的侧栏关闭接口，请使用原生关闭按钮；Chrome 请升级至 142 或以上，Edge 请更新到支持这些接口的版本。');
    if (this.pending.has(windowId)) throw new TranslationError('BUSY', '侧栏正在切换，请等待当前操作完成。', true);
    const record = this.records.get(windowId) ?? { open: false, version: 0, events: 0 };
    this.records.set(windowId, record);
    this.pending.add(windowId);
    record.version++;
    const events = record.events;
    try {
      const native = this.native()!;
      const operation = open ? native.open!({ windowId }) : native.close!({ windowId });
      this.announce(windowId);
      await operation;
      if (this.removed.has(windowId) || this.records.get(windowId) !== record) throw new TranslationError('SIDE_PANEL_NOT_READY', '目标窗口已关闭，请在当前窗口重试。', true);
      // 原生 X 或浏览器入口事件提供更新事实，晚到的 open/close 回执不能覆盖它。
      if (record.events === events) record.open = open;
      this.confirmed.add(windowId);
    } catch (error) {
      if (error instanceof TranslationError) throw error;
      throw new TranslationError('SIDE_PANEL', '原生侧栏操作未完成，请再次点击或使用浏览器侧栏入口。', true);
    } finally {
      this.pending.delete(windowId);
      if (this.records.get(windowId) === record) { record.version++; this.announce(windowId); }
    }
    if (this.loaded) await this.persist();
    return this.state(windowId);
  }

  /** 仅旧入口缺少窗口上下文时回退到 tabId；关闭始终不会使用此路径。 */
  async openLegacy(tabId: number): Promise<void> {
    const native = this.native();
    if (!native?.open) throw new TranslationError('UNSUPPORTED', '当前浏览器不支持原生侧栏，请升级至 Chrome / Edge 116 或以上版本。');
    try { await native.open({ tabId }); }
    catch { throw new TranslationError('SIDE_PANEL', '原生侧栏未能打开，请再次点击打开按钮。', true); }
  }

  private nativeChanged(info: NativeInfo, open: boolean): void {
    if (!info || !Number.isInteger(info.windowId) || info.windowId < 0 || info.tabId !== undefined || !['sidepanel.html', '/sidepanel.html', this.api.runtime.getURL('sidepanel.html')].includes(info.path)) return;
    if (this.removed.has(info.windowId)) return;
    const record = this.records.get(info.windowId) ?? { open: false, version: 0, events: 0 };
    record.open = open;
    record.version++;
    record.events++;
    this.records.set(info.windowId, record);
    this.confirmed.add(info.windowId);
    this.announce(info.windowId);
  }

  /** 窗口关闭只清理元数据，不调用任何浏览器窗口操作。 */
  async remove(windowId: number): Promise<void> {
    this.removed.add(windowId);
    this.records.delete(windowId);
    this.pending.delete(windowId);
    this.confirmed.delete(windowId);
    await this.ready;
    await this.persist();
  }

  private persist(): Promise<void> {
    const operation = this.saving.then(() => {
      const stored = Object.fromEntries([...this.records].map(([id, record]) => [String(id), { open: record.open, version: record.version }]));
      return this.api.storage.session.set({ [SESSION_ENTRY]: stored });
    });
    this.saving = operation.catch(() => undefined);
    return operation;
  }

  private announce(windowId: number): void {
    void this.ready.then(async () => {
      await this.persist();
      // 广播在持久化队列之外，页面收到状态后可以安全回调后台查询。
      const tabs = await this.api.tabs.query({ windowId });
      for (const tab of tabs) {
        if (tab.id === undefined || tab.windowId !== windowId || this.removed.has(windowId)) continue;
        try { await this.api.tabs.sendMessage(tab.id, { type: 'SIDE_PANEL_STATE', state: this.state(windowId) }); } catch { /* 当前标签页可能尚未加载内容脚本。 */ }
      }
    }).catch(() => undefined);
  }
}
