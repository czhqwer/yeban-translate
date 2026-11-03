/** 图片只通过可信扩展界面传递，不接受远程图片 URL。 */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_MAX_EDGE = 4096;
export const IMAGE_MAX_PIXELS = 10_000_000;
export type ReadingDraft = { id: string } & (
  | { kind: 'text'; text: string }
  | { kind: 'error'; message: string }
);
export interface CropRect { x: number; y: number; width: number; height: number }

/** 鼠标正反向拖动都转换为原图像素，并裁到图像边界内。 */
export function cropRect(a: { x: number; y: number }, b: { x: number; y: number }, width: number, height: number): CropRect {
  const x = Math.max(0, Math.min(width, Math.floor(Math.min(a.x, b.x))));
  const y = Math.max(0, Math.min(height, Math.floor(Math.min(a.y, b.y))));
  return { x, y, width: Math.max(0, Math.min(width, Math.ceil(Math.max(a.x, b.x))) - x), height: Math.max(0, Math.min(height, Math.ceil(Math.max(a.y, b.y))) - y) };
}

/** 后台独立校验格式、字节和像素限制；不信任界面宣称的 MIME 或尺寸。 */
export function imageDimensions(data: unknown): { width: number; height: number } {
  const bad = () => { throw new Error('图片无效或过大，请重新选择不超过 4 MB、4096 像素边长的 PNG/JPEG 图片。'); };
  if (typeof data !== 'string' || data.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 32) return bad();
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match || match[2].length % 4 !== 0) return bad();
  let bytes: string;
  try { bytes = atob(match[2]); } catch { return bad(); }
  if (bytes.length > IMAGE_MAX_BYTES) return bad();
  const byte = (n: number) => bytes.charCodeAt(n);
  const uint16 = (n: number) => byte(n) * 256 + byte(n + 1);
  const uint32 = (n: number) => uint16(n) * 65536 + uint16(n + 2);
  let width = 0, height = 0;
  if (match[1] === 'png') {
    if (!bytes.startsWith('\x89PNG\r\n\x1a\n') || bytes.length < 33 || bytes.slice(12, 16) !== 'IHDR' || uint32(8) !== 13) return bad();
    width = uint32(16); height = uint32(20);
  } else {
    if (!bytes.startsWith('\xff\xd8')) return bad();
    let i = 2;
    while (i + 8 < bytes.length) {
      if (byte(i++) !== 255) return bad();
      while (byte(i) === 255) i++;
      const marker = byte(i++);
      if (marker === 0xda || marker === 0xd9) break;
      const length = uint16(i);
      if (length < 2 || i + length > bytes.length) return bad();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { height = uint16(i + 3); width = uint16(i + 5); break; }
      i += length;
    }
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > IMAGE_MAX_EDGE || height > IMAGE_MAX_EDGE || width * height > IMAGE_MAX_PIXELS) return bad();
  return { width, height };
}
