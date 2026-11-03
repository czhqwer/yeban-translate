import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadingBridge, READING_SELECTION_MENU } from '../src/background/reading';

const viewport = { width: 1000, height: 700, x: 0, y: 0, scale: 1 };
const rect = { x: 30, y: 40, width: 300, height: 160 };
const bridges: ReadingBridge[] = [];
function fixture() {
  const tab = { id: 1, windowId: 8, active: true, url: 'https://example.test/paper.pdf' } as chrome.tabs.Tab;
  const api = {
    runtime: { id: 'virtual-reading', getURL: (path: string) => 'chrome-extension://virtual-reading/' + path, sendMessage: vi.fn(async () => {}) },
    sidePanel: { open: vi.fn(async () => {}) },
    action: { setBadgeText: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) },
    tabs: {
      get: vi.fn(async () => ({ ...tab })), query: vi.fn(async () => [{ ...tab }]),
      captureVisibleTab: vi.fn(async () => 'VIRTUAL_FULL_SCREEN'),
      sendMessage: vi.fn(async (_tabId: number, _message: unknown, _options?: unknown) => ({ ok: true })),
      create: vi.fn(async () => ({})),
    },
    scripting: { executeScript: vi.fn(async (_options: unknown) => [{ frameId: 0, documentId: 'doc-virtual', result: { ...viewport } }]) },
    contextMenus: { removeAll: vi.fn((callback: () => void) => callback()), create: vi.fn() },
  };
  const crop = vi.fn(async (_data: string, _rect: unknown, _viewport: unknown) => ({ image: 'VIRTUAL_CROPPED_ONLY', style: { background: '#fff', color: '#000', solid: true } }));
  const service = { imageReadiness: vi.fn(async () => {}), translateRegion: vi.fn(async (_image: string, _signal: AbortSignal, guard: () => Promise<void>) => { await guard(); return { translated: '虚拟译文' }; }) };
  const bridge = new ReadingBridge(api as unknown as typeof chrome, service, crop); bridges.push(bridge);
  const panel = { id: api.runtime.id, url: api.runtime.getURL('sidepanel.html') };
  const sender: chrome.runtime.MessageSender = { id: api.runtime.id, url: tab.url, tab, frameId: 0, documentId: 'doc-virtual', documentLifecycle: 'active' };
  const take = (windowId = 8, from: chrome.runtime.MessageSender = panel) => bridge.handle({ type: 'TAKE_READING_DRAFT', windowId }, from);
  const token = () => (api.tabs.sendMessage.mock.calls.find(call => (call[1] as { type: string }).type === 'REGION_START')![1] as { token: string }).token;
  const submit = (overrides = {}, from = sender) => bridge.handle({ type: 'REGION_CAPTURE', token: token(), rect, viewport, ...overrides }, from);
  return { tab, api, bridge, panel, sender, take, token, submit, crop, service };
}
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.cancelAll(); vi.useRealTimers(); });

describe('右键选区和原位框选会话', () => {
  it('安装菜单只注册主动入口', () => {
    const { bridge, api } = fixture(); bridge.install();
    expect(api.contextMenus.create).toHaveBeenCalledTimes(1);
    expect(api.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: READING_SELECTION_MENU, contexts: ['selection'] }), expect.any(Function));
  });
  it('右键在首个 await 前打开所属窗口侧栏，草稿只领取一次', async () => {
    const { bridge, tab, api, take } = fixture();
    bridge.selection({ selectionText: '论文中的选中文字' } as chrome.contextMenus.OnClickData, tab);
    expect(api.sidePanel.open).toHaveBeenCalledWith({ windowId: 8 });
    expect(await take(9)).toEqual({ ok: true, value: null });
    expect(await take()).toMatchObject({ ok: true, value: { kind: 'text', text: '论文中的选中文字' } });
    expect(await take()).toEqual({ ok: true, value: null });
  });
  it.each(['', '字'.repeat(2001)])('空选区或超限选区不静默截断', async text => {
    const { bridge, tab, take } = fixture();
    bridge.selection({ selectionText: text } as chrome.contextMenus.OnClickData, tab);
    expect(await take()).toMatchObject({ ok: true, value: { kind: 'error' } });
  });
  it('普通网页不能读取草稿或开启截图', async () => {
    const { bridge, take, sender, api } = fixture();
    expect(await take(8, sender)).toMatchObject({ ok: false });
    expect(await bridge.handle({ type: 'CAPTURE_READING', tabId: 1 }, sender)).toMatchObject({ ok: false });
    expect(api.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });
  it('原位框选只注入顶层，启动时不截图、不跳转、不发送图片', async () => {
    const { bridge, tab, api, service } = fixture();
    expect(await bridge.capture(tab)).toBe(true);
    expect(api.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1, frameIds: [0] }, files: ['region.js'] });
    expect(api.tabs.captureVisibleTab).not.toHaveBeenCalled(); expect(service.translateRegion).not.toHaveBeenCalled();
    expect(api.sidePanel.open).not.toHaveBeenCalled(); expect(api.tabs.create).not.toHaveBeenCalled();
  });
  it('松开后截图、裁剪再发送；原始整屏不进入模型或侧栏', async () => {
    const { bridge, tab, api, submit, crop, service, take } = fixture(); await bridge.capture(tab);
    expect(await submit()).toMatchObject({ ok: true, value: { translated: '虚拟译文' } });
    expect(crop).toHaveBeenCalledWith('VIRTUAL_FULL_SCREEN', rect, viewport);
    expect(service.translateRegion.mock.calls[0][0]).toBe('VIRTUAL_CROPPED_ONLY');
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'REGION_LOADING' }), { frameId: 0, documentId: 'doc-virtual' });
    expect(await take()).toEqual({ ok: true, value: null }); expect(api.tabs.create).not.toHaveBeenCalled();
  });
  it('拒绝重放、伪造 token、其他文档和子帧', async () => {
    const { bridge, tab, submit, sender, api } = fixture(); await bridge.capture(tab);
    expect(await submit({ token: 'guessed' })).toMatchObject({ ok: false });
    expect(await submit({}, { ...sender, frameId: 1 })).toMatchObject({ ok: false });
    expect(await submit({}, { ...sender, documentId: 'stale-document' })).toMatchObject({ ok: false });
    expect(await submit({ rect: { ...rect, x: -1 } })).toMatchObject({ ok: false });
    expect(await submit({ viewport: { ...viewport, scale: 2 } })).toMatchObject({ ok: false });
    expect(api.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(await submit()).toMatchObject({ ok: true });
    expect(await submit()).toMatchObject({ ok: false }); expect(api.tabs.captureVisibleTab).toHaveBeenCalledOnce();
  });
  it('截图中切走再切回也丢弃，不发送错误截图', async () => {
    const { bridge, tab, api, submit, service } = fixture(); await bridge.capture(tab);
    api.tabs.captureVisibleTab.mockImplementation(async () => { bridge.tabActivated(8, 2); bridge.tabActivated(8, 1); return 'VIRTUAL_SCREEN'; });
    expect(await submit()).toMatchObject({ ok: false }); expect(service.translateRegion).not.toHaveBeenCalled();
  });
  it('缩放、滚动或同 URL 导航期间不交付旧结果', async () => {
    const { bridge, tab, api, submit, service } = fixture(); await bridge.capture(tab);
    api.scripting.executeScript.mockResolvedValue([{ frameId: 0, documentId: 'doc-virtual', result: { ...viewport, y: 20 } }]);
    expect(await submit()).toMatchObject({ ok: false }); expect(service.translateRegion).not.toHaveBeenCalled();
    await bridge.capture(tab); bridge.tabChanged(1); expect(await submit()).toMatchObject({ ok: false });
  });
  it('关闭会中止模型请求并丢弃迟到响应', async () => {
    const { bridge, tab, submit, service, sender, token } = fixture(); await bridge.capture(tab);
    let complete!: (value: { translated: string }) => void;
    service.translateRegion.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const pending = submit();
    await vi.waitFor(() => expect(service.translateRegion).toHaveBeenCalled());
    await bridge.handle({ type: 'REGION_CANCEL', token: token() }, sender);
    expect(service.translateRegion.mock.calls[0][1].aborted).toBe(true);
    complete({ translated: '迟到结果' }); expect(await pending).toMatchObject({ ok: false });
  });
  it('受保护 PDF 拒绝注入时给出提示，不打开新页面或截取整屏', async () => {
    const { bridge, tab, api, take } = fixture();
    api.scripting.executeScript.mockRejectedValue(new Error('虚拟内部错误'));
    expect(await bridge.capture(tab)).toBe(false);
    expect(api.tabs.create).not.toHaveBeenCalled(); expect(api.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(api.action.setBadgeText).toHaveBeenCalledWith({ tabId: 1, text: '!' });
    const reply = await take(); expect(reply).toMatchObject({ ok: true, value: { kind: 'error' } }); expect(JSON.stringify(reply)).not.toContain('虚拟内部错误');
  });
  it('缺少配置只显示设置引导，松开也不截图上传', async () => {
    const { bridge, tab, api, service, submit } = fixture(); service.imageReadiness.mockRejectedValue(new Error());
    await bridge.capture(tab); expect(await submit()).toMatchObject({ ok: false }); expect(api.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });
  it('右键侧栏打开失败不创建替代页面；过期草稿不重放', async () => {
    vi.useFakeTimers();
    const { bridge, tab, api, take } = fixture(); api.sidePanel.open.mockRejectedValue(new Error());
    bridge.selection({ selectionText: 'Test' } as chrome.contextMenus.OnClickData, tab);
    await Promise.resolve(); expect(api.tabs.create).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120001); expect(await take()).toMatchObject({ ok: true, value: null });
  });
});
