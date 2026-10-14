import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundApp } from '../src/background/app';
import { RequestPool } from '../src/background/pool';
import type { BackgroundMessage, ContentMessage } from '../src/shared/types';
import { PANEL_PORT_NAME, type PanelRequest as PanelEnvelope, type PanelResponse } from '../src/shared/panel';

const prefs = { provider: 'bailian', source: 'auto', target: 'zh' } as const;
const optionSender = { id: 'extension-test', url: 'chrome-extension://extension-test/options.html' };
const popupSender = { id: 'extension-test', url: 'chrome-extension://extension-test/popup.html' };
const panelSender = { id: 'extension-test', url: 'chrome-extension://extension-test/sidepanel.html', documentId: 'panel-a', documentLifecycle: 'active' as const };
const pageSender = { id: 'extension-test', url: 'https://example.test/article', origin: 'https://example.test', frameId: 0, documentId: 'document-a', tab: { id: 8 }, documentLifecycle: 'active' } as chrome.runtime.MessageSender;
const completed = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '测试译文' } }] }));

function createMock() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const origins = new Set<string>();
  const registered = new Map<string, chrome.scripting.RegisteredContentScript>();
  const events: string[] = [];
  const area = (data: Record<string, unknown>, label: string) => ({
    setAccessLevel: vi.fn(async () => { events.push(`${label}-protected`); }),
    get: vi.fn(async (name: string) => { events.push(`${label}-read`); return { [name]: structuredClone(data[name]) }; }),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
  });
  const chromeMock = {
    runtime: { id: 'extension-test', getURL: (path: string) => `chrome-extension://extension-test/${path}` },
    storage: { local: area(local, 'local'), session: area(session, 'session') },
    permissions: {
      contains: vi.fn(async ({ origins: requested }: { origins: string[] }) => requested.every(value => origins.has(value) || origins.has(value.startsWith('https:') ? 'https://*/*' : 'http://*/*'))),
      remove: vi.fn(async ({ origins: removed }: { origins: string[] }) => { for (const origin of removed) origins.delete(origin); return true; }),
    },
    sidePanel: { open: vi.fn(async (_options: { tabId: number }) => undefined) },
    tabs: {
      get: vi.fn(async () => ({ id: 8, url: 'https://example.test/article' })),
      query: vi.fn(async () => [{ id: 8, url: 'https://example.test/article' }]),
      sendMessage: vi.fn(async (_tabId: number, _message: ContentMessage) => undefined),
    },
    scripting: {
      executeScript: vi.fn(async ({ target }: { target: { documentIds?: string[] } }) => [{ documentId: target.documentIds?.[0] ?? 'document-a', result: true }]),
      getRegisteredContentScripts: vi.fn(async (filter?: { ids: string[] }) => [...registered.values()].filter(value => !filter || filter.ids.includes(value.id))),
      registerContentScripts: vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => { for (const script of scripts) registered.set(script.id, script); }),
      unregisterContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => { for (const id of ids) registered.delete(id); }),
    },
  };
  return { api: chromeMock as unknown as typeof chrome, mock: chromeMock, local, session, origins, registered, events };
}

function createPanelPort(sender: chrome.runtime.MessageSender = { id: 'extension-test', url: 'chrome-extension://extension-test/sidepanel.html' }, name = PANEL_PORT_NAME) {
  const messages = new Set<(message: unknown) => void>();
  const disconnections = new Set<() => void>();
  const responses: PanelResponse[] = [];
  let closed = false;
  const mock = {
    name, sender,
    onMessage: { addListener: (listener: (message: unknown) => void) => messages.add(listener), removeListener: (listener: (message: unknown) => void) => messages.delete(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnections.add(listener), removeListener: (listener: () => void) => disconnections.delete(listener) },
    postMessage: vi.fn((response: PanelResponse) => { if (closed) throw new Error('连接已断开'); responses.push(response); }),
    disconnect: vi.fn(() => { if (closed) return; closed = true; for (const listener of [...disconnections]) listener(); }),
  };
  return { port: mock as unknown as chrome.runtime.Port, mock, responses, send: (message: PanelEnvelope | unknown) => { if (!closed) for (const listener of [...messages]) listener(message); } };
}

async function configured(fetcher: typeof fetch = vi.fn(async () => completed())) {
  const context = createMock();
  const app = new BackgroundApp(context.api, fetcher);
  await app.ready;
  const reply = await app.handle({ type: 'SAVE_SETTINGS', provider: 'bailian', dataNoticeAccepted: true, config: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', apiKey: 'VIRTUAL_ONLY_CONFIG_VALUE' } }, optionSender);
  expect(reply.ok).toBe(true);
  return { ...context, app, fetcher };
}

async function start(app: BackgroundApp, jobId = 'job-page', kind: 'page' | 'selection' | 'hover' = 'page'): Promise<void> {
  const result = await app.handle({ type: 'BEGIN_JOB', jobId, mode: kind, preferences: prefs }, pageSender);
  expect(result).toMatchObject({ ok: true, value: { revision: 1 } });
}

/** 给互相等待的消息设置测试期限，避免回归用例本身长期挂起。 */
async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('后台消息相互等待')), 350); });
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); }
}

beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });

describe('后台来源与隐私边界', () => {
  it('连接测试无需正文发送确认，只发送固定示例文本', async () => {
    const { app, fetcher } = await configured();
    expect((await app.handle({ type: 'SAVE_SETTINGS', dataNoticeAccepted: false }, optionSender)).ok).toBe(true);
    expect(await app.handle({ type: 'TEST_SERVICE', provider: 'bailian' }, optionSender)).toMatchObject({ ok: true, value: { translated: '测试译文' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body));
    expect(body.messages.at(-1)?.content).toBe('Hello, world.');
  });

  it('先限制 local/session 访问，再读取配置；公开状态不返回实际值', async () => {
    const { app, events, api } = await configured();
    expect(events.indexOf('local-protected')).toBeLessThan(events.indexOf('local-read'));
    expect(api.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(api.storage.session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    const publicReply = await app.handle({ type: 'GET_SETTINGS' }, optionSender);
    expect(JSON.stringify(publicReply)).not.toContain('VIRTUAL_ONLY_CONFIG_VALUE');
    const page = await app.handle({ type: 'GET_CONTEXT' }, pageSender);
    expect(page).toMatchObject({ ok: true, value: { selectionEnabled: false, services: { bailian: { configured: true } } } });
    expect(JSON.stringify(page)).not.toContain('VIRTUAL_ONLY_CONFIG_VALUE');
    expect(JSON.stringify(page)).not.toContain('sites');
  });

  it('内容脚本不能读取全部配置或管理服务，伪造扩展来源也不通过', async () => {
    const { app } = await configured();
    const messages: BackgroundMessage[] = [
      { type: 'GET_SETTINGS' }, { type: 'DELETE_SERVICE', provider: 'bailian' }, { type: 'TEST_SERVICE', provider: 'bailian' },
      { type: 'SAVE_SETTINGS', dataNoticeAccepted: true }, { type: 'ENABLE_SITE', origin: 'https://example.test' },
    ];
    for (const message of messages) expect(await app.handle(message, pageSender)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await app.handle({ type: 'GET_SETTINGS' }, { ...optionSender, id: 'different-extension' })).toMatchObject({ ok: false });
    expect(await app.handle({ type: 'GET_SETTINGS' }, { ...optionSender, url: `${optionSender.url}?spoof=1` })).toMatchObject({ ok: false });
  });

  it('popup 可以保存偏好与确认说明，但不能写入服务资料', async () => {
    const { app } = await configured();
    expect(await app.handle({ type: 'SAVE_SETTINGS', preferences: { ...prefs, target: 'en' } }, popupSender)).toMatchObject({ ok: true });
    expect(await app.handle({ type: 'SAVE_SETTINGS', provider: 'bailian', config: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } }, popupSender)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await app.handle({ type: 'GET_SETTINGS' }, { ...optionSender, tab: { id: 19 } as chrome.tabs.Tab })).toMatchObject({ ok: true });
  });

  it('接收支持的多语偏好并拒绝清单之外的语言代码', async () => {
    const { app } = await configured();
    expect(await app.handle({ type: 'SAVE_SETTINGS', preferences: { ...prefs, source: 'ja', target: 'ko' } }, popupSender)).toMatchObject({ ok: true, value: { preferences: { source: 'ja', target: 'ko' } } });
    const unsupported = { type: 'SAVE_SETTINGS', preferences: { ...prefs, source: 'xx', target: 'yy' } } as unknown as BackgroundMessage;
    expect(await app.handle(unsupported, popupSender)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', message: '请选择支持的语言选项。' } });
  });

  it('迁移并持久化页面展示模式、默认关闭的悬停翻译和规范快捷键', async () => {
    const { app } = await configured();
    expect(await app.handle({ type: 'GET_SETTINGS' }, optionSender)).toMatchObject({ ok: true, value: { pageDisplayMode: 'bilingual', hoverTranslationEnabled: false, hoverShortcut: 'Alt+I' } });
    expect(await app.handle({ type: 'SAVE_SETTINGS', pageDisplayMode: 'parallel', hoverTranslationEnabled: true, hoverShortcut: 'Ctrl+Shift+K' }, optionSender)).toMatchObject({ ok: true, value: { pageDisplayMode: 'parallel', hoverTranslationEnabled: true, hoverShortcut: 'Ctrl+Shift+K' } });
    expect(await app.handle({ type: 'SAVE_SETTINGS', hoverShortcut: 'Shift+I' }, optionSender)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await app.handle({ type: 'SAVE_SETTINGS', pageDisplayMode: 'overlay' } as unknown as BackgroundMessage, optionSender)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('拒绝缺失文档身份、iframe、错误来源以及跨文档任务请求', async () => {
    const { app, fetcher } = await configured();
    for (const sender of [{ ...pageSender, documentId: undefined }, { ...pageSender, frameId: 2 }, { ...pageSender, origin: 'https://other.test' }]) {
      expect(await app.handle({ type: 'GET_CONTEXT' }, sender)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    await start(app);
    expect(await app.handle({ type: 'TRANSLATE', jobId: 'job-page', mode: 'page', itemId: 'p1', text: 'Hello' }, { ...pageSender, documentId: 'different-document' })).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('文档发生变化或授权失效时实际请求之前拒绝', async () => {
    const { app, mock, fetcher } = await configured();
    await start(app);
    mock.scripting.executeScript.mockRejectedValueOnce(new Error('cannot access'));
    expect(await app.handle({ type: 'TRANSLATE', jobId: 'job-page', mode: 'page', itemId: 'p1', text: 'Hello' }, pageSender)).toMatchObject({ ok: false, error: { code: 'PERMISSION' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('session 只记录控制信息，重启不重放旧请求', async () => {
    const { app, api, session, fetcher } = await configured();
    await start(app);
    expect(await app.handle({ type: 'TRANSLATE', jobId: 'job-page', mode: 'page', itemId: 'p1', text: 'A unique paragraph body' }, pageSender)).toMatchObject({ ok: true });
    expect(JSON.stringify(session)).not.toContain('A unique paragraph body');
    expect(JSON.stringify(session)).not.toContain('测试译文');
    expect(JSON.stringify(session)).not.toContain('VIRTUAL_ONLY_CONFIG_VALUE');
    const restarted = new BackgroundApp(api, fetcher);
    await restarted.ready;
    expect(await restarted.handle({ type: 'TRANSLATE', jobId: 'job-page', mode: 'page', itemId: 'p2', text: 'Hello' }, pageSender)).toMatchObject({ ok: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('后台队列、停止与配置删除', () => {
  it('停止取消后台排队项，已发迟到响应不成功，不再发送下一项', async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const { app } = await configured(fetcher);
    await start(app);
    const requests = [1, 2, 3].map(index => app.handle({ type: 'TRANSLATE', jobId: 'job-page', mode: 'page', itemId: `p${index}`, text: `Hello ${index}` }, pageSender));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(await app.handle({ type: 'CANCEL_JOB', jobId: 'job-page', mode: 'page' }, pageSender)).toMatchObject({ ok: true });
    expect((await Promise.all(requests)).every(reply => !reply.ok && reply.error.code === 'CANCELED')).toBe(true);
    releases.forEach(release => release(completed()));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('删除服务撤销排队与已发请求、发送删除通知，并拒绝重新开始', async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const { app, mock, local } = await configured(fetcher);
    await start(app);
    const requests = [1, 2, 3].map(index => app.handle({ type: 'TRANSLATE', jobId: 'job-page', mode: 'page', itemId: `p${index}`, text: `Hello ${index}` }, pageSender));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(await app.handle({ type: 'DELETE_SERVICE', provider: 'bailian' }, optionSender)).toMatchObject({ ok: true });
    expect(JSON.stringify(local)).not.toContain('VIRTUAL_ONLY_CONFIG_VALUE');
    expect(mock.tabs.sendMessage).toHaveBeenCalledWith(8, { type: 'SERVICE_REMOVED', provider: 'bailian' });
    expect((await Promise.all(requests)).every(reply => !reply.ok)).toBe(true);
    releases.forEach(release => release(completed()));
    expect(await app.handle({ type: 'BEGIN_JOB', jobId: 'new-job', mode: 'page', preferences: prefs }, pageSender)).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('保存新配置使旧任务失效，不改变旧任务快照', async () => {
    const { app, fetcher } = await configured();
    await start(app);
    expect(await app.handle({ type: 'SAVE_SETTINGS', provider: 'bailian', config: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' } }, optionSender)).toMatchObject({ ok: true });
    expect(await app.handle({ type: 'TRANSLATE', jobId: 'job-page', mode: 'page', itemId: 'p1', text: 'Hello' }, pageSender)).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await app.handle({ type: 'BEGIN_JOB', jobId: 'new-job', mode: 'page', preferences: prefs }, pageSender)).toMatchObject({ ok: true, value: { revision: 2 } });
  });

  it('供应商鉴权失败保持准确错误分类，同时停止其他请求', async () => {
    const { app } = await configured(vi.fn(async () => new Response('not exposed', { status: 401 })));
    await start(app);
    expect(await app.handle({ type: 'TRANSLATE', jobId: 'job-page', mode: 'page', itemId: 'p1', text: 'Hello' }, pageSender)).toMatchObject({ ok: false, error: { code: 'AUTH' } });
  });

  it.each([[10009, 'AUTH'], [10010, 'CONFIG'], [10013, 'QUOTA']] as const)('阿里业务码 %i 停止同服务的已发与排队项，并保留 %s 分类', async (businessCode, expected) => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const { app } = await configured(fetcher);
    expect(await app.handle({ type: 'SAVE_SETTINGS', provider: 'aliyun', config: { endpoint: 'https://mt.cn-hangzhou.aliyuncs.com', accessKeyId: 'VIRTUAL_ID_ONLY', accessKeySecret: 'VIRTUAL_SIGNING_ONLY' } }, optionSender)).toMatchObject({ ok: true });
    expect(await app.handle({ type: 'BEGIN_JOB', jobId: 'aliyun-page', mode: 'page', preferences: { ...prefs, provider: 'aliyun' } }, pageSender)).toMatchObject({ ok: true });
    const requests = [1, 2, 3].map(index => app.handle({ type: 'TRANSLATE', jobId: 'aliyun-page', mode: 'page', itemId: `p${index}`, text: `Hello ${index}` }, pageSender));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    releases[0](new Response(JSON.stringify({ Code: businessCode, Message: 'DO_NOT_ECHO_REMOTE_BUSINESS_MESSAGE' })));
    const replies = await within(Promise.all(requests));
    expect(replies.every(reply => !reply.ok && reply.error.code === expected)).toBe(true);
    expect(JSON.stringify(replies)).not.toContain('DO_NOT_ECHO');
    releases[1](new Response(JSON.stringify({ Code: 200, Data: { Translated: '迟到译文' } })));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await app.handle({ type: 'TRANSLATE', jobId: 'aliyun-page', mode: 'page', itemId: 'p4', text: 'Hello again' }, pageSender)).toMatchObject({ ok: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('文本识别失败仅失败当前项，不停止同服务后续段落', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ Code: 200, Data: { Translated: '后续译文' } })));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ Code: 10006 })));
    const { app } = await configured(fetcher);
    await app.handle({ type: 'SAVE_SETTINGS', provider: 'aliyun', config: { endpoint: 'https://mt.cn-hangzhou.aliyuncs.com', accessKeyId: 'VIRTUAL_ID_ONLY', accessKeySecret: 'VIRTUAL_SIGNING_ONLY' } }, optionSender);
    await app.handle({ type: 'BEGIN_JOB', jobId: 'aliyun-page', mode: 'page', preferences: { ...prefs, provider: 'aliyun' } }, pageSender);
    expect(await app.handle({ type: 'TRANSLATE', jobId: 'aliyun-page', mode: 'page', itemId: 'p1', text: '12345' }, pageSender)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await app.handle({ type: 'TRANSLATE', jobId: 'aliyun-page', mode: 'page', itemId: 'p2', text: 'Hello' }, pageSender)).toMatchObject({ ok: true, value: { translated: '后续译文' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('划词任务优先取得下一个空闲槽，不抢占已发正文', async () => {
    const pool = new RequestPool(1);
    const order: string[] = [];
    let release!: () => void;
    const first = pool.enqueue('first', 'page', async () => { order.push('first'); await new Promise<void>(resolve => { release = resolve; }); return 1; });
    const page = pool.enqueue('page', 'page', async () => { order.push('page'); return 2; });
    const selection = pool.enqueue('selection', 'selection', async () => { order.push('selection'); return 3; });
    await vi.waitFor(() => expect(order).toEqual(['first']));
    release();
    await Promise.all([first, page, selection]);
    expect(order).toEqual(['first', 'selection', 'page']);
  });
});

describe('站点划词授权', () => {
  it('授权成功前不能登记站点，也不能开始划词', async () => {
    const { app, registered } = await configured();
    expect(await app.handle({ type: 'ENABLE_SITE', origin: 'https://example.test' }, popupSender)).toMatchObject({ ok: false, error: { code: 'PERMISSION' } });
    expect(registered.size).toBe(0);
    expect(await app.handle({ type: 'BEGIN_JOB', mode: 'selection', jobId: 'selected', preferences: prefs }, pageSender)).toMatchObject({ ok: false });
    const settings = await app.handle({ type: 'GET_SETTINGS' }, popupSender);
    expect(settings).toMatchObject({ ok: true, value: { sites: [] } });
  });

  it('只登记已授权来源，撤销权限清理注册、相关任务与页面状态', async () => {
    const { app, origins, registered, mock } = await configured();
    origins.add('https://example.test/*');
    expect(await app.handle({ type: 'ENABLE_SITE', origin: 'https://example.test' }, popupSender)).toMatchObject({ ok: true });
    expect(registered.size).toBe(1);
    expect([...registered.values()][0]).toMatchObject({ matches: ['https://example.test/*'], js: ['content.js'], persistAcrossSessions: true });
    await start(app, 'selected', 'selection');
    origins.clear();
    await app.permissionsRemoved();
    expect(registered.size).toBe(0);
    expect(mock.tabs.sendMessage).toHaveBeenCalledWith(8, { type: 'SITE_CHANGED', enabled: false });
    expect(await app.handle({ type: 'TRANSLATE', mode: 'selection', jobId: 'selected', itemId: 'chosen', text: 'Hello' }, pageSender)).toMatchObject({ ok: false });
  });

  it('工具栏授权框关闭弹窗后，后台权限新增事件直接启用当前网站并注入页面', async () => {
    const { app, origins, registered, mock } = await configured();
    vi.clearAllMocks();
    origins.add('https://example.test/*');
    await app.permissionsAdded({ origins: ['https://example.test/*'] });
    expect(await app.handle({ type: 'GET_SETTINGS' }, popupSender)).toMatchObject({ ok: true, value: { sites: ['https://example.test'] } });
    expect([...registered.values()][0]).toMatchObject({ matches: ['https://example.test/*'], js: ['content.js'] });
    expect(mock.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 8, allFrames: true }, files: ['content.js'] });
    expect(mock.tabs.sendMessage).toHaveBeenCalledWith(8, { type: 'SITE_CHANGED', enabled: true });
  });

  it('全站权限新增事件一次完成启用、注册和当前页面注入', async () => {
    const { app, origins, registered, mock } = await configured();
    vi.clearAllMocks();
    origins.add('http://*/*');
    origins.add('https://*/*');
    await app.permissionsAdded({ origins: ['<all_urls>'] });
    expect(await app.handle({ type: 'GET_SETTINGS' }, popupSender)).toMatchObject({ ok: true, value: { allSitesEnabled: true, allSitesGranted: true } });
    expect([...registered.keys()]).toEqual(['yeban-all-sites']);
    expect(mock.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 8, allFrames: true }, files: ['content.js'] });
  });

  it('悬停任务要求网站授权和独立开关，关闭后立即使已有任务失效', async () => {
    const { app, origins } = await configured();
    origins.add('https://example.test/*');
    await app.handle({ type: 'ENABLE_SITE', origin: 'https://example.test' }, popupSender);
    expect(await app.handle({ type: 'BEGIN_JOB', mode: 'hover', jobId: 'hovered', preferences: prefs }, pageSender)).toMatchObject({ ok: false, error: { code: 'PERMISSION' } });
    await app.handle({ type: 'SAVE_SETTINGS', hoverTranslationEnabled: true }, optionSender);
    expect(await app.handle({ type: 'GET_CONTEXT' }, pageSender)).toMatchObject({ ok: true, value: { hoverTranslationEnabled: true, hoverShortcut: 'Alt+I' } });
    await start(app, 'hovered', 'hover');
    expect(await app.handle({ type: 'TRANSLATE', mode: 'hover', jobId: 'hovered', itemId: 'paragraph', text: 'Hover text' }, pageSender)).toMatchObject({ ok: true });
    await app.handle({ type: 'SAVE_SETTINGS', hoverTranslationEnabled: false }, optionSender);
    expect(await app.handle({ type: 'TRANSLATE', mode: 'hover', jobId: 'hovered', itemId: 'later', text: 'Later text' }, pageSender)).toMatchObject({ ok: false });
  });
});

describe('同源 iframe 划词与文档隔离', () => {
  const child = { ...pageSender, url: 'https://example.test/md/', frameId: 2, documentId: 'frame-document' };

  async function authorizedFrame() {
    const fixture = await configured();
    fixture.origins.add('https://example.test/*');
    await fixture.app.handle({ type: 'ENABLE_SITE', origin: 'https://example.test' }, popupSender);
    return fixture;
  }

  it('已授权同源 iframe 可主动翻译，独立上下文不创建浮球或侧栏状态', async () => {
    const { app, mock, registered } = await authorizedFrame();
    expect([...registered.values()][0].allFrames).toBe(true);
    expect(await app.handle({ type: 'GET_CONTEXT' }, child)).toMatchObject({ ok: true, value: { selectionEnabled: true, floatingEnabled: false, sidePanel: undefined } });
    expect(await app.handle({ type: 'BEGIN_JOB', jobId: 'selected', mode: 'selection', preferences: prefs }, child)).toMatchObject({ ok: true });
    expect(await app.handle({ type: 'TRANSLATE', jobId: 'selected', mode: 'selection', itemId: 'p', text: 'Dummy iframe selection' }, child)).toMatchObject({ ok: true, value: { translated: '测试译文' } });
    expect(mock.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 8, documentIds: ['frame-document'] }, func: expect.any(Function) });
  });

  it('不同 iframe 使用相同任务 ID 仍彼此隔离，取消一个不影响另一个和顶层', async () => {
    const { app } = await authorizedFrame();
    const sibling = { ...child, frameId: 3, documentId: 'sibling-document' };
    for (const sender of [pageSender, child, sibling]) expect(await app.handle({ type: 'BEGIN_JOB', mode: 'selection', jobId: 'same-id', preferences: prefs }, sender)).toMatchObject({ ok: true });
    await app.handle({ type: 'CANCEL_JOB', mode: 'selection', jobId: 'same-id' }, child);
    const command = { type: 'TRANSLATE', mode: 'selection', jobId: 'same-id', itemId: 'p', text: 'Dummy selected words' };
    expect(await app.handle(command, child)).toMatchObject({ ok: false });
    for (const sender of [pageSender, sibling]) expect(await app.handle(command, sender)).toMatchObject({ ok: true });
    expect(await app.handle(command, { ...sibling, documentId: 'new-document' })).toMatchObject({ ok: false });
  });

  it('跨站 iframe 即使自身获得站点授权也不能借用顶层页面', async () => {
    const { app, origins, fetcher } = await authorizedFrame();
    origins.add('https://other.test/*');
    await app.handle({ type: 'ENABLE_SITE', origin: 'https://other.test' }, popupSender);
    const crossOrigin = { ...child, url: 'https://other.test/md/', origin: 'https://other.test' };
    expect(await app.handle({ type: 'GET_CONTEXT' }, crossOrigin)).toMatchObject({ ok: false });
    expect(await app.handle({ type: 'BEGIN_JOB', mode: 'selection', jobId: 'x', preferences: prefs }, crossOrigin)).toMatchObject({ ok: false });
    expect(await app.handle({ type: 'GET_CONTEXT' }, { ...child, origin: 'null' })).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('iframe 无权启动全文翻译、读取凭据配置或控制顶层浮球与侧栏', async () => {
    const { app } = await authorizedFrame();
    for (const command of [
      { type: 'GET_SETTINGS' }, { type: 'SET_FLOATING_POSITION', position: 0.4 }, { type: 'GET_SIDE_PANEL_STATE' },
      { type: 'OPEN_SIDE_PANEL' }, { type: 'SET_SIDE_PANEL', open: true },
      { type: 'BEGIN_JOB', mode: 'page', jobId: 'x', preferences: prefs },
    ]) expect(await app.handle(command, child)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('子文档导航、顶层跨站或撤销授权后不再提交翻译', async () => {
    const { app, mock, origins, fetcher } = await authorizedFrame();
    await app.handle({ type: 'BEGIN_JOB', mode: 'selection', jobId: 'x', preferences: prefs }, child);
    const command = { type: 'TRANSLATE', mode: 'selection', jobId: 'x', itemId: 'p', text: 'Dummy selected words' };
    mock.scripting.executeScript.mockResolvedValueOnce([{ documentId: 'replaced-document', result: true }]);
    expect(await app.handle(command, child)).toMatchObject({ ok: false });
    mock.tabs.get.mockResolvedValueOnce({ id: 8, url: 'https://other.test/article' });
    expect(await app.handle(command, child)).toMatchObject({ ok: false });
    origins.clear();
    expect(await app.handle(command, child)).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('升级时替换同一来源的旧顶层注册，保留网站授权并启用全部 frame', async () => {
    const { app, registered } = await authorizedFrame();
    const [id, script] = [...registered.entries()][0];
    registered.set(id, { ...script, allFrames: false });
    await app.handle({ type: 'ENABLE_SITE', origin: 'https://example.test' }, popupSender);
    expect(registered.size).toBe(1);
    expect(registered.get(id)?.allFrames).toBe(true);
  });
});

describe('通知接收方回调后台的并发边界', () => {
  it.each(['delete', 'disable', 'revoke'] as const)('%s：控制状态先失效，再等待页面取消回执，不形成互等', async operation => {
    const { app, origins, mock, local, fetcher } = await configured();
    origins.add('https://example.test/*');
    await app.handle({ type: 'ENABLE_SITE', origin: 'https://example.test' }, popupSender);
    const kind = operation === 'delete' ? 'page' : 'selection';
    await start(app, 'notified-job', kind);
    const cancellationReplies: unknown[] = [];
    mock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type !== 'SERVICE_REMOVED' && (message.type !== 'SITE_CHANGED' || message.enabled)) return;
      // 模拟内容脚本收到通知后，必须先等 CANCEL_JOB 才回复 sendMessage。
      cancellationReplies.push(await app.handle({ type: 'CANCEL_JOB', mode: kind, jobId: 'notified-job' }, pageSender));
      const stale = await app.handle({ type: 'TRANSLATE', mode: kind, jobId: 'notified-job', itemId: 'old-item', text: 'Hello' }, pageSender);
      expect(stale.ok).toBe(false);
      if (operation === 'delete') expect(JSON.stringify(local)).not.toContain('VIRTUAL_ONLY_CONFIG_VALUE');
      else expect(await app.handle({ type: 'GET_CONTEXT' }, pageSender)).toMatchObject({ ok: true, value: { selectionEnabled: false } });
    });
    if (operation === 'revoke') {
      origins.clear();
      await within(app.permissionsRemoved());
    } else {
      const reply = operation === 'delete'
        ? app.handle({ type: 'DELETE_SERVICE', provider: 'bailian' }, optionSender)
        : app.handle({ type: 'DISABLE_SITE', origin: 'https://example.test' }, popupSender);
      expect(await within(reply)).toMatchObject({ ok: true });
    }
    expect(cancellationReplies).toEqual([{ ok: true, value: null }]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await within(app.handle({ type: 'GET_SETTINGS' }, popupSender))).toMatchObject({ ok: true });
    expect(await within(app.handle({ type: 'SAVE_SETTINGS', preferences: prefs }, popupSender))).toMatchObject({ ok: true });
  });

  it('启用站点后的通知也允许接收方回调取消操作', async () => {
    const { app, origins, mock } = await configured();
    origins.add('https://example.test/*');
    mock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'SITE_CHANGED') expect(await app.handle({ type: 'CANCEL_JOB', mode: 'selection' }, pageSender)).toMatchObject({ ok: true });
    });
    expect(await within(app.handle({ type: 'ENABLE_SITE', origin: 'https://example.test' }, popupSender))).toMatchObject({ ok: true });
  });
});

describe('0.2 默认服务与全站模式', () => {
  it('迁移旧默认服务为首优先级，并为旧配置补齐全局默认', async () => {
    const context = createMock();
    context.local.yebanSettings = { preferences: { ...prefs, provider: 'aliyun' }, services: {
      bailian: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', version: 0 },
      aliyun: { endpoint: 'https://mt.cn-hangzhou.aliyuncs.com', version: 0 },
    }, sites: [], dataNoticeAccepted: false };
    const app = new BackgroundApp(context.api);
    expect(await app.handle({ type: 'GET_SETTINGS' }, optionSender)).toMatchObject({ ok: true, value: { providerPriority: ['aliyun', 'bailian'], selectionEnabled: true, allSitesEnabled: false, allSitesGranted: false, blockedSites: [] } });
    expect(context.registered.size).toBe(0);
  });

  it('自动默认使用唯一已配置服务，严格拒绝重复或不完整优先级', async () => {
    const context = createMock();
    const app = new BackgroundApp(context.api);
    await app.handle({ type: 'SAVE_SETTINGS', provider: 'aliyun', config: { endpoint: 'https://mt.cn-hangzhou.aliyuncs.com', accessKeyId: 'VIRTUAL_ID_ONLY', accessKeySecret: 'VIRTUAL_ONLY' } }, optionSender);
    expect(await app.handle({ type: 'GET_SETTINGS' }, popupSender)).toMatchObject({ ok: true, value: { preferences: { provider: 'aliyun' }, providerPriority: ['aliyun', 'bailian'] } });
    for (const providerPriority of [['bailian'], ['bailian', 'bailian'], ['aliyun', 'unsupported']]) expect(await app.handle({ type: 'SAVE_SETTINGS', providerPriority }, optionSender)).toMatchObject({ ok: false });
  });

  it('全站授权未授予时不注册，授予后单一全站注册且被屏蔽站点关闭', async () => {
    const { app, origins, registered } = await configured();
    expect(await app.handle({ type: 'ENABLE_ALL_SITES' }, popupSender)).toMatchObject({ ok: false, error: { code: 'PERMISSION' } });
    expect(registered.size).toBe(0);
    origins.add('http://*/*'); origins.add('https://*/*');
    expect(await app.handle({ type: 'ENABLE_ALL_SITES' }, popupSender)).toMatchObject({ ok: true, value: { allSitesEnabled: true, allSitesGranted: true } });
    expect([...registered.keys()]).toEqual(['yeban-all-sites']);
    expect(await app.handle({ type: 'GET_CONTEXT' }, pageSender)).toMatchObject({ ok: true, value: { selectionEnabled: true, floatingEnabled: true } });
    await app.handle({ type: 'DISABLE_SITE', origin: 'https://example.test' }, popupSender);
    expect(await app.handle({ type: 'GET_CONTEXT' }, pageSender)).toMatchObject({ ok: true, value: { selectionEnabled: false, floatingEnabled: false } });
    expect(registered.get('yeban-all-sites')?.excludeMatches).toEqual(['https://example.test/*']);
    await app.handle({ type: 'ENABLE_SITE', origin: 'https://example.test' }, popupSender);
    expect(await app.handle({ type: 'GET_CONTEXT' }, pageSender)).toMatchObject({ ok: true, value: { selectionEnabled: true, floatingEnabled: true } });
  });

  it('全局划词关闭只取消划词，浮球与手动正文继续可用', async () => {
    const { app, origins } = await configured();
    origins.add('https://example.test/*');
    await app.handle({ type: 'ENABLE_SITE', origin: 'https://example.test' }, popupSender);
    await start(app, 'selected', 'selection');
    await start(app, 'page-active');
    expect(await app.handle({ type: 'SAVE_SETTINGS', selectionEnabled: false }, optionSender)).toMatchObject({ ok: true });
    expect(await app.handle({ type: 'GET_CONTEXT' }, pageSender)).toMatchObject({ ok: true, value: { selectionEnabled: false, floatingEnabled: true } });
    expect(await app.handle({ type: 'TRANSLATE', mode: 'selection', jobId: 'selected', itemId: 's', text: 'Hello' }, pageSender)).toMatchObject({ ok: false });
    expect(await app.handle({ type: 'TRANSLATE', mode: 'page', jobId: 'page-active', itemId: 'p', text: 'Hello' }, pageSender)).toMatchObject({ ok: true });
  });

  it('全站权限撤销关闭注册与已有任务，关闭全站保留仍有效逐站权限', async () => {
    const { app, origins, registered } = await configured();
    origins.add('https://example.test/*');
    await app.handle({ type: 'ENABLE_SITE', origin: 'https://example.test' }, popupSender);
    origins.add('http://*/*'); origins.add('https://*/*');
    await app.handle({ type: 'ENABLE_ALL_SITES' }, popupSender);
    expect(registered.size).toBe(1);
    expect(await app.handle({ type: 'DISABLE_ALL_SITES' }, popupSender)).toMatchObject({ ok: true, value: { allSitesEnabled: false, allSitesGranted: false, sites: ['https://example.test'] } });
    expect(registered.has('yeban-all-sites')).toBe(false);
    expect(registered.size).toBe(1);
    origins.add('http://*/*'); origins.add('https://*/*');
    await app.handle({ type: 'ENABLE_ALL_SITES' }, popupSender);
    origins.clear();
    await app.permissionsRemoved();
    expect(registered.size).toBe(0);
    expect(await app.handle({ type: 'GET_CONTEXT' }, pageSender)).toMatchObject({ ok: true, value: { selectionEnabled: false } });
  });

  it('优先级重排仅影响新默认，已有任务维持服务快照并且通知不持锁', async () => {
    const { app, mock, fetcher } = await configured();
    await start(app);
    await app.handle({ type: 'SAVE_SETTINGS', provider: 'aliyun', config: { endpoint: 'https://mt.cn-hangzhou.aliyuncs.com', accessKeyId: 'VIRTUAL_ID_ONLY', accessKeySecret: 'VIRTUAL_ONLY' } }, optionSender);
    mock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'FEATURES_CHANGED') expect(await app.handle({ type: 'CANCEL_JOB', mode: 'selection' }, pageSender)).toMatchObject({ ok: true });
    });
    expect(await within(app.handle({ type: 'SAVE_SETTINGS', providerPriority: ['aliyun', 'bailian'] }, optionSender))).toMatchObject({ ok: true, value: { preferences: { provider: 'aliyun' } } });
    expect(await app.handle({ type: 'TRANSLATE', mode: 'page', jobId: 'job-page', itemId: 'old', text: 'Hello' }, pageSender)).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledWith('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', expect.anything());
  });

  it('移除全站权限时浏览器反向通知不会与控制锁互等', async () => {
    const { app, origins, mock } = await configured();
    origins.add('http://*/*'); origins.add('https://*/*');
    await app.handle({ type: 'ENABLE_ALL_SITES' }, popupSender);
    mock.permissions.remove.mockImplementation(async ({ origins: removed }) => {
      removed.forEach(origin => origins.delete(origin));
      await app.permissionsRemoved();
      return true;
    });
    mock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'FEATURES_CHANGED') expect(await app.handle({ type: 'CANCEL_JOB', mode: 'selection' }, pageSender)).toMatchObject({ ok: true });
    });
    expect(await within(app.handle({ type: 'DISABLE_ALL_SITES' }, popupSender))).toMatchObject({ ok: true, value: { allSitesEnabled: false, allSitesGranted: false } });
  });
});

describe('0.2 原生侧栏消息与任务', () => {
  it('原生open在任何初始化等待之前触发，不支持时明确失败', async () => {
    const context = createMock();
    let release!: () => void;
    context.mock.storage.local.setAccessLevel.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const app = new BackgroundApp(context.api);
    const opening = app.handle({ type: 'OPEN_SIDE_PANEL', tabId: 8 }, popupSender);
    expect(context.mock.sidePanel.open).toHaveBeenCalledWith({ tabId: 8 });
    expect(await within(opening)).toMatchObject({ ok: true });
    release(); await app.ready;
    (context.api as unknown as { sidePanel?: unknown }).sidePanel = undefined;
    expect(await app.handle({ type: 'OPEN_SIDE_PANEL' }, pageSender)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
  });

  it('侧栏可读公开设置和翻译文本，不能管理服务；网页不能冒充侧栏', async () => {
    const { app, mock } = await configured();
    expect(await app.handle({ type: 'GET_SETTINGS' }, panelSender)).toMatchObject({ ok: true });
    for (const message of [{ type: 'SAVE_SETTINGS', preferences: prefs }, { type: 'DELETE_SERVICE', provider: 'bailian' }, { type: 'TEST_SERVICE', provider: 'bailian' }]) expect(await app.handle(message, panelSender)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await app.handle({ type: 'TRANSLATE_PANEL', requestId: 'one', preferences: prefs, text: 'Hello' }, pageSender)).toMatchObject({ ok: false });
    expect(await app.handle({ type: 'TRANSLATE_PANEL', requestId: 'one', preferences: prefs, text: 'Hello' }, panelSender)).toMatchObject({ ok: true, value: { translated: '测试译文' } });
    expect(mock.scripting.executeScript).not.toHaveBeenCalled();
    expect(await app.handle({ type: 'OPEN_SIDE_PANEL', tabId: 99 }, { ...pageSender, id: 'forged' })).toMatchObject({ ok: false });
  });

  it('侧栏排队请求可取消，配置删除取消已发请求且迟到结果不成功', async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const { app, session } = await configured(fetcher);
    const requests = ['a', 'b', 'c'].map(id => app.handle({ type: 'TRANSLATE_PANEL', requestId: id, preferences: prefs, text: 'Panel sample text' }, { ...panelSender, documentId: `panel-${id}` }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(await app.handle({ type: 'CANCEL_PANEL', requestId: 'c' }, { ...panelSender, documentId: 'panel-c' })).toMatchObject({ ok: true });
    expect(await requests[2]).toMatchObject({ ok: false, error: { code: 'CANCELED' } });
    await app.handle({ type: 'DELETE_SERVICE', provider: 'bailian' }, optionSender);
    expect((await Promise.all(requests)).every(reply => !reply.ok)).toBe(true);
    releases.forEach(release => release(completed()));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(session)).not.toContain('Panel sample text');
  });

  it('侧栏同文档的新请求取消旧请求，并拒绝超长输入', async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const { app } = await configured(fetcher);
    const first = app.handle({ type: 'TRANSLATE_PANEL', requestId: 'old', preferences: prefs, text: 'Old text' }, panelSender);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    // 不同侧栏文档不能取消此文档的请求。
    expect(await app.handle({ type: 'CANCEL_PANEL', requestId: 'old' }, { ...panelSender, documentId: 'other-panel' })).toMatchObject({ ok: true });
    const second = app.handle({ type: 'TRANSLATE_PANEL', requestId: 'new', preferences: prefs, text: 'New text' }, panelSender);
    expect(await within(first)).toMatchObject({ ok: false, error: { code: 'CANCELED' } });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    releases[1](completed());
    expect(await second).toMatchObject({ ok: true, value: { translated: '测试译文' } });
    releases[0](completed());
    expect(await app.handle({ type: 'TRANSLATE_PANEL', requestId: 'long', preferences: prefs, text: 'a'.repeat(2001) }, panelSender)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('正在关闭的侧栏可取消自身排队和在途请求，但不能取消其他文档或创建新请求', async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const { app } = await configured(fetcher);
    const requests = ['a', 'b', 'c'].map(id => app.handle({ type: 'TRANSLATE_PANEL', requestId: id, preferences: prefs, text: `Panel ${id}` }, { ...panelSender, documentId: `panel-${id}` }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const closing = { ...panelSender, documentLifecycle: 'pending_deletion' as const };
    expect(await app.handle({ type: 'CANCEL_PANEL', requestId: 'c' }, { ...closing, documentId: 'panel-c' })).toMatchObject({ ok: true });
    expect(await within(requests[2])).toMatchObject({ ok: false, error: { code: 'CANCELED' } });
    expect(await app.handle({ type: 'CANCEL_PANEL', requestId: 'a' }, closing)).toMatchObject({ ok: true });
    expect(await within(requests[0])).toMatchObject({ ok: false, error: { code: 'CANCELED' } });
    expect(await app.handle({ type: 'CANCEL_PANEL', requestId: 'b' }, closing)).toMatchObject({ ok: true });
    for (const documentLifecycle of ['pending_deletion', 'cached', 'prerender'] as const) {
      expect(await app.handle({ type: 'TRANSLATE_PANEL', requestId: 'new', preferences: prefs, text: 'No new request' }, { ...panelSender, documentLifecycle })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    for (const sender of [{ ...closing, id: 'other-extension' }, { ...closing, url: 'https://example.test' }, { ...closing, documentId: undefined }]) {
      expect(await app.handle({ type: 'CANCEL_PANEL', requestId: 'b' }, sender)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    releases[0](completed());
    releases[1](completed());
    expect(await within(requests[1])).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('0.2.1 侧栏独立连接', () => {
  it('合法侧栏缺少可选文档字段也能通过独立 Port 翻译，扩展 origin 不用 URL.origin 判断', async () => {
    const { app, fetcher } = await configured();
    const connection = createPanelPort({ id: 'extension-test', url: panelSender.url, origin: 'chrome-extension://extension-test' });
    app.connectPanel(connection.port);
    connection.send({ messageId: 'message-1', message: { type: 'TRANSLATE_PANEL', requestId: 'request-1', preferences: prefs, text: 'Hello' } });
    await vi.waitFor(() => expect(connection.responses).toEqual([{ messageId: 'message-1', reply: { ok: true, value: { translated: '测试译文' } } }]));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('拒绝网页、其他扩展、伪造 origin、错误名称和明确非活动文档连接', async () => {
    const { app, fetcher } = await configured();
    for (const sender of [
      { id: 'extension-test', url: 'https://example.test' },
      { id: 'other-extension', url: panelSender.url },
      { id: 'extension-test', url: panelSender.url, origin: 'https://example.test' },
      { id: 'extension-test', url: panelSender.url, origin: 'null' },
      { id: 'extension-test', url: panelSender.url, documentLifecycle: 'pending_deletion' as const },
    ]) {
      const connection = createPanelPort(sender);
      app.connectPanel(connection.port);
      expect(connection.mock.disconnect).toHaveBeenCalledTimes(1);
    }
    const named = createPanelPort(undefined, 'unknown-channel');
    app.connectPanel(named.port);
    expect(named.mock.disconnect).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('两条 Port 使用相同 requestId 互不串用，一个断开不影响另一个', async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const { app } = await configured(fetcher);
    const a = createPanelPort(); const b = createPanelPort();
    app.connectPanel(a.port); app.connectPanel(b.port);
    const envelope: PanelEnvelope = { messageId: 'message-1', message: { type: 'TRANSLATE_PANEL', requestId: 'same-request', preferences: prefs, text: 'Hello' } };
    a.send(envelope); b.send(envelope);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    a.mock.disconnect();
    releases[0](completed()); releases[1](completed());
    await vi.waitFor(() => expect(b.responses).toHaveLength(1));
    expect(b.responses[0].reply).toMatchObject({ ok: true });
    expect(a.responses).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ready 之前断连使已收到的消息失效，初始化完成也不会再发请求', async () => {
    const { api, mock, fetcher } = await configured();
    let release!: () => void;
    mock.storage.local.setAccessLevel.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const restarted = new BackgroundApp(api, fetcher);
    const connection = createPanelPort();
    restarted.connectPanel(connection.port);
    connection.send({ messageId: 'waiting', message: { type: 'TRANSLATE_PANEL', requestId: 'waiting', preferences: prefs, text: 'Hello' } });
    connection.mock.disconnect();
    release(); await restarted.ready;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetcher).not.toHaveBeenCalled();
    expect(connection.responses).toEqual([]);
  });

  it('等待其他设置写入释放控制锁时断连，也不会在锁释放后发出迟到请求', async () => {
    const { app, mock, fetcher } = await configured();
    let release!: () => void;
    const persist = mock.storage.local.set.getMockImplementation()!;
    mock.storage.local.set.mockImplementationOnce(async values => {
      await new Promise<void>(resolve => { release = resolve; });
      await persist(values);
    });
    const saving = app.handle({ type: 'SAVE_SETTINGS', preferences: prefs }, optionSender);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const connection = createPanelPort();
    app.connectPanel(connection.port);
    connection.send({ messageId: 'waiting-lock', message: { type: 'TRANSLATE_PANEL', requestId: 'waiting-lock', preferences: prefs, text: 'Hello' } });
    await Promise.resolve();
    connection.mock.disconnect();
    release();
    expect(await within(saving)).toMatchObject({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetcher).not.toHaveBeenCalled();
    expect(connection.responses).toEqual([]);
  });

  it('断开 Port 同时撤销队列与在途，空连接或重新启动不自动重放', async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const { app, api } = await configured(fetcher);
    const connections = [createPanelPort(), createPanelPort(), createPanelPort()];
    for (const [index, connection] of connections.entries()) {
      app.connectPanel(connection.port);
      connection.send({ messageId: `m${index}`, message: { type: 'TRANSLATE_PANEL', requestId: 'same', preferences: prefs, text: 'Hello' } });
    }
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    connections.forEach(connection => connection.mock.disconnect());
    releases.forEach(release => release(completed()));
    const restarted = new BackgroundApp(api, fetcher);
    await restarted.ready;
    restarted.connectPanel(createPanelPort().port);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(connections.every(connection => connection.responses.length === 0)).toBe(true);
  });

  it('Port 只接受翻译与取消，不接受自报 owner；合法取消不用等待网络', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const { app } = await configured(fetcher);
    const connection = createPanelPort();
    app.connectPanel(connection.port);
    connection.send({ messageId: 'invalid-type', message: { type: 'GET_SETTINGS' } });
    connection.send({ messageId: 'invalid-owner', message: { type: 'TRANSLATE_PANEL', requestId: 'same', preferences: prefs, text: 'Hello', ownerId: 'port:another' } });
    expect(connection.responses).toMatchObject([{ messageId: 'invalid-type', reply: { ok: false, error: { code: 'FORBIDDEN' } } }, { messageId: 'invalid-owner', reply: { ok: false, error: { code: 'INVALID_REQUEST' } } }]);
    expect(fetcher).not.toHaveBeenCalled();
    connection.send({ messageId: 'translate', message: { type: 'TRANSLATE_PANEL', requestId: 'same', preferences: prefs, text: 'Hello' } });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    connection.send({ messageId: 'cancel', message: { type: 'CANCEL_PANEL', requestId: 'same' } });
    await vi.waitFor(() => expect(connection.responses.find(response => response.messageId === 'cancel')?.reply).toEqual({ ok: true, value: null }));
    expect(connection.responses.find(response => response.messageId === 'translate')?.reply).toMatchObject({ ok: false, error: { code: 'CANCELED' } });
    release(completed());
  });

  it('response postMessage 失败安全断连并取消仍在运行的请求', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const { app } = await configured(fetcher);
    const connection = createPanelPort();
    app.connectPanel(connection.port);
    connection.send({ messageId: 'active', message: { type: 'TRANSLATE_PANEL', requestId: 'active', preferences: prefs, text: 'Hello' } });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    connection.mock.postMessage.mockImplementationOnce(() => { throw new Error('接收方已经关闭'); });
    connection.send({ messageId: 'unsupported', message: { type: 'GET_SETTINGS' } });
    expect(connection.mock.disconnect).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].signal?.aborted).toBe(true);
    release(completed());
    expect(connection.responses).toEqual([]);
  });

  it.each(['delete', 'consent', 'auth'] as const)('%s 取消 Port 的同服务已发与排队请求', async operation => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const { app, session } = await configured(fetcher);
    const connections = [createPanelPort(), createPanelPort(), createPanelPort()];
    for (const [index, connection] of connections.entries()) {
      app.connectPanel(connection.port);
      connection.send({ messageId: `m${index}`, message: { type: 'TRANSLATE_PANEL', requestId: 'same', preferences: prefs, text: 'Unique port paragraph' } });
    }
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    if (operation === 'delete') await app.handle({ type: 'DELETE_SERVICE', provider: 'bailian' }, optionSender);
    else if (operation === 'consent') await app.handle({ type: 'SAVE_SETTINGS', dataNoticeAccepted: false }, optionSender);
    else releases[0](new Response('DO_NOT_ECHO_PROVIDER_TEXT', { status: 401 }));
    await vi.waitFor(() => expect(connections.every(connection => connection.responses.length === 1)).toBe(true));
    expect(connections.every(connection => !connection.responses[0].reply.ok)).toBe(true);
    if (operation === 'auth') expect(connections.every(connection => !connection.responses[0].reply.ok && connection.responses[0].reply.error.code === 'AUTH')).toBe(true);
    releases.forEach(release => release(completed()));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(session)).not.toContain('Unique port paragraph');
    expect(JSON.stringify(connections.map(connection => connection.responses))).not.toContain('VIRTUAL_ONLY_CONFIG_VALUE');
  });

  it('初始化等待期间限制每连接待处理数量，断连后不再执行这些消息', async () => {
    const { api, mock, fetcher } = await configured();
    let release!: () => void;
    mock.storage.local.setAccessLevel.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const waiting = new BackgroundApp(api, fetcher);
    const connection = createPanelPort();
    waiting.connectPanel(connection.port);
    for (let index = 0; index < 17; index++) connection.send({ messageId: `m${index}`, message: { type: 'TRANSLATE_PANEL', requestId: `r${index}`, preferences: prefs, text: 'Hello' } });
    expect(connection.responses).toMatchObject([{ messageId: 'm16', reply: { ok: false, error: { code: 'QUEUE_FULL' } } }]);
    connection.mock.disconnect();
    release(); await waiting.ready;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['active', 'queued'] as const)('16 个翻译等待者占满时仍可取消 %s 请求，并且没有后续调用', async location => {
    const releases: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve)));
    const { app } = await configured(fetcher);
    const blockers = location === 'queued' ? [createPanelPort(), createPanelPort()] : [];
    for (const [index, connection] of blockers.entries()) {
      app.connectPanel(connection.port);
      connection.send({ messageId: `block-${index}`, message: { type: 'TRANSLATE_PANEL', requestId: 'block', preferences: prefs, text: 'Blocker' } });
    }
    if (blockers.length) await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const connection = createPanelPort();
    app.connectPanel(connection.port);
    for (let index = 0; index < 16; index++) connection.send({ messageId: `waiting-${index}`, message: { type: 'TRANSLATE_PANEL', requestId: 'same-request', preferences: prefs, text: 'Hello' } });
    if (!blockers.length) await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    connection.send({ messageId: 'cancel-full', message: { type: 'CANCEL_PANEL', requestId: 'same-request' } });
    await vi.waitFor(() => expect(connection.responses.find(response => response.messageId === 'cancel-full')?.reply).toEqual({ ok: true, value: null }));
    await vi.waitFor(() => expect(connection.responses).toHaveLength(17));
    expect(connection.responses.filter(response => response.messageId !== 'cancel-full').every(response => !response.reply.ok && response.reply.error.code === 'CANCELED')).toBe(true);
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].signal?.aborted).toBe(location === 'active');
    releases.forEach(release => release(completed()));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetcher).toHaveBeenCalledTimes(blockers.length ? 2 : 1);
  });

  it('取消控制消息也有独立上限，超限安全断连而非无限积压', async () => {
    const { api, mock, fetcher } = await configured();
    let release!: () => void;
    mock.storage.local.setAccessLevel.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const waiting = new BackgroundApp(api, fetcher);
    const connection = createPanelPort();
    waiting.connectPanel(connection.port);
    for (let index = 0; index < 5; index++) connection.send({ messageId: `cancel-${index}`, message: { type: 'CANCEL_PANEL', requestId: 'any' } });
    expect(connection.mock.disconnect).toHaveBeenCalledTimes(1);
    release(); await waiting.ready;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('旧一次性入口允许省略生命周期，但仍要求真实文档标识', async () => {
    const { app } = await configured();
    expect(await app.handle({ type: 'TRANSLATE_PANEL', requestId: 'legacy', preferences: prefs, text: 'Hello' }, { ...panelSender, documentLifecycle: undefined })).toMatchObject({ ok: true });
    expect(await app.handle({ type: 'TRANSLATE_PANEL', requestId: 'missing-doc', preferences: prefs, text: 'Hello' }, { id: 'extension-test', url: panelSender.url })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
