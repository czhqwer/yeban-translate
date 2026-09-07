import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidePanelManager } from '../src/background/side-panel-state';
import { BackgroundApp } from '../src/background/app';

interface NativeInfo { windowId: number; path: string; tabId?: number }
function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return { addListener: (listener: (value: T) => void) => listeners.add(listener), emit: (value: T) => { for (const listener of listeners) listener(value); } };
}

function fixture() {
  const session: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  const tabs = new Map([[1, { id: 1, windowId: 10, url: 'https://one.example/article' }], [2, { id: 2, windowId: 20, url: 'https://two.example/article' }]]);
  const area = (data: Record<string, unknown>) => ({ setAccessLevel: vi.fn(async () => {}), get: vi.fn(async (name: string) => ({ [name]: structuredClone(data[name]) })), set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }) });
  const opened = event<NativeInfo>(); const closed = event<NativeInfo>();
  const mock = {
    runtime: { id: 'extension-test', getURL: (path: string) => `chrome-extension://extension-test/${path}` },
    storage: { session: area(session), local: area(local) },
    permissions: { contains: vi.fn(async () => false) },
    scripting: { getRegisteredContentScripts: vi.fn(async () => []), executeScript: vi.fn(async () => []) },
    tabs: { get: vi.fn(async (id: number) => tabs.get(id)), query: vi.fn(async (query: { windowId?: number }) => [...tabs.values()].filter(tab => query.windowId === undefined || tab.windowId === query.windowId)), sendMessage: vi.fn(async (_tabId: number, _message: unknown) => undefined) },
    sidePanel: { open: vi.fn(async (_options: { windowId?: number; tabId?: number }) => {}), close: vi.fn(async (_options: { windowId: number }) => {}), onOpened: opened, onClosed: closed },
  };
  return { api: mock as unknown as typeof chrome, mock, session, tabs, opened, closed };
}
const popup = { id: 'extension-test', url: 'chrome-extension://extension-test/popup.html' };
const content = { id: 'extension-test', url: 'https://one.example/article', origin: 'https://one.example', tab: { id: 1, windowId: 10 }, frameId: 0, documentId: 'doc-1', documentLifecycle: 'active' } as chrome.runtime.MessageSender;

beforeEach(() => vi.restoreAllMocks());

describe('原生侧栏窗口状态', () => {
  it('打开关闭都使用windowId，两个窗口隔离，原生X后可重新打开', async () => {
    const f = fixture(); const manager = new SidePanelManager(f.api);
    await manager.initialize();
    expect(manager.state(10)).toMatchObject({ open: false, ready: true, canOpen: true, canToggle: true });
    expect(await manager.set(10, true)).toMatchObject({ open: true, windowId: 10 });
    expect(f.mock.sidePanel.open).toHaveBeenCalledWith({ windowId: 10 });
    expect(manager.state(20).open).toBe(false);
    expect(await manager.set(10, false)).toMatchObject({ open: false });
    expect(f.mock.sidePanel.close).toHaveBeenCalledWith({ windowId: 10 });
    await manager.set(10, true);
    f.closed.emit({ windowId: 10, path: 'sidepanel.html' });
    expect(manager.state(10).open).toBe(false);
    await manager.set(10, true);
    expect(manager.state(10).open).toBe(true);
  });

  it('原生事件更新优先于迟到API成功，外部或tab专属面板事件不混入', async () => {
    const f = fixture(); const manager = new SidePanelManager(f.api);
    await manager.initialize();
    let finish!: () => void;
    f.mock.sidePanel.open.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const opening = manager.set(10, true);
    f.opened.emit({ windowId: 10, path: 'sidepanel.html' });
    f.closed.emit({ windowId: 10, path: 'sidepanel.html' });
    finish();
    expect(await opening).toMatchObject({ open: false });
    f.opened.emit({ windowId: 10, path: 'other.html' });
    f.opened.emit({ windowId: 10, path: 'sidepanel.html', tabId: 1 });
    expect(manager.state(10).open).toBe(false);
  });

  it('worker恢复session，并且初始化期间的新关闭事件不会被旧存储覆盖', async () => {
    const f = fixture(); const first = new SidePanelManager(f.api);
    await first.initialize(); await first.set(10, true);
    await vi.waitFor(() => expect(Object.keys(f.session)).toHaveLength(1));
    const restored = new SidePanelManager(f.api); await restored.initialize();
    expect(restored.state(10).open).toBe(true);
    const read = f.mock.storage.session.get.getMockImplementation()!;
    let release!: () => void;
    f.mock.storage.session.get.mockImplementationOnce(async name => { const result = await read(name); await new Promise<void>(resolve => { release = resolve; }); return result; });
    const racing = new SidePanelManager(f.api); const initializing = racing.initialize();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.closed.emit({ windowId: 10, path: 'sidepanel.html' });
    release(); await initializing;
    expect(racing.state(10)).toMatchObject({ open: false, ready: true });
  });

  it('旧能力只允许open，API失败不假成功，连点只发一次', async () => {
    const f = fixture(); (f.mock.sidePanel as unknown as { onClosed?: unknown }).onClosed = undefined;
    const manager = new SidePanelManager(f.api); await manager.initialize();
    expect(manager.state(10)).toMatchObject({ canOpen: true, canToggle: false });
    await expect(manager.set(10, false)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(f.mock.sidePanel.close).not.toHaveBeenCalled();
    f.mock.sidePanel.open.mockRejectedValueOnce(new Error('native failure'));
    await expect(manager.set(10, true)).rejects.toMatchObject({ code: 'SIDE_PANEL' });
    expect(manager.state(10).open).toBe(false);
    let finish!: () => void;
    f.mock.sidePanel.open.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const opening = manager.set(10, true);
    await expect(manager.set(10, true)).rejects.toMatchObject({ code: 'BUSY' });
    finish(); await opening;
    expect(f.mock.sidePanel.open).toHaveBeenCalledTimes(2);
  });

  it('构造时已注册原生事件，初始化之前的浏览器入口打开不会丢失', async () => {
    const f = fixture(); const manager = new SidePanelManager(f.api);
    f.opened.emit({ windowId: 20, path: 'sidepanel.html' });
    expect(manager.state(20)).toMatchObject({ open: true, ready: false });
    await manager.initialize();
    expect(manager.state(20)).toMatchObject({ open: true, ready: true });
    expect(manager.state(10).open).toBe(false);
    expect(f.mock.sidePanel.open).not.toHaveBeenCalled();
  });

  it.each([false, true])('初始化读取等待期间原生操作open=%s失败，不覆盖已保存的真实打开状态', async requestedOpen => {
    const f = fixture();
    f.session.yebanSidePanels = { '10': { open: true, version: 7 } };
    const read = f.mock.storage.session.get.getMockImplementation()!;
    let release!: () => void;
    f.mock.storage.session.get.mockImplementationOnce(async name => { const result = await read(name); await new Promise<void>(resolve => { release = resolve; }); return result; });
    const manager = new SidePanelManager(f.api);
    const loading = manager.initialize();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (requestedOpen) f.mock.sidePanel.open.mockRejectedValueOnce(new Error('native failure'));
    else f.mock.sidePanel.close.mockRejectedValueOnce(new Error('native failure'));
    await expect(manager.set(10, requestedOpen)).rejects.toMatchObject({ code: 'SIDE_PANEL' });
    release(); await loading;
    expect(manager.state(10)).toMatchObject({ open: true, ready: true });
    expect(manager.state(10).version).toBeGreaterThanOrEqual(7);
    expect(f.session.yebanSidePanels).toMatchObject({ '10': { open: true } });
  });

  it('初始化读取等待期间成功关闭属于确认事实，仍优先于旧的打开记录', async () => {
    const f = fixture(); f.session.yebanSidePanels = { '10': { open: true, version: 7 } };
    const read = f.mock.storage.session.get.getMockImplementation()!;
    let release!: () => void;
    f.mock.storage.session.get.mockImplementationOnce(async name => { const result = await read(name); await new Promise<void>(resolve => { release = resolve; }); return result; });
    const manager = new SidePanelManager(f.api); const loading = manager.initialize();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await manager.set(10, false)).toMatchObject({ open: false });
    release(); await loading;
    expect(manager.state(10)).toMatchObject({ open: false, ready: true });
  });
});

describe('原生侧栏消息窗口归属与用户手势', () => {
  it('预取tab/window后SET在首个await前调用原生API，拒绝内容伪造其他窗口', async () => {
    const f = fixture(); const app = new BackgroundApp(f.api);
    expect(await app.handle({ type: 'GET_SIDE_PANEL_STATE', tabId: 1 }, popup)).toMatchObject({ ok: true, value: { windowId: 10, ready: true } });
    const opening = app.handle({ type: 'SET_SIDE_PANEL', open: true, tabId: 1, windowId: 10 }, popup);
    expect(f.mock.sidePanel.open).toHaveBeenCalledWith({ windowId: 10 });
    expect(await opening).toMatchObject({ ok: true, value: { open: true } });
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: false, tabId: 2, windowId: 20 }, content)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await app.handle({ type: 'GET_SIDE_PANEL_STATE', tabId: 2 }, content)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.mock.sidePanel.close).not.toHaveBeenCalled();
  });

  it('窗口广播回调GET_STATE不会死锁，窗口关闭清理状态和tab缓存', async () => {
    const f = fixture(); const app = new BackgroundApp(f.api);
    await app.handle({ type: 'GET_SIDE_PANEL_STATE', tabId: 1 }, popup);
    f.mock.tabs.sendMessage.mockImplementation(async (_id, message) => {
      if ((message as { type?: string }).type === 'SIDE_PANEL_STATE') expect(await app.handle({ type: 'GET_SIDE_PANEL_STATE' }, content)).toMatchObject({ ok: true });
    });
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: true, tabId: 1, windowId: 10 }, popup)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.mock.tabs.sendMessage).toHaveBeenCalled());
    expect(f.mock.tabs.sendMessage.mock.calls.every(([id]) => id === 1)).toBe(true);
    await app.panelWindowRemoved(10);
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: false, tabId: 1, windowId: 10 }, popup)).toMatchObject({ ok: false });
  });

  it('真实sender窗口已知时，初始化等待也不能延迟原生open；legacy同样优先窗口', async () => {
    const f = fixture();
    let release!: () => void;
    f.mock.storage.local.setAccessLevel.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const app = new BackgroundApp(f.api);
    const opening = app.handle({ type: 'SET_SIDE_PANEL', open: true, windowId: 10 }, content);
    expect(f.mock.sidePanel.open).toHaveBeenCalledWith({ windowId: 10 });
    expect(await opening).toMatchObject({ ok: true, value: { open: true, ready: false } });
    release(); await app.ready;
    expect(await app.handle({ type: 'GET_SIDE_PANEL_STATE' }, content)).toMatchObject({ ok: true, value: { open: true, ready: true } });
    expect(await app.handle({ type: 'OPEN_SIDE_PANEL' }, content)).toMatchObject({ ok: true });
    expect(f.mock.sidePanel.open.mock.calls.every(([options]) => options.windowId === 10 && options.tabId === undefined)).toBe(true);
  });

  it('标签移到另一窗口后旧windowId失效，未知窗口和恶意来源不会调用close', async () => {
    const f = fixture(); const app = new BackgroundApp(f.api); await app.ready;
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: false, tabId: 1, windowId: 10 }, popup)).toMatchObject({ ok: false, error: { code: 'SIDE_PANEL_NOT_READY' } });
    await app.handle({ type: 'GET_SIDE_PANEL_STATE', tabId: 1 }, popup);
    app.panelTabAttached(1, 20);
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: false, tabId: 1, windowId: 10 }, popup)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: false, tabId: 1, windowId: 20 }, { ...popup, id: 'other-extension' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.mock.sidePanel.close).not.toHaveBeenCalled();
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: false, tabId: 1, windowId: 20 }, popup)).toMatchObject({ ok: true });
    expect(f.mock.sidePanel.close).toHaveBeenCalledWith({ windowId: 20 });
    app.panelTabDetached(1);
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: false, tabId: 1, windowId: 20 }, popup)).toMatchObject({ ok: false });
  });

  it.each(['state', 'context'] as const)('延迟%s读取旧归属不得覆盖已到达的窗口移动事件', async kind => {
    const f = fixture(); const app = new BackgroundApp(f.api); await app.ready;
    let release!: () => void;
    f.mock.tabs.get.mockImplementationOnce(async () => { const old = { id: 1, windowId: 10, url: 'https://one.example/article' }; await new Promise<void>(resolve => { release = resolve; }); return old; });
    const reading = kind === 'state' ? app.handle({ type: 'GET_SIDE_PANEL_STATE', tabId: 1 }, popup) : app.handle({ type: 'GET_CONTEXT' }, content);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    app.panelTabAttached(1, 20);
    f.tabs.set(1, { id: 1, windowId: 20, url: 'https://one.example/article' });
    release();
    expect(await reading).toMatchObject({ ok: true, value: kind === 'state' ? { windowId: 20, ready: true } : { sidePanel: { windowId: 20, ready: true } } });
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: false, tabId: 1, windowId: 10 }, popup)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(f.mock.sidePanel.close).not.toHaveBeenCalled();
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: false, tabId: 1, windowId: 20 }, popup)).toMatchObject({ ok: true });
    expect(f.mock.sidePanel.close).toHaveBeenCalledWith({ windowId: 20 });
  });

  it.each(['detach', 'remove'] as const)('延迟查询不得恢复%s之后已经失效的tab归属', async operation => {
    const f = fixture(); const app = new BackgroundApp(f.api); await app.ready;
    await app.handle({ type: 'GET_SIDE_PANEL_STATE', tabId: 1 }, popup);
    let release!: () => void;
    f.mock.tabs.get.mockImplementationOnce(async () => { const old = { id: 1, windowId: 10, url: 'https://one.example/article' }; await new Promise<void>(resolve => { release = resolve; }); return old; });
    const reading = app.handle({ type: 'GET_SIDE_PANEL_STATE', tabId: 1 }, popup);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (operation === 'detach') app.panelTabDetached(1);
    else await app.panelWindowRemoved(10);
    release();
    expect(await reading).toMatchObject({ ok: true, value: { ready: false } });
    expect(await app.handle({ type: 'SET_SIDE_PANEL', open: false, tabId: 1, windowId: 10 }, popup)).toMatchObject({ ok: false });
    expect(f.mock.sidePanel.close).not.toHaveBeenCalled();
  });

  it('标签迁移或激活时主动通知该标签当前窗口状态，不依赖原生开关事件', async () => {
    const f = fixture(); const app = new BackgroundApp(f.api); await app.ready;
    app.panelTabAttached(1, 20);
    await vi.waitFor(() => expect(f.mock.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'SIDE_PANEL_STATE', state: expect.objectContaining({ windowId: 20, open: false, ready: true }) }));
    expect(f.mock.tabs.sendMessage.mock.calls.every(([id]) => id === 1)).toBe(true);
    expect(f.mock.sidePanel.open).not.toHaveBeenCalled();
    expect(f.mock.sidePanel.close).not.toHaveBeenCalled();
    f.mock.tabs.sendMessage.mockClear();
    app.panelTabAttached(1, 20);
    await vi.waitFor(() => expect(f.mock.tabs.sendMessage).toHaveBeenCalledTimes(1));
  });

  it('初始化等待期间多次迁移只通知最新epoch，分离或关闭后不再通知旧状态', async () => {
    const f = fixture(); let release!: () => void;
    f.mock.storage.local.setAccessLevel.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const app = new BackgroundApp(f.api);
    app.panelTabAttached(1, 10);
    app.panelTabAttached(1, 20);
    app.panelTabAttached(2, 20);
    app.panelTabDetached(2);
    release(); await app.ready;
    await vi.waitFor(() => expect(f.mock.tabs.sendMessage).toHaveBeenCalledTimes(1));
    expect(f.mock.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'SIDE_PANEL_STATE', state: expect.objectContaining({ windowId: 20 }) });
    f.mock.tabs.sendMessage.mockClear();
    app.panelTabAttached(1, 10);
    await app.panelWindowRemoved(10);
    await Promise.resolve();
    expect(f.mock.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
