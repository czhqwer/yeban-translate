import { DEFAULT_HOVER_SHORTCUT } from '../shared/types';
import { matchesShortcut } from '../shared/shortcuts';
import { findHoverParagraph, OWNED } from './dom';

/** 只记录鼠标下的段落；真正读取并发送文本必须再按一次已配置快捷键。 */
export class HoverTranslator {
  private enabled = false;
  private shortcut = DEFAULT_HOVER_SHORTCUT;
  private hovered?: HTMLElement;
  private point?: { x: number; y: number };

  constructor(private readonly doc: Document, private readonly translate: (element: HTMLElement) => Promise<void>) {}

  setEnabled(enabled: boolean, shortcut = DEFAULT_HOVER_SHORTCUT): void {
    if (this.enabled === enabled && this.shortcut === shortcut) return;
    if (this.enabled !== enabled) {
      const method = enabled ? 'addEventListener' : 'removeEventListener';
      this.doc[method]('pointermove', this.onPointerMove, true);
      this.doc[method]('keydown', this.onKeyDown, true);
    }
    this.enabled = enabled;
    this.shortcut = shortcut;
    if (!enabled) { this.hovered = undefined; this.point = undefined; }
  }

  destroy(): void { this.setEnabled(false); }

  private onPointerMove = (event: Event): void => {
    if (!this.enabled) return;
    if (event.composedPath().some(node => node instanceof Element && node.hasAttribute(OWNED))) { this.hovered = undefined; this.point = undefined; return; }
    const pointer = event as PointerEvent;
    if (Number.isFinite(pointer.clientX) && Number.isFinite(pointer.clientY)) this.point = { x: pointer.clientX, y: pointer.clientY };
    this.hovered = findHoverParagraph(event.target) ?? undefined;
  };

  private onKeyDown = (event: Event): void => {
    const keyboard = event as KeyboardEvent;
    if (!this.enabled || keyboard.repeat || !matchesShortcut(keyboard, this.shortcut)) return;
    const hit = this.point && typeof this.doc.elementFromPoint === 'function' ? this.doc.elementFromPoint(this.point.x, this.point.y) : null;
    const paragraph = findHoverParagraph(hit) ?? this.hovered;
    if (!paragraph?.isConnected) return;
    keyboard.preventDefault();
    keyboard.stopPropagation();
    void this.translate(paragraph);
  };
}
