import { IMAGE_MAX_EDGE, IMAGE_MAX_PIXELS, imageDimensions } from '../shared/image';
import { element } from '../ui/common';

/** 粘贴图片只是文本侧栏的附件，不创建新页面，也不在载入时请求服务。 */
export class ImageAttachment {
  private bitmap?: ImageBitmap;
  private url?: string;
  private generation = 0;
  private disposed = false;
  loading = false;
  private readonly preview = element<HTMLImageElement>('image-preview');
  constructor(private readonly changed: (error?: string) => void) {}
  hasContent(): boolean { return Boolean(this.bitmap); }

  async load(file: Blob): Promise<void> {
    if (this.disposed) return;
    this.clear(); this.loading = true; this.changed();
    const version = ++this.generation;
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 16 * 1024 * 1024) throw new Error();
      const bitmap = await createImageBitmap(file);
      if (version !== this.generation || this.disposed) { bitmap.close(); return; }
      if (bitmap.width * bitmap.height > 32_000_000) { bitmap.close(); throw new Error(); }
      this.bitmap = bitmap;
      this.url = URL.createObjectURL(file); this.preview.src = this.url;
      element('image-attachment').hidden = false;
    } catch { if (version === this.generation) this.changed('图片无法打开，请粘贴不超过 16 MB、3200 万像素的 PNG、JPEG 或 WebP 图片。'); }
    finally { if (version === this.generation) { this.loading = false; this.changed(); } }
  }

  prepare(): string {
    if (!this.bitmap) throw new Error();
    const { width, height } = this.bitmap;
    let scale = Math.min(1, IMAGE_MAX_EDGE / width, IMAGE_MAX_EDGE / height, Math.sqrt(IMAGE_MAX_PIXELS / (width * height)));
    const canvas = document.createElement('canvas');
    for (let i = 0; i < 4; i++, scale *= .75) {
      canvas.width = Math.max(1, Math.floor(width * scale)); canvas.height = Math.max(1, Math.floor(height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error();
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(this.bitmap, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', .94);
      try { imageDimensions(data); return data; } catch { /* 降采样并移除元信息后重试。 */ }
    }
    throw new Error();
  }

  clear(): void {
    this.generation++; this.loading = false; this.bitmap?.close(); this.bitmap = undefined;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined; this.preview.removeAttribute('src'); element('image-attachment').hidden = true;
  }
  dispose(): void { this.disposed = true; this.clear(); }
}
