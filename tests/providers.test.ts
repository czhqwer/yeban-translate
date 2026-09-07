import { createHash, createHmac, webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asError } from '../src/background/errors';
import { mergeService, parseAliyunResult, parseBailianResult, canonicalForm, formEncode, signAliyunRequest, splitText, translate, validateEndpoint, type ServiceConfig } from '../src/background/providers';

const bailian: ServiceConfig = { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', apiKey: 'VIRTUAL_ONLY_NOT_A_REAL_VALUE', version: 1 };
const aliyun: ServiceConfig = { endpoint: 'https://mt.cn-hangzhou.aliyuncs.com', accessKeyId: 'VIRTUAL_ID_ONLY', accessKeySecret: 'VIRTUAL_SIGNING_MATERIAL_ONLY', version: 1 };
const ok = (text = '你好') => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] }), { status: 200 });

beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });

describe('服务端点与结果校验', () => {
  it('接收官方完整路径与工作空间端点，规范化基础路径', () => {
    expect(validateEndpoint('bailian', 'https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(bailian.endpoint);
    expect(validateEndpoint('bailian', 'https://workspace-demo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions')).toContain('workspace-demo.cn-beijing.maas.aliyuncs.com');
    expect(validateEndpoint('aliyun', aliyun.endpoint)).toBe(aliyun.endpoint);
  });

  it.each([
    'https://dashscope.aliyuncs.com.attacker.test/compatible-mode/v1',
    'https://user@dashscope.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1?x=1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1#fragment',
    'http://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com:9443/compatible-mode/v1',
    'https://other.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com/another/path',
  ])('拒绝非白名单或含隐藏参数的地址：%s', address => {
    expect(() => validateEndpoint('bailian', address)).toThrow();
  });

  it('保存时保留留空的已有值，且不会误收其他服务字段', () => {
    const saved = mergeService('bailian', bailian, { endpoint: bailian.endpoint, apiKey: '', model: 'qwen-plus', accessKeyId: 'IGNORED_VIRTUAL' });
    expect(saved.apiKey).toBe(bailian.apiKey);
    expect(saved.version).toBe(2);
    expect(saved.accessKeyId).toBeUndefined();
  });

  it('拒绝截断、空译文、非文本输出和不完整结束状态', () => {
    expect(() => parseBailianResult({ choices: [{ finish_reason: 'length', message: { content: '部分内容' } }] })).toThrow('截断');
    expect(() => parseBailianResult({ choices: [{ finish_reason: 'stop', message: { content: '' } }] })).toThrow('未返回译文');
    expect(() => parseBailianResult({ choices: [{ finish_reason: 'stop', message: { content: [] } }] })).toThrow();
    expect(() => parseBailianResult({ choices: [{ finish_reason: 'tool_calls', message: { content: '解释' } }] })).toThrow();
    expect(() => parseAliyunResult({ Code: 200, Data: {} })).toThrow('未返回译文');
  });

  it.each([
    [10001, 'TIMEOUT', true],
    [10003, 'SERVICE_REQUEST', false],
    [10004, 'SERVICE_REQUEST', false],
    [10005, 'INVALID_REQUEST', false],
    [10006, 'INVALID_REQUEST', false],
    [10007, 'SERVICE', true],
    [10008, 'INVALID_REQUEST', false],
    [10009, 'AUTH', false],
    [10010, 'CONFIG', false],
    [10011, 'SERVICE', true],
    [10012, 'SERVICE', true],
    [10013, 'QUOTA', false],
  ])('阿里业务码 %i 映射为 %s，兼容数字与字符串且不透传错误原文', (businessCode, code, retryable) => {
    for (const value of [businessCode, String(businessCode)]) {
      try {
        parseAliyunResult({ TranslateGeneralResponse: { Code: value, Message: 'DO_NOT_ECHO_REMOTE_BUSINESS_MESSAGE' } });
        expect.unreachable();
      } catch (error) {
        expect(asError(error)).toMatchObject({ code, retryable });
        expect(JSON.stringify(asError(error))).not.toContain('DO_NOT_ECHO');
      }
    }
  });
});

describe('阿里云 ACS3 签名与 Unicode 分段', () => {
  it('准确编码表单，并与独立 Node 加密实现核对完整 ACS3 签名', async () => {
    expect(formEncode("你好 +~!*'()" )).toBe('%E4%BD%A0%E5%A5%BD%20%2B~%21%2A%27%28%29');
    const params = { SourceText: '你好 + A', FormatType: 'text', Scene: 'general', SourceLanguage: 'zh', TargetLanguage: 'en' };
    const body = 'FormatType=text&Scene=general&SourceLanguage=zh&SourceText=%E4%BD%A0%E5%A5%BD%20%2B%20A&TargetLanguage=en';
    expect(canonicalForm(params)).toBe(body);
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const bodyDigest = digest(body);
    const headerNames = 'content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version';
    const headerText = `content-type:application/x-www-form-urlencoded\nhost:mt.cn-hangzhou.aliyuncs.com\nx-acs-action:TranslateGeneral\nx-acs-content-sha256:${bodyDigest}\nx-acs-date:2026-09-07T01:00:00Z\nx-acs-signature-nonce:virtual-nonce\nx-acs-version:2018-10-12\n`;
    const canonical = ['POST', '/', '', headerText, headerNames, bodyDigest].join('\n');
    const expected = createHmac('sha256', 'VIRTUAL_SIGNING_ONLY').update(`ACS3-HMAC-SHA256\n${digest(canonical)}`).digest('hex');
    const signed = await signAliyunRequest(aliyun.endpoint, params, 'VIRTUAL_ID_ONLY', 'VIRTUAL_SIGNING_ONLY', '2026-09-07T01:00:00Z', 'virtual-nonce');
    expect(signed.body).toBe(body);
    expect(signed.headers.Authorization).toBe(`ACS3-HMAC-SHA256 Credential=VIRTUAL_ID_ONLY,SignedHeaders=${headerNames},Signature=${expected}`);
    expect(signed.headers.host).toBeUndefined();
    expect(await signAliyunRequest(aliyun.endpoint, { ...params }, 'VIRTUAL_ID_ONLY', 'VIRTUAL_SIGNING_ONLY', '2026-09-07T01:00:00Z', 'virtual-nonce')).toEqual(signed);
  });

  it('按 Unicode 字符分片，不丢字、不截断代理对且优先句边界', () => {
    const text = '你好😀。'.repeat(1500);
    const chunks = splitText(text, 4000);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => Array.from(chunk).length <= 4000)).toBe(true);
    expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
    expect(splitText('abcdef。xyzxyz', 8)[0]).toBe('abcdef。');
  });

  it('保护标记在请求长度边缘保持完整且不突破分片上限', () => {
    const marker = '[[YEBAN_KEEP_demo_0]]';
    const formatMarker = '[[YEBAN_FMT_demo_0_OPEN]]';
    const text = 'a'.repeat(1597) + marker + 'Hello' + 'b'.repeat(1597) + formatMarker + 'world';
    const chunks = splitText(text, 1600);
    expect(chunks.join('')).toBe(text);
    expect(chunks.some(chunk => chunk.includes(marker))).toBe(true);
    expect(chunks.some(chunk => chunk.includes(formatMarker))).toBe(true);
    expect(chunks.every(chunk => Array.from(chunk).length <= 1600)).toBe(true);
  });

  it('阿里机翻发送表单签名、自动语言和中英参数，重定向与附带身份均关闭', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ Code: '200', Data: { Translated: 'Hello' } })));
    const result = await translate(aliyun, { provider: 'aliyun', source: 'auto', target: 'en' }, '你好😀', { signal: new AbortController().signal, fetcher });
    expect(result).toBe('Hello');
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(aliyun.endpoint);
    const form = new URLSearchParams(String(call[1].body));
    expect((call[1].headers as Record<string, string>)['x-acs-action']).toBe('TranslateGeneral');
    expect((call[1].headers as Record<string, string>)['x-acs-version']).toBe('2018-10-12');
    expect(form.get('SourceLanguage')).toBe('auto');
    expect(form.get('TargetLanguage')).toBe('en');
    expect(form.get('SourceText')).toBe('你好😀');
    expect((call[1].headers as Record<string, string>).Authorization).toContain('ACS3-HMAC-SHA256');
    expect(form.get('Signature')).toBeNull();
    expect(call[1].credentials).toBe('omit');
    expect(call[1].redirect).toBe('error');
  });

  it('多语请求向阿里机翻传递标准代码，并在百炼提示词中使用语言名称', async () => {
    const aliyunFetcher = vi.fn(async () => new Response(JSON.stringify({ Code: '200', Data: { Translated: 'Bonjour' } })));
    await translate(aliyun, { provider: 'aliyun', source: 'de', target: 'fr' }, 'Guten Tag', { signal: new AbortController().signal, fetcher: aliyunFetcher });
    const aliyunCall = aliyunFetcher.mock.calls[0] as unknown as [string, RequestInit];
    const form = new URLSearchParams(String(aliyunCall[1].body));
    expect(form.get('SourceLanguage')).toBe('de');
    expect(form.get('TargetLanguage')).toBe('fr');

    const bailianFetcher = vi.fn(async () => ok('안녕하세요'));
    await translate(bailian, { provider: 'bailian', source: 'ja', target: 'ko' }, 'こんにちは', { signal: new AbortController().signal, fetcher: bailianFetcher });
    const bailianCall = bailianFetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(bailianCall[1].body));
    expect(body.messages[0].content).toContain('原文语言为日语，翻译为韩语');
  });

  it('支持通用版官方示例的外层响应包装', () => {
    expect(parseAliyunResult({ TranslateGeneralResponse: { Code: 200, Data: { Translated: 'Hello' } } })).toBe('Hello');
  });
});

describe('文本调用与停止', () => {
  it('百炼设置目标语言并仅提取文本，每个分片在发送前复验', async () => {
    const fetcher = vi.fn(async () => ok());
    const beforeRequest = vi.fn(async () => undefined);
    const result = await translate(bailian, { provider: 'bailian', source: 'en', target: 'zh' }, 'a'.repeat(2000), { signal: new AbortController().signal, fetcher, beforeRequest });
    expect(result).toBe('你好\n你好');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1].body));
    expect(body.messages[0].content).toContain('翻译为简体中文');
    expect(body.stream).toBe(false);
    expect(body.enable_thinking).toBe(false);
    expect(body.max_tokens).toBe(4096);
  });

  it('取消后的迟到结果不得成功，也不得发出后续分片', async () => {
    const controller = new AbortController();
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const result = translate(bailian, { provider: 'bailian', source: 'en', target: 'zh' }, 'a'.repeat(2000), { signal: controller.signal, fetcher });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    release(ok());
    await expect(result).rejects.toMatchObject({ code: 'CANCELED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('鉴权错误不回显服务原始错误正文', async () => {
    const fetcher = vi.fn(async () => new Response('DO_NOT_ECHO_PROVIDER_RESPONSE', { status: 401 }));
    try {
      await translate(bailian, { provider: 'bailian', source: 'en', target: 'zh' }, 'Hello', { signal: new AbortController().signal, fetcher });
      expect.unreachable();
    } catch (error) {
      expect(asError(error).code).toBe('AUTH');
      expect(JSON.stringify(asError(error))).not.toContain('DO_NOT_ECHO');
    }
  });

  it('超时明确失败，不无限等待', async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await expect(translate(bailian, { provider: 'bailian', source: 'en', target: 'zh' }, 'Hello', { signal: new AbortController().signal, fetcher, timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
