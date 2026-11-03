// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegionOverlay } from '../src/content/region';
import type { RegionCommand, RegionReply } from '../src/shared/region';

let overlay: RegionOverlay | undefined;
let shadow: ShadowRoot;
let send = vi.fn(async (_command: RegionCommand): Promise<RegionReply> => ({ ok: true, value: { translated: '虚拟译文', recognized: 'Virtual', style: { solid: true, background: 'rgb(255, 255, 255)', color: 'rgb(25, 25, 25)' } } }));
const node = (selector: string) => shadow.querySelector<HTMLElement>(selector)!;
function pointer(type: string, x: number, y: number, button = 0): void {
  const event = new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, composed: true });
  Object.defineProperty(event, 'pointerId', { value: 1 }); node('.layer').dispatchEvent(event);
}
function start(trust = true, problem?: string): void {
  overlay = new RegionOverlay('virtual-token', send, problem, trust ? () => true : undefined);
  node('.layer').setPointerCapture = vi.fn(); node('.layer').hasPointerCapture = () => false;
}
beforeEach(() => {
  document.body.innerHTML = '<p>虚拟论文内容</p>';
  send = vi.fn(async (_command: RegionCommand): Promise<RegionReply> => ({ ok: true, value: { translated: '虚拟译文', style: { solid: true, background: 'rgb(255, 255, 255)', color: 'rgb(25, 25, 25)' } } }));
  const attach = HTMLElement.prototype.attachShadow;
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { shadow = attach.call(this, options); return shadow; });
  vi.stubGlobal('visualViewport', { scale: 1, addEventListener: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
  Object.defineProperty(document, 'elementFromPoint', { value: () => document.querySelector('p'), configurable: true });
});
afterEach(() => { overlay?.dispose(false); overlay = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('原页十字框选与译文覆盖层', () => {
  it('拖动期间不请求，松开后自动发送选区并在原位加载、展示', async () => {
    let complete!: (value: RegionReply) => void;
    send.mockImplementation(command => command.type === 'REGION_CAPTURE' ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ ok: false, error: { code: 'CANCELED', message: '', retryable: false } }));
    start(); pointer('pointerdown', 30, 50); pointer('pointermove', 330, 210);
    expect(send).not.toHaveBeenCalled(); pointer('pointerup', 330, 210);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][0]).toMatchObject({ type: 'REGION_CAPTURE', rect: { x: 30, y: 50, width: 300, height: 160 } });
    expect(node('.hint').hidden).toBe(true); expect(node('.box').hidden).toBe(true);
    overlay!.loading(); expect(node('.body').textContent).toContain('翻译给你'); expect(node('.box').style.left).toBe('30px');
    complete({ ok: true, value: { translated: '翻译结果', style: { solid: true, background: 'rgb(255, 255, 255)', color: 'rgb(20, 20, 20)' } } });
    await vi.waitFor(() => expect(node('.body').textContent).toBe('翻译结果'));
    expect(node('.box').style.background).toBe('rgb(255, 255, 255)');
    expect(document.querySelector('p')!.textContent).toBe('虚拟论文内容');
    expect(shadow.host.shadowRoot).toBeNull();
  });
  it('反向拖动有效，小选区与非左键不发送', async () => {
    start(); pointer('pointerdown', 30, 50, 2); pointer('pointerup', 330, 210, 2); expect(send).not.toHaveBeenCalled();
    pointer('pointerdown', 10, 10); pointer('pointerup', 11, 11); expect(send).not.toHaveBeenCalled();
    pointer('pointerdown', 330, 210); pointer('pointerup', 30, 50);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ rect: { x: 30, y: 50, width: 300, height: 160 } })));
  });
  it('实际默认入口忽略网页合成的鼠标事件', async () => {
    start(false); pointer('pointerdown', 30, 50); pointer('pointerup', 330, 210);
    await Promise.resolve(); expect(send).not.toHaveBeenCalled();
  });
  it('结束事件落在遮罩外仍使用同一指针提交，其他指针不能提交', async () => {
    start(); pointer('pointerdown', 30, 50);
    const other = new MouseEvent('pointerup', { clientX: 330, clientY: 210, button: 0 });
    Object.defineProperty(other, 'pointerId', { value: 2 }); window.dispatchEvent(other); expect(send).not.toHaveBeenCalled();
    const finish = new MouseEvent('pointerup', { clientX: 330, clientY: 210, button: 0 });
    Object.defineProperty(finish, 'pointerId', { value: 1 }); window.dispatchEvent(finish);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'REGION_CAPTURE', rect: { x: 30, y: 50, width: 300, height: 160 } })));
  });
  it('Esc 取消后迟到模型响应不恢复界面', async () => {
    let complete!: (value: RegionReply) => void;
    send.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    start(); pointer('pointerdown', 30, 50); pointer('pointerup', 330, 210);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce()); const finish = complete;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(send).toHaveBeenCalledWith({ type: 'REGION_CANCEL', token: 'virtual-token' });
    finish({ ok: true, value: { translated: '迟到结果', style: { solid: true, background: '#fff', color: '#000' } } });
    await Promise.resolve(); expect(shadow.host.isConnected).toBe(false);
  });
  it('复杂背景使用卡片；滚动卡片不关闭，滚动原页则关闭', async () => {
    send.mockResolvedValue({ ok: true, value: { translated: '<script>仅作为文本</script>', style: { solid: false, background: '#777', color: '#000' } } });
    start(); pointer('pointerdown', 30, 50); pointer('pointerup', 330, 210);
    await vi.waitFor(() => expect(node('.body').classList.contains('card')).toBe(true));
    expect(node('.body').querySelector('script')).toBeNull();
    node('.body').dispatchEvent(new WheelEvent('wheel', { bubbles: true, composed: true })); expect(shadow.host.isConnected).toBe(true);
    document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); expect(shadow.host.isConnected).toBe(false);
  });
  it('缺少设置只在当前页显示引导，用户主动点击才打开设置', () => {
    start(true, '请先配置百炼。'); expect(node('.body').textContent).toBe('请先配置百炼。'); expect(send).not.toHaveBeenCalled();
    [...shadow.querySelectorAll('button')].find(button => button.textContent === '前往设置')!.click();
    expect(send).toHaveBeenCalledWith({ type: 'REGION_SETTINGS', token: 'virtual-token' });
  });
});
