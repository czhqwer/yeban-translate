// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SERVICES, type BackgroundMessage, type PublicSettings } from '../src/shared/types';

let settings: PublicSettings;
let request: ReturnType<typeof vi.fn>;
let windowEvents: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  windowEvents = vi.spyOn(window, 'addEventListener');
  settings = {
    preferences: { provider: 'bailian', source: 'auto', target: 'zh' },
    services: { bailian: { ...DEFAULT_SERVICES.bailian, configured: true }, aliyun: { ...DEFAULT_SERVICES.aliyun, configured: true } },
    sites: [], dataNoticeAccepted: true,
  };
  request = vi.fn(async (message: BackgroundMessage) => {
    if (message.type === 'SAVE_SETTINGS' && message.dataNoticeAccepted) settings.dataNoticeAccepted = true;
    return { ok: true, value: structuredClone(settings) };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: request }, permissions: { request: vi.fn(async () => false) } });
});

afterEach(() => {
  for (const [type, listener, options] of windowEvents.mock.calls) window.removeEventListener(type as string, listener as EventListener, options as EventListenerOptions);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 仅挂载静态设置页，用原生对话框事件语义补齐 jsdom 未实现的界面行为。 */
async function load(): Promise<void> {
  const html = readFileSync(resolve(process.cwd(), 'options.html'), 'utf8');
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  const dialog = node<HTMLDialogElement>('service-help-dialog');
  dialog.showModal = vi.fn(() => {
    dialog.open = true;
    node('service-help-close').focus();
  });
  dialog.close = vi.fn(() => {
    dialog.open = false;
    dialog.dispatchEvent(new Event('close'));
  });
  await import('../src/options/index');
}

/** 获取固定的测试节点，不读取浏览器真实设置。 */
function node<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }

/** 按服务找到对应的教程入口。 */
function helpButton(provider: string): HTMLButtonElement { return document.querySelector(`[data-service-help="${provider}"]`) as HTMLButtonElement; }

describe('设置页配置帮助', () => {
  it('按服务展示步骤和固定官方链接，打开与关闭不发送保存或测试请求，也不覆盖表单', async () => {
    await load();
    node<HTMLInputElement>('bailian-model').value = '尚未保存的模型';
    node<HTMLInputElement>('bailian-api-key').value = '<FAKE_API_KEY_FOR_TEST>';
    helpButton('bailian').click();
    expect(node<HTMLDialogElement>('service-help-dialog').open).toBe(true);
    expect(node('service-help-title').textContent).toBe('百炼大模型 · 配置帮助');
    expect(node('service-help-content').textContent).toContain('完整请求地址，不是 Base URL');
    expect(node('service-help-content').textContent).toContain('qwen-plus');
    expect(node('service-help-content').textContent).not.toContain('尚未保存的模型');
    expect(node('service-help-content').textContent).not.toContain('<FAKE_API_KEY_FOR_TEST>');
    node('service-help-close').click();
    expect(document.activeElement).toBe(helpButton('bailian'));
    helpButton('aliyun').click();
    expect(node('service-help-title').textContent).toBe('阿里云机器翻译 · 配置帮助');
    expect(node('service-help-content').textContent).toContain('alimt:TranslateGeneral');
    expect(node('service-help-content').textContent).toContain('AccessKey ID（AK）');
    expect(node('service-help-content').textContent).toContain('AccessKey Secret（SK）');
    const links = [...node('service-help-content').querySelectorAll('a')];
    expect(links.map(link => link.href)).toEqual([
      'https://help.aliyun.com/zh/machine-translation/getting-started/activate-machine-translation-for-developers',
      'https://help.aliyun.com/zh/machine-translation/getting-started/prepare-accounts-for-developers',
    ]);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    }
    expect(node<HTMLInputElement>('bailian-model').value).toBe('尚未保存的模型');
    expect(node<HTMLInputElement>('bailian-api-key').value).toBe('<FAKE_API_KEY_FOR_TEST>');
    expect(request.mock.calls.map(([message]) => message.type)).toEqual(['GET_SETTINGS']);
  });

  it('首次读取期间仍能打开和关闭帮助，读取完成不关闭正在查看的教程', async () => {
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await load();
    expect(node<HTMLButtonElement>('save-bailian').disabled).toBe(true);
    expect(helpButton('bailian').disabled).toBe(false);
    helpButton('bailian').click();
    expect(node<HTMLButtonElement>('service-help-close').disabled).toBe(false);
    node('service-help-close').click();
    expect(node<HTMLDialogElement>('service-help-dialog').open).toBe(false);
    helpButton('aliyun').click();
    finish({ ok: true, value: structuredClone(settings) });
    await vi.waitFor(() => expect(node<HTMLButtonElement>('save-bailian').disabled).toBe(false));
    expect(node<HTMLDialogElement>('service-help-dialog').open).toBe(true);
    expect(node('service-help-title').textContent).toContain('阿里云机器翻译');
  });

  it('保存处理中帮助仍可用，打开或关闭教程不会新增操作或清除另一服务的未保存内容', async () => {
    await load();
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    node<HTMLInputElement>('aliyun-access-id').value = '<FAKE_ID_FOR_TEST>';
    node('bailian-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(node<HTMLButtonElement>('save-bailian').disabled).toBe(true);
    expect(helpButton('aliyun').disabled).toBe(false);
    helpButton('aliyun').click();
    expect(node<HTMLButtonElement>('service-help-close').disabled).toBe(false);
    node('service-help-close').click();
    expect(node<HTMLDialogElement>('service-help-dialog').open).toBe(false);
    expect(node<HTMLInputElement>('aliyun-access-id').value).toBe('<FAKE_ID_FOR_TEST>');
    expect(request.mock.calls.map(([message]) => message.type)).toEqual(['GET_SETTINGS', 'SAVE_SETTINGS']);
    finish({ ok: true, value: structuredClone(settings) });
    await vi.waitFor(() => expect(node<HTMLButtonElement>('save-bailian').disabled).toBe(false));
    expect(node<HTMLInputElement>('aliyun-access-id').value).toBe('<FAKE_ID_FOR_TEST>');
  });

  it('Esc 的原生取消流程不被阻止，关闭后焦点回到打开帮助的按钮', async () => {
    await load();
    helpButton('aliyun').click();
    const dialog = node<HTMLDialogElement>('service-help-dialog');
    expect(document.activeElement).toBe(node('service-help-close'));
    // 浏览器在 Esc 产生的 cancel 事件未被阻止时执行默认关闭。
    const allowClose = dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(allowClose).toBe(true);
    if (allowClose) dialog.close();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(helpButton('aliyun'));
  });

  it('读取失败不阻止查看帮助，帮助本身不尝试再次读取或测试服务', async () => {
    request.mockResolvedValueOnce({ ok: false, error: { code: 'DISCONNECTED', message: '模拟读取失败', retryable: true } });
    await load();
    helpButton('bailian').click();
    expect(node<HTMLDialogElement>('service-help-dialog').open).toBe(true);
    node('service-help-close').click();
    expect(request).toHaveBeenCalledTimes(1);
    expect(node<HTMLButtonElement>('save-bailian').disabled).toBe(true);
  });
});

describe('数据说明折叠和首次确认', () => {
  it('未确认时展开并保留显式确认入口，只有点击确认才保存，成功后收起', async () => {
    settings.dataNoticeAccepted = false;
    await load();
    const details = node<HTMLDetailsElement>('privacy-details');
    expect(details.open).toBe(true);
    expect(node('privacy-summary-state').textContent).toBe('待确认');
    expect(node('accept-notice').hidden).toBe(false);
    expect(request.mock.calls.map(([message]) => message.type)).toEqual(['GET_SETTINGS']);
    node('accept-notice').click();
    await vi.waitFor(() => expect(details.open).toBe(false));
    expect(request.mock.calls[1][0]).toEqual({ type: 'SAVE_SETTINGS', dataNoticeAccepted: true });
    expect(node('accept-notice').hidden).toBe(true);
    expect(node('notice-accepted').hidden).toBe(false);
  });

  it('已确认时默认收起，用户展开后刷新配置保持展开，确认失败不会隐藏入口', async () => {
    await load();
    const details = node<HTMLDetailsElement>('privacy-details');
    expect(details.open).toBe(false);
    details.open = true;
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(details.open).toBe(true);
    settings.dataNoticeAccepted = false;
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(node('accept-notice').hidden).toBe(false));
    request.mockResolvedValueOnce({ ok: false, error: { code: 'SAVE_FAILED', message: '模拟保存失败', retryable: true } });
    node('accept-notice').click();
    await vi.waitFor(() => expect(node('global-feedback').textContent).toContain('模拟保存失败'));
    expect(details.open).toBe(true);
    expect(node('accept-notice').hidden).toBe(false);
  });
});
