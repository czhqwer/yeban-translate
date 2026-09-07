// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNED, readSelection } from '../src/content/dom';
import { SelectionTranslator } from '../src/content/selection';
import { FloatingTranslator } from '../src/content/floating';
import type { Preferences } from '../src/shared/types';

let translator: SelectionTranslator;
let request: ReturnType<typeof vi.fn>;
let shadows: WeakMap<Element, ShadowRoot>;
let dock: FloatingTranslator | undefined;
const rect = { top: 10, bottom: 40, left: 10, right: 200, width: 190, height: 30, x: 10, y: 10, toJSON: () => ({}) };
const context = { preferences: { provider: 'bailian', source: 'auto', target: 'zh' }, selectionEnabled: true, dataNoticeAccepted: true, services: { bailian: { configured: true }, aliyun: { configured: false } } };

beforeEach(() => {
  document.body.innerHTML = '<p id="first">First selection</p><p id="second">Second selection</p>';
  shadows = new WeakMap();
  const attachShadow = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { const shadow = attachShadow.call(this, init); shadows.set(this, shadow); return shadow; });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  request = vi.fn(async (message: { type: string }) => message.type === 'GET_CONTEXT' ? { ok: true, value: context } : message.type === 'BEGIN_JOB' ? { ok: true, value: { revision: 1 } } : message.type === 'TRANSLATE' ? { ok: true, value: { translated: '测试译文' } } : { ok: true, value: undefined });
  vi.stubGlobal('chrome', { runtime: { sendMessage: request } });
  translator = new SelectionTranslator(document);
});
afterEach(async () => { dock?.destroy(); dock = undefined; await translator.setEnabled(false); await translator.close(); document.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function select(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}
function panel(): ShadowRoot | undefined { const host = document.querySelector(`[${OWNED}]:not([data-yeban-floating])`); return host ? shadows.get(host) : undefined; }
async function clickTrigger(): Promise<void> {
  await vi.waitFor(() => expect(panel()?.querySelector<HTMLButtonElement>('.trigger')).toBeTruthy());
  panel()!.querySelector<HTMLButtonElement>('.trigger')!.click();
}

function lineRect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function selectionGeometry(bounds: DOMRect, lines: DOMRect[] = []): void {
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(lines as unknown as DOMRectList);
}

function position(): { left: number; top: number } {
  const host = document.querySelector<HTMLElement>(`[${OWNED}]:not([data-yeban-floating])`)!;
  return { left: Number.parseFloat(host.style.left), top: Number.parseFloat(host.style.top) };
}

describe('划词按钮与结果窗定位', () => {
  beforeEach(() => {
    vi.stubGlobal('innerWidth', 500);
    vi.stubGlobal('innerHeight', 300);
  });

  it('单行按钮跟随文字右端，未完成布局时也按24px计算而不是结果窗宽度', async () => {
    selectionGeometry(lineRect(20, 60, 180, 20), [lineRect(20, 60, 180, 20)]);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(position()).toEqual({ left: 206, top: 58 });
    expect(request).not.toHaveBeenCalled();
  });

  it('多行选区采用最后一个有效可见文本矩形，忽略空矩形与视口外尾行', async () => {
    selectionGeometry(lineRect(20, 60, 400, 280), [lineRect(20, 60, 400, 20), lineRect(20, 84, 150, 20), lineRect(170, 84, 0, 0), lineRect(20, 320, 150, 20)]);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(position()).toEqual({ left: 176, top: 82 });
  });

  it('跨行并跨过加粗、链接和隐藏装饰节点时仍显示按钮，且不读取装饰文本', async () => {
    document.body.innerHTML = '<p id="mixed">Every function and operator in Flink can be <strong>stateful</strong> (see <a href="#state">working with state<span aria-hidden="true">↗</span></a><svg aria-hidden="true"><text>DO_NOT_SEND</text></svg> for details). Stateful functions store data across the processing of individual elements/events, making state a critical building block.</p>';
    selectionGeometry(lineRect(20, 60, 400, 44), [lineRect(175, 60, 325, 20), lineRect(20, 84, 150, 20)]);
    await translator.setEnabled(true);
    const paragraph = document.querySelector('#mixed')!;
    const texts: Text[] = [];
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    const startNode = texts.find(node => node.data.includes('operator in Flink'))!;
    const endNode = texts.find(node => node.data.includes('individual elements/events'))!;
    const range = document.createRange();
    range.setStart(startNode, startNode.data.indexOf('operator in Flink'));
    range.setEnd(endNode, endNode.data.indexOf('events,') + 'events,'.length);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    expect(readSelection(document.getSelection(), document)?.text).toBe('operator in Flink can be stateful (see working with state for details). Stateful functions store data across the processing of individual elements/events,');
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(position()).toEqual({ left: 176, top: 82 });
  });

  it('反向选择与正向选择使用相同的文字末行锚点', async () => {
    selectionGeometry(lineRect(20, 60, 400, 44), [lineRect(20, 60, 400, 20), lineRect(20, 84, 150, 20)]);
    await translator.setEnabled(true);
    const paragraph = document.querySelector('#first')!;
    select(paragraph);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    const forward = position();
    await translator.close();
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(paragraph.firstChild!, paragraph.textContent!.length, paragraph.firstChild!, 0);
    expect(selection.anchorOffset).toBeGreaterThan(selection.focusOffset);
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(position()).toEqual(forward);
  });

  it('右边缘空间不足时在末行右下方避让，不退回选区左端', async () => {
    selectionGeometry(lineRect(350, 60, 140, 20), [lineRect(350, 60, 140, 20)]);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(position()).toEqual({ left: 464, top: 86 });
  });

  it('右下角不足时避让到整个选区上方，不覆盖上一行选中文字', async () => {
    selectionGeometry(lineRect(30, 230, 460, 58), [lineRect(30, 230, 460, 24), lineRect(350, 264, 140, 24)]);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(position()).toEqual({ left: 464, top: 200 });
  });

  it('末行右侧会碰到上一行选中文字时，改用末行下方的空隙', async () => {
    selectionGeometry(lineRect(20, 60, 400, 40), [lineRect(20, 60, 400, 20), lineRect(20, 80, 150, 20)]);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(position()).toEqual({ left: 146, top: 106 });
  });

  it('整屏选区没有空位时最终回退到视口右缘，允许局部覆盖而不隐藏入口', async () => {
    selectionGeometry(lineRect(0, 0, 500, 300), [lineRect(0, 0, 500, 300)]);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    const host = document.querySelector<HTMLElement>(`[${OWNED}]`)!;
    expect(host.style.visibility).not.toBe('hidden');
    expect(position()).toEqual({ left: 464, top: 264 });
    selectionGeometry(lineRect(20, 60, 180, 20), [lineRect(20, 60, 180, 20)]);
    document.dispatchEvent(new Event('scroll'));
    expect(host.style.visibility).not.toBe('hidden');
    expect(position()).toEqual({ left: 206, top: 58 });
  });

  it('滚动和缩放重新定位，选区离开视口后收起', async () => {
    selectionGeometry(lineRect(20, 60, 180, 20), [lineRect(20, 60, 180, 20)]);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    selectionGeometry(lineRect(300, 100, 190, 20), [lineRect(300, 100, 190, 20)]);
    document.dispatchEvent(new Event('scroll'));
    expect(position()).toEqual({ left: 464, top: 126 });
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    expect(position()).toEqual({ left: 364, top: 126 });
    selectionGeometry(lineRect(20, -40, 180, 20), [lineRect(20, -40, 180, 20)]);
    document.dispatchEvent(new Event('scroll'));
    expect(panel()).toBeUndefined();
  });

  it.each([{ name: '空列表', lines: [] }, { name: '零尺寸', lines: [lineRect(0, 0, 0, 0)] }])('client rects为空或零尺寸时以选区边界可靠回退（$name）', async ({ lines }) => {
    selectionGeometry(lineRect(20, 60, 180, 20), lines);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(position()).toEqual({ left: 206, top: 58 });
  });

  it('点击后宽结果窗回到选区附近并限制边界，不沿用小按钮的右置锚点', async () => {
    vi.stubGlobal('innerWidth', 280);
    selectionGeometry(lineRect(210, 200, 60, 20), [lineRect(210, 200, 60, 20)]);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(position()).toEqual({ left: 244, top: 226 });
    await clickTrigger();
    await vi.waitFor(() => expect(panel()?.textContent).toContain('测试译文'));
    expect(panel()?.querySelector('.compact')).toBeNull();
    expect(position()).toEqual({ left: 12, top: 228 });
    expect(position().left + 256).toBeLessThanOrEqual(window.innerWidth - 12);
    expect(position().top + 48).toBeLessThanOrEqual(window.innerHeight - 12);
  });

  it('结果窗已测得的实际宽高用于底部避让，恢复到选区上方且完整留在视口', async () => {
    selectionGeometry(lineRect(380, 200, 110, 20), [lineRect(380, 200, 110, 20)]);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    const host = document.querySelector<HTMLElement>(`[${OWNED}]`)!;
    Object.defineProperties(host, { offsetWidth: { configurable: true, value: 360 }, offsetHeight: { configurable: true, value: 160 } });
    await clickTrigger();
    await vi.waitFor(() => expect(panel()?.textContent).toContain('测试译文'));
    expect(position()).toEqual({ left: 128, top: 32 });
    expect(position().left + host.offsetWidth).toBeLessThanOrEqual(window.innerWidth - 12);
    expect(position().top + host.offsetHeight).toBeLessThan(200);
  });
});

describe('受保护选区', () => {
  it('普通段落中的行内代码可以随相邻文本一起划词翻译', () => {
    document.body.innerHTML = '<p>Normal <code>protected</code> normal</p>';
    const paragraph = document.querySelector('p')!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.lastChild!, 7);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    expect(readSelection(document.getSelection(), document)?.text).toBe('Normal protected normal');
  });

  it('代码块仍然拒绝划词翻译', () => {
    document.body.innerHTML = '<pre>const protectedValue = true;</pre>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('pre')!);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    expect(readSelection(document.getSelection(), document)).toBeNull();
  });

  it('没有网站授权时不监听、不展示按钮、不发送文本', async () => {
    select(document.querySelector('p')!);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(panel()).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('点击划词翻译', () => {
  it('划词按钮使用16px SVG且宿主无整体焦点框，鼠标不转移焦点但键盘仍可聚焦按钮', async () => {
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    const trigger = panel()!.querySelector<HTMLButtonElement>('.trigger')!;
    expect(trigger.querySelector('svg')?.getAttribute('width')).toBe('16');
    const host = document.querySelector<HTMLElement>(`[${OWNED}]`)!;
    expect(host.shadowRoot).toBeNull();
    expect(host.style.getPropertyValue('outline')).toBe('none');
    expect(host.style.getPropertyPriority('outline')).toBe('important');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    trigger.focus();
    expect(panel()!.activeElement).toBe(trigger);
    expect(panel()?.querySelector('style')?.textContent).toContain('width:24px;height:24px');
  });

  it('操作实际浮球留下 closed shadow 焦点后，外部合法选区仍显示划词按钮', async () => {
    const status = { state: 'idle' as const, completed: 0, failed: 0, pending: 0 };
    const action = async () => ({ ok: true as const, value: status });
    dock = new FloatingTranslator(document, { start: action, restore: action, status: () => status, reportError: () => undefined, updateSidePanel: () => undefined });
    dock.setEnabled(true);
    const host = document.querySelector('[data-yeban-floating]')!;
    const button = shadows.get(host)!.querySelector<HTMLButtonElement>('[aria-label="翻译当前页"]')!;
    button.focus();
    button.click();
    expect(document.activeElement).toBe(host);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(request.mock.calls.some(([message]) => message.type === 'TRANSLATE')).toBe(false);
  });

  it('网页阻止 mouseup 冒泡时仍能识别选区，禁用后捕获监听同步移除', async () => {
    const paragraph = document.querySelector('#first')!;
    paragraph.addEventListener('mouseup', event => event.stopPropagation());
    await translator.setEnabled(true);
    select(paragraph);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    await translator.setEnabled(false);
    select(paragraph);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(panel()).toBeUndefined();
    expect(request.mock.calls.some(([message]) => message.type === 'TRANSLATE')).toBe(false);
  });

  it('被网页阻止冒泡的键盘选区也显示按钮，浮窗内部操作不创建新请求', async () => {
    const paragraph = document.querySelector('#first')!;
    paragraph.addEventListener('keyup', event => event.stopPropagation());
    await translator.setEnabled(true);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    paragraph.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    await clickTrigger();
    await vi.waitFor(() => expect(panel()?.textContent).toContain('测试译文'));
    const before = request.mock.calls.length;
    panel()!.querySelector('.result')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    panel()!.querySelector('.result')!.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', shiftKey: true, bubbles: true, composed: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(request.mock.calls).toHaveLength(before);
    expect(panel()?.textContent).toContain('测试译文');
  });

  it('自动选择在新划词时采用最新排序，失败重试保留当次实际服务', async () => {
    translator = new SelectionTranslator(document, () => ({ provider: 'auto', source: 'auto', target: 'zh' }));
    let priority = ['bailian', 'aliyun'];
    let shouldFail = true;
    request.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_CONTEXT') return { ok: true, value: { ...context, providerPriority: priority, services: { bailian: { configured: true }, aliyun: { configured: true } } } };
      if (message.type === 'BEGIN_JOB') return { ok: true, value: { revision: 1 } };
      if (message.type === 'TRANSLATE' && shouldFail) return { ok: false, error: { code: 'NETWORK', message: '连接暂时失败', retryable: true } };
      return { ok: true, value: { translated: '成功译文' } };
    });
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await clickTrigger();
    await vi.waitFor(() => expect(panel()?.textContent).toContain('连接暂时失败'));
    priority = ['aliyun', 'bailian'];
    shouldFail = false;
    [...panel()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '重试')!.click();
    await vi.waitFor(() => expect(panel()?.textContent).toContain('成功译文'));
    await translator.close();
    select(document.querySelector('#second')!);
    await clickTrigger();
    await vi.waitFor(() => expect(request.mock.calls.filter(([message]) => message.type === 'BEGIN_JOB')).toHaveLength(3));
    expect(request.mock.calls.filter(([message]) => message.type === 'BEGIN_JOB').map(([message]) => message.preferences.provider)).toEqual(['bailian', 'bailian', 'aliyun']);
  });

  it('本页所选阿里翻译及英语优先于全局默认百炼，点击时固定服务快照', async () => {
    let selectedPreferences: Preferences = { provider: 'aliyun', source: 'auto', target: 'en' };
    translator = new SelectionTranslator(document, () => selectedPreferences);
    request.mockImplementation(async (message: { type: string }) => message.type === 'GET_CONTEXT' ? { ok: true, value: { ...context, services: { bailian: { configured: false }, aliyun: { configured: true } } } } : message.type === 'BEGIN_JOB' ? { ok: true, value: { revision: 1 } } : { ok: true, value: { translated: 'Translated selection' } });
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await clickTrigger();
    selectedPreferences = { provider: 'bailian', source: 'auto', target: 'zh' };
    await vi.waitFor(() => expect(request.mock.calls.some(([message]) => message.type === 'BEGIN_JOB')).toBe(true));
    expect(request.mock.calls.find(([message]) => message.type === 'BEGIN_JOB')?.[0]).toMatchObject({ mode: 'selection', preferences: { provider: 'aliyun', source: 'auto', target: 'en' } });
    await vi.waitFor(() => expect(panel()?.textContent).toContain('阿里云机器翻译 · 英语'));
  });

  it('选中只显示按钮，点击后才发送快照，返回 HTML 只显示文本', async () => {
    request.mockImplementation(async (message: { type: string }) => message.type === 'GET_CONTEXT' ? { ok: true, value: context } : message.type === 'BEGIN_JOB' ? { ok: true, value: { revision: 1 } } : { ok: true, value: { translated: '<img src=x onerror=alert(1)>' } });
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.querySelector('.trigger')).toBeTruthy());
    expect(request).not.toHaveBeenCalled();
    document.getSelection()?.removeAllRanges();
    await clickTrigger();
    await vi.waitFor(() => expect(panel()?.textContent).toContain('<img src=x onerror=alert(1)>'));
    expect(panel()?.querySelector('img')).toBeNull();
    expect(request.mock.calls.find(([message]) => message.type === 'TRANSLATE')?.[0].text).toBe('First selection');
  });

  it('连续选择 A/B 后旧结果不串入新浮窗，关闭后迟到结果不重开', async () => {
    const responses: Array<(result: unknown) => void> = [];
    request.mockImplementation((message: { type: string }) => message.type === 'TRANSLATE' ? new Promise(resolve => { responses.push(resolve); }) : Promise.resolve({ ok: true, value: message.type === 'GET_CONTEXT' ? context : { revision: 1 } }));
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await clickTrigger();
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    select(document.querySelector('#second')!);
    await clickTrigger();
    await vi.waitFor(() => expect(responses).toHaveLength(2));
    responses[0]({ ok: true, value: { translated: 'A 的迟到译文' } });
    await Promise.resolve();
    expect(panel()?.textContent).not.toContain('A 的迟到译文');
    expect(panel()?.textContent).toContain('Second selection');
    await translator.close();
    responses[1]({ ok: true, value: { translated: 'B 的迟到译文' } });
    await Promise.resolve();
    expect(panel()).toBeUndefined();
    expect(request.mock.calls.filter(([message]) => message.type === 'CANCEL_JOB').every(([message]) => message.mode === 'selection')).toBe(true);
  });

  it('超长划词给出提示且没有翻译请求，撤销授权清理界面', async () => {
    document.querySelector('#first')!.textContent = '😀'.repeat(2001);
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await vi.waitFor(() => expect(panel()?.textContent).toContain('超过 2000 字'));
    expect(panel()?.querySelector('.trigger')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    await translator.setEnabled(false);
    expect(panel()).toBeUndefined();
  });

  it('撤销站点授权会取消在途划词任务，并丢弃迟到结果', async () => {
    let finish!: (result: unknown) => void;
    request.mockImplementation((message: { type: string }) => message.type === 'TRANSLATE' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: message.type === 'GET_CONTEXT' ? context : { revision: 1 } }));
    await translator.setEnabled(true);
    select(document.querySelector('#first')!);
    await clickTrigger();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await translator.setEnabled(false);
    finish({ ok: true, value: { translated: '撤销后迟到译文' } });
    await Promise.resolve();
    expect(panel()).toBeUndefined();
    expect(request.mock.calls.some(([message]) => message.type === 'CANCEL_JOB' && message.mode === 'selection')).toBe(true);
    const previousRequestCount = request.mock.calls.length;
    select(document.querySelector('#second')!);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(panel()).toBeUndefined();
    expect(request.mock.calls).toHaveLength(previousRequestCount);
  });
});
