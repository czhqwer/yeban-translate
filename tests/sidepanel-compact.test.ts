// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SERVICES, type BackgroundMessage, type PublicSettings, type Reply, type TranslationResult } from '../src/shared/types';

const channel = vi.hoisted(() => ({ send: vi.fn(), disconnect: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/sidepanel/channel', () => ({ PanelChannel: class { send = channel.send; disconnect = channel.disconnect; dispose = channel.dispose; } }));

let settings: PublicSettings;
let pending: Array<{ message: Extract<BackgroundMessage, { type: 'TRANSLATE_PANEL' }>; finish: (reply: Reply<TranslationResult>) => void }>;
let windowEvents: ReturnType<typeof vi.spyOn>;
let documentEvents: ReturnType<typeof vi.spyOn>;
let createTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  pending = [];
  settings = { preferences: { provider: 'bailian', source: 'auto', target: 'zh' }, services: { bailian: { ...DEFAULT_SERVICES.bailian, configured: true }, aliyun: { ...DEFAULT_SERVICES.aliyun, configured: true } }, providerPriority: ['bailian', 'aliyun'], sites: [], dataNoticeAccepted: true };
  windowEvents = vi.spyOn(window, 'addEventListener');
  documentEvents = vi.spyOn(document, 'addEventListener');
  createTab = vi.fn(async () => ({}));
  channel.send.mockImplementation((message: BackgroundMessage) => message.type === 'TRANSLATE_PANEL' ? new Promise<Reply<TranslationResult>>(finish => pending.push({ message, finish })) : Promise.resolve({ ok: true, value: null }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ ok: true, value: structuredClone(settings) })), openOptionsPage: vi.fn(async () => {}), getURL: vi.fn((path: string) => `chrome-extension://test/${path}`) }, tabs: { create: createTab } });
});

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const [type, listener, options] of windowEvents.mock.calls) window.removeEventListener(type as string, listener as EventListener, options as EventListenerOptions);
  for (const [type, listener, options] of documentEvents.mock.calls) document.removeEventListener(type as string, listener as EventListener, options as EventListenerOptions);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 加载真实侧栏交互，只有扩展消息和付费服务使用模拟响应。 */
async function load(): Promise<void> {
  const html = readFileSync(resolve(process.cwd(), 'sidepanel.html'), 'utf8');
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  await import('../src/sidepanel/index');
  await vi.waitFor(() => expect(node<HTMLSelectElement>('panel-source').disabled).toBe(false));
}

function node<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function typeText(text: string): void { node<HTMLTextAreaElement>('panel-input').value = text; node('panel-input').dispatchEvent(new Event('input')); }

describe('侧栏精简后的必要反馈', () => {
  it('扩展界面统一使用主题色细滚动条和渐变缩放手柄', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/base.css'), 'utf8');
    const surfaces = readFileSync(resolve(process.cwd(), 'src/ui/surfaces.css'), 'utf8');
    expect(css).toContain('*::-webkit-scrollbar-thumb');
    expect(css).toContain('scrollbar-color: var(--scrollbar) transparent');
    expect(css).toContain('*::-webkit-resizer');
    expect(css).toContain('var(--resize)');
    expect(surfaces).toContain('html:has(body.sidepanel-body), body.sidepanel-body { scrollbar-width: none; }');
    expect(surfaces).toContain('body.sidepanel-body::-webkit-scrollbar { display: none;');
  });

  it('未确认数据说明时直接打开并定位设置页的数据与隐私区域', async () => {
    settings.dataNoticeAccepted = false;
    await load();
    expect(node('panel-setup').hidden).toBe(false);
    expect(node('panel-setup-button').textContent).toBe('查看数据使用说明');
    node('panel-setup-button').click();
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledWith({ url: 'chrome-extension://test/options.html#privacy' }));
  });

  it('底部展示固定寄语，不占用翻译状态区域', async () => {
    await load();
    const quote = document.querySelector('.sidepanel-quote');
    expect(quote?.tagName).toBe('FOOTER');
    expect(quote?.textContent).toBe('跨过语言，抵达文字本身。');
    expect(quote?.closest('main')?.classList.contains('sidepanel-shell')).toBe(true);
  });

  it('正常输入不占用说明行，超限按 Unicode 字符显示错误，改短后即时恢复', async () => {
    await load();
    expect(node('panel-input-hint').hidden).toBe(true);
    expect(node('panel-empty').hidden).toBe(true);
    expect(node('panel-result-footer').hidden).toBe(true);
    typeText('😀'.repeat(2001));
    expect(node('panel-input-hint').hidden).toBe(false);
    expect(node('panel-input-hint').textContent).toBe('已超出 1 个字符，请缩短后翻译。');
    expect(node('panel-input').getAttribute('aria-invalid')).toBe('true');
    expect(node<HTMLButtonElement>('panel-translate').disabled).toBe(true);
    expect(channel.send).not.toHaveBeenCalled();
    expect(Array.from(node<HTMLTextAreaElement>('panel-input').value)).toHaveLength(2001);
    typeText('😀'.repeat(2000));
    expect(node('panel-count').textContent).toBe('2000 / 2000 字符');
    expect(node('panel-input-hint').hidden).toBe(true);
    expect(node('panel-input-hint').textContent).toBe('');
    expect(node('panel-input').getAttribute('aria-invalid')).toBe('false');
    expect(node<HTMLButtonElement>('panel-translate').disabled).toBe(false);
  });

  it('只保留语言选择，并始终按设置中的优先级自动选择可用服务', async () => {
    settings.services.bailian.configured = false;
    await load();
    expect(document.getElementById('panel-provider')).toBeNull();
    expect(document.getElementById('panel-provider-hint')).toBeNull();
    expect(node<HTMLSelectElement>('panel-source').options).toHaveLength(17);
    expect(node<HTMLSelectElement>('panel-target').options).toHaveLength(16);
    node<HTMLSelectElement>('panel-target').value = 'ja';
    node('panel-target').dispatchEvent(new Event('change'));
    typeText('A short sentence');
    expect(node('panel-setup').hidden).toBe(true);
    node('panel-translate').click();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].message.preferences).toEqual({ provider: 'aliyun', source: 'auto', target: 'ja' });
  });

  it('输入中文默认译成英语，输入其他语言默认译成中文，手动目标语言优先', async () => {
    settings.preferences.source = 'fr';
    await load();
    typeText('这是一段中文内容。');
    expect(node<HTMLSelectElement>('panel-source').value).toBe('auto');
    expect(node<HTMLSelectElement>('panel-target').value).toBe('en');
    typeText('This is an English sentence.');
    expect(node<HTMLSelectElement>('panel-target').value).toBe('zh');
    node<HTMLSelectElement>('panel-target').value = 'fr';
    node('panel-target').dispatchEvent(new Event('change'));
    typeText('这是手动选择目标语言后的文本。');
    expect(node<HTMLSelectElement>('panel-target').value).toBe('fr');
  });

  it('失败重试保留旧任务语言和实际服务，完成后只展示目标语言', async () => {
    settings.providerPriority = ['aliyun', 'bailian'];
    await load();
    typeText('Preserve the retry provider');
    node('panel-translate').click();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].finish({ ok: false, error: { code: 'TIMEOUT', message: '请求超时。', retryable: true } });
    await vi.waitFor(() => expect(node('panel-retry').hidden).toBe(false));
    expect(node('panel-result-meta').textContent).toBe('翻译为 简体中文');
    node<HTMLSelectElement>('panel-target').value = 'fr';
    node('panel-target').dispatchEvent(new Event('change'));
    node('panel-retry').click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1].message.preferences).toEqual(pending[0].message.preferences);
    pending[1].finish({ ok: true, value: { translated: '保留原来的翻译服务' } });
    await vi.waitFor(() => expect(node('panel-translated').textContent).toBe('保留原来的翻译服务'));
    expect(node('panel-result-meta').textContent).toBe('翻译为 简体中文');
    expect(node('panel-result-footer').hidden).toBe(false);
    expect(node('panel-feedback').hidden).toBe(true);
    expect(node('panel-retry').hidden).toBe(true);
  });
});
