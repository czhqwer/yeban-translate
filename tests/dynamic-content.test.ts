// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTranslator } from '../src/content/page';
import { OWNED } from '../src/content/dom';

let translator: PageTranslator;
let request: ReturnType<typeof vi.fn>;
const preferences = { provider: 'bailian' as const, source: 'auto' as const, target: 'zh' as const };
const rect = { top: 20, bottom: 40, left: 20, right: 300, width: 280, height: 20, x: 20, y: 20, toJSON: () => ({}) };

beforeEach(() => {
  document.body.innerHTML = '<style>nav input:not(:checked)+label+ul{display:none}</style><nav><ul><li><input id="learn" type="checkbox"><label for="learn">Try Flink</label><ul id="submenu"><li><a href="#first">First steps</a></li><li><a href="#examples">Examples</a></li></ul></li></ul></nav>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    // jsdom 缓存 :checked 的计算样式；按真实 CSS 选择器补足属性变更，不修改 DOM 属性。
    if (element.id === 'submenu') style.display = element.matches('nav input:not(:checked)+label+ul') ? 'none' : 'block';
    return style;
  });
  request = vi.fn(async (message: { type: string; text?: string }) => message.type === 'BEGIN_JOB' ? { ok: true, value: { revision: 1 } } : message.type === 'TRANSLATE' ? { ok: true, value: { translated: `译文：${message.text}` } } : { ok: true, value: null });
  vi.stubGlobal('chrome', { runtime: { sendMessage: request } });
  translator = new PageTranslator(document);
});
afterEach(async () => { await translator.restore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function toggle(checked: boolean): void {
  const checkbox = document.querySelector<HTMLInputElement>('#learn')!;
  checkbox.checked = checked;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
}
function sent(): string[] { return request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').map(([message]) => message.text); }

describe('展开菜单后的增量正文发现', () => {
  it('全文模式展开菜单后自动翻译其中的屏外子项，不等待滚动', async () => {
    const lastItem = document.querySelector('#submenu > li:last-child')!;
    Object.defineProperty(lastItem, 'getBoundingClientRect', { configurable: true, value: () => ({ ...rect, top: 5000, bottom: 5020 }) });
    await translator.start(preferences, 'expanded');
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    expect(sent()).toEqual(['Try Flink']);
    toggle(true);
    await vi.waitFor(() => expect(translator.status().completed).toBe(3));
    expect(sent()).toEqual(['Try Flink', 'First steps', 'Examples']);
    expect(translator.status().message).not.toContain('滚动');
    toggle(false); toggle(true);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(sent()).toHaveLength(3);
  });

  it('真实 nowrap flex 标签把译文放进文字 div，保留箭头列、相邻 CSS 与点击折叠', async () => {
    const label = document.querySelector<HTMLLabelElement>('label')!;
    label.style.cssText = 'display:flex;justify-content:space-between;flex-wrap:nowrap';
    label.innerHTML = '<div id="label-text"><i aria-hidden="true">✦</i>Try Flink</div><span>▾</span>';
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    expect(label.children).toHaveLength(2);
    expect(label.style.flexWrap).toBe('nowrap');
    const translation = label.querySelector<HTMLSpanElement>(`#label-text > [${OWNED}]`)!;
    expect(translation).toBeTruthy();
    expect(label.nextElementSibling?.id).toBe('submenu');
    expect(getComputedStyle(document.querySelector('#submenu')!).display).toBe('none');
    translation.click();
    expect(document.querySelector<HTMLInputElement>('#learn')!.checked).toBe(true);
    await vi.waitFor(() => expect(translator.status().completed).toBe(3));
    expect(label.children).toHaveLength(2);
  });

  it('没有文字 div 的 flex 标签使用可恢复换行，恢复原文后还原原有 nowrap', async () => {
    const label = document.querySelector<HTMLLabelElement>('label')!;
    label.style.cssText = 'display:flex;justify-content:space-between;flex-wrap:nowrap';
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    expect(label.style.flexWrap).toBe('wrap');
    expect(label.querySelector<HTMLElement>(`[${OWNED}]`)?.style.flexBasis).toBe('100%');
    expect(label.nextElementSibling?.id).toBe('submenu');
    await translator.restore();
    expect(label.style.flexWrap).toBe('nowrap');
    expect(label.style.justifyContent).toBe('space-between');
    expect(document.querySelector<HTMLInputElement>('#learn')!.checked).toBe(false);
  });

  it('先翻译父标签仍保持默认折叠，展开后翻译新子项，往返展开不重发父项和子项', async () => {
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    expect(getComputedStyle(document.querySelector('#submenu')!).display).toBe('none');
    expect(sent()).toEqual(['Try Flink']);
    toggle(true);
    expect(document.querySelector<HTMLInputElement>('#learn')!.checked).toBe(true);
    expect(getComputedStyle(document.querySelector('#submenu')!).display).not.toBe('none');
    await vi.waitFor(() => expect(translator.status().completed).toBe(3));
    expect(sent()).toEqual(['Try Flink', 'First steps', 'Examples']);
    toggle(false);
    toggle(true);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(sent()).toHaveLength(3);
    expect(document.querySelector('label')?.getAttribute('for')).toBe('learn');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('#first');
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(3);
  });

  it('停止与恢复取消等待中的发现任务，停后展开不会新增请求', async () => {
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    toggle(true);
    await translator.stop();
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(sent()).toEqual(['Try Flink']);
    await translator.restore();
    toggle(false);
    toggle(true);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(sent()).toEqual(['Try Flink']);
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(0);
  });

  it('导航 childList 与 class 展开可发现新项，仍折叠内容和正文区动态插入不触发付费', async () => {
    document.querySelector('style')!.textContent += 'nav ul.collapsed{display:none}';
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    const list = document.createElement('ul');
    list.className = 'collapsed';
    list.innerHTML = '<li><a href="#additional">Additional menu entry.</a></li>';
    document.querySelector('nav')!.append(list);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(sent()).toEqual(['Try Flink']);
    list.classList.remove('collapsed');
    await vi.waitFor(() => expect(translator.status().completed).toBe(2));
    const outside = document.createElement('p');
    outside.textContent = 'New body content is outside incremental menu scope.';
    document.body.append(outside);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(sent()).toEqual(['Try Flink', 'Additional menu entry.']);
    expect(sent().some(text => text.includes('译文：'))).toBe(false);
  });

  it('服务失败清理菜单观察，重试恢复后补发现失败期间已展开的子菜单', async () => {
    let fail = true;
    request.mockImplementation(async (message: { type: string; text?: string }) => message.type === 'BEGIN_JOB' ? { ok: true, value: { revision: 1 } } : message.type === 'TRANSLATE' && fail ? { ok: false, error: { code: 'AUTH', message: '鉴权失败。', retryable: false } } : { ok: true, value: { translated: '成功译文' } });
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().failed).toBe(1));
    toggle(true);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(sent()).toEqual(['Try Flink']);
    fail = false;
    await translator.retry();
    await vi.waitFor(() => expect(translator.status().completed).toBe(3));
    expect(sent()).toEqual(['Try Flink', 'Try Flink', 'First steps', 'Examples']);
  });

  it('新发现的视口外菜单项只登记观察，滚动进入后才请求', async () => {
    let observer!: TestObserver;
    class TestObserver {
      readonly targets = new Set<Element>();
      constructor(private readonly callback: IntersectionObserverCallback) { observer = this; }
      observe(target: Element): void { this.targets.add(target); }
      unobserve(target: Element): void { this.targets.delete(target); }
      disconnect(): void { this.targets.clear(); }
      enter(target: Element): void { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    }
    vi.stubGlobal('IntersectionObserver', TestObserver);
    const lastItem = document.querySelector('#submenu > li:last-child')!;
    let visible = false;
    Object.defineProperty(lastItem, 'getBoundingClientRect', { configurable: true, value: () => visible ? rect : ({ ...rect, top: 4000, bottom: 4020 }) });
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    toggle(true);
    await vi.waitFor(() => expect(translator.status().completed).toBe(2));
    expect(sent()).toEqual(['Try Flink', 'First steps']);
    expect(observer.targets.has(lastItem)).toBe(true);
    visible = true;
    observer.enter(lastItem);
    await vi.waitFor(() => expect(translator.status().completed).toBe(3));
    expect(sent()).toEqual(['Try Flink', 'First steps', 'Examples']);
  });
});
