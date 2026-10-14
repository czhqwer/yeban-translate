// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundMessage, ContentMessage, PageStatus, PublicSettings, Reply, SidePanelState, TranslationResult } from '../src/shared/types';
import { DEFAULT_SERVICES } from '../src/shared/types';
import { websiteFeatures } from '../src/ui/state';
import { PANEL_PORT_NAME, type PanelRequest, type PanelResponse } from '../src/shared/panel';

let settings: PublicSettings;
let request: ReturnType<typeof vi.fn>;
let runtimeMessage: ReturnType<typeof vi.fn>;
let connect: ReturnType<typeof vi.fn>;
let ports: Array<{ port: chrome.runtime.Port; sent: PanelRequest[]; disconnected: boolean; breakConnection: () => void }>;
let permission: ReturnType<typeof vi.fn>;
let pageRequest: ReturnType<typeof vi.fn>;
let pageStatus: PageStatus;
let sidePanels: Record<number, SidePanelState>;
let activeTab: { id: number; windowId: number; url: string };
let windowEvents: ReturnType<typeof vi.spyOn>;
let documentEvents: ReturnType<typeof vi.spyOn>;
let pending: Array<{ message: Extract<BackgroundMessage, { type: 'TRANSLATE_PANEL' }>; finish: (reply: Reply<TranslationResult>) => void }>;

beforeEach(() => {
  vi.resetModules();
  windowEvents = vi.spyOn(window, 'addEventListener');
  documentEvents = vi.spyOn(document, 'addEventListener');
  settings = { preferences: { provider: 'bailian', source: 'auto', target: 'zh' }, services: { bailian: { ...DEFAULT_SERVICES.bailian, configured: true }, aliyun: { ...DEFAULT_SERVICES.aliyun, configured: true } }, sites: ['https://reading.example'], dataNoticeAccepted: true, providerPriority: ['bailian', 'aliyun'], selectionEnabled: true, allSitesEnabled: false, allSitesGranted: false, blockedSites: [] };
  pending = [];
  ports = [];
  activeTab = { id: 4, windowId: 10, url: 'https://reading.example/article' };
  sidePanels = {
    10: { windowId: 10, open: false, ready: true, canOpen: true, canToggle: true, version: 1 },
    20: { windowId: 20, open: false, ready: true, canOpen: true, canToggle: true, version: 1 },
  };
  request = vi.fn((message: BackgroundMessage) => {
    if (message.type === 'GET_SETTINGS') return Promise.resolve({ ok: true, value: structuredClone(settings) });
    if (message.type === 'GET_SIDE_PANEL_STATE') return Promise.resolve({ ok: true, value: structuredClone(sidePanels[message.tabId === 14 ? 20 : 10]) });
    if (message.type === 'SET_SIDE_PANEL') {
      const windowId = message.tabId === 14 ? 20 : 10;
      if (message.windowId !== windowId) return Promise.resolve({ ok: false, error: { code: 'WINDOW_CHANGED', message: '当前窗口已变化。', retryable: true } });
      sidePanels[windowId] = { ...sidePanels[windowId], open: message.open, version: sidePanels[windowId].version + 1 };
      return Promise.resolve({ ok: true, value: structuredClone(sidePanels[windowId]) });
    }
    if (message.type === 'TRANSLATE_PANEL') return new Promise<Reply<TranslationResult>>(resolve => pending.push({ message, finish: resolve }));
    if (message.type === 'CANCEL_PANEL') return Promise.resolve({ ok: true, value: null });
    if (message.type === 'SAVE_SETTINGS') {
      if (message.preferences) settings.preferences = message.preferences;
      if (message.providerPriority) settings.providerPriority = message.providerPriority;
      if (typeof message.selectionEnabled === 'boolean') settings.selectionEnabled = message.selectionEnabled;
      return Promise.resolve({ ok: true, value: structuredClone(settings) });
    }
    return Promise.resolve({ ok: true, value: undefined });
  });
  const dispatch = (message: BackgroundMessage): Promise<PanelResponse['reply']> => (request as unknown as (message: BackgroundMessage) => Promise<PanelResponse['reply']>)(message);
  runtimeMessage = vi.fn(dispatch);
  connect = vi.fn((_options: { name: string }) => {
    const receivers = new Set<(message: PanelResponse) => void>();
    const disconnects = new Set<() => void>();
    const fixture = { port: undefined as unknown as chrome.runtime.Port, sent: [] as PanelRequest[], disconnected: false, breakConnection: () => {} };
    fixture.breakConnection = () => {
      if (fixture.disconnected) return;
      fixture.disconnected = true;
      for (const callback of [...disconnects]) callback();
    };
    fixture.port = {
      name: PANEL_PORT_NAME,
      onMessage: { addListener: (callback: (message: PanelResponse) => void) => receivers.add(callback), removeListener: (callback: (message: PanelResponse) => void) => receivers.delete(callback) },
      onDisconnect: { addListener: (callback: () => void) => disconnects.add(callback), removeListener: (callback: () => void) => disconnects.delete(callback) },
      postMessage: (envelope: PanelRequest) => {
        if (fixture.disconnected) throw new Error('模拟连接已关闭');
        fixture.sent.push(envelope);
        void Promise.resolve(dispatch(envelope.message)).then(reply => { for (const callback of [...receivers]) callback({ messageId: envelope.messageId, reply }); });
      },
      disconnect: fixture.breakConnection,
    } as unknown as chrome.runtime.Port;
    ports.push(fixture);
    return fixture.port;
  });
  permission = vi.fn(async () => false);
  pageStatus = { state: 'idle', completed: 0, failed: 0, pending: 0, selection: { provider: 'auto', source: 'auto', target: 'zh' } };
  pageRequest = vi.fn(async (_tabId: number, message: ContentMessage) => {
    if (message.type === 'SET_SELECTION') pageStatus.selection = message.selection;
    if (message.type === 'PAGE_START') pageStatus = { ...pageStatus, state: 'running', preferences: message.preferences, selection: message.selection };
    return { ok: true, value: structuredClone(pageStatus) };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: runtimeMessage, connect, openOptionsPage: vi.fn(async () => {}) }, permissions: { request: permission }, tabs: { query: vi.fn(async () => [structuredClone(activeTab)]), sendMessage: pageRequest }, scripting: { executeScript: vi.fn(async () => []) } });
});

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const [type, listener, options] of windowEvents.mock.calls) window.removeEventListener(type as string, listener as EventListener, options as EventListenerOptions);
  for (const [type, listener, options] of documentEvents.mock.calls) document.removeEventListener(type as string, listener as EventListener, options as EventListenerOptions);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function node<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function typeText(text: string): void { node<HTMLTextAreaElement>('panel-input').value = text; node('panel-input').dispatchEvent(new Event('input')); }
async function load(name: 'sidepanel' | 'options' | 'popup'): Promise<void> {
  const html = readFileSync(resolve(process.cwd(), `${name}.html`), 'utf8');
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  if (name === 'sidepanel') await import('../src/sidepanel/index');
  else if (name === 'options') await import('../src/options/index');
  else await import('../src/popup/index');
  if (name === 'popup') await vi.waitFor(() => expect(document.body.dataset.ready).toBe('true'));
  else await vi.waitFor(() => expect(node<HTMLSelectElement>(name === 'sidepanel' ? 'panel-source' : 'default-source').disabled).toBe(false));
}

describe('侧栏翻译交互', () => {
  it('侧栏隐藏会取消已提交任务，迟到结果被忽略，重新可见不自动重放', async () => {
    await load('sidepanel');
    typeText('Hide while translating');
    node('panel-translate').click();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(request.mock.calls.some(([message]) => message.type === 'CANCEL_PANEL' && message.requestId === pending[0].message.requestId)).toBe(true);
    expect(ports[0].disconnected).toBe(true);
    expect(runtimeMessage.mock.calls.some(([message]) => message.type === 'TRANSLATE_PANEL' || message.type === 'CANCEL_PANEL')).toBe(false);
    expect(node('panel-feedback').textContent).toContain('侧栏已隐藏，翻译已停止');
    expect(node<HTMLButtonElement>('panel-stop').disabled).toBe(true);
    pending[0].finish({ ok: true, value: { translated: '不应显示的隐藏后结果' } });
    await Promise.resolve();
    expect(node('panel-translated').textContent).toBe('');
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(pending).toHaveLength(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(node('panel-translated').textContent).toBe('');
  });

  it('侧栏在读取配置期间隐藏，配置迟到回复也不能再发翻译请求', async () => {
    await load('sidepanel');
    const previous = request.getMockImplementation() as (message: BackgroundMessage) => Promise<unknown>;
    let finishSettings!: (value: unknown) => void;
    let delaySettings = true;
    request.mockImplementation((message: BackgroundMessage) => message.type === 'GET_SETTINGS' && delaySettings ? new Promise(resolve => { finishSettings = resolve; }) : previous(message));
    typeText('Hide while preparing');
    node('panel-translate').click();
    expect(node<HTMLButtonElement>('panel-stop').disabled).toBe(false);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(node<HTMLButtonElement>('panel-stop').disabled).toBe(true);
    finishSettings({ ok: true, value: structuredClone(settings) });
    await Promise.resolve();
    await Promise.resolve();
    expect(pending).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();
    expect(node('panel-feedback').textContent).toContain('再次打开不会自动重试');
    delaySettings = false;
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(pending).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();
  });

  it('真实通道断开不自动重放，用户点击重试才创建新连接，旧响应不覆盖新译文', async () => {
    await load('sidepanel');
    expect(connect).not.toHaveBeenCalled();
    typeText('Explicit retry reconnects');
    node('panel-translate').click();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(connect).toHaveBeenCalledWith({ name: PANEL_PORT_NAME });
    expect(ports[0].port.sender).toBeUndefined();
    ports[0].breakConnection();
    await vi.waitFor(() => expect(node('panel-feedback').textContent).toContain('侧栏连接已中断'));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
    node('panel-retry').click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(connect).toHaveBeenCalledTimes(2);
    pending[0].finish({ ok: true, value: { translated: '断开连接的旧结果' } });
    pending[1].finish({ ok: true, value: { translated: '重新连接后的结果' } });
    await vi.waitFor(() => expect(node('panel-translated').textContent).toBe('重新连接后的结果'));
    expect(pending[1].message.preferences).toEqual(pending[0].message.preferences);
    expect(pending[1].message.text).toBe(pending[0].message.text);
  });

  it('自动模式在点击时读取最新优先级，清空后旧请求不能覆盖新结果，服务文本不会作为 HTML 执行', async () => {
    await load('sidepanel');
    settings.providerPriority = ['aliyun', 'bailian'];
    typeText('First text');
    node('panel-translate').click();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].message.preferences.provider).toBe('aliyun');
    node('panel-clear').click();
    expect(request.mock.calls.some(([message]) => message.type === 'CANCEL_PANEL' && message.requestId === pending[0].message.requestId)).toBe(true);
    typeText('Second text');
    node('panel-translate').click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0].finish({ ok: true, value: { translated: '不应显示的旧译文' } });
    await Promise.resolve();
    expect(node('panel-translated').textContent).not.toContain('旧译文');
    pending[1].finish({ ok: true, value: { translated: '<img src="invalid" onerror="alert(1)">安全文本' } });
    await vi.waitFor(() => expect(node('panel-translated').textContent).toContain('<img'));
    expect(node('panel-output').querySelector('img')).toBeNull();
  });

  it('重试保持原文本和服务，优先级变化不会串服务，原服务删除后不再发送', async () => {
    settings.providerPriority = ['aliyun', 'bailian'];
    await load('sidepanel');
    typeText('Keep this snapshot');
    node('panel-translate').click();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].finish({ ok: false, error: { code: 'TIMEOUT', message: '请求超时。', retryable: true } });
    await vi.waitFor(() => expect(node('panel-retry').hidden).toBe(false));
    settings.providerPriority = ['bailian', 'aliyun'];
    node<HTMLSelectElement>('panel-target').value = 'en';
    node('panel-target').dispatchEvent(new Event('change'));
    node('panel-retry').click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].message.preferences).toEqual(pending[0].message.preferences);
    expect(pending[1].message.text).toBe('Keep this snapshot');
    pending[1].finish({ ok: false, error: { code: 'TIMEOUT', message: '请求超时。', retryable: true } });
    await vi.waitFor(() => expect(node('panel-retry').hidden).toBe(false));
    settings.services.aliyun.configured = false;
    node('panel-retry').click();
    await vi.waitFor(() => expect(node('panel-feedback').textContent).toContain('原服务配置已删除'));
    expect(pending).toHaveLength(2);
  });

  it('以 Unicode 字符计数，2000 个补充字符可翻译，2001 个不截断也不发送', async () => {
    settings.services.bailian.configured = false;
    await load('sidepanel');
    typeText('😀'.repeat(2000));
    expect(node('panel-count').textContent).toBe('2000 / 2000 字符');
    expect(node<HTMLButtonElement>('panel-translate').disabled).toBe(false);
    expect(document.getElementById('panel-provider')).toBeNull();
    typeText('😀'.repeat(2001));
    expect(node<HTMLButtonElement>('panel-translate').disabled).toBe(true);
    node('panel-translate').click();
    expect(pending).toHaveLength(0);
    expect(Array.from(node<HTMLTextAreaElement>('panel-input').value)).toHaveLength(2001);
  });
});

describe('优先级和网站授权界面', () => {
  it('弹窗不显示服务选择器，只改语言并按最新优先级固定实际服务', async () => {
    await load('popup');
    expect(document.getElementById('provider')).toBeNull();
    expect(document.getElementById('provider-hint')).toBeNull();
    node<HTMLSelectElement>('target').value = 'en';
    node('target').dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(pageRequest.mock.calls.some(([, message]) => message.type === 'SET_SELECTION')).toBe(true));
    await vi.waitFor(() => expect(node<HTMLSelectElement>('source').disabled).toBe(false));
    settings.providerPriority = ['aliyun', 'bailian'];
    node('start').click();
    await vi.waitFor(() => expect(pageRequest.mock.calls.some(([, message]) => message.type === 'PAGE_START')).toBe(true));
    const message = pageRequest.mock.calls.find(([, value]) => value.type === 'PAGE_START')![1];
    expect(message.preferences).toEqual({ provider: 'aliyun', source: 'auto', target: 'en' });
    expect(message.selection).toEqual({ provider: 'auto', source: 'auto', target: 'en' });
    expect(request.mock.calls.some(([value]) => value.type === 'SAVE_SETTINGS')).toBe(false);
  });

  it('没有可用服务时在状态区引导打开设置，不恢复冗余选择器', async () => {
    settings.services.bailian.configured = false;
    settings.services.aliyun.configured = false;
    await load('popup');
    expect(document.getElementById('provider')).toBeNull();
    expect(node('status-title').textContent).toBe('尚未配置翻译服务');
    expect(node('status-detail').textContent).toContain('右上角设置');
    expect(node<HTMLButtonElement>('start').disabled).toBe(true);
  });

  it('调整顺序与保存语言不会将自动意图改为显式服务', async () => {
    settings.services.bailian.configured = false;
    await load('options');
    expect([...document.querySelectorAll('.provider-stack > form')].map(form => form.id)).toEqual(['aliyun-form', 'bailian-form']);
    expect(node('aliyun-form').querySelector('.provider-index')?.textContent).toBe('01');
    expect(node('bailian-form').querySelector('.provider-index')?.textContent).toBe('02');
    expect(node('priority-summary').textContent).toContain('阿里云机器翻译');
    (document.querySelector('[aria-label="上移阿里云机器翻译"]') as HTMLButtonElement).click();
    node<HTMLSelectElement>('default-target').value = 'en';
    node('preferences-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(node('global-feedback').textContent).toContain('阅读偏好已保存'));
    const save = request.mock.calls.find(([message]) => message.type === 'SAVE_SETTINGS')![0];
    expect(save.providerPriority).toEqual(['aliyun', 'bailian']);
    expect(save.preferences).toEqual({ provider: 'bailian', source: 'auto', target: 'en' });
  });

  it('拒绝全站授权不写启用状态，保留单独网站；功能开关不冒充权限授权', async () => {
    settings.selectionEnabled = undefined;
    await load('options');
    expect(node<HTMLInputElement>('selection-toggle').checked).toBe(true);
    expect(node('all-sites-state').textContent).toContain('尚未获得全站权限');
    node('grant-all-sites').click();
    expect(permission).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] });
    await vi.waitFor(() => expect(node('global-feedback').textContent).toContain('原有单独网站功能保持不变'));
    expect(request.mock.calls.some(([message]) => message.type === 'ENABLE_ALL_SITES')).toBe(false);
    expect(node('sites-list').textContent).toContain('https://reading.example');
    const toggle = node<HTMLInputElement>('selection-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(node('selection-toggle-label').textContent).toBe('已关闭'));
    expect(settings.selectionEnabled).toBe(false);
    expect(settings.allSitesGranted).toBe(false);
  });

  it('全站授权缺失不能视为可用，黑名单优先且关闭划词不影响悬浮球', () => {
    settings.allSitesEnabled = true;
    expect(websiteFeatures(settings, 'https://new.example').authorized).toBe(false);
    settings.allSitesGranted = true;
    settings.selectionEnabled = false;
    expect(websiteFeatures(settings, 'https://new.example')).toEqual({ authorized: true, selection: false, floating: true });
    settings.blockedSites = ['https://new.example'];
    expect(websiteFeatures(settings, 'https://new.example')).toEqual({ authorized: false, selection: false, floating: false });
  });
});

describe('弹窗的窗口级侧栏开关', () => {
  it('同一按钮打开和关闭，原生关闭后刷新状态再点击会打开，并同步发送用户操作', async () => {
    await load('popup');
    const button = node<HTMLButtonElement>('open-sidepanel');
    expect(node('sidepanel-label').textContent).toBe('打开文本翻译侧栏');
    button.click();
    expect(runtimeMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'SET_SIDE_PANEL', open: true, tabId: 4, windowId: 10 });
    await vi.waitFor(() => expect(node('sidepanel-label').textContent).toBe('关闭文本翻译侧栏'));
    button.click();
    await vi.waitFor(() => expect(node('sidepanel-label').textContent).toBe('打开文本翻译侧栏'));
    button.click();
    await vi.waitFor(() => expect(node('sidepanel-label').textContent).toBe('关闭文本翻译侧栏'));
    sidePanels[10] = { ...sidePanels[10], open: false, version: sidePanels[10].version + 1 };
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(node('sidepanel-label').textContent).toBe('打开文本翻译侧栏'));
    button.click();
    expect(runtimeMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'SET_SIDE_PANEL', open: true });
    expect(request.mock.calls.filter(([message]) => message.type === 'SET_SIDE_PANEL').map(([message]) => message.open)).toEqual([true, false, true, true]);
    expect(request.mock.calls.some(([message]) => message.type === 'OPEN_SIDE_PANEL')).toBe(false);
  });

  it('开关绑定标签页所在窗口，忽略其他窗口返回的状态', async () => {
    activeTab = { id: 14, windowId: 20, url: 'https://reading.example/other-window' };
    sidePanels[10].open = true;
    await load('popup');
    expect(node('sidepanel-label').textContent).toBe('打开文本翻译侧栏');
    node('open-sidepanel').click();
    expect(runtimeMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'SET_SIDE_PANEL', tabId: 14, windowId: 20, open: true });
    await vi.waitFor(() => expect(node('sidepanel-label').textContent).toBe('关闭文本翻译侧栏'));
    const previous = request.getMockImplementation() as (message: BackgroundMessage) => Promise<unknown>;
    request.mockImplementation((message: BackgroundMessage) => message.type === 'GET_SIDE_PANEL_STATE' ? Promise.resolve({ ok: true, value: { ...sidePanels[10], open: false, version: 999 } }) : previous(message));
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve(); await Promise.resolve();
    expect(node('sidepanel-label').textContent).toBe('关闭文本翻译侧栏');
    expect(sidePanels[10].open).toBe(true);
  });

  it('状态未就绪时禁用；旧浏览器不依赖可能过时的打开状态，每次点击都能重新打开', async () => {
    sidePanels[10].ready = false;
    await load('popup');
    expect(node<HTMLButtonElement>('open-sidepanel').disabled).toBe(true);
    node('open-sidepanel').click();
    expect(request.mock.calls.some(([message]) => message.type === 'SET_SIDE_PANEL')).toBe(false);
    sidePanels[10] = { ...sidePanels[10], ready: true, canToggle: false, version: 2 };
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(node<HTMLButtonElement>('open-sidepanel').disabled).toBe(false));
    expect(node('sidepanel-label').textContent).toBe('打开侧栏（请用原生 × 关闭）');
    node('open-sidepanel').click();
    await vi.waitFor(() => expect(sidePanels[10].open).toBe(true));
    await vi.waitFor(() => expect(node<HTMLButtonElement>('open-sidepanel').disabled).toBe(false));
    // 用户使用原生 × 关闭，但旧浏览器没有关闭事件，本地快照仍为 open:true。
    node('open-sidepanel').click();
    await vi.waitFor(() => expect(request.mock.calls.filter(([message]) => message.type === 'SET_SIDE_PANEL')).toHaveLength(2));
    expect(node('sidepanel-hint').textContent).toContain('Chrome 142+');
    expect(node('sidepanel-hint').textContent).toContain('原生 ×');
    expect(node('open-sidepanel').hasAttribute('aria-pressed')).toBe(false);
    expect(node('open-sidepanel').hasAttribute('aria-expanded')).toBe(false);
    expect(sidePanels[10].open).toBe(true);
    expect(request.mock.calls.filter(([message]) => message.type === 'SET_SIDE_PANEL').map(([message]) => message.open)).toEqual([true, true]);
    expect(node('sidepanel-label').textContent).not.toContain('关闭文本翻译侧栏');
  });

  it('打开失败或空回复不推断侧栏状态，也不改变正文的完成状态', async () => {
    pageStatus.state = 'waiting';
    pageStatus.completed = 3;
    await load('popup');
    const previous = request.getMockImplementation() as (message: BackgroundMessage) => Promise<unknown>;
    request.mockImplementation((message: BackgroundMessage) => message.type === 'SET_SIDE_PANEL' ? Promise.resolve({ ok: false, error: { code: 'SIDE_PANEL', message: '模拟原生打开失败。', retryable: true } }) : previous(message));
    node('open-sidepanel').click();
    await vi.waitFor(() => expect(node('action-feedback').textContent).toBe('模拟原生打开失败。'));
    expect(node('sidepanel-label').textContent).toBe('打开文本翻译侧栏');
    expect(node('status-title').textContent).toBe('等待继续滚动阅读');
    expect(node('status-detail').textContent).toContain('已译 3 段');
    request.mockImplementation((message: BackgroundMessage) => message.type === 'SET_SIDE_PANEL' ? Promise.resolve({ ok: true, value: null }) : previous(message));
    node('open-sidepanel').click();
    await vi.waitFor(() => expect(node('action-feedback').textContent).toContain('无法确认当前窗口'));
    expect(node('sidepanel-label').textContent).toBe('打开文本翻译侧栏');
  });

  it('用户点击之后返回的旧轮询不能覆盖新的开关结果', async () => {
    await load('popup');
    const previous = request.getMockImplementation() as (message: BackgroundMessage) => Promise<unknown>;
    let finishRead!: (reply: unknown) => void;
    const oldState = structuredClone(sidePanels[10]);
    request.mockImplementation((message: BackgroundMessage) => message.type === 'GET_SIDE_PANEL_STATE' ? new Promise(resolve => { finishRead = resolve; }) : previous(message));
    window.dispatchEvent(new Event('focus'));
    node('open-sidepanel').click();
    await vi.waitFor(() => expect(node('sidepanel-label').textContent).toBe('关闭文本翻译侧栏'));
    finishRead({ ok: true, value: oldState });
    await Promise.resolve(); await Promise.resolve();
    expect(node('sidepanel-label').textContent).toBe('关闭文本翻译侧栏');
    expect(node('action-feedback').textContent).toContain('已打开');
  });

  it('内容页 actionError 单独显示，正文状态及停止按钮仍保持可用', async () => {
    pageStatus = { ...pageStatus, state: 'running', completed: 2, pending: 4, message: '正在翻译当前视口内的文字。', actionError: { code: 'SIDE_PANEL', message: '侧栏打开失败，请重试。', retryable: true } };
    await load('popup');
    expect(node('action-feedback').textContent).toBe('侧栏打开失败，请重试。');
    expect(node('status-title').textContent).toBe('正在翻译当前可见内容');
    expect(node('status-detail').textContent).toContain('已译 2 段');
    expect(node('status-detail').textContent).not.toContain('侧栏打开失败');
    expect(node<HTMLButtonElement>('stop').disabled).toBe(false);
  });
});
