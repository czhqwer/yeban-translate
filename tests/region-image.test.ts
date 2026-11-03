import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareRegion, sampleStyle } from '../src/background/region-image';
import { sameViewport, validRegion } from '../src/shared/region';

afterEach(() => vi.unstubAllGlobals());
describe('原位截图的裁剪与配色', () => {
  it('纯色纸张和深色背景选择对应的文字色；复杂背景使用卡片', () => {
    const pixels = new Uint8ClampedArray(400);
    for (let i = 0; i < 100; i++) pixels.set(i < 80 ? [255, 255, 255, 255] : [20, 20, 20, 255], i * 4);
    expect(sampleStyle(pixels)).toEqual({ solid: true, background: 'rgb(255, 255, 255)', color: 'rgb(20, 20, 20)' });
    for (let i = 0; i < 100; i++) pixels.set(i < 80 ? [20, 20, 20, 255] : [255, 255, 255, 255], i * 4);
    expect(sampleStyle(pixels)).toMatchObject({ solid: true, background: 'rgb(20, 20, 20)', color: 'rgb(255, 255, 255)' });
    for (let i = 0; i < 100; i++) pixels.set([i * 2, 200 - i, 80, 255], i * 4);
    expect(sampleStyle(pixels).solid).toBe(false);
  });
  it('拒绝非有限、越界和触控缩放坐标，视口任一变化即失效', () => {
    const viewport = { width: 800, height: 600, x: 0, y: 0, scale: 1 }, rect = { x: 10, y: 10, width: 200, height: 100 };
    expect(validRegion(rect, viewport)).toBe(true);
    for (const patch of [{ x: NaN }, { width: Infinity }, { width: 1000 }, { y: -1 }]) expect(validRegion({ ...rect, ...patch }, viewport)).toBe(false);
    expect(validRegion(rect, { ...viewport, scale: 2 })).toBe(false);
    expect(sameViewport(viewport, { ...viewport, y: 1 })).toBe(false);
  });
  it('高 DPI 使用选区像素裁剪，释放整屏位图，不输出整屏', async () => {
    const close = vi.fn(), draw = vi.fn();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhGQAAAAASUVORK5CYII=';
    // 输出必须为 JPEG；测试用最小 SOF 头部，仅验证尺寸与裁剪契约。
    const jpeg = new Uint8Array([255,216,255,192,0,17,8,0,100,0,200,3,1,17,0,2,17,0,3,17,0,255,217]);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1600, height: 1200, close })));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(readonly width: number, readonly height: number) {}
      getContext() { return { drawImage: draw, getImageData: () => ({ data: new Uint8ClampedArray(48 * 48 * 4).fill(255) }) }; }
      async convertToBlob() { return new Blob([jpeg], { type: 'image/jpeg' }); }
    });
    const result = await prepareRegion('data:image/jpeg;base64,' + png, { x: 20, y: 30, width: 100, height: 50 }, { width: 800, height: 600, x: 0, y: 0, scale: 1 });
    expect(draw.mock.calls[1].slice(1)).toEqual([40, 60, 200, 100, 0, 0, 200, 100]);
    expect(close).toHaveBeenCalledOnce(); expect(result.image).not.toContain(png);
  });
});
