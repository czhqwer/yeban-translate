import { IMAGE_MAX_EDGE, IMAGE_MAX_PIXELS, imageDimensions, type CropRect } from '../shared/image';
import type { RegionStyle, Viewport } from '../shared/region';

/** 只在底色占据大多数像素时模拟覆盖；图片/渐变等复杂背景改用阅读卡片。 */
export function sampleStyle(pixels: Uint8ClampedArray): RegionStyle {
  const bins = new Map<string, { count: number; sum: number[] }>();
  for (let i = 0; i < pixels.length; i += 4) {
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
    const key = rgb.map(c => c >> 4).join(',');
    const bin = bins.get(key) ?? { count: 0, sum: [0, 0, 0] };
    bin.count++; rgb.forEach((c, j) => { bin.sum[j] += c; }); bins.set(key, bin);
  }
  const sorted = [...bins.values()].sort((a, b) => b.count - a.count);
  if (!sorted.length) return { background: '#f8f6f0', color: '#213e37', solid: false };
  const average = (bin: typeof sorted[number]) => bin.sum.map(c => Math.round(c / bin.count));
  const bg = average(sorted[0]);
  const luma = (rgb: number[]) => rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  const foreground = sorted.find(bin => Math.abs(luma(average(bin)) - luma(bg)) > 100);
  const fg = foreground ? average(foreground) : luma(bg) > 140 ? [30, 40, 36] : [240, 244, 241];
  return { background: `rgb(${bg.join(', ')})`, color: `rgb(${fg.join(', ')})`, solid: sorted[0].count / (pixels.length / 4) >= .65 };
}

/** 整屏位图仅短暂存在于后台，裁好后只把选区送给模型，不传入网页 DOM。 */
export async function prepareRegion(data: string, rect: CropRect, viewport: Viewport): Promise<{ image: string; style: RegionStyle }> {
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(data) || data.length > 32 * 1024 * 1024) throw new Error('无效截图');
  const bytes = Uint8Array.from(atob(data.split(',')[1]), char => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  try {
    const sx = bitmap.width / viewport.width, sy = bitmap.height / viewport.height;
    if (Math.abs(sx - sy) > .02 * Math.max(sx, sy)) throw new Error('窗口尺寸已变化');
    const x = Math.floor(rect.x * sx), y = Math.floor(rect.y * sy);
    const width = Math.min(bitmap.width - x, Math.ceil(rect.width * sx)), height = Math.min(bitmap.height - y, Math.ceil(rect.height * sy));
    const sample = new OffscreenCanvas(48, 48);
    const sc = sample.getContext('2d')!;
    sc.drawImage(bitmap, x, y, width, height, 0, 0, 48, 48);
    const style = sampleStyle(sc.getImageData(0, 0, 48, 48).data);
    let scale = Math.min(1, IMAGE_MAX_EDGE / width, IMAGE_MAX_EDGE / height, Math.sqrt(IMAGE_MAX_PIXELS / (width * height)));
    for (let i = 0; i < 4; i++, scale *= .75) {
      const canvas = new OffscreenCanvas(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)));
      canvas.getContext('2d')!.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: .94 });
      const output = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let j = 0; j < output.length; j += 8192) binary += String.fromCharCode(...output.subarray(j, j + 8192));
      const image = `data:image/jpeg;base64,${btoa(binary)}`;
      try { imageDimensions(image); return { image, style }; } catch { /* 降采样重试，绝不上传整屏。 */ }
    }
    throw new Error('选区过大');
  } finally { bitmap.close(); }
}
