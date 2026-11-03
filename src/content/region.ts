import { cropRect, type CropRect } from '../shared/image';
import type { RegionCommand, RegionReply, Viewport } from '../shared/region';

type Transport = (message: RegionCommand) => Promise<RegionReply>;
const view = (): Viewport => ({ width: innerWidth, height: innerHeight, x: scrollX, y: scrollY, scale: visualViewport?.scale ?? 1 });

/** 框选层只由浏览器手势注入；所有网页合成的鼠标、键盘事件均忽略。 */
export class RegionOverlay {
  private readonly host = document.createElement('div');
  private readonly root = this.host.attachShadow({ mode: 'closed' });
  private readonly layer = document.createElement('div');
  private readonly hint = document.createElement('div');
  private readonly box = document.createElement('div');
  private readonly toolbar = document.createElement('div');
  private readonly body = document.createElement('div');
  private readonly events = new AbortController();
  private phase: 'selecting' | 'capturing' | 'working' | 'done' = 'selecting';
  private start?: { x: number; y: number; pointerId: number };
  private rect?: CropRect;
  private closed = false;
  private originalVisible = false;
  private fontSize = 16;
  private fontFamily = 'system-ui, sans-serif';
  private deadline?: ReturnType<typeof setTimeout>;

  constructor(readonly token: string, private readonly send: Transport, problem?: string, private readonly trusted: (event: Event) => boolean = event => event.isTrusted) {
    const style = document.createElement('style');
    style.textContent = `
      :host { color-scheme: light; }
      * { box-sizing: border-box; }
      .layer { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; touch-action: none; user-select: none; }
      .hint { position: fixed; left: 50%; top: 18px; transform: translateX(-50%); max-width: calc(100vw - 32px); padding: 10px 16px; border: 1px solid #dce5db; border-radius: 12px; background: #f8f6f0; color: #26463c; box-shadow: 0 8px 28px #163d2720; font: 13px/1.6 system-ui, sans-serif; text-align: center; pointer-events: none; }
      .box { position: fixed; border: 2px solid #24705c; box-shadow: 0 0 0 99999px #10271d30; pointer-events: none; }
      .body { width: 100%; height: 100%; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #a9bdb3 transparent; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; font: 16px/1.5 system-ui, sans-serif; }
      .working, .card { border: 1px solid #dae3d9; border-radius: 12px; background: #f8f6f0; color: #244239; box-shadow: 0 12px 40px #142b2726; padding: 16px; }
      .working { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; font: 13px/1.6 system-ui, sans-serif; text-align: center; }
      .working::before { content: '译'; display: grid; place-items: center; width: 34px; height: 34px; flex: none; border-radius: 12px; background: #dcece3; color: #24705c; font: 600 16px/1 system-ui, sans-serif; animation: float 1.4s ease-in-out infinite; }
      @keyframes float { 0%, 100% { transform: translateY(0) rotate(-5deg); } 50% { transform: translateY(-6px) rotate(5deg); } }
      @media (prefers-reduced-motion: reduce) { .working::before { animation: none; } }
      .toolbar { position: fixed; display: flex; gap: 4px; border: 1px solid #dce5db; border-radius: 8px; padding: 3px; background: #f8f6f0; box-shadow: 0 3px 14px #10271d18; pointer-events: auto; }
      button { border: 0; border-radius: 5px; background: transparent; color: #246450; font: 12px/1.5 system-ui, sans-serif; padding: 4px 8px; cursor: pointer; }
      button:hover { background: #e8f0e9; } button:focus-visible { outline: 2px solid #24705c; }
      [hidden] { display: none !important; }
    `;
    this.layer.className = 'layer'; this.hint.className = 'hint'; this.box.className = 'box'; this.toolbar.className = 'toolbar'; this.body.className = 'body';
    this.body.setAttribute('role', 'status'); this.body.setAttribute('aria-live', 'polite');
    this.box.hidden = this.toolbar.hidden = true;
    this.hint.textContent = '拖动框选 · 松开后将选区发送至百炼翻译 · Esc 取消';
    this.box.append(this.body); this.root.append(style, this.layer, this.hint, this.box, this.toolbar);
    this.host.setAttribute('popover', 'manual');
    for (const [property, value] of Object.entries({ all: 'initial', position: 'fixed', inset: '0', width: '100vw', height: '100vh', margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible', 'pointer-events': 'none', 'z-index': '2147483647' })) this.host.style.setProperty(property, value, 'important');
    document.documentElement.append(this.host);
    this.host.showPopover?.();
    this.button('关闭', () => this.dispose());
    const listen = <K extends keyof WindowEventMap>(type: K, callback: (event: WindowEventMap[K]) => void) => window.addEventListener(type, callback, { signal: this.events.signal, capture: true });
    this.layer.addEventListener('pointerdown', event => this.down(event), { signal: this.events.signal });
    // 捕获层保证鼠标结束点跨越嵌入内容或 Shadow DOM 边界时仍能提交。
    listen('pointermove', event => this.move(event));
    listen('pointerup', event => { void this.up(event); });
    this.layer.addEventListener('pointercancel', () => this.dispose(), { signal: this.events.signal });
    listen('keydown', event => { if (this.trusted(event) && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.dispose(); } });
    // 页面或 PDF 内部滚动后，旧覆盖层不应继续盖在另一段内容上。
    listen('wheel', event => { if (this.trusted(event) && !event.composedPath().includes(this.host)) this.dispose(); });
    listen('scroll', event => { if (!event.composedPath().includes(this.host)) this.dispose(); }); listen('resize', () => this.dispose()); listen('pagehide', () => this.dispose());
    listen('blur', () => { if (this.phase !== 'done') this.dispose(); });
    visualViewport?.addEventListener('resize', () => this.dispose(), { signal: this.events.signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.dispose(); }, { signal: this.events.signal });
    this.deadline = setTimeout(() => this.dispose(), 120_000);
    if (problem || view().scale !== 1) this.error(problem ?? '请退出触控缩放后重新框选。', true);
  }

  private button(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', event => { if (this.trusted(event)) action(); }, { signal: this.events.signal }); this.toolbar.prepend(button); return button;
  }

  private down(event: PointerEvent): void {
    if (!this.trusted(event) || event.button !== 0 || this.phase !== 'selecting') return;
    event.preventDefault(); event.stopPropagation();
    this.start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    this.layer.setPointerCapture(event.pointerId);
    // 临时穿透以读取原区域字体，仅作网页排版参考，不读取正文。
    this.layer.style.pointerEvents = 'none';
    const underlying = document.elementFromPoint(event.clientX, event.clientY);
    if (underlying) { const style = getComputedStyle(underlying); this.fontSize = Math.max(12, Math.min(32, parseFloat(style.fontSize) || 16)); this.fontFamily = style.fontFamily || this.fontFamily; }
    this.layer.style.pointerEvents = '';
    this.move(event);
  }

  private move(event: PointerEvent): void {
    if (!this.trusted(event) || !this.start || event.pointerId !== this.start.pointerId || this.phase !== 'selecting') return;
    this.rect = cropRect(this.start, { x: event.clientX, y: event.clientY }, innerWidth, innerHeight);
    this.place(this.rect); this.box.hidden = false;
  }

  private place(rect: CropRect): void {
    Object.assign(this.box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    Object.assign(this.toolbar.style, { left: `${Math.max(8, Math.min(rect.x, innerWidth - 230))}px`, top: `${rect.y >= 42 ? rect.y - 38 : Math.min(innerHeight - 38, rect.y + rect.height + 4)}px` });
  }

  private async up(event: PointerEvent): Promise<void> {
    if (!this.trusted(event) || event.button !== 0 || !this.start || event.pointerId !== this.start.pointerId || this.phase !== 'selecting') return;
    this.move(event); this.start = undefined;
    if (this.layer.hasPointerCapture(event.pointerId)) this.layer.releasePointerCapture(event.pointerId);
    if (!this.rect || this.rect.width < 8 || this.rect.height < 8) { this.box.hidden = true; this.hint.textContent = '选区太小，请按住鼠标左键重新框选 · Esc 取消'; return; }
    this.phase = 'capturing';
    this.box.hidden = this.hint.hidden = true;
    this.layer.style.cursor = 'wait';
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.error('等待超时，请关闭后重新框选。'), 85_000);
    const viewport = view();
    // 留出两帧移除选框，截图中不包含扩展自身界面。
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (this.closed) return;
    try {
      const response = await this.send({ type: 'REGION_CAPTURE', token: this.token, rect: this.rect, viewport });
      if (this.closed || (this.phase as string) === 'done') return;
      if (!response.ok) { this.error(response.error.message, ['CONFIG', 'CONSENT'].includes(response.error.code)); return; }
      this.phase = 'done'; this.layer.hidden = this.hint.hidden = true;
      this.box.hidden = this.toolbar.hidden = false;
      this.body.className = 'body'; this.body.textContent = response.value.translated;
      this.box.style.cssText = ''; this.box.style.pointerEvents = 'auto'; this.box.style.boxShadow = 'none'; this.box.style.border = '0';
      this.body.style.fontFamily = this.fontFamily; this.body.style.fontSize = `${this.fontSize}px`;
      const style = response.value.style;
      Object.assign(this.box.style, { background: style.background, color: style.color });
      this.place(this.rect);
      // 小选区、复杂背景或译文无法装下时，使用可滚动阅读卡片，不裁掉译文。
      if (!style.solid || this.rect.width < 180 || this.rect.height < 70 || this.body.scrollHeight > this.body.clientHeight + 2) this.card();
      const originalButton = this.button('查看原文', () => { this.originalVisible = !this.originalVisible; this.box.style.visibility = this.originalVisible ? 'hidden' : 'visible'; originalButton.textContent = this.originalVisible ? '查看译文' : '查看原文'; });
      this.button('复制', () => { void navigator.clipboard.writeText(response.value.translated).catch(() => { this.hint.hidden = false; this.hint.textContent = '复制失败，请选中译文手动复制。'; }); });
    } catch { if (!this.closed) this.error('扩展连接已中断，请重新框选。'); }
    finally { if (this.deadline) clearTimeout(this.deadline); }
  }

  loading(): void {
    if (this.closed || this.phase !== 'capturing' || !this.rect) return;
    this.phase = 'working'; this.layer.hidden = true; this.box.hidden = this.toolbar.hidden = false;
    this.box.style.boxShadow = 'none'; this.box.style.border = '0'; this.box.style.pointerEvents = 'auto';
    this.body.className = 'body working'; this.body.textContent = '正在把这一小块世界翻译给你…';
    const width = Math.min(innerWidth - 24, Math.max(180, this.rect.width));
    const height = Math.min(innerHeight - 60, Math.max(110, this.rect.height));
    this.place({ x: Math.max(12, Math.min(this.rect.x, innerWidth - width - 12)), y: Math.max(42, Math.min(this.rect.y, innerHeight - height - 12)), width, height });
  }

  private card(): void {
    const width = Math.min(innerWidth - 24, Math.max(280, this.rect?.width ?? 400));
    const height = Math.min(innerHeight - 70, Math.max(150, this.rect?.height ?? 160));
    this.body.className = 'body card'; this.body.style.fontFamily = 'system-ui, sans-serif'; this.body.style.fontSize = '14px';
    this.box.style.background = 'transparent';
    this.place({ x: Math.max(12, Math.min(this.rect?.x ?? (innerWidth - width) / 2, innerWidth - width - 12)), y: Math.max(48, Math.min(this.rect?.y ?? 80, innerHeight - height - 12)), width, height });
  }

  private error(message: string, setup = false): void {
    if (this.closed) return;
    this.phase = 'done'; if (this.deadline) clearTimeout(this.deadline);
    this.layer.hidden = this.hint.hidden = true; this.box.hidden = this.toolbar.hidden = false;
    this.box.style.boxShadow = 'none'; this.box.style.border = '0'; this.box.style.pointerEvents = 'auto';
    this.body.textContent = message; this.card();
    if (setup) this.button('前往设置', () => { void this.send({ type: 'REGION_SETTINGS', token: this.token }); });
  }

  dispose(notify = true): void {
    if (this.closed) return;
    this.closed = true; this.events.abort(); if (this.deadline) clearTimeout(this.deadline);
    this.host.remove();
    if (notify) void this.send({ type: 'REGION_CANCEL', token: this.token }).catch(() => undefined);
  }
}
