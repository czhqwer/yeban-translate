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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  pending = [];
  settings = { preferences: { provider: 'bailian', source: 'auto', target: 'zh' }, services: { bailian: { ...DEFAULT_SERVICES.bailian, configured: true }, aliyun: { ...DEFAULT_SERVICES.aliyun, configured: true } }, providerPriority: ['bailian', 'aliyun'], sites: [], dataNoticeAccepted: true };
  windowEvents = vi.spyOn(window, 'addEventListener');
  documentEvents = vi.spyOn(document, 'addEventListener');
  channel.send.mockImplementation((message: BackgroundMessage) => message.type === 'TRANSLATE_PANEL' ? new Promise<Reply<TranslationResult>>(finish => pending.push({ message, finish })) : Promise.resolve({ ok: true, value: null }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ ok: true, value: structuredClone(settings) })), openOptionsPage: vi.fn(async () => {}) } });
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
  await vi.waitFor(() => expect(node<HTMLSelectElement>('panel-provider').disabled).toBe(false));
}

function node<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function typeText(text: string): void { node<HTMLTextAreaElement>('panel-input').value = text; node('panel-input').dispatchEvent(new Event('input')); }

describe('侧栏精简后的必要反馈', () => {
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

  it('自动选择显示实际服务短名，手动选择未配置服务仍禁止发送并展示设置入口', async () => {
    settings.services.bailian.configured = false;
    await load();
    expect(node('panel-provider-hint').textContent).toBe('阿里翻译');
    expect(node('panel-provider-hint').title).toBe('阿里云机器翻译');
    const provider = node<HTMLSelectElement>('panel-provider');
    provider.value = 'bailian';
    provider.dispatchEvent(new Event('change'));
    typeText('A short sentence');
    expect(node('panel-provider-hint').textContent).toBe('未配置');
    expect(node('panel-setup').hidden).toBe(false);
    expect(node<HTMLButtonElement>('panel-translate').disabled).toBe(true);
    provider.value = 'aliyun';
    provider.dispatchEvent(new Event('change'));
    expect(node('panel-provider-hint').hidden).toBe(true);
    expect(node('panel-setup').hidden).toBe(true);
    node('panel-translate').click();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].message.preferences.provider).toBe('aliyun');
  });

  it('失败重试仍展示旧任务的实际服务，完成后保留译文和简短来源，不重复成功提示', async () => {
    settings.providerPriority = ['aliyun', 'bailian'];
    await load();
    typeText('Preserve the retry provider');
    node('panel-translate').click();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].finish({ ok: false, error: { code: 'TIMEOUT', message: '请求超时。', retryable: true } });
    await vi.waitFor(() => expect(node('panel-retry').hidden).toBe(false));
    expect(node('panel-result-meta').textContent).toBe('阿里翻译 · 简体中文');
    const provider = node<HTMLSelectElement>('panel-provider');
    provider.value = 'bailian';
    provider.dispatchEvent(new Event('change'));
    node('panel-retry').click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(node('panel-provider-hint').hidden).toBe(false);
    expect(node('panel-provider-hint').textContent).toBe('阿里翻译');
    expect(pending[1].message.preferences).toEqual(pending[0].message.preferences);
    pending[1].finish({ ok: true, value: { translated: '保留原来的翻译服务' } });
    await vi.waitFor(() => expect(node('panel-translated').textContent).toBe('保留原来的翻译服务'));
    expect(node('panel-result-meta').textContent).toBe('阿里翻译 · 简体中文');
    expect(node('panel-result-footer').hidden).toBe(false);
    expect(node('panel-feedback').hidden).toBe(true);
    expect(node('panel-retry').hidden).toBe(true);
  });
});
