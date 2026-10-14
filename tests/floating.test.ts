// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentController } from '../src/content/controller';
import { FloatingTranslator } from '../src/content/floating';
import { OWNED } from '../src/content/dom';
import type { PageContext, PageStatus, Preferences, TranslationSelection } from '../src/shared/types';

let controller: ContentController;
let state: PageContext;
let request: ReturnType<typeof vi.fn>;
let shadows: WeakMap<Element, ShadowRoot>;
let draggable: FloatingTranslator | undefined;
const prefs: Preferences = { provider: 'bailian', source: 'auto', target: 'zh' };
const auto: TranslationSelection = { provider: 'auto', source: 'auto', target: 'zh' };
const rect = { top: 20, bottom: 40, left: 20, right: 240, width: 220, height: 20, x: 20, y: 20, toJSON: () => ({}) };

beforeEach(() => {
  document.body.innerHTML = '<main><p>Hello documentation.</p></main>';
  state = {
    preferences: { ...prefs }, providerPriority: ['bailian', 'aliyun'], dataNoticeAccepted: true, selectionEnabled: false, floatingEnabled: true,
    sidePanel: { windowId: 1, open: false, ready: true, canOpen: true, canToggle: true, version: 1 },
    services: { bailian: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', configured: true }, aliyun: { endpoint: 'https://mt.cn-hangzhou.aliyuncs.com', configured: true } },
  };
  shadows = new WeakMap();
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { const shadow = attach.call(this, init); shadows.set(this, shadow); return shadow; });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect });
  request = vi.fn(async (message: { type: string; text?: string; open?: boolean }) => {
    if (message.type === 'GET_CONTEXT') return { ok: true, value: structuredClone(state) };
    if (message.type === 'BEGIN_JOB') return { ok: true, value: { revision: 1 } };
    if (message.type === 'TRANSLATE') return { ok: true, value: { translated: '测试译文' } };
    if (message.type === 'SET_SIDE_PANEL') return { ok: true, value: { ...state.sidePanel, open: message.open, version: (state.sidePanel?.version ?? 0) + 1 } };
    return { ok: true, value: null };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: request } });
  controller = new ContentController(document);
});

afterEach(async () => { draggable?.destroy(); draggable = undefined; await controller.suspend(); document.getSelection()?.removeAllRanges(); document.querySelectorAll(`[${OWNED}]`).forEach(node => node.remove()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function floating(): ShadowRoot | undefined { const host = document.querySelector('[data-yeban-floating]'); return host ? shadows.get(host) : undefined; }
function clickFloating(label: string): void { floating()!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(); }
function clickMain(): void { floating()!.querySelector<HTMLButtonElement>('.primary')!.click(); }
function selectText(): void {
  const paragraph = document.querySelector('p')!;
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}
function selectionHost(): Element | null { return document.querySelector(`[${OWNED}]:not([data-yeban-floating])`); }

describe('浮球入口与文档控制', () => {
  it('浮球只有两个 SVG 按钮且无菜单，动作错误交给 popup 不覆盖正文状态', async () => {
    await controller.ready;
    expect(floating()?.querySelector('.status')).toBeNull();
    expect(floating()?.querySelector('.menu')).toBeNull();
    expect(floating()?.querySelectorAll('button')).toHaveLength(2);
    expect(floating()?.querySelectorAll('button > svg')).toHaveLength(2);
    state.services.bailian.configured = false;
    state.services.aliyun.configured = false;
    clickFloating('翻译当前页');
    await vi.waitFor(() => expect(floating()?.querySelector('.primary')?.getAttribute('data-state')).toBe('error'));
    expect(controller.status().actionError?.message).toContain('没有可用的翻译服务');
    expect(controller.status().state).toBe('idle');
    expect(controller.status().canRestore).toBe(false);
    expect(floating()?.querySelector('.status')).toBeNull();
  });

  it('侧栏点击立即按预同步窗口状态发 SET_SIDE_PANEL，之前没有异步状态读取', async () => {
    await controller.ready;
    request.mockClear();
    clickFloating('打开页伴翻译侧栏');
    expect(request.mock.calls.map(([message]) => message.type)).toEqual(['SET_SIDE_PANEL']);
    expect(request.mock.calls[0][0]).toEqual({ type: 'SET_SIDE_PANEL', open: true, windowId: 1 });
  });

  it('浮球一击翻译并展示状态，恢复原文后入口仍可使用', async () => {
    await controller.ready;
    const host = document.querySelector('[data-yeban-floating]');
    clickFloating('翻译当前页');
    await vi.waitFor(() => expect(controller.status().completed).toBe(1));
    expect(request.mock.calls.find(([message]) => message.type === 'BEGIN_JOB')?.[0].preferences.provider).toBe('bailian');
    clickMain();
    await vi.waitFor(() => expect(controller.status().canRestore).toBe(false));
    expect(document.querySelector('[data-yeban-floating]')).toBe(host);
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(1);
    expect(controller.status().state).toBe('idle');
    expect(floating()?.querySelector<HTMLButtonElement>('[aria-label="翻译当前页"]')?.disabled).toBe(false);
  });

  it('没有可用服务时明确提示设置，不发送翻译请求', async () => {
    await controller.ready;
    state.services.bailian.configured = false;
    state.services.aliyun.configured = false;
    clickFloating('翻译当前页');
    await vi.waitFor(() => expect(floating()?.textContent).toContain('没有可用的翻译服务'));
    expect(request.mock.calls.some(([message]) => message.type === 'BEGIN_JOB' || message.type === 'TRANSLATE')).toBe(false);
  });

  it('异步准备期间恢复原文会取消启动，迟到上下文不会再创建任务', async () => {
    await controller.ready;
    let finish!: (reply: unknown) => void;
    request.mockImplementation((message: { type: string }) => message.type === 'GET_CONTEXT' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: null }));
    const starting = controller.handle({ type: 'PAGE_START', preferences: prefs, selection: auto });
    await controller.handle({ type: 'RESTORE' });
    finish({ ok: true, value: structuredClone(state) });
    await starting;
    expect(request.mock.calls.some(([message]) => message.type === 'BEGIN_JOB')).toBe(false);
    expect(controller.status().state).toBe('idle');
    expect(document.querySelector('[data-yeban-floating]')).toBeTruthy();
  });

  it('同一主按钮在准备期间第二击恢复，第三击立即新建准备且旧上下文不能抢占', async () => {
    await controller.ready;
    const contexts: Array<(reply: unknown) => void> = [];
    request.mockImplementation((message: { type: string }) => message.type === 'GET_CONTEXT' ? new Promise(resolve => { contexts.push(resolve); }) : Promise.resolve({ ok: true, value: message.type === 'BEGIN_JOB' ? { revision: 1 } : { translated: '测试译文' } }));
    clickMain();
    expect(controller.status().canRestore).toBe(true);
    expect(floating()?.querySelector<HTMLButtonElement>('.primary')?.disabled).toBe(false);
    clickMain();
    await vi.waitFor(() => expect(floating()?.querySelector<HTMLButtonElement>('.primary')?.disabled).toBe(false));
    clickMain();
    expect(contexts).toHaveLength(2);
    contexts[0]({ ok: true, value: structuredClone(state) });
    await Promise.resolve(); await Promise.resolve();
    expect(controller.status().canRestore).toBe(true);
    expect(request.mock.calls.some(([message]) => message.type === 'BEGIN_JOB')).toBe(false);
    contexts[1]({ ok: true, value: { ...structuredClone(state), providerPriority: ['aliyun', 'bailian'] } });
    await vi.waitFor(() => expect(controller.status().completed).toBe(1));
    expect(request.mock.calls.filter(([message]) => message.type === 'BEGIN_JOB')).toHaveLength(1);
    expect(controller.status().preferences?.provider).toBe('aliyun');
  });

  it('主按钮只翻译可见正文，滚动到屏外段落后才发送且同按钮可恢复', async () => {
    await controller.ready;
    document.body.innerHTML = '<main><p>Visible paragraph.</p><p id="below">Expanded offscreen paragraph.</p><p hidden>Hidden paragraph.</p></main>';
    let observer!: { enter: (target: Element) => void };
    class TestObserver {
      constructor(private readonly callback: IntersectionObserverCallback) { observer = this; }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      enter(target: Element): void { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    }
    vi.stubGlobal('IntersectionObserver', TestObserver);
    const below = document.querySelector('#below')!;
    let visible = false;
    Object.defineProperty(below, 'getBoundingClientRect', { configurable: true, value: () => visible ? rect : ({ ...rect, top: 4000, bottom: 4020 }) });
    clickMain();
    await vi.waitFor(() => expect(controller.status().completed).toBe(1));
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').map(([message]) => message.text)).toEqual(['Visible paragraph.']);
    expect(controller.status().message).toContain('滚动');
    visible = true;
    observer.enter(below);
    await vi.waitFor(() => expect(controller.status().completed).toBe(2));
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').map(([message]) => message.text)).toEqual(['Visible paragraph.', 'Expanded offscreen paragraph.']);
    expect(controller.status().canRestore).toBe(true);
    clickMain();
    await vi.waitFor(() => expect(controller.status().canRestore).toBe(false));
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(1);
  });

  it('浮球宿主无蓝框，鼠标按下不转移整体焦点而键盘可聚焦内部图标按钮', async () => {
    await controller.ready;
    const host = document.querySelector<HTMLElement>('[data-yeban-floating]')!;
    expect(host.shadowRoot).toBeNull();
    expect(host.style.getPropertyValue('outline')).toBe('none');
    expect(host.style.getPropertyPriority('outline')).toBe('important');
    expect(host.style.getPropertyValue('box-shadow')).toBe('none');
    for (const button of floating()!.querySelectorAll<HTMLButtonElement>('button')) {
      const mouse = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      button.dispatchEvent(mouse);
      expect(mouse.defaultPrevented).toBe(true);
      button.focus();
      expect(floating()!.activeElement).toBe(button);
      expect(button.querySelector('svg')?.getAttribute('focusable')).toBe('false');
    }
  });
});

describe('窗口级侧栏状态', () => {
  it('移动窗口后的外窗广播触发一次权威核实，期间仅禁用侧栏，随后按新窗口操作', async () => {
    await controller.ready;
    clickMain();
    await vi.waitFor(() => expect(controller.status().completed).toBe(1));
    const before = request.mock.calls.filter(([message]) => message.type === 'GET_CONTEXT').length;
    let resolveContext!: (reply: unknown) => void;
    state.sidePanel = { ...state.sidePanel!, windowId: 20, version: 3 };
    request.mockImplementation((message: { type: string; open?: boolean }) => message.type === 'GET_CONTEXT' ? new Promise(resolve => { resolveContext = resolve; }) : Promise.resolve({ ok: true, value: { ...state.sidePanel, open: message.open, version: 4 } }));
    const moved = Array.from({ length: 12 }, () => controller.handle({ type: 'SIDE_PANEL_STATE', state: { ...state.sidePanel! } }));
    expect(controller.status()).toMatchObject({ state: 'waiting', canRestore: true, sidePanel: { windowId: 1, ready: false } });
    expect(floating()?.querySelector<HTMLButtonElement>('.primary')?.disabled).toBe(false);
    expect(floating()?.querySelector<HTMLButtonElement>('.side-panel')?.disabled).toBe(true);
    await vi.waitFor(() => expect(request.mock.calls.filter(([message]) => message.type === 'GET_CONTEXT')).toHaveLength(before + 1));
    resolveContext({ ok: true, value: structuredClone(state) });
    await Promise.all(moved);
    expect(controller.status().sidePanel).toMatchObject({ windowId: 20, ready: true, version: 3 });
    clickFloating('打开页伴翻译侧栏');
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ type: 'SET_SIDE_PANEL', open: true, windowId: 20 });
  });

  it('无关外窗只触发核实，不直接采用其高版本；更早上下文迟到也不能改回旧窗口', async () => {
    await controller.ready;
    const replies: Array<(reply: unknown) => void> = [];
    request.mockImplementation((message: { type: string }) => message.type === 'GET_CONTEXT' ? new Promise(resolve => replies.push(resolve)) : Promise.resolve({ ok: true, value: null }));
    const stale = controller.handle({ type: 'FEATURES_CHANGED' });
    const moving = controller.handle({ type: 'SIDE_PANEL_STATE', state: { ...state.sidePanel!, windowId: 20, open: true, version: 90 } });
    expect(controller.status().sidePanel?.windowId).toBe(1);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]({ ok: true, value: { ...structuredClone(state), sidePanel: { ...state.sidePanel!, windowId: 20, open: false, version: 91 } } });
    await moving;
    replies[0]({ ok: true, value: { ...structuredClone(state), sidePanel: { ...state.sidePanel!, windowId: 1, open: true, version: 999 } } });
    await stale;
    expect(controller.status().sidePanel).toMatchObject({ windowId: 20, open: false, version: 91 });
    const unrelated = controller.handle({ type: 'SIDE_PANEL_STATE', state: { ...state.sidePanel!, windowId: 99, open: true, version: 999 } });
    expect(controller.status().sidePanel?.windowId).toBe(20);
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    replies[2]({ ok: true, value: { ...structuredClone(state), sidePanel: { ...state.sidePanel!, windowId: 20, open: false, version: 3 } } });
    await unrelated;
    expect(controller.status().sidePanel).toMatchObject({ windowId: 20, open: false, ready: true, version: 91 });
  });

  it('核实期间连续迁移合并为一次后续查询，保持侧栏禁用直至确认最新窗口', async () => {
    await controller.ready;
    const replies: Array<(reply: unknown) => void> = [];
    request.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    const first = controller.handle({ type: 'SIDE_PANEL_STATE', state: { ...state.sidePanel!, windowId: 20, version: 2 } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    const second = controller.handle({ type: 'SIDE_PANEL_STATE', state: { ...state.sidePanel!, windowId: 30, version: 1 } });
    replies[0]({ ok: true, value: { ...structuredClone(state), sidePanel: { ...state.sidePanel!, windowId: 20, version: 2 } } });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(controller.status().sidePanel?.ready).toBe(false);
    replies[1]({ ok: true, value: { ...structuredClone(state), sidePanel: { ...state.sidePanel!, windowId: 30, version: 1 } } });
    await Promise.all([first, second]);
    expect(controller.status().sidePanel).toMatchObject({ windowId: 30, ready: true, version: 1 });
  });

  it('侧栏动作失败保留正文状态与恢复能力，主按钮仍可立即恢复原文', async () => {
    await controller.ready;
    clickMain();
    await vi.waitFor(() => expect(controller.status().completed).toBe(1));
    request.mockResolvedValueOnce({ ok: false, error: { code: 'SIDE_PANEL', message: '侧栏暂时无法打开。', retryable: true } });
    clickFloating('打开页伴翻译侧栏');
    await vi.waitFor(() => expect(controller.status().actionError?.code).toBe('SIDE_PANEL'));
    expect(controller.status()).toMatchObject({ state: 'waiting', canRestore: true });
    expect(controller.status().sidePanel?.open).toBe(false);
    clickMain();
    await vi.waitFor(() => expect(controller.status()).toMatchObject({ state: 'idle', canRestore: false }));
    expect(controller.status().actionError).toBeUndefined();
  });

  it('只接受本窗口较新的广播，旧 FEATURES 上下文与旧请求回复不能回滚状态', async () => {
    await controller.ready;
    let complete!: (reply: unknown) => void;
    request.mockImplementation((message: { type: string }) => message.type === 'SET_SIDE_PANEL' ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ ok: true, value: structuredClone(state) }));
    clickFloating('打开页伴翻译侧栏');
    await controller.handle({ type: 'SIDE_PANEL_STATE', state: { ...state.sidePanel!, windowId: 99, open: true, version: 99 } });
    expect(controller.status().sidePanel?.open).toBe(false);
    await controller.handle({ type: 'SIDE_PANEL_STATE', state: { ...state.sidePanel!, open: false, version: 5 } });
    await controller.handle({ type: 'FEATURES_CHANGED' });
    expect(controller.status().sidePanel?.version).toBe(5);
    complete({ ok: true, value: { ...state.sidePanel!, open: true, version: 2 } });
    await Promise.resolve(); await Promise.resolve();
    expect(controller.status().sidePanel).toMatchObject({ windowId: 1, open: false, version: 5 });
  });

  it('旧能力只提供打开入口，用户用原生 X 关闭且无事件后再次点击仍请求打开', async () => {
    await controller.ready;
    await controller.handle({ type: 'SIDE_PANEL_STATE', state: { ...state.sidePanel!, ready: false, version: 2 } });
    const side = () => floating()!.querySelector<HTMLButtonElement>('.side-panel')!;
    expect(side().disabled).toBe(true);
    await controller.handle({ type: 'SIDE_PANEL_STATE', state: { ...state.sidePanel!, canToggle: false, version: 3 } });
    expect(side().getAttribute('aria-label')).toBe('打开侧栏（用原生×关闭）');
    request.mockResolvedValueOnce({ ok: true, value: { ...state.sidePanel!, canToggle: false, open: true, version: 4 } });
    side().click();
    await vi.waitFor(() => { expect(controller.status().sidePanel?.open).toBe(true); expect(side().disabled).toBe(false); });
    expect(side().hasAttribute('aria-pressed')).toBe(false);
    // 用户点原生 X 后旧浏览器不会通知扩展，缓存仍显示 open:true。
    request.mockResolvedValueOnce({ ok: true, value: { ...state.sidePanel!, canToggle: false, open: true, version: 5 } });
    side().click();
    expect(request.mock.calls.filter(([message]) => message.type === 'SET_SIDE_PANEL').map(([message]) => message.open)).toEqual([true, true]);
    expect(controller.status().sidePanel?.open).toBe(true);
    expect(controller.status().actionError).toBeUndefined();
    expect(controller.status().state).toBe('idle');
  });
});

describe('自动服务与功能通知', () => {
  it('优先级改变不影响运行快照，新自动任务按最新顺序解析', async () => {
    await controller.ready;
    await controller.handle({ type: 'PAGE_START', preferences: prefs, selection: auto });
    await vi.waitFor(() => expect(controller.status().completed).toBe(1));
    state.providerPriority = ['aliyun', 'bailian'];
    await controller.handle({ type: 'FEATURES_CHANGED' });
    expect(controller.status()).toMatchObject({ selection: { provider: 'auto' }, preferences: { provider: 'bailian' } });
    await controller.handle({ type: 'PAGE_STOP' });
    await controller.handle({ type: 'PAGE_START', preferences: prefs, selection: auto });
    await vi.waitFor(() => expect(controller.status().completed).toBe(1));
    expect(request.mock.calls.filter(([message]) => message.type === 'BEGIN_JOB').map(([message]) => message.preferences.provider)).toEqual(['bailian', 'aliyun']);
    expect(controller.status().selection?.provider).toBe('auto');
  });

  it('显式选择不被排序替代，仅修改语言可以继续保留 auto', async () => {
    await controller.ready;
    state.providerPriority = ['aliyun', 'bailian'];
    await controller.handle({ type: 'SET_SELECTION', selection: { ...auto, target: 'en' } });
    await controller.handle({ type: 'FEATURES_CHANGED' });
    expect(controller.status().selection).toEqual({ provider: 'auto', source: 'auto', target: 'en' });
    await controller.handle({ type: 'SET_PREFERENCES', preferences: prefs });
    await controller.handle({ type: 'PAGE_START', preferences: prefs });
    await vi.waitFor(() => expect(controller.status().completed).toBe(1));
    expect(controller.status().preferences?.provider).toBe('bailian');
    await controller.handle({ type: 'PAGE_STOP' });
    state.services.bailian.configured = false;
    const beginCount = request.mock.calls.filter(([message]) => message.type === 'BEGIN_JOB').length;
    expect(await controller.handle({ type: 'PAGE_START', preferences: prefs })).toMatchObject({ ok: false, error: { code: 'CONFIG' } });
    expect(request.mock.calls.filter(([message]) => message.type === 'BEGIN_JOB')).toHaveLength(beginCount);
    expect(controller.status().selection?.provider).toBe('bailian');
  });

  it('功能关闭取消划词并移除浮球，重新启用可恢复；SITE_CHANGED 使用后台有效状态', async () => {
    await controller.ready;
    state.selectionEnabled = true;
    await controller.handle({ type: 'SITE_CHANGED', enabled: false });
    selectText();
    await vi.waitFor(() => expect(selectionHost()).toBeTruthy());
    state.selectionEnabled = false;
    state.floatingEnabled = false;
    await controller.handle({ type: 'FEATURES_CHANGED' });
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(0);
    state.floatingEnabled = true;
    await controller.handle({ type: 'SITE_CHANGED', enabled: true });
    selectText();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(selectionHost()).toBeNull();
    expect(document.querySelector('[data-yeban-floating]')).toBeTruthy();
    expect(request.mock.calls.some(([message]) => message.type === 'TRANSLATE')).toBe(false);
  });
});

/** jsdom 没有完整 PointerEvent；保留浏览器事件中实际使用的指针字段。 */
function pointer(target: EventTarget, type: string, x: number, y: number, overrides: Partial<PointerEvent> = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button: overrides.button ?? 0 });
  Object.defineProperties(event, {
    pointerId: { value: overrides.pointerId ?? 7 },
    pointerType: { value: overrides.pointerType ?? 'mouse' },
    isPrimary: { value: overrides.isPrimary ?? true },
  });
  target.dispatchEvent(event);
  return event;
}

/** 这里用真实浮球配合内存状态，避免把拖动测试耦合到正文翻译任务。 */
async function dragFixture(): Promise<{ main: HTMLButtonElement; side: HTMLButtonElement; host: HTMLElement; start: ReturnType<typeof vi.fn>; page: PageStatus; capture: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> {
  await controller.ready;
  await controller.suspend();
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
  const page: PageStatus = { state: 'idle', completed: 0, failed: 0, pending: 0, sidePanel: structuredClone(state.sidePanel) };
  const start = vi.fn(async () => ({ ok: true as const, value: page }));
  draggable = new FloatingTranslator(document, {
    start, restore: vi.fn(async () => ({ ok: true as const, value: page })), status: () => page,
    reportError: error => { page.actionError = error; }, updateSidePanel: panel => { page.sidePanel = panel; },
  });
  draggable.setEnabled(true);
  const host = document.querySelector<HTMLElement>('[data-yeban-floating]')!;
  const main = floating()!.querySelector<HTMLButtonElement>('.primary')!;
  const side = floating()!.querySelector<HTMLButtonElement>('.side-panel')!;
  const capture = vi.fn();
  const release = vi.fn();
  for (const button of [main, side]) {
    Object.defineProperty(button, 'setPointerCapture', { configurable: true, value: capture });
    Object.defineProperty(button, 'hasPointerCapture', { configurable: true, value: () => true });
    Object.defineProperty(button, 'releasePointerCapture', { configurable: true, value: release });
  }
  request.mockClear();
  return { main, side, host, start, page, capture, release };
}

describe('浮球上下拖动', () => {
  it('两个按钮都能拖动，移动过程中不保存，松手仅保存一次且紧随 click 不触发动作', async () => {
    const { main, side, host, start, capture, release } = await dragFixture();
    for (const button of [main, side]) {
      const previous = Number.parseFloat(host.style.top);
      pointer(button, 'pointerdown', 500, 300);
      pointer(document, 'pointermove', 500, 325);
      pointer(document, 'pointermove', 500, 360);
      expect(Number.parseFloat(host.style.top)).toBe(previous + 60);
      expect(request).not.toHaveBeenCalled();
      pointer(button, 'pointerup', 500, 360);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, detail: 1 }));
      expect(request.mock.calls.map(([message]) => message.type)).toEqual(['SET_FLOATING_POSITION']);
      expect(request.mock.calls[0][0].position).toBeCloseTo((previous + 60 - 12) / 512);
      expect(start).not.toHaveBeenCalled();
      request.mockClear();
    }
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledWith(7);
    expect(capture.mock.contexts).toEqual([main, side]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('阈值内抖动保留轻点击，侧栏仍在点击调用栈内发出打开消息', async () => {
    const { side, host } = await dragFixture();
    const previous = host.style.top;
    pointer(side, 'pointerdown', 500, 300);
    pointer(document, 'pointermove', 502, 303);
    pointer(side, 'pointerup', 502, 303);
    expect(host.style.top).toBe(previous);
    side.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(request.mock.calls.map(([message]) => message.type)).toEqual(['SET_SIDE_PANEL']);
    expect(request.mock.calls[0][0]).toMatchObject({ open: true, windowId: 1 });
  });

  it('拖动后只抑制本次 click，新的指针点击和键盘点击都能正常触发', async () => {
    const { main, start } = await dragFixture();
    pointer(main, 'pointerdown', 500, 300);
    pointer(document, 'pointermove', 500, 350);
    pointer(main, 'pointerup', 500, 350);
    main.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(start).not.toHaveBeenCalled();
    pointer(main, 'pointerdown', 500, 350);
    pointer(main, 'pointerup', 500, 350);
    main.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(start).toHaveBeenCalledTimes(1);
    pointer(main, 'pointerdown', 500, 350);
    pointer(document, 'pointermove', 500, 390);
    pointer(main, 'pointerup', 500, 390);
    // 键盘产生的 click.detail 为 0；即使还未收到拖动的兼容 click，也不能吞掉它。
    main.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('拖到边缘时保留 12px，resize 按比例定位，超矮视口保持顶部非负', async () => {
    const { main, host } = await dragFixture();
    draggable!.setInitialPosition(0.25);
    expect(host.style.top).toBe('140px');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    window.dispatchEvent(new Event('resize'));
    expect(host.style.top).toBe('240px');
    pointer(main, 'pointerdown', 500, 250);
    pointer(document, 'pointermove', 500, 2000);
    expect(host.style.top).toBe('924px');
    pointer(main, 'pointerup', 500, 2000);
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ type: 'SET_FLOATING_POSITION', position: 1 });
    pointer(main, 'pointerdown', 500, 950);
    pointer(document, 'pointermove', 500, -1000);
    expect(host.style.top).toBe('12px');
    pointer(main, 'pointerup', 500, -1000);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 40 });
    window.dispatchEvent(new Event('resize'));
    expect(host.style.top).toBe('0px');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    window.dispatchEvent(new Event('resize'));
    expect(host.style.top).toBe('12px');
    expect(host.style.right).toBe('12px');
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur'])('%s 取消拖动后恢复原位置、清理选中限制且不保存或误点击', async cancel => {
    const { main, host, start, release } = await dragFixture();
    const original = host.style.top;
    document.documentElement.style.setProperty('user-select', 'text');
    pointer(main, 'pointerdown', 500, 300);
    pointer(document, 'pointermove', 500, 360);
    expect(document.documentElement.style.getPropertyValue('user-select')).toBe('none');
    if (cancel === 'blur') window.dispatchEvent(new Event('blur'));
    else pointer(main, cancel, 500, 360);
    expect(host.style.top).toBe(original);
    expect(document.documentElement.style.getPropertyValue('user-select')).toBe('text');
    pointer(document, 'pointermove', 500, 390);
    pointer(main, 'pointerup', 500, 390);
    main.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(request).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    document.documentElement.style.removeProperty('user-select');
  });

  it('销毁时释放捕获并恢复页面选择样式，残留事件和保存回复都不再作用', async () => {
    const { main, start, release } = await dragFixture();
    pointer(main, 'pointerdown', 500, 300);
    pointer(document, 'pointermove', 500, 360);
    draggable!.destroy();
    expect(document.documentElement.style.getPropertyValue('user-select')).toBe('');
    expect(release).toHaveBeenCalledOnce();
    pointer(document, 'pointerup', 500, 360);
    expect(request).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(document.querySelector('[data-yeban-floating]')).toBeNull();
  });

  it('首次恢复位置后刷新和重复上下文不重置，保存旧回复也不覆盖最新拖动位置', async () => {
    const { main, host } = await dragFixture();
    draggable!.setInitialPosition(0.2);
    const original = host.style.top;
    draggable!.setInitialPosition(0.8);
    draggable!.refresh();
    expect(host.style.top).toBe(original);
    const replies: Array<(reply: unknown) => void> = [];
    request.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    pointer(main, 'pointerdown', 500, 200);
    pointer(document, 'pointermove', 500, 260);
    pointer(main, 'pointerup', 500, 260);
    pointer(main, 'pointerdown', 500, 260);
    pointer(document, 'pointermove', 500, 320);
    pointer(main, 'pointerup', 500, 320);
    const latest = host.style.top;
    replies[1]({ ok: true, value: 0.4 });
    replies[0]({ ok: true, value: 0.2 });
    await Promise.resolve(); await Promise.resolve();
    draggable!.setInitialPosition(0.1);
    draggable!.refresh();
    expect(host.style.top).toBe(latest);
  });

  it('用户先拖动时不接受迟到初始位置，保存失败提示但不移动当前位置', async () => {
    const { main, host, page } = await dragFixture();
    request.mockResolvedValueOnce({ ok: false, error: { code: 'STORAGE', message: '写入失败。', retryable: true } });
    pointer(main, 'pointerdown', 500, 300);
    pointer(document, 'pointermove', 500, 400);
    pointer(main, 'pointerup', 500, 400);
    const latest = host.style.top;
    draggable!.setInitialPosition(0);
    await vi.waitFor(() => expect(page.actionError?.message).toContain('位置暂未保存'));
    expect(host.style.top).toBe(latest);
    expect(page.state).toBe('idle');
  });

  it('旧保存失败在新一轮拖动开始或浮球销毁后返回时，不再显示过期错误', async () => {
    const { main, page } = await dragFixture();
    const replies: Array<(reply: unknown) => void> = [];
    request.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    pointer(main, 'pointerdown', 500, 300);
    pointer(document, 'pointermove', 500, 330);
    pointer(main, 'pointerup', 500, 330);
    pointer(main, 'pointerdown', 500, 330);
    pointer(document, 'pointermove', 500, 360);
    replies[0]({ ok: false, error: { code: 'STORAGE', message: '旧写入失败。', retryable: true } });
    await Promise.resolve(); await Promise.resolve();
    expect(page.actionError).toBeUndefined();
    pointer(main, 'pointerup', 500, 360);
    draggable!.destroy();
    replies[1]({ ok: false, error: { code: 'STORAGE', message: '已关闭的写入失败。', retryable: true } });
    await Promise.resolve(); await Promise.resolve();
    expect(page.actionError).toBeUndefined();
  });

  it('只接收主指针左键，加载或禁用侧栏仍可移动且不改变禁用语义', async () => {
    const { main, side, host, page } = await dragFixture();
    const original = host.style.top;
    for (const overrides of [{ button: 2 }, { isPrimary: false }]) {
      pointer(main, 'pointerdown', 500, 300, overrides);
      pointer(document, 'pointermove', 500, 360, overrides);
      pointer(main, 'pointerup', 500, 360, overrides);
      expect(host.style.top).toBe(original);
    }
    page.sidePanel!.ready = false;
    draggable!.refresh();
    expect(side.disabled).toBe(true);
    pointer(side, 'pointerdown', 500, 300, { pointerType: 'touch' });
    pointer(document, 'pointermove', 500, 360, { pointerType: 'touch', pointerId: 8 });
    expect(host.style.top).toBe(original);
    pointer(document, 'pointermove', 500, 360, { pointerType: 'touch' });
    pointer(side, 'pointerup', 500, 360, { pointerType: 'touch' });
    expect(host.style.top).not.toBe(original);
    expect(side.disabled).toBe(true);
    expect(request.mock.calls.map(([message]) => message.type)).toEqual(['SET_FLOATING_POSITION']);
  });
});
