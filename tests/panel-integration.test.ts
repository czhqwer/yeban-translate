import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundApp } from '../src/background/app';
import { PanelChannel } from '../src/sidepanel/channel';
import type { PanelCommand } from '../src/shared/panel';

type MessageListener = (message: unknown, port: chrome.runtime.Port) => void;
type DisconnectListener = (port: chrome.runtime.Port) => void;

/** 浏览器只负责连接事件传递，客户端和后台均使用真实实现。 */
function portPair(sender: chrome.runtime.MessageSender, name: string) {
  const clientMessages = new Set<MessageListener>();
  const serverMessages = new Set<MessageListener>();
  const clientDisconnects = new Set<DisconnectListener>();
  const serverDisconnects = new Set<DisconnectListener>();
  let closed = false;
  const event = <T>(listeners: Set<T>) => ({ addListener: (listener: T) => listeners.add(listener), removeListener: (listener: T) => listeners.delete(listener) });
  const close = (): void => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => {
      for (const listener of [...clientDisconnects]) listener(client);
      for (const listener of [...serverDisconnects]) listener(server);
    });
  };
  const client = {
    name, onMessage: event(clientMessages), onDisconnect: event(clientDisconnects), disconnect: close,
    postMessage: (message: unknown) => {
      if (closed) throw new Error('虚拟连接已关闭');
      queueMicrotask(() => { if (!closed) for (const listener of [...serverMessages]) listener(message, server); });
    },
  } as unknown as chrome.runtime.Port;
  const server = {
    name, sender, onMessage: event(serverMessages), onDisconnect: event(serverDisconnects), disconnect: close,
    postMessage: (message: unknown) => {
      if (closed) throw new Error('虚拟连接已关闭');
      queueMicrotask(() => { if (!closed) for (const listener of [...clientMessages]) listener(message, client); });
    },
  } as unknown as chrome.runtime.Port;
  return { client, server };
}

/** 独立内存配置；所有字符串均为虚拟测试值，不读取浏览器存储。 */
async function configured(fetcher: typeof fetch) {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const area = (store: Record<string, unknown>) => ({
    setAccessLevel: async () => undefined,
    get: async (name: string) => ({ [name]: structuredClone(store[name]) }),
    set: async (value: Record<string, unknown>) => { Object.assign(store, structuredClone(value)); },
  });
  const api = {
    runtime: { id: 'panel-integration', getURL: (path: string) => `chrome-extension://panel-integration/${path}` },
    storage: { local: area(local), session: area(session) },
    permissions: { contains: async () => false },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => undefined, unregisterContentScripts: async () => undefined },
    tabs: { query: async () => [], sendMessage: async () => undefined },
  } as unknown as typeof chrome;
  const app = new BackgroundApp(api, fetcher);
  await app.ready;
  expect(await app.handle({ type: 'SAVE_SETTINGS', provider: 'bailian', dataNoticeAccepted: true,
    config: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', apiKey: 'VIRTUAL_INTEGRATION_VALUE' } },
  { id: api.runtime.id, url: api.runtime.getURL('options.html') })).toMatchObject({ ok: true });
  const runtime = (sender: chrome.runtime.MessageSender = { id: api.runtime.id, url: api.runtime.getURL('sidepanel.html'), origin: 'chrome-extension://panel-integration' }) => ({
    connect: vi.fn((options: chrome.runtime.ConnectInfo) => {
      const ports = portPair(sender, options.name!);
      queueMicrotask(() => app.connectPanel(ports.server));
      return ports.client;
    }),
  } as Pick<typeof chrome.runtime, 'connect'>);
  return { app, api, runtime };
}

const command = (text = 'Hello', requestId = 'same-request'): PanelCommand => ({ type: 'TRANSLATE_PANEL', requestId, preferences: { provider: 'bailian', source: 'en', target: 'zh' }, text });
const result = (text: string) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] }));
beforeEach(() => vi.stubGlobal('crypto', webcrypto));

describe('侧栏真实客户端与后台连接集成', () => {
  it('合法侧栏缺少全部可选文档字段时成功走到供应商并返回结果', async () => {
    const fetcher = vi.fn(async () => result('集成译文'));
    const fixture = await configured(fetcher);
    const runtime = fixture.runtime();
    const channel = new PanelChannel(runtime);
    expect(await channel.send(command())).toEqual({ ok: true, value: { translated: '集成译文' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(runtime.connect).toHaveBeenCalledTimes(1);
    channel.dispose();
  });

  it('两个缺少文档标识的侧栏使用同一请求编号仍互不取消', async () => {
    const pending: Array<{ signal: AbortSignal; resolve: (value: Response) => void }> = [];
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => pending.push({ signal: init!.signal!, resolve })));
    const fixture = await configured(fetcher);
    const first = new PanelChannel(fixture.runtime());
    const second = new PanelChannel(fixture.runtime());
    const firstResult = first.send(command('First'));
    const secondResult = second.send(command('Second'));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await first.send({ type: 'CANCEL_PANEL', requestId: 'same-request' });
    expect(pending[0].signal.aborted).toBe(true);
    expect(pending[1].signal.aborted).toBe(false);
    pending[0].resolve(result('旧译文'));
    pending[1].resolve(result('第二个侧栏译文'));
    expect(await firstResult).toMatchObject({ ok: false });
    expect(await secondResult).toEqual({ ok: true, value: { translated: '第二个侧栏译文' } });
    first.dispose(); second.dispose();
  });

  it('断连后旧结果失效，只有再次主动翻译才创建新连接', async () => {
    const pending: Array<{ signal: AbortSignal; resolve: (value: Response) => void }> = [];
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => pending.push({ signal: init!.signal!, resolve })));
    const fixture = await configured(fetcher);
    const runtime = fixture.runtime();
    const channel = new PanelChannel(runtime);
    const old = channel.send(command('Old'));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    channel.disconnect();
    expect(await old).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } });
    await vi.waitFor(() => expect(pending[0].signal.aborted).toBe(true));
    pending[0].resolve(result('迟到结果'));
    expect(runtime.connect).toHaveBeenCalledTimes(1);
    const next = channel.send(command('New'));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].resolve(result('新连接译文'));
    expect(await next).toEqual({ ok: true, value: { translated: '新连接译文' } });
    expect(runtime.connect).toHaveBeenCalledTimes(2);
    channel.dispose();
  });

  it('网页伪装成侧栏连接不能调用供应商', async () => {
    const fetcher = vi.fn(async () => result('不应请求'));
    const fixture = await configured(fetcher);
    const channel = new PanelChannel(fixture.runtime({ id: fixture.api.runtime.id, url: 'https://example.test/sidepanel.html' }));
    expect(await channel.send(command())).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } });
    expect(fetcher).not.toHaveBeenCalled();
    channel.dispose();
  });
});
