// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameSelectionController } from '../src/content/frame';
import { OWNED } from '../src/content/dom';
import { DEFAULT_SERVICES, type BackgroundMessage, type PageContext } from '../src/shared/types';

let controller: FrameSelectionController | undefined;
let request: ReturnType<typeof vi.fn>;
let context: PageContext;
let shadows: WeakMap<Element, ShadowRoot>;

beforeEach(() => {
  document.body.innerHTML = '<article><p id="paragraph">Dummy iframe paragraph for selection.</p><div contenteditable="true"><p id="editor">用于测试的富文本内容</p></div></article>';
  shadows = new WeakMap();
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function(this: Element, options) {
    const shadow = attach.call(this, options);
    shadows.set(this, shadow);
    return shadow;
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 10, right: 180, top: 20, bottom: 40, width: 170, height: 20 }) });
  context = {
    preferences: { provider: 'aliyun', source: 'auto', target: 'zh' },
    services: { aliyun: { ...DEFAULT_SERVICES.aliyun, configured: true }, bailian: { ...DEFAULT_SERVICES.bailian, configured: false } },
    selectionEnabled: true, hoverTranslationEnabled: false, floatingEnabled: false, dataNoticeAccepted: true,
  };
  request = vi.fn(async (message: BackgroundMessage) => {
    if (message.type === 'GET_CONTEXT') return { ok: true, value: structuredClone(context) };
    if (message.type === 'BEGIN_JOB') return { ok: true, value: { revision: 1 } };
    if (message.type === 'TRANSLATE') return { ok: true, value: { translated: '模拟内嵌页译文' } };
    return { ok: true, value: undefined };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: request } });
});

afterEach(async () => {
  await controller?.suspend();
  controller = undefined;
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function panel(): ShadowRoot | undefined {
  const host = document.querySelector(`[${OWNED}]`);
  return host ? shadows.get(host) : undefined;
}

function select(id = 'paragraph'): void {
  const element = document.getElementById(id)!;
  const range = document.createRange();
  range.selectNodeContents(element);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

describe('子页面独立划词控制器', () => {
  it('预览正文划词后点击才发送片段，不创建额外浮球或启动全文翻译', async () => {
    controller = new FrameSelectionController(document);
    await controller.ready;
    expect(document.querySelector(`[${OWNED}]`)).toBeNull();
    await controller.handle({ type: 'PAGE_START', preferences: context.preferences });
    await controller.handle({ type: 'STATUS' });
    expect(request.mock.calls.map(([message]) => message.type)).toEqual(['GET_CONTEXT']);
    select();
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(request.mock.calls.map(([message]) => message.type)).toEqual(['GET_CONTEXT']);
    panel()!.querySelector<HTMLButtonElement>('.trigger')!.click();
    await vi.waitFor(() => expect(panel()?.querySelector('.result')?.textContent).toBe('模拟内嵌页译文'));
    expect(request.mock.calls.find(([message]) => message.type === 'TRANSLATE')?.[0]).toMatchObject({ mode: 'selection', text: 'Dummy iframe paragraph for selection.' });
    expect(document.querySelector('[data-yeban-floating]')).toBeNull();
    await controller.handle({ type: 'RESTORE' });
    expect(panel()).toBeUndefined();
    expect(request.mock.calls.some(([message]) => message.type === 'CANCEL_JOB')).toBe(true);
  });

  it('同源富文本选区可翻译，编辑内容只有点击回写按钮才变化', async () => {
    controller = new FrameSelectionController(document);
    await controller.ready;
    select('editor');
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    panel()!.querySelector<HTMLButtonElement>('.trigger')!.click();
    await vi.waitFor(() => expect(panel()?.querySelector('.result')?.textContent).toBe('模拟内嵌页译文'));
    expect(document.getElementById('editor')!.textContent).toBe('用于测试的富文本内容');
    expect(request.mock.calls.find(([message]) => message.type === 'BEGIN_JOB')?.[0].preferences.target).toBe('en');
    expect(panel()?.textContent).toContain('替换选中');
  });

  it('授权拒绝时没有入口，授权通知后可选中，撤销时关闭窗口并停止监听', async () => {
    request.mockResolvedValueOnce({ ok: false, error: { code: 'FORBIDDEN', message: '模拟未授权' } });
    controller = new FrameSelectionController(document);
    await controller.ready;
    select();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(panel()).toBeUndefined();
    await controller.handle({ type: 'SITE_CHANGED', enabled: true });
    select();
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    context.selectionEnabled = false;
    await controller.handle({ type: 'FEATURES_CHANGED' });
    expect(panel()).toBeUndefined();
    select();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(panel()).toBeUndefined();
  });

  it('子文档离开后迟到的上下文回复不能重新启用监听', async () => {
    let finish!: (reply: unknown) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    controller = new FrameSelectionController(document);
    await controller.suspend();
    finish({ ok: true, value: context });
    await controller.ready;
    select();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(panel()).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('子页面悬停沿用独立开关和自定义快捷键，不依赖划词开关', async () => {
    context.selectionEnabled = false;
    context.hoverTranslationEnabled = true;
    context.hoverShortcut = 'Ctrl+Shift+K';
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, right: 180, top: 20, bottom: 40, width: 170, height: 20, x: 10, y: 20, toJSON: () => ({}) });
    controller = new FrameSelectionController(document);
    await controller.ready;
    document.getElementById('paragraph')!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', altKey: true, bubbles: true }));
    expect(request.mock.calls.map(([message]) => message.type)).toEqual(['GET_CONTEXT']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, bubbles: true }));
    await vi.waitFor(() => expect(panel()?.querySelector('.result')?.textContent).toBe('模拟内嵌页译文'));
    expect(request.mock.calls.find(([message]) => message.type === 'TRANSLATE')?.[0]).toMatchObject({ mode: 'hover', text: 'Dummy iframe paragraph for selection.' });
    expect(document.querySelector('[data-yeban-floating]')).toBeNull();
  });
});
