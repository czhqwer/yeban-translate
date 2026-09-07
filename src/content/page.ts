import { send, type AppError, type PageStatus, type Preferences, type ProviderId, type Reply } from '../shared/types';
import { createHost, extractParagraphs, insertParagraphTranslation, isInViewport, isSameLanguage, OWNED, readParagraphSnapshot, restoreParagraphLiterals, splitText, type ParagraphFormat, type ParagraphSnapshot } from './dom';
import { htmlLanguage } from '../shared/languages';

type ParagraphState = 'new' | 'queued' | 'active' | 'done' | 'failed' | 'skipped';
interface Paragraph { node: HTMLElement; snapshot: ParagraphSnapshot; state: ParagraphState; translation?: HTMLElement }
interface Job {
  id: string; generation: number; preferences: Preferences; revision: number; url: string; active: boolean;
  scope: 'viewport' | 'expanded';
  paragraphs: Paragraph[]; queue: Paragraph[]; inflight: Map<string, Promise<Reply<{ translated: string }>>>;
  running: number; observer?: IntersectionObserver; error?: AppError; ready: boolean; manuallyStopped?: boolean;
  byNode: Map<HTMLElement, Paragraph>; discoveryRoots: Set<Element>; discoveryObserver?: MutationObserver;
  discoveryTimer?: ReturnType<typeof setTimeout>; removeDiscoveryListeners?: () => void; discovered: number; discoveryLimited?: boolean;
}
const BLOCKING_ERRORS = new Set(['AUTH', 'QUOTA', 'CONFIG', 'CONSENT', 'RATE_LIMIT', 'COOLDOWN', 'SERVICE_REMOVED', 'PERMISSION', 'STALE_JOB', 'CANCELED', 'DISCONNECTED']);
const MENU_ROOTS = 'nav,aside,[role="navigation"],[role="tree"],[role="menu"],details';
const DISCOVERY_DELAY = 100;
const MAX_DISCOVERY_ROOTS = 8;
const MAX_DISCOVERED_PARAGRAPHS = 1000;
const TEXT_STYLE_PROPERTIES = [
  'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant',
  'font-feature-settings', 'font-kerning', 'font-optical-sizing', 'font-variation-settings', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-decoration', 'text-indent', 'text-transform',
  'text-shadow', 'text-rendering', 'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'tab-size',
  'direction', 'writing-mode', 'text-orientation'
] as const;
const MARGIN_PROPERTIES = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'] as const;
const BOX_STYLE_PROPERTIES = [
  'background-color', 'border-top-color', 'border-top-style', 'border-top-width', 'border-right-color',
  'border-right-style', 'border-right-width', 'border-bottom-color', 'border-bottom-style', 'border-bottom-width',
  'border-left-color', 'border-left-style', 'border-left-width', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'box-shadow'
] as const;
const FORMAT_MARKER = /\[\[YEBAN_FMT_\d+_\d+_(?:OPEN|CLOSE)\]\]/gu;
const SAFE_FORMAT_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'del', 'em', 'i', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var']);

interface OriginalTextStyle { text: Array<[string, string]>; box: Array<[string, string]>; margins: Array<[string, string]> }

/** 固定原节点最终排版快照，避免译文插入后相邻选择器改变取值。 */
function originalTextStyle(node: HTMLElement): OriginalTextStyle {
  const computed = node.ownerDocument.defaultView?.getComputedStyle(node);
  if (!computed) return { text: [], box: [], margins: [] };
  const values = (properties: readonly string[]): Array<[string, string]> => properties
    .map(property => [property, computed.getPropertyValue(property)] as [string, string])
    .filter(([, value]) => Boolean(value));
  return { text: values(TEXT_STYLE_PROPERTIES), box: values(BOX_STYLE_PROPERTIES), margins: values(MARGIN_PROPERTIES) };
}

/** 只降低文字颜色的不透明度，深浅背景都会自然向底色靠拢。 */
function softenedTextColor(value: string): string {
  if (!/^rgba?\(/iu.test(value.trim())) return value;
  const components = value.match(/[\d.]+/gu)?.map(Number);
  if (!components || components.length < 3 || components.slice(0, 3).some(component => !Number.isFinite(component))) return value;
  const [red, green, blue, originalAlpha = 1] = components;
  const alpha = Math.max(0, Math.min(1, originalAlpha * 0.62));
  return `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(3))})`;
}

function applyStyles(styles: Array<[string, string]>, target: HTMLElement, softenColor = false): void {
  for (const [property, value] of styles) target.style.setProperty(property, softenColor && property === 'color' ? softenedTextColor(value) : value, 'important');
}

function applyOriginalTextStyle(style: OriginalTextStyle, target: HTMLElement): void {
  applyStyles(style.text, target, true);
  applyStyles(style.box, target);
}

function safeLink(raw: string | undefined, doc: Document): string | undefined {
  if (!raw) return;
  try {
    const value = new URL(raw, doc.URL);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(value.protocol) ? value.href : undefined;
  } catch { return; }
}

function formatNode(doc: Document, format: ParagraphFormat): HTMLElement {
  const tag = SAFE_FORMAT_TAGS.has(format.tag) ? format.tag : 'span';
  const link = tag === 'a' ? safeLink(format.href, doc) : undefined;
  const node = doc.createElement(tag === 'a' && !link ? 'span' : tag);
  if (link && node instanceof HTMLAnchorElement) {
    node.href = link;
    node.rel = 'noopener noreferrer';
  }
  if (format.title) node.title = format.title;
  applyStyles(format.styles, node, true);
  return node;
}

/** 只按预先生成且严格配对的内部标记重建安全节点，不解析服务返回的 HTML。 */
function renderRichTranslation(doc: Document, snapshot: ParagraphSnapshot, translated: string, target: HTMLElement): boolean {
  if (!snapshot.formats.length) { target.textContent = translated; return true; }
  const expected = new Map<string, { format: ParagraphFormat; edge: 'open' | 'close'; index: number }>();
  snapshot.formats.forEach((format, index) => {
    expected.set(format.open, { format, edge: 'open', index });
    expected.set(format.close, { format, edge: 'close', index });
  });
  const seen = new Set<string>();
  const stack: Array<{ node: HTMLElement; index?: number }> = [{ node: target }];
  let offset = 0;
  for (const match of translated.matchAll(FORMAT_MARKER)) {
    const token = match[0];
    const marker = expected.get(token);
    if (!marker || seen.has(token)) return false;
    stack.at(-1)!.node.append(doc.createTextNode(translated.slice(offset, match.index)));
    seen.add(token);
    if (marker.edge === 'open') {
      const node = formatNode(doc, marker.format);
      stack.at(-1)!.node.append(node);
      stack.push({ node, index: marker.index });
    } else {
      if (stack.length === 1 || stack.at(-1)!.index !== marker.index) return false;
      stack.pop();
    }
    offset = match.index + token.length;
  }
  if (stack.length !== 1 || seen.size !== expected.size || translated.slice(offset).includes('[[YEBAN_FMT_')) return false;
  target.append(doc.createTextNode(translated.slice(offset)));
  return true;
}

/** 网页翻译独立管理代次、视口队列和本页缓存。 */
export class PageTranslator {
  private generation = 0;
  private job?: Job;
  private cache = new Map<string, string>();
  private translations = new Set<HTMLElement>();
  private translationCleanup = new Map<HTMLElement, () => void>();
  private idleStatus: PageStatus = { state: 'idle', completed: 0, failed: 0, pending: 0 };
  constructor(private readonly doc: Document) {}

  /** 运行或等待滚动期间保持正文快照，修改本页选项需先停止任务。 */
  isActive(): boolean { return this.job?.active === true && this.job.url === this.doc.URL; }

  /** 已启动的任务或保留的译文都可以恢复原文。 */
  canRestore(): boolean { return this.isActive() || this.translations.size > 0; }

  /** 固定当次设置，运行中相同操作保持幂等。 */
  async start(preferences: Preferences, scope: 'viewport' | 'expanded' = 'viewport'): Promise<PageStatus> {
    if (this.job?.active && this.job.url === this.doc.URL && this.job.scope === scope && JSON.stringify(this.job.preferences) === JSON.stringify(preferences)) return this.status();
    const generation = ++this.generation;
    await this.cancelCurrent();
    if (generation !== this.generation) return this.status();
    this.clearTranslations();
    const job = this.createJob(preferences, generation, extractParagraphs(this.doc).map(node => ({ node, snapshot: readParagraphSnapshot(node), state: 'new' })), scope);
    this.job = job;
    if (!job.paragraphs.length) {
      job.active = false;
      this.idleStatus = { state: 'unavailable', completed: 0, failed: 0, pending: 0, message: '当前页面没有可翻译的正文。' };
      this.job = undefined;
      return this.status();
    }
    for (const paragraph of job.paragraphs) if (isSameLanguage(paragraph.snapshot.naturalText, preferences.target) || (preferences.source !== 'auto' && preferences.source === preferences.target)) paragraph.state = 'skipped';
    if (job.paragraphs.every(paragraph => paragraph.state === 'skipped')) {
      job.active = false;
      this.idleStatus = { state: 'unavailable', completed: 0, failed: 0, pending: 0, message: '正文已是目标语言，无需翻译。' };
      this.job = undefined;
      return this.status();
    }
    const reply = await send<{ revision: number }>({ type: 'BEGIN_JOB', mode: 'page', jobId: job.id, preferences: job.preferences });
    if (!this.isCurrent(job)) return this.status();
    if (!reply.ok) { job.active = false; job.error = reply.error; return this.status(); }
    job.revision = reply.value.revision;
    job.ready = true;
    this.observe(job);
    return this.status();
  }

  /** 停止先使页面代次失效，再等待后台撤销已排队请求。 */
  async stop(): Promise<PageStatus> {
    ++this.generation;
    if (this.job) this.job.manuallyStopped = true;
    await this.cancelCurrent();
    return this.status();
  }

  /** 恢复仅清理扩展节点，不改写原网页内容。 */
  async restore(): Promise<PageStatus> {
    await this.stop();
    this.clearTranslations();
    this.job = undefined;
    this.idleStatus = { state: 'idle', completed: 0, failed: 0, pending: 0 };
    return this.status();
  }

  /** 重试只接收失败段落；配置版本变化需明确重新开始。 */
  async retry(): Promise<PageStatus> {
    const previous = this.job;
    if (!previous || previous.running || !previous.paragraphs.some(item => item.state === 'failed')) return this.status();
    const generation = ++this.generation;
    await this.cancelCurrent();
    if (generation !== this.generation) return this.status();
    const job = this.createJob(previous.preferences, generation, previous.paragraphs, previous.scope);
    this.job = job;
    const reply = await send<{ revision: number }>({ type: 'BEGIN_JOB', mode: 'page', jobId: job.id, preferences: job.preferences });
    if (!this.isCurrent(job)) return this.status();
    if (!reply.ok) { job.active = false; job.error = reply.error; return this.status(); }
    if (previous.revision !== reply.value.revision) {
      job.error = { code: 'CONFIG', message: '服务配置已更改，请点击翻译此页重新开始。', retryable: false };
      await this.cancelCurrent();
      return this.status();
    }
    job.revision = reply.value.revision;
    job.ready = true;
    for (const paragraph of job.paragraphs) {
      if (paragraph.state === 'failed') paragraph.state = 'new';
    }
    // 新代次同时恢复尚未读到的段落观察，已成功段落仍保持 done，不重新请求。
    this.observe(job);
    return this.status();
  }

  /** 删除服务后，保留成功译文但停止该服务所有新增正文请求。 */
  async serviceRemoved(provider: ProviderId): Promise<void> {
    if (this.job?.preferences.provider !== provider) return;
    this.job.error = { code: 'SERVICE_REMOVED', message: '翻译服务配置已删除，请重新配置。', retryable: false };
    await this.stop();
  }

  /** 状态只说明当前已处理内容，不将视口完成冒充整页完成。 */
  status(): PageStatus {
    const job = this.job;
    if (!job) return { ...this.idleStatus, canRestore: false };
    return { ...this.jobStatus(job), preferences: { ...job.preferences }, canRestore: this.canRestore() };
  }

  private jobStatus(job: Job): PageStatus {
    if (job.active && job.url !== this.doc.URL) {
      ++this.generation;
      job.error = { code: 'PAGE_CHANGED', message: '页面地址已变化，请重新开始翻译。', retryable: true };
      void this.cancelCurrent();
    }
    const completed = job.paragraphs.filter(p => p.state === 'done').length;
    const failed = job.paragraphs.filter(p => p.state === 'failed').length;
    const pending = job.active ? job.paragraphs.filter(p => p.state === 'queued' || p.state === 'active').length : 0;
    if (job.manuallyStopped) return { state: 'stopped', completed, failed, pending: 0, message: job.error ? `已停止。${job.error.message}` : '已停止；已提交的请求仍可能产生用量。' };
    if (job.error) return { state: failed ? 'partial' : 'unavailable', completed, failed, pending, message: job.error.message };
    if (!job.active) return { state: 'stopped', completed, failed, pending: 0, message: '已停止；已提交的请求仍可能产生用量。' };
    if (pending || !job.ready) return { state: 'running', completed, failed, pending, message: job.scope === 'expanded' ? '正在翻译当前已展开的全文…' : '正在翻译当前可见内容…' };
    if (failed) return { state: 'partial', completed, failed, pending: 0, message: '部分段落翻译失败，可重试失败段落。' };
    if (job.discoveryLimited) return { state: 'waiting', completed, failed, pending: 0, message: '页面新增内容较多，请停止后重新开始翻译。' };
    return { state: 'waiting', completed, failed, pending: 0, message: job.scope === 'expanded' ? '当前已展开内容已翻译；展开其他菜单后会继续翻译。' : '当前可见内容已翻译，滚动后继续处理新段落。' };
  }

  private createJob(preferences: Preferences, generation: number, paragraphs: Paragraph[], scope: 'viewport' | 'expanded'): Job {
    return { id: crypto.randomUUID(), generation, preferences: { ...preferences }, scope, revision: 0, url: this.doc.URL, active: true, paragraphs, byNode: new Map(paragraphs.map(paragraph => [paragraph.node, paragraph])), queue: [], inflight: new Map(), running: 0, ready: false, discoveryRoots: new Set(), discovered: 0 };
  }

  private isCurrent(job: Job): boolean { return this.job === job && job.active && job.generation === this.generation && this.doc.URL === job.url; }

  private async cancelCurrent(): Promise<void> {
    const job = this.job;
    if (!job) return;
    job.active = false;
    job.observer?.disconnect();
    job.discoveryObserver?.disconnect();
    job.removeDiscoveryListeners?.();
    if (job.discoveryTimer) clearTimeout(job.discoveryTimer);
    job.discoveryTimer = undefined;
    job.discoveryRoots.clear();
    job.queue.length = 0;
    job.inflight.clear();
    for (const paragraph of job.paragraphs) if (paragraph.state === 'queued' || paragraph.state === 'active') paragraph.state = 'new';
    await send({ type: 'CANCEL_JOB', mode: 'page', jobId: job.id });
  }

  private clearTranslations(): void {
    for (const node of this.translations) { this.translationCleanup.get(node)?.(); node.remove(); }
    this.translationCleanup.clear();
    this.translations.clear();
  }

  private observe(job: Job): void {
    if (job.scope === 'viewport' && typeof IntersectionObserver !== 'undefined') {
      job.observer = new IntersectionObserver(entries => {
        if (!this.isCurrent(job)) return;
        for (const entry of entries) if (entry.isIntersecting) {
          const paragraph = job.paragraphs.find(item => item.node === entry.target);
          if (paragraph) this.enqueue(job, paragraph);
        }
      }, { rootMargin: '0px', threshold: 0 });
      for (const paragraph of job.paragraphs) if (paragraph.state === 'new') job.observer.observe(paragraph.node);
    }
    this.watchMenus(job);
    for (const paragraph of job.paragraphs) if (job.scope === 'expanded' || isInViewport(paragraph.node)) this.enqueue(job, paragraph);
  }

  /** 只在活动任务中监听菜单展开；不轮询整页，也不将翻译节点当作网页新增内容。 */
  private watchMenus(job: Job): void {
    const owned = (node: Node): boolean => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
      return !!element?.closest(`[${OWNED}]`);
    };
    const queue = (element: Element, includeDescendantMenus = false): void => {
      if (!this.isCurrent(job) || owned(element)) return;
      const root = element.closest(MENU_ROOTS) ?? element.closest('ul,ol');
      const roots = root ? [root] : includeDescendantMenus ? [...element.querySelectorAll(MENU_ROOTS)] : [];
      for (const candidate of roots) {
        if (!candidate.isConnected || [...job.discoveryRoots].some(existing => existing.contains(candidate))) continue;
        for (const existing of job.discoveryRoots) if (candidate.contains(existing)) job.discoveryRoots.delete(existing);
        if (job.discoveryRoots.size < MAX_DISCOVERY_ROOTS) job.discoveryRoots.add(candidate);
      }
      if (!job.discoveryRoots.size) return;
      if (job.discoveryTimer) clearTimeout(job.discoveryTimer);
      job.discoveryTimer = setTimeout(() => { job.discoveryTimer = undefined; this.discoverMenus(job); }, DISCOVERY_DELAY);
    };
    const onExpand = (event: Event): void => {
      if (event.composedPath().some(node => node instanceof Element && node.hasAttribute(OWNED))) return;
      const element = event.target instanceof Element ? event.target : null;
      if (element) queue(element);
    };
    for (const type of ['change', 'toggle', 'click']) this.doc.addEventListener(type, onExpand, true);
    job.removeDiscoveryListeners = () => { for (const type of ['change', 'toggle', 'click']) this.doc.removeEventListener(type, onExpand, true); };
    if (typeof MutationObserver === 'undefined' || !this.doc.body) return;
    job.discoveryObserver = new MutationObserver(records => {
      if (!this.isCurrent(job)) return;
      for (const record of records) {
        if (owned(record.target)) continue;
        const changed = [...record.addedNodes, ...record.removedNodes];
        if (record.type === 'childList' && changed.length && changed.every(owned)) continue;
        if (record.target instanceof Element) queue(record.target, record.type === 'attributes');
        for (const added of record.addedNodes) if (added instanceof Element && !owned(added)) queue(added, true);
      }
    });
    job.discoveryObserver.observe(this.doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-expanded', 'open'] });
    // 启动准备或停止期间可能已展开菜单；恢复观察时补一次菜单范围发现。
    for (const root of [...this.doc.querySelectorAll(MENU_ROOTS)].slice(0, MAX_DISCOVERY_ROOTS)) queue(root);
  }

  /** 发现范围限定为本批菜单容器，新增块仍只在进入视口后请求。 */
  private discoverMenus(job: Job): void {
    if (!this.isCurrent(job)) return;
    const roots = [...job.discoveryRoots];
    job.discoveryRoots.clear();
    for (const root of roots) {
      if (!root.isConnected) continue;
      for (const node of extractParagraphs(this.doc, root)) {
        const snapshot = readParagraphSnapshot(node);
        const previous = job.byNode.get(node);
        if (previous?.snapshot.signature === snapshot.signature) {
          if (previous.state === 'new' && (job.scope === 'expanded' || isInViewport(node))) this.enqueue(job, previous);
          continue;
        }
        if (job.discovered >= MAX_DISCOVERED_PARAGRAPHS) { job.discoveryLimited = true; return; }
        if (previous) {
          // 新原文使用新记录和请求标识；旧响应即使迟到也不能回写到新记录。
          previous.state = 'skipped';
          if (previous.translation) {
            this.translationCleanup.get(previous.translation)?.();
            this.translationCleanup.delete(previous.translation);
            previous.translation.remove();
            this.translations.delete(previous.translation);
          }
          job.queue = job.queue.filter(paragraph => paragraph !== previous);
          job.observer?.unobserve(node);
        }
        const sameLanguage = isSameLanguage(snapshot.naturalText, job.preferences.target) || job.preferences.source === job.preferences.target;
        const paragraph: Paragraph = { node, snapshot, state: sameLanguage ? 'skipped' : 'new' };
        job.byNode.set(node, paragraph);
        job.paragraphs.push(paragraph);
        job.discovered++;
        if (paragraph.state === 'new') {
          job.observer?.observe(node);
          if (job.scope === 'expanded' || isInViewport(node)) this.enqueue(job, paragraph);
        }
      }
    }
  }

  private enqueue(job: Job, paragraph: Paragraph): void {
    if (!this.isCurrent(job) || paragraph.state !== 'new') return;
    paragraph.state = 'queued';
    job.queue.push(paragraph);
    this.pump(job);
  }

  private pump(job: Job): void {
    while (this.isCurrent(job) && job.running < 2 && job.queue.length) {
      const paragraph = job.queue.shift()!;
      // 队列等待期间滚出视口的段落恢复为待观察，避免快速滚动触发整篇付费翻译。
      if (job.observer && !isInViewport(paragraph.node)) { paragraph.state = 'new'; continue; }
      paragraph.state = 'active';
      job.running++;
      void this.translateParagraph(job, paragraph).finally(() => { job.running--; if (this.isCurrent(job)) this.pump(job); });
    }
  }

  private async translateParagraph(job: Job, paragraph: Paragraph): Promise<void> {
    const result: string[] = [];
    const completedChunks: Array<[string, string]> = [];
    // 留出后台分片余量，避免服务适配器再次切断行内代码占位符。
    for (const [index, chunk] of splitText(paragraph.snapshot.text, 1400).entries()) {
      if (!this.validParagraph(job, paragraph)) return;
      const key = JSON.stringify(['page', job.preferences, job.revision, paragraph.snapshot.signature, chunk]);
      let reply: Reply<{ translated: string }>;
      const cached = this.cache.get(key);
      if (cached !== undefined) reply = { ok: true, value: { translated: cached } };
      else {
        let request = job.inflight.get(key);
        if (!request) {
          request = send<{ translated: string }>({ type: 'TRANSLATE', mode: 'page', jobId: job.id, itemId: `${job.paragraphs.indexOf(paragraph)}-${index}`, text: chunk });
          job.inflight.set(key, request);
        }
        reply = await request;
        if (job.inflight.get(key) === request) job.inflight.delete(key);
      }
      if (!this.validParagraph(job, paragraph)) return;
      if (!reply.ok) {
        paragraph.state = 'failed';
        if (BLOCKING_ERRORS.has(reply.error.code)) { job.error = reply.error; await this.cancelCurrent(); }
        return;
      }
      if (!reply.value.translated?.trim()) { paragraph.state = 'failed'; return; }
      completedChunks.push([key, reply.value.translated]);
      result.push(reply.value.translated);
    }
    if (!this.validParagraph(job, paragraph)) return;
    const restored = restoreParagraphLiterals(result.join(' '), paragraph.snapshot);
    if (!restored?.trim()) { paragraph.state = 'failed'; return; }
    const originalStyle = originalTextStyle(paragraph.node);
    const { host, shadow } = createHost(this.doc);
    const style = this.doc.createElement('style');
    style.textContent = ':host{display:block!important;margin:.45em 0 0!important;padding:0!important;border:0!important;background:transparent!important;box-shadow:none!important;}.translation{display:block;margin:0;}a{cursor:pointer;}';
    const translation = this.doc.createElement('div');
    translation.className = 'translation';
    if (!renderRichTranslation(this.doc, paragraph.snapshot, restored, translation)) { paragraph.state = 'failed'; return; }
    translation.lang = htmlLanguage(job.preferences.target);
    applyOriginalTextStyle(originalStyle, translation);
    for (const [key, value] of completedChunks) this.cache.set(key, value);
    shadow.append(style, translation);
    const cleanup = insertParagraphTranslation(paragraph.node, host);
    if (host.parentElement === paragraph.node.parentElement && paragraph.node.nextElementSibling === host) {
      for (const [property, value] of originalStyle.margins) host.style.setProperty(property, value, 'important');
    }
    if (cleanup) this.translationCleanup.set(host, cleanup);
    paragraph.translation = host;
    this.translations.add(host);
    paragraph.state = 'done';
    job.observer?.unobserve(paragraph.node);
  }

  private validParagraph(job: Job, paragraph: Paragraph): boolean {
    if (!this.isCurrent(job)) return false;
    if (job.byNode.get(paragraph.node) !== paragraph) return false;
    if (!paragraph.node.isConnected || readParagraphSnapshot(paragraph.node).signature !== paragraph.snapshot.signature) {
      paragraph.state = 'failed';
      return false;
    }
    return true;
  }
}
