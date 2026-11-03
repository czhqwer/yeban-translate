// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SERVICES } from '../src/shared/types';
import type { ReadingDraft } from '../src/shared/image';

const channel = vi.hoisted(() => ({ send: vi.fn(), disconnect: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/sidepanel/channel', () => ({ PanelChannel: class { send = channel.send; disconnect = channel.disconnect; dispose = channel.dispose; } }));
let draft: ReadingDraft | null;
let windowEvents: ReturnType<typeof vi.spyOn>;
let documentEvents: ReturnType<typeof vi.spyOn>;
let accepted: boolean;
const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); accepted = true; draft = null;
  windowEvents = vi.spyOn(window, 'addEventListener'); documentEvents = vi.spyOn(document, 'addEventListener');
  document.body.innerHTML = new DOMParser().parseFromString(readFileSync('sidepanel.html', 'utf8'), 'text/html').body.innerHTML;
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async message => {
      if (message.type === 'GET_SETTINGS') return { ok: true, value: { preferences: { provider: 'aliyun', source: 'auto', target: 'zh' }, services: { bailian: { ...DEFAULT_SERVICES.bailian, configured: true }, aliyun: { ...DEFAULT_SERVICES.aliyun, configured: true } }, dataNoticeAccepted: accepted, providerPriority: ['aliyun', 'bailian'], sites: [] } };
      if (message.type === 'TAKE_READING_DRAFT') { const value = draft; draft = null; return { ok: true, value }; }
      return { ok: true, value: null };
    }) }, windows: { getCurrent: vi.fn(async () => ({ id: 8 })) },
  });
  channel.send.mockResolvedValue({ ok: true, value: { translated: '虚拟译文' } });
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const [type, listener, options] of windowEvents.mock.calls) window.removeEventListener(type as string, listener as EventListener, options as EventListenerOptions);
  for (const [type, listener, options] of documentEvents.mock.calls) document.removeEventListener(type as string, listener as EventListener, options as EventListenerOptions);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('阅读选区与粘贴图片接入侧栏', () => {
  it('右键中文选区进入空侧栏后自动选英文，并沿用原服务优先级', async () => {
    draft = { id: 'virtual-draft', kind: 'text', text: '这是论文选区' };
    await import('../src/sidepanel/index');
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'TRANSLATE_PANEL', text: '这是论文选区', preferences: { provider: 'aliyun', source: 'auto', target: 'en' } })));
    expect(node<HTMLTextAreaElement>('panel-input').value).toBe('这是论文选区');
  });
  it('未确认说明时只填入选区，不调用翻译', async () => {
    accepted = false; draft = { id: 'virtual-draft', kind: 'text', text: 'Read this' };
    await import('../src/sidepanel/index'); await vi.waitFor(() => expect(node<HTMLTextAreaElement>('panel-input').value).toBe('Read this'));
    expect(channel.send).not.toHaveBeenCalled(); expect(node('panel-setup').hidden).toBe(false);
  });
  it('新选区自动替换旧草稿并翻译，不再要求载入确认', async () => {
    await import('../src/sidepanel/index'); await vi.waitFor(() => expect(node<HTMLTextAreaElement>('panel-input').disabled).toBe(false));
    node<HTMLTextAreaElement>('panel-input').value = '保留用户草稿'; node('panel-input').dispatchEvent(new Event('input'));
    draft = { id: 'virtual-later', kind: 'text', text: 'New selection' };
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalled(), { timeout: 2500 });
    expect(document.getElementById('reading-load')).toBeNull();
    expect(node<HTMLTextAreaElement>('panel-input').value).toBe('New selection');
  });
  it('粘贴图片显示小附件，文字粘贴不被拦截，图片不自动上传', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 300, height: 200, close: vi.fn() })));
    vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:virtual-paste'); static revokeObjectURL = vi.fn(); });
    await import('../src/sidepanel/index');
    const textEvent = new Event('paste', { cancelable: true });
    Object.defineProperty(textEvent, 'clipboardData', { value: { items: [{ kind: 'string', type: 'text/plain' }] } });
    document.dispatchEvent(textEvent); expect(textEvent.defaultPrevented).toBe(false);
    const imageEvent = new Event('paste', { cancelable: true });
    Object.defineProperty(imageEvent, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => new Blob(['VIRTUAL'], { type: 'image/png' }) }] } });
    document.dispatchEvent(imageEvent); expect(imageEvent.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(node('image-attachment').hidden).toBe(false));
    expect(document.getElementById('image-mode')).toBeNull(); expect(channel.send).not.toHaveBeenCalled();
  });
  it('新选区取消进行中的旧翻译，旧响应不能覆盖新结果', async () => {
    let complete!: (value: unknown) => void;
    channel.send.mockImplementation(command => command.type === 'TRANSLATE_PANEL' && command.text === 'Old text' ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ ok: true, value: { translated: '新结果' } }));
    draft = { id: 'old', kind: 'text', text: 'Old text' };
    await import('../src/sidepanel/index'); await vi.waitFor(() => expect(channel.send).toHaveBeenCalledOnce());
    draft = { id: 'new', kind: 'text', text: 'New text' };
    await vi.waitFor(() => expect(node('panel-translated').textContent).toBe('新结果'), { timeout: 2500 });
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'CANCEL_PANEL' }));
    complete({ ok: true, value: { translated: '迟到旧结果' } }); await Promise.resolve();
    expect(node('panel-translated').textContent).toBe('新结果'); expect(node<HTMLTextAreaElement>('panel-input').value).toBe('New text');
  });
});
