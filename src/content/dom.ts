/** 正文与划词共用的 DOM 保护规则；页面内容始终作为不可信纯文本。 */
import type { TargetLanguage } from '../shared/types';

export const OWNED = 'data-yeban-owned';
const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,dt,dd,figcaption,summary';
const INLINE_BLOCKS = 'label,a';
const CONTAINERS = 'nav,aside';
const ALL_BLOCKS = `${BLOCKS},${INLINE_BLOCKS},${CONTAINERS}`;
const EXCLUDED = `input,textarea,select,option,button,pre,script,style,noscript,iframe,svg,canvas,object,embed,[${OWNED}],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[aria-hidden="true"]`;
const PROTECTED = `${EXCLUDED},code`;
const SELECTION_BLOCKED = `input,textarea,select,option,button,script,style,noscript,iframe,canvas,object,embed,[${OWNED}]`;
const SELECTION_IGNORED = `svg,[hidden],[aria-hidden="true"]`;
const RICH_INLINE = 'a,abbr,b,bdi,bdo,cite,code,del,em,i,ins,kbd,mark,q,s,samp,small,span,strong,sub,sup,time,u,var';
const MAX_INLINE_FORMATS = 20;
const INLINE_STYLE_PROPERTIES = [
  'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant',
  'font-feature-settings', 'font-kerning', 'font-optical-sizing', 'font-variation-settings', 'line-height',
  'letter-spacing', 'word-spacing', 'text-decoration', 'text-transform', 'text-shadow', 'white-space',
  'word-break', 'overflow-wrap', 'vertical-align', 'background-color', 'border-top-color', 'border-top-style',
  'border-top-width', 'border-right-color', 'border-right-style', 'border-right-width', 'border-bottom-color',
  'border-bottom-style', 'border-bottom-width', 'border-left-color', 'border-left-style', 'border-left-width',
  'border-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
] as const;

/** 只识别计算样式能够证明零面积的裁剪，不根据 sr-only 等类名推断。 */
function isFullyClipped(style: CSSStyleDeclaration): boolean {
  const inset = style.clipPath?.trim().match(/^inset\(([^)]+)\)$/iu);
  if (inset) {
    const values = inset[1].split(/\s+round\s+/iu)[0].trim().split(/\s+/u);
    if (values.length >= 1 && values.length <= 4) {
      const [top, right = top, bottom = top, left = right] = values;
      const percent = (value: string): number | undefined => {
        if (/^[+-]?(?:\d+\.?\d*|\.\d+)%$/u.test(value)) return Number.parseFloat(value);
        return /^0(?:px)?$/u.test(value) ? 0 : undefined;
      };
      const [t, r, b, l] = [top, right, bottom, left].map(percent);
      if (t !== undefined && b !== undefined && t + b >= 100 || r !== undefined && l !== undefined && r + l >= 100) return true;
    }
  }
  // 旧式 clip 只作用于绝对或固定定位元素；普通文档流上的相同声明不可当作隐藏。
  if (style.position !== 'absolute' && style.position !== 'fixed') return false;
  const clipped = style.clip?.trim().match(/^rect\(([^)]+)\)$/iu);
  if (!clipped) return false;
  const coordinates = clipped[1].trim().split(/[\s,]+/u);
  if (coordinates.length !== 4 || !coordinates.every(value => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:px)?$/u.test(value))) return false;
  const [top, right, bottom, left] = coordinates.map(Number.parseFloat);
  return right <= left || bottom <= top;
}

function isHidden(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const parent: Element | null = current.parentElement;
    if (parent?.tagName === 'DETAILS' && !parent.hasAttribute('open')) {
      // 原生折叠不一定反映为子节点 display:none，只有第一个 summary 仍然可见。
      const summary: Element | undefined = [...parent.children].find(child => child.tagName === 'SUMMARY');
      if (current !== summary) return true;
    }
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0' || style && isFullyClipped(style)) return true;
    current = current.parentElement;
  }
  return false;
}

/** 排除可编辑、代码、隐藏和扩展自身区域，包括所有祖先。 */
export function isProtected(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  if (!element || element.closest(PROTECTED)) return true;
  return isHidden(element);
}

/** 全页按语义块分配文字所有者；嵌套块分别处理，不遍历每个 span 产生重复译文。 */
export function extractParagraphs(doc: Document, root?: Element): HTMLElement[] {
  const candidates = [...(root ?? doc).querySelectorAll<HTMLElement>(ALL_BLOCKS)];
  if (root?.matches(ALL_BLOCKS)) candidates.unshift(root as HTMLElement);
  return candidates.filter(node => {
    if (isProtected(node)) return false;
    if (node.matches(INLINE_BLOCKS) && node.parentElement?.closest(`${BLOCKS},${INLINE_BLOCKS}`)) return false;
    const { naturalText } = readParagraphSnapshot(node);
    // 配置名和代码标识本身不构成需要翻译的自然语言。
    return /\p{L}/u.test(naturalText) && !/^[\p{L}\p{N}_-]+(?:[._][\p{L}\p{N}_-]+)+$/u.test(naturalText);
  });
}

/** 正文空白统一，缓存仍保留服务、语言和版本隔离。 */
export function normalizeText(text: string): string { return text.replace(/\s+/gu, ' ').trim(); }

export interface ParagraphLiteral { placeholder: string; value: string }
export interface ParagraphFormat {
  open: string;
  close: string;
  tag: string;
  href?: string;
  title?: string;
  styles: Array<[string, string]>;
}
export interface ParagraphSnapshot { text: string; naturalText: string; literals: ParagraphLiteral[]; formats: ParagraphFormat[]; signature: string }

/** 隐藏内容与代码块完全排除；行内代码仅以稳定占位符参与自然语言翻译。 */
export function readParagraphSnapshot(element: Element): ParagraphSnapshot {
  type Fragment = string | { kind: 'literal'; value: string } | { kind: 'format'; index: number; edge: 'open' | 'close' };
  const fragments: Fragment[] = [];
  const natural: string[] = [];
  const formatSources: Array<{ tag: string; href?: string; title?: string; styles: Array<[string, string]> }> = [];
  const container = element.matches(CONTAINERS);
  const literalText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const child = node as Element;
    if (child.matches(EXCLUDED) || isHidden(child)) return '';
    if (child.tagName === 'BR') return ' ';
    return [...child.childNodes].map(literalText).join('');
  };
  const formatSource = (child: Element): typeof formatSources[number] => {
    const computed = child.ownerDocument.defaultView?.getComputedStyle(child);
    const styles = computed ? INLINE_STYLE_PROPERTIES
      .map(property => [property, computed.getPropertyValue(property)] as [string, string])
      .filter(([, value]) => Boolean(value)) : [];
    const tag = child.matches(RICH_INLINE) ? child.tagName.toLowerCase() : 'span';
    const href = child.tagName === 'A' ? child.getAttribute('href') ?? undefined : undefined;
    const title = child.matches('abbr,q,time') ? child.getAttribute('title') ?? undefined : undefined;
    return { tag, ...(href ? { href } : {}), ...(title ? { title } : {}), styles };
  };
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { const value = node.nodeValue ?? ''; fragments.push(value); natural.push(value); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child.matches(EXCLUDED) || isHidden(child)) return;
    if (child !== element && (child.matches(BLOCKS) || child.matches('ul,ol') || container && child.matches(`${INLINE_BLOCKS},${CONTAINERS}`))) return;
    if (child.tagName === 'BR') { fragments.push(' '); natural.push(' '); return; }
    const preserve = child !== element && formatSources.length < MAX_INLINE_FORMATS && child.matches(RICH_INLINE) && Boolean(normalizeText(literalText(child)));
    const formatIndex = preserve ? formatSources.push(formatSource(child)) - 1 : -1;
    if (preserve) fragments.push({ kind: 'format', index: formatIndex, edge: 'open' });
    if (child.tagName === 'CODE') {
      const value = literalText(child);
      if (value) fragments.push({ kind: 'literal', value });
    } else {
      for (const descendant of child.childNodes) visit(descendant);
    }
    if (preserve) fragments.push({ kind: 'format', index: formatIndex, edge: 'close' });
  };
  if (!isProtected(element)) visit(element);
  const allText = fragments.map(fragment => typeof fragment === 'string' ? fragment : fragment.kind === 'literal' ? fragment.value : '').join('');
  let salt = 0;
  while (allText.includes(`[[YEBAN_KEEP_${salt}_`) || allText.includes(`[[YEBAN_FMT_${salt}_`)) salt++;
  const literals: ParagraphLiteral[] = [];
  const formats: ParagraphFormat[] = formatSources.map((source, index) => ({
    ...source,
    open: `[[YEBAN_FMT_${salt}_${index}_OPEN]]`,
    close: `[[YEBAN_FMT_${salt}_${index}_CLOSE]]`,
  }));
  const text = normalizeText(fragments.map(fragment => {
    if (typeof fragment === 'string') return fragment;
    if (fragment.kind === 'format') return formats[fragment.index][fragment.edge];
    const placeholder = `[[YEBAN_KEEP_${salt}_${literals.length}]]`;
    literals.push({ placeholder, value: fragment.value });
    return placeholder;
  }).join(''));
  const formatSignature = formats.map(({ open, close, tag, href, title, styles }) => ({ open, close, tag, href, title, styles }));
  return { text, naturalText: normalizeText(natural.join('')), literals, formats, signature: JSON.stringify([text, literals, formatSignature]) };
}

/** 正文提取与校验共享过滤和换行规则。 */
export function readParagraphText(element: Element): string { return readParagraphSnapshot(element).text; }

/** 占位符必须完整且各出现一次，任何损坏都不能作为成功结果展示或缓存。 */
export function restoreParagraphLiterals(translated: string, snapshot: ParagraphSnapshot): string | undefined {
  const found = translated.match(/\[\[YEBAN_KEEP_\d+_\d+\]\]/gu) ?? [];
  if (found.length !== snapshot.literals.length || found.some(marker => !snapshot.literals.some(literal => literal.placeholder === marker))) return undefined;
  let output = translated;
  for (const literal of snapshot.literals) {
    if (output.split(literal.placeholder).length !== 2) return undefined;
    output = output.replace(literal.placeholder, () => literal.value);
  }
  return output;
}

/** 保留折叠标签相邻结构，并避免给 nowrap flex 标签增加横向第三列。 */
function insertInLabel(label: HTMLElement, translation: HTMLElement): (() => void) | undefined {
  const textContainer = [...label.children].find(child => child.tagName === 'DIV' && /\p{L}/u.test(readParagraphSnapshot(child).naturalText));
  if (textContainer) { textContainer.append(translation); return; }
  label.append(translation);
  const display = label.ownerDocument.defaultView?.getComputedStyle(label).display;
  if (display !== 'flex' && display !== 'inline-flex') return;
  const original = label.style.getPropertyValue('flex-wrap');
  const priority = label.style.getPropertyPriority('flex-wrap');
  label.style.setProperty('flex-wrap', 'wrap', 'important');
  translation.style.setProperty('flex-basis', '100%', 'important');
  translation.style.setProperty('width', '100%', 'important');
  return () => {
    // 页面自身随后改过同一属性时保留页面的更新。
    if (label.style.getPropertyValue('flex-wrap') !== 'wrap' || label.style.getPropertyPriority('flex-wrap') !== 'important') return;
    if (original) label.style.setProperty('flex-wrap', original, priority);
    else label.style.removeProperty('flex-wrap');
  };
}

/** 单元格译文留在格内；父列表自己的译文位于子列表之前，必要样式返回恢复函数。 */
export function insertParagraphTranslation(node: HTMLElement, translation: HTMLElement): (() => void) | undefined {
  if (node.matches('td,th')) { node.append(translation); return; }
  if (node.tagName === 'SUMMARY') { node.append(translation); return; }
  // 译文留在标签内部，保留 input + label + ul 等折叠 CSS 的相邻结构和原生点击行为。
  if (node.tagName === 'LABEL') return insertInLabel(node, translation);
  if (node.tagName === 'LI') {
    const nestedList = [...node.children].find(child => child.matches('ul,ol') || child.querySelector('ul,ol'));
    const label = nestedList?.previousElementSibling;
    if (label?.tagName === 'LABEL' && label.previousElementSibling?.matches('input[type="checkbox"],input[type="radio"]')) return insertInLabel(label as HTMLElement, translation);
    node.insertBefore(translation, nestedList ?? null);
    return;
  }
  if (node.matches(CONTAINERS)) { node.append(translation); return; }
  node.after(translation);
}

/** 长段按 Unicode 字符和句子边界拆分，不截断代理对。 */
export function splitText(text: string, limit = 1800): string[] {
  if (limit < 1) return [];
  const chars = Array.from(text);
  const markers = [...text.matchAll(/\[\[YEBAN_(?:KEEP_\d+_\d+|FMT_\d+_\d+_(?:OPEN|CLOSE))\]\]/gu)].map(match => {
    const start = Array.from(text.slice(0, match.index)).length;
    return { start, end: start + match[0].length };
  });
  const chunks: string[] = [];
  let offset = 0;
  while (offset < chars.length) {
    let end = Math.min(offset + limit, chars.length);
    if (end < chars.length) {
      for (let i = end - 1; i > offset + Math.floor(limit / 2); i--) {
        if (/[。！？.!?\n]/u.test(chars[i])) { end = i + 1; break; }
      }
      // 保留代码与富文本标记的完整边界，不能将一个标记拆入两个独立请求。
      const marker = markers.find(span => span.start < end && span.end > end);
      if (marker && marker.start > offset) end = marker.start;
    }
    chunks.push(chars.slice(offset, end).join(''));
    offset = end;
  }
  return chunks;
}

/** 明确为同语种时跳过；混合文本保守交给所选服务判断。 */
export function isSameLanguage(text: string, target: TargetLanguage): boolean {
  const han = /\p{Script=Han}/u.test(text);
  const latin = /[a-z]/iu.test(text);
  if (target === 'zh') return han && !latin && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
  if (target !== 'en') return false;
  // 拉丁字母并不等于英语；只有具备明确英语结构时才跳过自动识别。其他语言保守交给服务判断。
  const englishMarkers = text.toLowerCase().match(/\b(the|this|that|these|those|is|are|was|were|with|your|you|have|has)\b/gu) ?? [];
  return latin && !han && englishMarkers.length >= 2 && !/[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u.test(text);
}

/** 仅当前视口段落可进入付费请求队列。 */
export function isInViewport(node: Element | Range): boolean {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

interface SelectionBase { text: string; documentUrl: string }
export type SelectionSnapshot =
  | SelectionBase & { kind: 'range'; range: Range; editableRoot?: HTMLElement }
  | SelectionBase & { kind: 'control'; control: HTMLInputElement | HTMLTextAreaElement; start: number; end: number };

function editableRoot(node: Node): HTMLElement | undefined {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const root = element?.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])');
  return root?.isConnected ? root : undefined;
}

/**
 * 按 Range 实际覆盖的文本节点重建可发送文本。
 * 隐藏节点与 SVG 装饰直接跳过；覆盖输入控件等交互内容时仍拒绝整个 Range。
 * 明确选中的代码块和行内 code 均可翻译；全文自动提取继续排除 pre。
 */
function readRangeText(range: Range, doc: Document): string | null {
  const common = range.commonAncestorContainer;
  const root = common.nodeType === Node.ELEMENT_NODE ? common as Element : common.parentElement;
  if (!root) return null;
  const fragments: string[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if (range.intersectsNode(textNode)) {
      const start = textNode === range.startContainer ? range.startOffset : 0;
      const end = textNode === range.endContainer ? range.endOffset : textNode.length;
      if (start < end) {
        const element = textNode.parentElement;
        if (!element) return null;
        if (!element.closest(SELECTION_IGNORED) && !isHidden(element)) {
          if (element.closest(SELECTION_BLOCKED)) return null;
          fragments.push(textNode.data.slice(start, end));
        }
      }
    }
    node = walker.nextNode();
  }
  return fragments.join('').trim() || null;
}

/** 原生输入控件不暴露 Range，只读取浏览器明确标记的选中文字；密码等敏感类型始终拒绝。 */
function readControlSelection(target: EventTarget | null | undefined, doc: Document): SelectionSnapshot | null {
  const candidate = target instanceof Element ? target.closest('textarea,input') : doc.activeElement?.closest('textarea,input');
  if (!(candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) || candidate.ownerDocument !== doc || !candidate.isConnected || candidate.disabled) return null;
  if (candidate instanceof HTMLInputElement && !['text', 'search', 'url', 'tel', 'email'].includes(candidate.type)) return null;
  const start = candidate.selectionStart;
  const end = candidate.selectionEnd;
  if (start === null || end === null || start >= end) return null;
  const text = candidate.value.slice(start, end).trim();
  return text ? { kind: 'control', text, control: candidate, start, end, documentUrl: doc.URL } : null;
}

/** 检查整个选区；富文本编辑器允许主动划词，整页提取仍继续排除编辑区域。 */
export function readSelection(selection: Selection | null, doc: Document, target?: EventTarget | null): SelectionSnapshot | null {
  const control = readControlSelection(target, doc);
  if (control) return control;
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) return null;
  const text = readRangeText(range, doc);
  const startRoot = editableRoot(range.startContainer);
  const endRoot = editableRoot(range.endContainer);
  return text ? { kind: 'range', text, range: range.cloneRange(), ...(startRoot && startRoot === endRoot ? { editableRoot: startRoot } : {}), documentUrl: doc.URL } : null;
}

/** 悬停快捷键将当前块构造成稳定选区快照，不改变网页的可见选区。 */
export function readElementSelection(element: HTMLElement, doc: Document): SelectionSnapshot | null {
  if (!element.isConnected || element.ownerDocument !== doc || element.closest(`[${OWNED}],input,textarea,select,button,iframe,canvas,object,embed`) || isHidden(element)) return null;
  const range = doc.createRange();
  range.selectNodeContents(element);
  const text = readRangeText(range, doc);
  const root = editableRoot(element);
  return text ? { kind: 'range', text, range, ...(root ? { editableRoot: root } : {}), documentUrl: doc.URL } : null;
}

/** 从鼠标所在节点选择最小的自然语言块；普通 div 只在没有语义段落时作为兜底。 */
export function findHoverParagraph(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element) || target.closest(`[${OWNED}],input,textarea,select,button,iframe,canvas,object,embed`)) return null;
  const semantic = target.closest<HTMLElement>(`${BLOCKS},output,[contenteditable]:not([contenteditable="false"]),[role="textbox"]`);
  if (semantic && !isHidden(semantic)) return semantic;
  let candidate = target.closest<HTMLElement>('div,section,article,main');
  while (candidate) {
    if (!isHidden(candidate)) {
      const text = normalizeText(candidate.textContent ?? '');
      if (/\p{L}/u.test(text) && Array.from(text).length <= 2000) return candidate;
    }
    candidate = candidate.parentElement?.closest<HTMLElement>('div,section,article,main') ?? null;
  }
  return null;
}

export function canWriteSelection(snapshot: SelectionSnapshot): boolean {
  return snapshot.kind === 'control' ? !snapshot.control.readOnly && !snapshot.control.disabled : Boolean(snapshot.editableRoot?.isConnected);
}

function inputEvent(doc: Document, type: 'beforeinput' | 'input', data: string, inputType: string, cancelable: boolean): Event {
  const EventConstructor = doc.defaultView?.InputEvent;
  return EventConstructor
    ? new EventConstructor(type, { bubbles: true, composed: true, cancelable, data, inputType })
    : new Event(type, { bubbles: true, cancelable });
}

/** 仅由结果窗按钮调用；尽量走浏览器编辑命令以保留编辑器撤销栈，失败时才做可观察的 DOM 兜底。 */
export function writeSelection(snapshot: SelectionSnapshot, translated: string, action: 'replace' | 'insert', doc: Document): boolean {
  if (!translated.trim() || !canWriteSelection(snapshot) || !selectionUnchanged(snapshot, doc)) return false;
  if (snapshot.kind === 'control') {
    const value = action === 'replace' ? translated : `${snapshot.control instanceof HTMLTextAreaElement ? '\n' : ' '}${translated}`;
    const start = action === 'replace' ? snapshot.start : snapshot.end;
    const end = action === 'replace' ? snapshot.end : snapshot.end;
    if (!snapshot.control.dispatchEvent(inputEvent(doc, 'beforeinput', value, action === 'replace' ? 'insertReplacementText' : 'insertText', true))) return false;
    snapshot.control.setRangeText(value, start, end, 'end');
    snapshot.control.dispatchEvent(inputEvent(doc, 'input', value, action === 'replace' ? 'insertReplacementText' : 'insertText', false));
    return true;
  }
  const range = snapshot.range.cloneRange();
  if (action === 'insert') range.collapse(false);
  const value = action === 'insert' ? `\n${translated}` : translated;
  const selection = doc.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  if (typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, value)) return true;
  const root = snapshot.editableRoot!;
  if (!root.dispatchEvent(inputEvent(doc, 'beforeinput', value, action === 'replace' ? 'insertReplacementText' : 'insertText', true))) return false;
  if (action === 'replace') range.deleteContents();
  const fragment = doc.createDocumentFragment();
  if (action === 'insert') fragment.append(doc.createElement('br'));
  const text = doc.createTextNode(translated);
  fragment.append(text);
  range.insertNode(fragment);
  range.setStartAfter(text);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  root.dispatchEvent(inputEvent(doc, 'input', value, action === 'replace' ? 'insertReplacementText' : 'insertText', false));
  return true;
}

/** DOM 原文和文档仍匹配时才展示异步结果。 */
export function selectionUnchanged(snapshot: SelectionSnapshot, doc: Document): boolean {
  if (doc.URL !== snapshot.documentUrl) return false;
  if (snapshot.kind === 'control') return snapshot.control.isConnected && snapshot.control.ownerDocument === doc && snapshot.control.value.slice(snapshot.start, snapshot.end).trim() === snapshot.text;
  return snapshot.range.startContainer.isConnected && snapshot.range.endContainer.isConnected && readRangeText(snapshot.range, doc) === snapshot.text;
}

/** 封闭 ShadowRoot 隔离站点样式；所有文本由 textContent 写入。 */
export function createHost(doc: Document): { host: HTMLSpanElement; shadow: ShadowRoot } {
  const host = doc.createElement('span');
  host.setAttribute(OWNED, '');
  const shadow = host.attachShadow({ mode: 'closed' });
  return { host, shadow };
}
