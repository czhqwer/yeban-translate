import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundApp } from '../src/background/app';
import { ContentController } from '../src/content/controller';
import type { BackgroundMessage, ContentMessage } from '../src/shared/types';

/** 模拟浏览器事件；业务控制器、后台和窗口状态管理均使用真实实现。 */
function event<T>() {
  const listeners = new Set<(value: T) => unknown>();
  return { addListener: (fn: (value: T) => unknown) => listeners.add(fn), removeListener: (fn: (value: T) => unknown) => listeners.delete(fn), emit: (value: T) => { for (const fn of [...listeners]) void fn(value); } };
}

const controllers: ContentController[] = [];
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  document.body.innerHTML = '<article><p>Browser controls integration example.</p></article>';
});
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.suspend()));
  document.querySelectorAll('[data-yeban-owned]').forEach(node => node.remove());
});

async function fixture(legacy = false) {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const store = (data: Record<string, unknown>) => ({
    setAccessLevel: async () => undefined,
    get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); },
  });
  const onOpened = event<chrome.sidePanel.PanelOpenedInfo>();
  const onClosed = event<chrome.sidePanel.PanelClosedInfo>();
  const tab = { id: 8, windowId: 3, url: document.URL };
  const sender = { id: 'controls-integration', url: document.URL, origin: new URL(document.URL).origin, frameId: 0, documentId: 'page-document', documentLifecycle: 'active', tab } as chrome.runtime.MessageSender;
  let app: BackgroundApp;
  let controller: ContentController | undefined;
  let gesture = false;
  const messages: BackgroundMessage[] = [];
  const roots: ShadowRoot[] = [];
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, options) { const root = attach.call(this, options); roots.push(root); return root; });
  const api = {
    runtime: { id: sender.id, getURL: (path: string) => `chrome-extension://controls-integration/${path}`, sendMessage: (message: BackgroundMessage) => { messages.push(message); return app.handle(message, sender); } },
    storage: { local: store(local), session: store(session) },
    permissions: { contains: async () => false },
    tabs: {
      get: async () => tab,
      query: async (filter?: { windowId?: number }) => filter?.windowId !== undefined && filter.windowId !== tab.windowId ? [] : [tab],
      sendMessage: async (_id: number, message: ContentMessage) => controller?.handle(message),
    },
    windows: { getAll: async () => [{ id: 3 }, { id: 9 }], get: async (id: number) => ({ id }), onRemoved: event<number>() },
    scripting: {
      executeScript: async ({ target }: { target: { documentIds?: string[] } }) => [{ documentId: target.documentIds?.[0] ?? 'page-document', result: true }],
      getRegisteredContentScripts: async () => [], registerContentScripts: async () => undefined, unregisterContentScripts: async () => undefined,
    },
    sidePanel: {
      onOpened, onClosed: legacy ? undefined : onClosed,
      open: vi.fn((options: { windowId: number }) => {
        expect(gesture).toBe(true);
        queueMicrotask(() => onOpened.emit({ windowId: options.windowId, path: 'sidepanel.html' }));
        return Promise.resolve();
      }),
      close: vi.fn((options: { windowId: number }) => {
        queueMicrotask(() => onClosed.emit({ windowId: options.windowId, path: 'sidepanel.html' }));
        return Promise.resolve();
      }),
    },
  };
  vi.stubGlobal('chrome', api);
  app = new BackgroundApp(api as unknown as typeof chrome, vi.fn(async () => { throw new Error('此测试不得调用翻译服务'); }));
  await app.ready;
  controller = new ContentController(document);
  controllers.push(controller);
  await controller.ready;
  const panelButton = () => {
    const root = roots.find(root => root.host.isConnected && root.host.hasAttribute('data-yeban-floating'));
    const button = root && [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => /侧栏/.test(node.getAttribute('aria-label') ?? node.title));
    if (!button) throw new Error('未找到原生侧栏按钮');
    return button;
  };
  const click = () => { gesture = true; panelButton().click(); gesture = false; };
  const moveWindow = async (windowId: number) => { tab.windowId = windowId; await app.panelTabAttached(tab.id, windowId); };
  const reloadPage = async () => { await controller!.suspend(); controller = new ContentController(document); controllers.push(controller); await controller.ready; };
  return { api, app, controller, panelButton, click, onOpened, onClosed, moveWindow, reloadPage, local, messages };
}

/** 在真实内容控制器上重放一次指针操作，浏览器捕获由单元测试与预览补充验证。 */
function pointer(button: HTMLButtonElement, type: string, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 100, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' }, isPrimary: { value: true } });
  button.dispatchEvent(event);
}

describe('浮球与真实后台的原生侧栏状态集成', () => {
  it('拖动通过真实后台保存位置，刷新文档后恢复，松手不误打开侧栏', async () => {
    const f = await fixture();
    const host = document.querySelector<HTMLElement>('[data-yeban-floating]')!;
    const originalTop = Number.parseFloat(host.style.top);
    const button = f.panelButton();
    pointer(button, 'pointerdown', originalTop + 48);
    pointer(button, 'pointermove', originalTop + 128);
    expect(f.messages.some(message => message.type === 'SET_FLOATING_POSITION')).toBe(false);
    pointer(button, 'pointerup', originalTop + 128);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, detail: 1 }));
    await vi.waitFor(() => expect(f.local.yebanFloatingPosition).toEqual(expect.any(Number)));
    expect(f.messages.filter(message => message.type === 'SET_FLOATING_POSITION')).toHaveLength(1);
    expect(f.api.sidePanel.open).not.toHaveBeenCalled();
    expect(f.messages.some(message => message.type === 'BEGIN_JOB' || message.type === 'TRANSLATE')).toBe(false);
    const movedTop = host.style.top;
    expect(Number.parseFloat(movedTop)).toBeGreaterThan(originalTop);
    await f.reloadPage();
    expect(document.querySelector<HTMLElement>('[data-yeban-floating]')!.style.top).toBe(movedTop);
  });

  it('同一按钮先打开再关闭，按窗口作用且打开保留点击调用栈', async () => {
    const f = await fixture();
    await vi.waitFor(() => expect(f.panelButton().disabled).toBe(false));
    f.click();
    await vi.waitFor(() => expect(f.panelButton().getAttribute('aria-pressed')).toBe('true'));
    expect(f.api.sidePanel.open).toHaveBeenCalledWith({ windowId: 3 });
    await vi.waitFor(() => expect(f.panelButton().disabled).toBe(false));
    f.click();
    await vi.waitFor(() => expect(f.panelButton().getAttribute('aria-pressed')).toBe('false'));
    expect(f.api.sidePanel.close).toHaveBeenCalledWith({ windowId: 3 });
  });

  it('原生关闭事件同步回浮球，下次点击重新打开而非关错窗口', async () => {
    const f = await fixture();
    f.click();
    await vi.waitFor(() => expect(f.panelButton().getAttribute('aria-pressed')).toBe('true'));
    f.onClosed.emit({ windowId: 3, path: 'sidepanel.html' });
    await vi.waitFor(() => expect(f.panelButton().getAttribute('aria-pressed')).toBe('false'));
    f.onOpened.emit({ windowId: 9, path: 'sidepanel.html' });
    await Promise.resolve();
    expect(f.panelButton().getAttribute('aria-pressed')).toBe('false');
    await vi.waitFor(() => expect(f.panelButton().disabled).toBe(false));
    f.click();
    await vi.waitFor(() => expect(f.api.sidePanel.open).toHaveBeenCalledTimes(2));
    expect(f.api.sidePanel.close).not.toHaveBeenCalled();
  });

  it('标签移到新窗口后核实当前窗口，再切换新窗口侧栏', async () => {
    const f = await fixture();
    f.click();
    await vi.waitFor(() => expect(f.panelButton().getAttribute('aria-pressed')).toBe('true'));
    await f.moveWindow(9);
    await vi.waitFor(() => expect(f.controller.status().sidePanel).toMatchObject({ windowId: 9, ready: true, open: false }));
    f.click();
    await vi.waitFor(() => expect(f.api.sidePanel.open).toHaveBeenLastCalledWith({ windowId: 9 }));
    expect(f.api.sidePanel.close).not.toHaveBeenCalled();
  });

  it('旧浏览器没有关闭事件时，原生关闭后仍可从入口重新打开', async () => {
    const f = await fixture(true);
    f.click();
    await vi.waitFor(() => expect(f.api.sidePanel.open).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(f.panelButton().disabled).toBe(false));
    // 旧版本原生 X 不通知扩展；再次点击必须保持打开能力，不能依赖过时的 open 标记。
    f.click();
    await vi.waitFor(() => expect(f.api.sidePanel.open).toHaveBeenCalledTimes(2));
    expect(f.api.sidePanel.close).not.toHaveBeenCalled();
  });
});
