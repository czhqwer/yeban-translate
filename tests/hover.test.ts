// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverTranslator } from '../src/content/hover';
import { SelectionTranslator } from '../src/content/selection';
import { OWNED } from '../src/content/dom';

const rect = { top: 20, bottom: 60, left: 30, right: 330, width: 300, height: 40, x: 30, y: 20, toJSON: () => ({}) };
let selection: SelectionTranslator;
let hover: HoverTranslator;
let request: ReturnType<typeof vi.fn>;
let shadows: WeakMap<Element, ShadowRoot>;

beforeEach(async () => {
  document.body.innerHTML = '<main><p id="paragraph">Hover this paragraph.</p><input id="private" type="password" value="DO_NOT_READ"></main>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  shadows = new WeakMap();
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { const shadow = attach.call(this, init); shadows.set(this, shadow); return shadow; });
  request = vi.fn(async (message: { type: string }) => message.type === 'GET_CONTEXT'
    ? { ok: true, value: { preferences: { provider: 'aliyun', source: 'auto', target: 'zh' }, selectionEnabled: false, hoverTranslationEnabled: true, dataNoticeAccepted: true, services: { aliyun: { configured: true }, bailian: { configured: false } } } }
    : message.type === 'BEGIN_JOB' ? { ok: true, value: { revision: 1 } }
      : message.type === 'TRANSLATE' ? { ok: true, value: { translated: '悬停译文' } }
        : { ok: true, value: undefined });
  vi.stubGlobal('chrome', { runtime: { sendMessage: request } });
  selection = new SelectionTranslator(document);
  await selection.setHoverEnabled(true);
  hover = new HoverTranslator(document, element => selection.translateElement(element));
});

afterEach(async () => {
  hover.destroy();
  await selection.setHoverEnabled(false);
  await selection.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function moveTo(element: Element): void { element.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })); }
function press(key: string, options: KeyboardEventInit): void { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })); }
function panel(): ShadowRoot | undefined {
  const host = document.querySelector(`[${OWNED}]`);
  return host ? shadows.get(host) : undefined;
}

describe('鼠标悬停快捷键翻译', () => {
  it('默认关闭时只移动鼠标和按键都不会读取或发送段落', () => {
    moveTo(document.querySelector('#paragraph')!);
    press('i', { altKey: true });
    expect(request).not.toHaveBeenCalled();
  });

  it('启用后必须先悬停再按 Alt+I，才以 hover 任务翻译当前最小段落', async () => {
    hover.setEnabled(true, 'Alt+I');
    moveTo(document.querySelector('#paragraph')!);
    expect(request).not.toHaveBeenCalled();
    press('i', { altKey: true });
    await vi.waitFor(() => expect(request.mock.calls.some(([message]) => message.type === 'TRANSLATE')).toBe(true));
    expect(request.mock.calls.find(([message]) => message.type === 'BEGIN_JOB')?.[0]).toMatchObject({ mode: 'hover', preferences: { source: 'auto', target: 'zh' } });
    expect(request.mock.calls.find(([message]) => message.type === 'TRANSLATE')?.[0]).toMatchObject({ mode: 'hover', text: 'Hover this paragraph.' });
    expect(panel()?.textContent).toContain('悬停译文');
  });

  it('支持自定义组合键，并拒绝密码框成为悬停翻译目标', async () => {
    hover.setEnabled(true, 'Ctrl+Shift+K');
    moveTo(document.querySelector('#private')!);
    press('k', { ctrlKey: true, shiftKey: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(request).not.toHaveBeenCalled();
    moveTo(document.querySelector('#paragraph')!);
    press('i', { altKey: true });
    expect(request).not.toHaveBeenCalled();
    press('k', { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(request.mock.calls.some(([message]) => message.type === 'TRANSLATE')).toBe(true));
  });
});
