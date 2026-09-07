// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractParagraphs, OWNED, readParagraphText, splitText } from '../src/content/dom';
import { PageTranslator } from '../src/content/page';

const preferences = { provider: 'bailian' as const, source: 'auto' as const, target: 'zh' as const };
const rect = { top: 10, bottom: 40, left: 10, right: 310, width: 300, height: 30, x: 10, y: 10, toJSON: () => ({}) };
let translator: PageTranslator;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);
  request = vi.fn(async (message: { type: string; text?: string }) => message.type === 'BEGIN_JOB' ? { ok: true, value: { revision: 1 } } : message.type === 'TRANSLATE' ? { ok: true, value: { translated: `译文：${message.text}` } } : { ok: true, value: undefined });
  vi.stubGlobal('chrome', { runtime: { sendMessage: request } });
  translator = new PageTranslator(document);
});
afterEach(async () => { await translator.restore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('正文识别与分片', () => {
  it('按语义所有者读取全页文字，保护编辑区、代码块、隐藏内容和原有链接', () => {
    document.body.innerHTML = '<nav><p>Navigation</p></nav><article><h1>Title</h1><p>Hello <a href="/go">world</a></p><p hidden>Hidden</p><p>Visible <span style="display:none">hidden inline text</span></p><p contenteditable="">Draft</p><p>Unsafe <code>code</code></p><ul><li>Outer<ul><li>Inner</li></ul></li></ul><pre><p>Private code</p></pre></article>';
    expect(extractParagraphs(document).map(readParagraphText)).toEqual(['Navigation', 'Title', 'Hello world', 'Visible', 'Unsafe [[YEBAN_KEEP_0_0]]', 'Outer', 'Inner']);
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/go');
  });

  it('切片不丢字符，不拆 Unicode 代理对，保留长段顺序', () => {
    const original = 'Hello world. '.repeat(300) + '😀'.repeat(1900);
    const chunks = splitText(original);
    expect(chunks.join('')).toBe(original);
    expect(chunks.every(chunk => Array.from(chunk).length <= 1800)).toBe(true);
    expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/u.test(chunk))).toBe(true);
  });
});

describe('网页翻译可观察行为', () => {
  it('全文模式只翻译关闭 details 的摘要，展开前不发送其折叠正文', async () => {
    document.body.innerHTML = '<main><details><summary>Advanced settings</summary><p>Collapsed details body stays local.</p></details><p>Expanded article.</p></main>';
    await translator.start(preferences, 'expanded');
    await vi.waitFor(() => expect(translator.status().completed).toBe(2));
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').map(([message]) => message.text)).toEqual(['Advanced settings', 'Expanded article.']);
    expect(document.querySelector('summary')?.querySelector(`[${OWNED}]`)).toBeTruthy();
    document.querySelector('details')!.open = true;
    await vi.waitFor(() => expect(translator.status().completed).toBe(3));
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').at(-1)?.[0].text).toBe('Collapsed details body stays local.');
  });

  it('全文模式屏外段落也入队但并发最多两个，恢复取消余下内容且迟到结果不回写', async () => {
    document.body.innerHTML = '<main><p>First expanded paragraph.</p><p>Second expanded paragraph.</p><p>Third expanded paragraph.</p><p>Fourth expanded paragraph.</p><p hidden>Hidden text must stay local.</p></main>';
    const releases: Array<(reply: unknown) => void> = [];
    request.mockImplementation((message: { type: string }) => message.type === 'TRANSLATE' ? new Promise(resolve => releases.push(resolve)) : Promise.resolve({ ok: true, value: { revision: 1 } }));
    await translator.start(preferences, 'expanded');
    expect(translator.status()).toMatchObject({ pending: 4, canRestore: true });
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE')).toHaveLength(2);
    await translator.restore();
    releases.forEach(resolve => resolve({ ok: true, value: { translated: '迟到译文' } }));
    await Promise.resolve(); await Promise.resolve();
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE')).toHaveLength(2);
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(0);
    expect(translator.status()).toMatchObject({ state: 'idle', canRestore: false });
  });

  it('完全裁剪的正文和子树不外发，部分裁剪及仅有样式类名的可见文本保留', async () => {
    document.body.innerHTML = '<main><p style="clip-path:inset(100%)">Sensitive fully clipped words.</p><p style="position:absolute;clip:rect(0px,0px,0px,0px);width:1px;height:1px;overflow:hidden">Sensitive screen reader words.</p><div style="clip-path:inset(50%)"><p>Sensitive ancestor clipped words.</p></div><p style="clip-path:inset(10%)">Partly visible text.</p><p style="clip:rect(0px,0px,0px,0px)">Clip is ineffective in normal flow.</p><p class="sr-only">Visible despite class.</p><p>Visible <span style="clip-path:inset(100%)">Sensitive clipped inline words.</span> text.</p></main>';
    expect(extractParagraphs(document).map(readParagraphText)).toEqual(['Partly visible text.', 'Clip is ineffective in normal flow.', 'Visible despite class.', 'Visible text.']);
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(4));
    const sent = request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').map(([message]) => message.text).join('\n');
    expect(sent).not.toContain('Sensitive');
  });

  it('全页识别带图标标题、表格说明、导航与父列表自身文字，保留表格和嵌套列表结构', async () => {
    document.body.innerHTML = '<nav><ul><li><label>State backends</label><ul><li><a href="/child">Managed state</a></li></ul></li></ul><a href="/standalone">Documentation home</a></nav><main><h1>Checkpointing <a aria-hidden="true" href="#"><svg><title>Hidden anchor</title></svg></a></h1><table><tbody><tr><th>Configuration</th><th>Description</th></tr><tr><td><code>state.backend.type</code></td><td>The backend stores state.</td></tr></tbody></table><p>Restore <code>UnionListState</code> across all operators.</p></main><aside><label>Related documentation</label></aside>';
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(9));
    const sent = request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').map(([message]) => message.text).join('\n');
    expect(sent).toContain('Checkpointing');
    expect(sent).toContain('The backend stores state.');
    expect(sent).toContain('State backends');
    expect(sent).toContain('Managed state');
    expect(sent).toContain('Documentation home');
    expect(sent).toContain('Related documentation');
    expect(sent).not.toContain('Hidden anchor');
    expect(sent).not.toContain('state.backend.type');
    expect(sent).not.toContain('UnionListState');
    expect(document.querySelectorAll(`tr > [${OWNED}]`)).toHaveLength(0);
    expect(document.querySelector('td:last-child')?.querySelector(`[${OWNED}]`)).toBeTruthy();
    const parentList = document.querySelector('nav > ul > li')!;
    expect(parentList.querySelector('ul')?.previousElementSibling?.hasAttribute(OWNED)).toBe(true);
    expect(document.querySelector('a[href="/child"]')?.textContent).toBe('Managed state');
  });

  it('行内隐藏子树与 SVG 不外发，也不导致可见正文整体漏译', async () => {
    document.body.innerHTML = '<main><h2>State APIs<svg><text>DO_NOT_SEND_SVG</text></svg></h2><p>Visible <span style="display:none">DO_NOT_SEND_HIDDEN</span> documentation.</p></main>';
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(2));
    const sent = request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').map(([message]) => message.text);
    expect(sent).toEqual(['State APIs', 'Visible documentation.']);
  });

  it('兼容 Flink 的透明标题锚点、折叠导航标签与表格配置名', async () => {
    document.body.innerHTML = '<nav><label for="menu" class="flex justify-between"><div style="font-weight:600"><i aria-hidden="true">DO_NOT_SEND_ICON</i>&nbsp;&nbsp;Try Flink</div><span>▾</span></label><input id="menu" type="checkbox"></nav><main><h3>How does state work?<a class="anchor" href="#state" style="opacity:0">#</a></h3><p>Read <code>ListState</code>, <code>UnionListState</code> and <code>MapState</code> safely.</p><table><tbody><tr><td><h5>state.backend.type</h5></td><td>Memory backend</td><td>Default behavior</td><td>Controls state storage.</td></tr></tbody></table></main>';
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(6));
    const sent = request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').map(([message]) => message.text).join('\n');
    expect(sent).toContain('Try Flink');
    expect(sent).toContain('How does state work?');
    expect(sent).toContain('Memory backend');
    expect(sent).not.toContain('DO_NOT_SEND_ICON');
    expect(sent).not.toContain('#');
    expect(sent).not.toContain('state.backend.type');
    expect(sent).not.toContain('UnionListState');
    expect(document.querySelector('label')?.getAttribute('for')).toBe('menu');
    expect(document.querySelector('h3 a')?.getAttribute('href')).toBe('#state');
    expect(document.querySelectorAll(`tr > [${OWNED}]`)).toHaveLength(0);
  });

  it('行内代码占位符还原字面值，损坏的占位符失败且不能成为成功缓存', async () => {
    document.body.innerHTML = '<main><p>Use <code>UnionListState</code> safely.</p></main>';
    const shadows = new WeakMap<Element, ShadowRoot>();
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) { const shadow = attach.call(this, init); shadows.set(this, shadow); return shadow; });
    let breakPlaceholder = true;
    request.mockImplementation(async (message: { type: string; text?: string }) => {
      if (message.type === 'BEGIN_JOB') return { ok: true, value: { revision: 1 } };
      return { ok: true, value: { translated: breakPlaceholder ? '错误译文没有保留占位符' : message.text } };
    });
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().failed).toBe(1));
    expect(document.querySelector(`[${OWNED}]`)).toBeNull();
    breakPlaceholder = false;
    await translator.retry();
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    const host = document.querySelector(`[${OWNED}]`)!;
    expect(shadows.get(host)?.textContent).toContain('Use UnionListState safely.');
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE')).toHaveLength(2);
  });

  it('行内代码改变后丢弃旧响应，不能把旧字面值挂到新正文', async () => {
    document.body.innerHTML = '<main><p>Use <code>UnionListState</code> safely.</p></main>';
    let finish!: (reply: unknown) => void;
    request.mockImplementation((message: { type: string }) => message.type === 'TRANSLATE' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: { revision: 1 } }));
    await translator.start(preferences);
    const sent = request.mock.calls.find(([message]) => message.type === 'TRANSLATE')![0].text;
    document.querySelector('code')!.textContent = 'ListState';
    finish({ ok: true, value: { translated: sent } });
    await vi.waitFor(() => expect(translator.status().failed).toBe(1));
    expect(document.querySelector(`[${OWNED}]`)).toBeNull();
  });

  it('长段切片不拆开行内代码占位符，所有片段成功后才展示译文', async () => {
    document.body.innerHTML = `<main><p>${'a '.repeat(699)}<code>UnionListState</code> ${'text '.repeat(350)}</p></main>`;
    request.mockImplementation(async (message: { type: string; text?: string }) => message.type === 'BEGIN_JOB' ? { ok: true, value: { revision: 1 } } : { ok: true, value: { translated: message.text } });
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    const chunks = request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').map(([message]) => message.text as string);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => Array.from(chunk).length <= 1400)).toBe(true);
    expect(chunks.filter(chunk => chunk.includes('[[YEBAN_KEEP_0_0]]'))).toHaveLength(1);
    expect(chunks.join('')).not.toContain('UnionListState');
  });

  it('标题和段落内 BR 保留词间空白，统一快照校验后正常回写', async () => {
    document.body.innerHTML = '<article><h1>Hello<br>world</h1><p>Hello<br>world</p></article>';
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(2));
    const translations = request.mock.calls.filter(([message]) => message.type === 'TRANSLATE');
    expect(translations).toHaveLength(1);
    expect(translations[0][0].text).toBe('Hello world');
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(2);
    expect(document.querySelectorAll('br')).toHaveLength(2);
  });

  it('相同段落合并请求，重新开始复用缓存并保持原文', async () => {
    document.body.innerHTML = '<article><p>Hello world.</p><p>Hello world.</p></article>';
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(2));
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE')).toHaveLength(1);
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(2);
    expect(document.querySelectorAll('p')[0].textContent).toBe('Hello world.');
    expect(translator.status().message).toContain('当前可见');
    expect(translator.status().preferences).toEqual(preferences);
    await translator.restore();
    expect(translator.status().preferences).toBeUndefined();
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(2));
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE')).toHaveLength(1);
  });

  it('停止和恢复后丢弃迟到响应，不重新插入译文', async () => {
    document.body.innerHTML = '<article><p>Hello world.</p></article>';
    let finish!: (value: unknown) => void;
    request.mockImplementation((message: { type: string }) => message.type === 'TRANSLATE' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: { revision: 1 } }));
    await translator.start(preferences);
    expect(translator.status().pending).toBe(1);
    await translator.restore();
    finish({ ok: true, value: { translated: '迟到译文' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(0);
    expect(translator.status().state).toBe('idle');
    expect(request.mock.calls.some(([message]) => message.type === 'CANCEL_JOB' && message.mode === 'page')).toBe(true);
  });

  it('网页原文变化时不把旧译文挂在新段落后', async () => {
    document.body.innerHTML = '<article><p>Hello world.</p></article>';
    let finish!: (value: unknown) => void;
    request.mockImplementation((message: { type: string }) => message.type === 'TRANSLATE' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, value: { revision: 1 } }));
    await translator.start(preferences);
    document.querySelector('p')!.textContent = 'Changed content.';
    finish({ ok: true, value: { translated: '旧译文' } });
    await vi.waitFor(() => expect(translator.status().failed).toBe(1));
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(0);
  });

  it('配置版本变化隔离缓存，恢复后使用新版本重新请求', async () => {
    document.body.innerHTML = '<article><p>Hello world.</p></article>';
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    await translator.restore();
    request.mockImplementation(async (message: { type: string; text?: string }) => message.type === 'BEGIN_JOB' ? { ok: true, value: { revision: 2 } } : { ok: true, value: { translated: message.text } });
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE')).toHaveLength(2);
  });

  it('只翻译进入视口的段落，不后台提交整篇文章', async () => {
    document.body.innerHTML = '<article><p>Visible article.</p><p>Far away article.</p></article>';
    const paragraphs = document.querySelectorAll('p');
    Object.defineProperty(paragraphs[1], 'getBoundingClientRect', { configurable: true, value: () => ({ ...rect, top: 4000, bottom: 4040 }) });
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().completed).toBe(1));
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE')).toHaveLength(1);
    expect(translator.status().state).toBe('waiting');
  });

  it('失败重试只提交失败段落，成功译文保留', async () => {
    document.body.innerHTML = '<article><p>Successful article.</p><p>Failing article.</p></article>';
    let shouldFail = true;
    request.mockImplementation(async (message: { type: string; text?: string }) => {
      if (message.type === 'BEGIN_JOB') return { ok: true, value: { revision: 1 } };
      if (message.type === 'TRANSLATE' && message.text === 'Failing article.' && shouldFail) return { ok: false, error: { code: 'NETWORK', message: '网络暂时不可用。', retryable: true } };
      return { ok: true, value: { translated: '成功译文' } };
    });
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status()).toMatchObject({ completed: 1, failed: 1, state: 'partial' }));
    shouldFail = false;
    await translator.retry();
    await vi.waitFor(() => expect(translator.status()).toMatchObject({ completed: 2, failed: 0 }));
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE' && message.text === 'Successful article.')).toHaveLength(1);
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(2);
  });

  it('首屏失败重试恢复视口观察，随后滚动继续翻译未处理正文且不重发成功段', async () => {
    document.body.innerHTML = '<main><p>Successful first paragraph.</p><p>Retry this paragraph.</p><p>Lower unread paragraph.</p></main>';
    const instances: TestObserver[] = [];
    class TestObserver {
      readonly targets = new Set<Element>();
      constructor(private readonly callback: IntersectionObserverCallback) { instances.push(this); }
      observe(target: Element): void { this.targets.add(target); }
      unobserve(target: Element): void { this.targets.delete(target); }
      disconnect(): void { this.targets.clear(); }
      enter(target: Element): void { if (this.targets.has(target)) this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    }
    vi.stubGlobal('IntersectionObserver', TestObserver);
    const lower = document.querySelectorAll('p')[2];
    let lowerVisible = false;
    Object.defineProperty(lower, 'getBoundingClientRect', { configurable: true, value: () => lowerVisible ? rect : ({ ...rect, top: 4000, bottom: 4040 }) });
    let shouldFail = true;
    request.mockImplementation(async (message: { type: string; text?: string }) => {
      if (message.type === 'BEGIN_JOB') return { ok: true, value: { revision: 1 } };
      if (message.type === 'TRANSLATE' && message.text === 'Retry this paragraph.' && shouldFail) return { ok: false, error: { code: 'NETWORK', message: '暂时失败', retryable: true } };
      return { ok: true, value: { translated: '成功译文' } };
    });
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status()).toMatchObject({ completed: 1, failed: 1 }));
    shouldFail = false;
    await translator.retry();
    await vi.waitFor(() => expect(translator.status()).toMatchObject({ completed: 2, failed: 0 }));
    expect(instances).toHaveLength(2);
    lowerVisible = true;
    instances[1].enter(lower);
    await vi.waitFor(() => expect(translator.status().completed).toBe(3));
    const sent = request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').map(([message]) => message.text);
    expect(sent.filter(text => text === 'Successful first paragraph.')).toHaveLength(1);
    expect(sent.filter(text => text === 'Retry this paragraph.')).toHaveLength(2);
    expect(sent.filter(text => text === 'Lower unread paragraph.')).toHaveLength(1);
  });

  it('鉴权失败后手动停止返回 stopped，保留成功译文且能换服务重新开始', async () => {
    document.body.innerHTML = '<main><p>Successful first paragraph.</p><p>Authentication failure.</p></main>';
    let shouldFail = true;
    request.mockImplementation(async (message: { type: string; text?: string }) => {
      if (message.type === 'BEGIN_JOB') return { ok: true, value: { revision: 1 } };
      if (message.type === 'TRANSLATE' && message.text === 'Authentication failure.' && shouldFail) return { ok: false, error: { code: 'AUTH', message: '服务鉴权失败。', retryable: false } };
      return { ok: true, value: { translated: '成功译文' } };
    });
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status()).toMatchObject({ completed: 1, failed: 1, state: 'partial' }));
    expect(await translator.stop()).toMatchObject({ state: 'stopped', completed: 1, failed: 1, pending: 0 });
    expect(document.querySelectorAll(`[${OWNED}]`)).toHaveLength(1);
    shouldFail = false;
    await translator.start({ ...preferences, provider: 'aliyun' });
    await vi.waitFor(() => expect(translator.status().completed).toBe(2));
    expect(request.mock.calls.filter(([message]) => message.type === 'BEGIN_JOB').at(-1)?.[0].preferences.provider).toBe('aliyun');
  });

  it('额度错误停止后续队列，不自动重试或换供应商', async () => {
    document.body.innerHTML = '<article><p>One article.</p><p>Two article.</p><p>Three article.</p><p>Four article.</p></article>';
    request.mockImplementation(async (message: { type: string }) => message.type === 'BEGIN_JOB' ? { ok: true, value: { revision: 1 } } : message.type === 'TRANSLATE' ? { ok: false, error: { code: 'QUOTA', message: '服务额度不足。', retryable: false } } : { ok: true, value: undefined });
    await translator.start(preferences);
    await vi.waitFor(() => expect(translator.status().message).toBe('服务额度不足。'));
    expect(request.mock.calls.filter(([message]) => message.type === 'TRANSLATE').length).toBeLessThanOrEqual(2);
    expect(translator.status().pending).toBe(0);
    expect(request.mock.calls.filter(([message]) => message.type === 'BEGIN_JOB')).toHaveLength(1);
  });
});
