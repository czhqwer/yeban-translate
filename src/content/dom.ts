/** 正文与划词共用的 DOM 保护规则；页面内容始终作为不可信纯文本。 */
export const OWNED = 'data-yeban-owned';
const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,dt,dd,figcaption,summary';
const INLINE_BLOCKS = 'label,a';
const CONTAINERS = 'nav,aside';
const ALL_BLOCKS = `${BLOCKS},${INLINE_BLOCKS},${CONTAINERS}`;
const EXCLUDED = `input,textarea,select,option,button,pre,script,style,noscript,iframe,svg,canvas,object,embed,[${OWNED}],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[aria-hidden="true"]`;
const PROTECTED = `${EXCLUDED},code`;

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
export interface ParagraphSnapshot { text: string; naturalText: string; literals: ParagraphLiteral[]; signature: string }

/** 隐藏内容与代码块完全排除；行内代码仅以稳定占位符参与自然语言翻译。 */
export function readParagraphSnapshot(element: Element): ParagraphSnapshot {
  const fragments: Array<string | { value: string }> = [];
  const natural: string[] = [];
  const container = element.matches(CONTAINERS);
  const literalText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const child = node as Element;
    if (child.matches(EXCLUDED) || isHidden(child)) return '';
    if (child.tagName === 'BR') return ' ';
    return [...child.childNodes].map(literalText).join('');
  };
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { const value = node.nodeValue ?? ''; fragments.push(value); natural.push(value); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child.matches(EXCLUDED) || isHidden(child)) return;
    if (child !== element && (child.matches(BLOCKS) || child.matches('ul,ol') || container && child.matches(`${INLINE_BLOCKS},${CONTAINERS}`))) return;
    if (child.tagName === 'CODE') { const value = literalText(child); if (value) fragments.push({ value }); return; }
    if (child.tagName === 'BR') { fragments.push(' '); natural.push(' '); return; }
    for (const descendant of child.childNodes) visit(descendant);
  };
  if (!isProtected(element)) visit(element);
  const allText = fragments.map(fragment => typeof fragment === 'string' ? fragment : fragment.value).join('');
  let salt = 0;
  while (allText.includes(`[[YEBAN_KEEP_${salt}_`)) salt++;
  const literals: ParagraphLiteral[] = [];
  const text = normalizeText(fragments.map(fragment => {
    if (typeof fragment === 'string') return fragment;
    const placeholder = `[[YEBAN_KEEP_${salt}_${literals.length}]]`;
    literals.push({ placeholder, value: fragment.value });
    return placeholder;
  }).join(''));
  return { text, naturalText: normalizeText(natural.join('')), literals, signature: JSON.stringify([text, literals]) };
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
  const markers = [...text.matchAll(/\[\[YEBAN_KEEP_\d+_\d+\]\]/gu)].map(match => {
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
      // 保留行内代码占位符的完整边界，不能将它拆入两个独立请求。
      const marker = markers.find(span => span.start < end && span.end > end);
      if (marker && marker.start > offset) end = marker.start;
    }
    chunks.push(chars.slice(offset, end).join(''));
    offset = end;
  }
  return chunks;
}

/** 明确为同语种时跳过；混合文本保守交给所选服务判断。 */
export function isSameLanguage(text: string, target: 'zh' | 'en'): boolean {
  const han = /\p{Script=Han}/u.test(text);
  const latin = /[a-z]/iu.test(text);
  if (target === 'zh') return han && !latin && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
  // 拉丁字母并不等于英语；只有具备明确英语结构时才跳过自动识别。
  const englishMarkers = text.toLowerCase().match(/\b(the|this|that|these|those|is|are|was|were|with|your|you|have|has)\b/gu) ?? [];
  return latin && !han && englishMarkers.length >= 2 && !/[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u.test(text);
}

/** 仅当前视口段落可进入付费请求队列。 */
export function isInViewport(node: Element | Range): boolean {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

export interface SelectionSnapshot { text: string; range: Range; documentUrl: string }

/** 检查整个选区，防止首尾正常但中间穿过代码或输入区域。 */
export function readSelection(selection: Selection | null, doc: Document): SelectionSnapshot | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!range.startContainer.isConnected || !range.endContainer.isConnected || isProtected(range.startContainer) || isProtected(range.endContainer)) return null;
  const common = range.commonAncestorContainer;
  const root = common.nodeType === Node.ELEMENT_NODE ? common as Element : common.parentElement;
  if (!root) return null;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (range.intersectsNode(node) && isProtected(node)) return null;
    node = walker.nextNode();
  }
  const text = selection.toString().trim();
  return text ? { text, range: range.cloneRange(), documentUrl: doc.URL } : null;
}

/** DOM 原文和文档仍匹配时才展示异步结果。 */
export function selectionUnchanged(snapshot: SelectionSnapshot, doc: Document): boolean {
  return doc.URL === snapshot.documentUrl && snapshot.range.startContainer.isConnected && snapshot.range.endContainer.isConnected && snapshot.range.toString().trim() === snapshot.text;
}

/** 封闭 ShadowRoot 隔离站点样式；所有文本由 textContent 写入。 */
export function createHost(doc: Document): { host: HTMLSpanElement; shadow: ShadowRoot } {
  const host = doc.createElement('span');
  host.setAttribute(OWNED, '');
  const shadow = host.attachShadow({ mode: 'closed' });
  return { host, shadow };
}
