import { describe, expect, it, vi } from 'vitest';
import { BackgroundApp } from '../src/background/app';
import { FloatingPositionStore } from '../src/background/floating-position';

const entry = 'yebanFloatingPosition';
const page = { id: 'extension-test', url: 'https://example.test/article', origin: 'https://example.test', frameId: 0, documentId: 'document-a', documentLifecycle: 'active', tab: { id: 8, windowId: 3 } } as chrome.runtime.MessageSender;

/** 全部存储均为内存假数据，仅注入当前用例的浮球比例。 */
function fixture(initial?: unknown) {
  const localData: Record<string, unknown> = initial === undefined ? {} : { [entry]: initial };
  const sessionData: Record<string, unknown> = {};
  const events: string[] = [];
  const area = (data: Record<string, unknown>, label: string) => ({
    setAccessLevel: vi.fn(async () => { events.push(`${label}:protected`); }),
    get: vi.fn(async (name: string) => { events.push(`${label}:get:${name}`); return { [name]: structuredClone(data[name]) }; }),
    set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); }),
  });
  const local = area(localData, 'local');
  const mock = {
    storage: { local, session: area(sessionData, 'session') },
    runtime: { id: 'extension-test', getURL: (path: string) => `chrome-extension://extension-test/${path}` },
    permissions: { contains: vi.fn(async () => false) },
    tabs: { get: vi.fn(async () => page.tab), query: vi.fn(async () => []), sendMessage: vi.fn(async () => undefined) },
    scripting: {
      executeScript: vi.fn(async () => [{ documentId: 'document-a', result: true }]),
      getRegisteredContentScripts: vi.fn(async () => []),
      registerContentScripts: vi.fn(async () => undefined), unregisterContentScripts: vi.fn(async () => undefined),
    },
  };
  return { localData, local, events, mock, api: mock as unknown as typeof chrome };
}

/** 明确控制异步顺序，复现慢读取和连续写入竞态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('浮球位置独立存储', () => {
  it('默认居中，后台先限制访问级别再读取独立位置项', async () => {
    const { api, events, local } = fixture();
    const app = new BackgroundApp(api);
    await app.ready;
    expect(events.indexOf(`local:get:${entry}`)).toBeGreaterThan(events.indexOf('local:protected'));
    expect(events.indexOf(`local:get:${entry}`)).toBeGreaterThan(events.indexOf('session:protected'));
    expect(await app.handle({ type: 'GET_CONTEXT' }, page)).toMatchObject({ ok: true, value: { floatingPosition: 0.5 } });
    expect(local.get).toHaveBeenCalledWith(entry);
  });

  it('保存上下边界与中间比例，独立键仅写数值；后台重启恢复最后位置', async () => {
    const { api, local, localData } = fixture();
    const app = new BackgroundApp(api);
    await app.ready;
    local.set.mockClear();
    for (const position of [0, 1, 0.73]) {
      expect(await app.handle({ type: 'SET_FLOATING_POSITION', position }, page)).toEqual({ ok: true, value: position });
      expect(local.set).toHaveBeenLastCalledWith({ [entry]: position });
    }
    expect(local.set).toHaveBeenCalledTimes(3);
    expect(localData[entry]).toBe(0.73);
    const restarted = new BackgroundApp(api);
    await restarted.ready;
    expect(await restarted.handle({ type: 'GET_CONTEXT' }, page)).toMatchObject({ ok: true, value: { floatingPosition: 0.73 } });
  });

  it('忽略损坏记录并拒绝非有限数值、越界和类型伪装', async () => {
    const invalid = [undefined, null, NaN, Infinity, -Infinity, -0.1, 1.1, '0.5', {}, [], true];
    for (const position of invalid) {
      const { api, local } = fixture(position);
      const app = new BackgroundApp(api);
      await app.ready;
      expect(await app.handle({ type: 'GET_CONTEXT' }, page)).toMatchObject({ ok: true, value: { floatingPosition: 0.5 } });
      local.set.mockClear();
      expect(await app.handle({ type: 'SET_FLOATING_POSITION', position }, page)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(local.set).not.toHaveBeenCalled();
    }
  });

  it('读取位置失败不阻断页面上下文，之后仍可保存有效位置', async () => {
    const { api, local } = fixture();
    const read = local.get.getMockImplementation()!;
    local.get.mockImplementation(async name => {
      if (name === entry) throw new Error('测试读取失败');
      return read(name);
    });
    const app = new BackgroundApp(api);
    await app.ready;
    expect(await app.handle({ type: 'GET_CONTEXT' }, page)).toMatchObject({ ok: true, value: { floatingEnabled: true, floatingPosition: 0.5 } });
    expect(await app.handle({ type: 'SET_FLOATING_POSITION', position: 0.8 }, page)).toEqual({ ok: true, value: 0.8 });
  });

  it('写入失败明确返回失败且保留旧位置，后续保存仍可执行', async () => {
    const { api, local, localData } = fixture(0.2);
    const app = new BackgroundApp(api);
    await app.ready;
    local.set.mockRejectedValueOnce(new Error('测试写入失败'));
    expect(await app.handle({ type: 'SET_FLOATING_POSITION', position: 0.9 }, page)).toMatchObject({ ok: false, error: { code: 'FLOATING_POSITION_SAVE', retryable: true } });
    expect(localData[entry]).toBe(0.2);
    expect(await app.handle({ type: 'GET_CONTEXT' }, page)).toMatchObject({ ok: true, value: { floatingPosition: 0.2 } });
    expect(await app.handle({ type: 'SET_FLOATING_POSITION', position: 0.6 }, page)).toEqual({ ok: true, value: 0.6 });
  });

  it('慢初始化读取不能覆盖已成功保存的新位置', async () => {
    const { local } = fixture();
    const oldRead = deferred<Record<string, unknown>>();
    local.get.mockImplementation(() => oldRead.promise);
    const store = new FloatingPositionStore(local as unknown as chrome.storage.StorageArea);
    const initialize = store.initialize();
    await store.set(0.9);
    oldRead.resolve({ [entry]: 0.1 });
    await initialize;
    expect(store.value()).toBe(0.9);
  });

  it('初始化期间失败的保存不会阻止恢复已有位置', async () => {
    const { local } = fixture();
    const oldRead = deferred<Record<string, unknown>>();
    local.get.mockImplementation(() => oldRead.promise);
    local.set.mockRejectedValueOnce(new Error('测试写入失败'));
    const store = new FloatingPositionStore(local as unknown as chrome.storage.StorageArea);
    const initialize = store.initialize();
    await expect(store.set(0.9)).rejects.toMatchObject({ code: 'FLOATING_POSITION_SAVE' });
    oldRead.resolve({ [entry]: 0.1 });
    await initialize;
    expect(store.value()).toBe(0.1);
  });

  it('连续消息连同授权检查与写入都按收到顺序执行', async () => {
    const { api, local, localData, mock } = fixture();
    const app = new BackgroundApp(api);
    await app.ready;
    const firstPermission = deferred<{ documentId: string; result: boolean }[]>();
    const firstWrite = deferred<void>();
    mock.scripting.executeScript.mockImplementationOnce(() => firstPermission.promise);
    local.set.mockClear();
    local.set.mockImplementationOnce(async value => {
      await firstWrite.promise;
      Object.assign(localData, structuredClone(value));
    });
    const earlier = app.handle({ type: 'SET_FLOATING_POSITION', position: 0.3 }, page);
    const later = app.handle({ type: 'SET_FLOATING_POSITION', position: 0.7 }, page);
    await vi.waitFor(() => expect(mock.scripting.executeScript).toHaveBeenCalledTimes(1));
    expect(local.set).not.toHaveBeenCalled();
    firstPermission.resolve([{ documentId: 'document-a', result: true }]);
    await vi.waitFor(() => expect(local.set).toHaveBeenCalledTimes(1));
    expect(mock.scripting.executeScript).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    expect(await earlier).toEqual({ ok: true, value: 0.3 });
    expect(await later).toEqual({ ok: true, value: 0.7 });
    expect(local.set.mock.calls).toEqual([[{ [entry]: 0.3 }], [{ [entry]: 0.7 }]]);
    expect(localData[entry]).toBe(0.7);
  });
});

describe('浮球位置消息来源', () => {
  it('拒绝 iframe、其他扩展、扩展 UI、缺失文档和伪造来源', async () => {
    const { api, local } = fixture();
    const app = new BackgroundApp(api);
    await app.ready;
    local.set.mockClear();
    const invalidSenders = [
      { ...page, frameId: 1 }, { ...page, id: 'other-extension' }, { ...page, documentId: undefined },
      { ...page, documentLifecycle: 'prerender' }, { ...page, origin: 'https://other.test' },
      { ...page, url: 'chrome://extensions' }, { ...page, tab: undefined },
      { id: 'extension-test', url: 'chrome-extension://extension-test/options.html' },
      { id: 'extension-test', url: 'chrome-extension://extension-test/popup.html' },
      { id: 'extension-test', url: 'chrome-extension://extension-test/sidepanel.html' },
    ] as chrome.runtime.MessageSender[];
    for (const sender of invalidSenders) expect(await app.handle({ type: 'SET_FLOATING_POSITION', position: 0.9 }, sender)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(local.set).not.toHaveBeenCalled();
  });

  it('已失去当前文档权限时拒绝保存，不借用其他文档授权', async () => {
    const { api, local, mock } = fixture();
    const app = new BackgroundApp(api);
    await app.ready;
    local.set.mockClear();
    mock.scripting.executeScript.mockRejectedValueOnce(new Error('页面不可访问'));
    expect(await app.handle({ type: 'SET_FLOATING_POSITION', position: 0.9 }, page)).toMatchObject({ ok: false, error: { code: 'PERMISSION' } });
    mock.scripting.executeScript.mockResolvedValueOnce([{ documentId: 'other-document', result: true }]);
    expect(await app.handle({ type: 'SET_FLOATING_POSITION', position: 0.9 }, page)).toMatchObject({ ok: false, error: { code: 'PERMISSION' } });
    expect(local.set).not.toHaveBeenCalled();
  });
});
