import { DEFAULT_HOVER_SHORTCUT, send, type ContentMessage, type PageContext } from '../shared/types';
import { HoverTranslator } from './hover';
import { SelectionTranslator } from './selection';

/** iframe 仅处理用户主动的划词和悬停；浮球、全文操作与侧栏始终由顶层页面管理。 */
export class FrameSelectionController {
  readonly ready: Promise<void>;
  private readonly selection: SelectionTranslator;
  private readonly hover: HoverTranslator;
  private generation = 0;

  constructor(doc: Document) {
    this.selection = new SelectionTranslator(doc);
    this.hover = new HoverTranslator(doc, element => this.selection.translateElement(element));
    this.ready = this.refreshContext();
  }

  async refreshContext(): Promise<void> {
    const generation = ++this.generation;
    const reply = await send<PageContext>({ type: 'GET_CONTEXT' });
    if (generation !== this.generation) return;
    const context = reply.ok ? reply.value : undefined;
    this.hover.setEnabled(context?.hoverTranslationEnabled === true, context?.hoverShortcut ?? DEFAULT_HOVER_SHORTCUT);
    await Promise.all([
      this.selection.setEnabled(context?.selectionEnabled === true),
      this.selection.setHoverEnabled(context?.hoverTranslationEnabled === true),
    ]);
  }

  async handle(message: ContentMessage): Promise<void> {
    if (message.type === 'SITE_CHANGED' || message.type === 'FEATURES_CHANGED') await this.refreshContext();
    else if (message.type === 'SERVICE_REMOVED') {
      await this.selection.serviceRemoved(message.provider);
      await this.refreshContext();
    } else if (message.type === 'RESTORE') await this.selection.close();
  }

  async suspend(): Promise<void> {
    this.generation++;
    this.hover.destroy();
    await Promise.all([this.selection.setEnabled(false), this.selection.setHoverEnabled(false)]);
  }
}
