// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ImageAttachment } from '../src/sidepanel/images';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhGQAAAAASUVORK5CYII=';
let attachment: ImageAttachment;
let changed = vi.fn((_error?: string) => {});
const node = (id: string) => document.getElementById(id)!;
beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(readFileSync('sidepanel.html', 'utf8'), 'text/html').body.innerHTML;
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1000, height: 500, close: vi.fn() })));
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:virtual-image'); static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(png);
  changed = vi.fn(); attachment = new ImageAttachment(changed);
});
afterEach(() => { attachment.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('侧栏内的粘贴图片附件', () => {
  it('载入只预览，准备时在本地重新编码，无独立图片页和模型输入', async () => {
    await attachment.load(new Blob(['VIRTUAL'], { type: 'image/png' }));
    expect(attachment.hasContent()).toBe(true); expect(node('image-attachment').hidden).toBe(false);
    expect(document.getElementById('image-mode')).toBeNull(); expect(document.getElementById('image-model')).toBeNull();
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
    expect(attachment.prepare()).toBe(png); expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledOnce();
  });
  it('移除释放对象 URL 和位图，不能继续发送', async () => {
    await attachment.load(new Blob(['VIRTUAL'], { type: 'image/png' }));
    attachment.clear(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:virtual-image');
    expect(attachment.hasContent()).toBe(false); expect(() => attachment.prepare()).toThrow();
  });
  it('清空后迟到的解码不恢复旧图片', async () => {
    let complete!: (bitmap: ImageBitmap) => void;
    vi.mocked(createImageBitmap).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const pending = attachment.load(new Blob(['VIRTUAL'], { type: 'image/png' }));
    attachment.clear(); const close = vi.fn(); complete({ width: 100, height: 100, close } as unknown as ImageBitmap); await pending;
    expect(close).toHaveBeenCalledOnce(); expect(attachment.hasContent()).toBe(false);
  });
  it('不接收 SVG 或超大位图', async () => {
    await attachment.load(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    expect(attachment.hasContent()).toBe(false); expect(createImageBitmap).not.toHaveBeenCalled();
    vi.mocked(createImageBitmap).mockResolvedValue({ width: 10000, height: 10000, close: vi.fn() } as unknown as ImageBitmap);
    await attachment.load(new Blob(['VIRTUAL'], { type: 'image/png' })); expect(attachment.hasContent()).toBe(false);
    expect(changed).toHaveBeenCalledWith(expect.stringContaining('图片无法打开'));
  });
});
