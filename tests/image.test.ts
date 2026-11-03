import { describe, expect, it, vi } from 'vitest';
import { cropRect, imageDimensions } from '../src/shared/image';
import { translateImage, type ServiceConfig } from '../src/background/providers';
import type { BackgroundMessage } from '../src/shared/types';

// 公开的透明 1×1 PNG 测试图，不包含用户数据。
export const TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhGQAAAAASUVORK5CYII=';
const config: ServiceConfig = { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen3-vl-plus', apiKey: 'VIRTUAL_IMAGE_TEST_ONLY', version: 1 };
const input: Extract<BackgroundMessage, { type: 'TRANSLATE_IMAGE' }> = { type: 'TRANSLATE_IMAGE', requestId: 'virtual-image', image: TEST_IMAGE, target: 'auto', operation: 'translate', imageConsent: true };
const response = (content: string, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }));

describe('图片裁剪、大小和服务契约', () => {
  it('正反向框选、越界坐标均按原图像素裁剪', () => {
    expect(cropRect({ x: 90, y: 80 }, { x: 10, y: 20 }, 100, 100)).toEqual({ x: 10, y: 20, width: 80, height: 60 });
    expect(cropRect({ x: -10, y: -20 }, { x: 200, y: 300 }, 100, 100)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
  it('识别真实 PNG 头部尺寸', () => expect(imageDimensions(TEST_IMAGE)).toEqual({ width: 1, height: 1 }));
  it.each(['https://example.test/image.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,AAAA', TEST_IMAGE.replace('png', 'jpeg'), TEST_IMAGE + '!', 'data:image/png;base64,' + 'A'.repeat(6_000_000)])('拒绝外部地址、伪装格式或超大字节串', value => expect(() => imageDimensions(value)).toThrow());
  it('拒绝零尺寸及超大像素，不信任界面元数据', () => {
    const bytes = Buffer.from(TEST_IMAGE.split(',')[1], 'base64');
    bytes.writeUInt32BE(99999, 16);
    expect(() => imageDimensions('data:image/png;base64,' + bytes.toString('base64'))).toThrow();
    bytes.writeUInt32BE(0, 16);
    expect(() => imageDimensions('data:image/png;base64,' + bytes.toString('base64'))).toThrow();
  });
  it('只把已确认图片发给白名单百炼，直接使用设置中的模型、不附加网页上下文', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response(JSON.stringify({ recognized: 'Original', translated: '译文' })));
    const check = vi.fn(async () => {});
    expect(await translateImage(config, input, { signal: new AbortController().signal, fetcher, beforeRequest: check })).toEqual({ recognized: 'Original', translated: '译文' });
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('qwen3-vl-plus'); expect(body.messages[0].content[0].image_url.url).toBe(TEST_IMAGE);
    expect(body.messages[0].content[1].text).toContain('否则翻译为简体中文'); expect(check).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  });
  it('仅识别路径丢弃模型多余译文，不自动发起第二次付费请求', async () => {
    const fetcher = vi.fn(async () => response(JSON.stringify({ recognized: 'Original', translated: '多余结果' })));
    expect(await translateImage(config, { ...input, operation: 'recognize' }, { signal: new AbortController().signal, fetcher })).toEqual({ recognized: 'Original', translated: '' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('没有图片确认不得发请求', async () => {
    const fetcher = vi.fn();
    await expect(translateImage(config, { ...input, imageConsent: false } as unknown as typeof input, { signal: new AbortController().signal, fetcher })).rejects.toMatchObject({ code: 'CONSENT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['非 JSON', '{"recognized":"","translated":"猜测"}', '{"recognized":"Hello","translated":{}}'])('拒绝无效识别结果', async content => {
    await expect(translateImage(config, input, { signal: new AbortController().signal, fetcher: vi.fn(async () => response(content)) })).rejects.toMatchObject({ code: 'INVALID_RESULT' });
  });
  it('截断和取消不能返回部分成功', async () => {
    await expect(translateImage(config, input, { signal: new AbortController().signal, fetcher: vi.fn(async () => response('{}', 'length')) })).rejects.toMatchObject({ code: 'TRUNCATED' });
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn();
    await expect(translateImage(config, input, { signal: controller.signal, fetcher })).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
