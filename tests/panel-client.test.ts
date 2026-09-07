import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelChannel } from '../src/sidepanel/channel';
import { PANEL_PORT_NAME, type PanelCommand, type PanelRequest, type PanelResponse } from '../src/shared/panel';

const channels: PanelChannel[] = [];
const command = (requestId: string): PanelCommand => ({ type: 'TRANSLATE_PANEL', requestId, preferences: { provider: 'bailian', source: 'en', target: 'zh' }, text: 'Public test text.' });

/** 模拟真实 Port 事件与传输；故意不提供可选 sender 元数据。 */
function fakePort() {
  const listeners = new Set<(message: unknown) => void>();
  const historicListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners = new Set<() => void>();
  const sent: PanelRequest[] = [];
  let closed = false;
  const disconnect = vi.fn(() => {
    if (closed) return;
    closed = true;
    for (const listener of [...disconnectListeners]) listener();
  });
  const port = {
    name: PANEL_PORT_NAME,
    postMessage: vi.fn((message: PanelRequest) => { if (closed) throw new Error('模拟连接已断开'); sent.push(message); }),
    disconnect,
    onMessage: { addListener: (listener: (message: unknown) => void) => { listeners.add(listener); historicListeners.push(listener); }, removeListener: (listener: (message: unknown) => void) => listeners.delete(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.add(listener), removeListener: (listener: () => void) => disconnectListeners.delete(listener) },
  } as unknown as chrome.runtime.Port;
  return {
    port, sent, disconnect,
    receive: (message: PanelResponse) => { for (const listener of [...listeners]) listener(message); },
    receiveLate: (message: PanelResponse) => { for (const listener of historicListeners) listener(message); },
    get closed() { return closed; },
  };
}

function setup(deadlineMs = 120_000) {
  const ports: ReturnType<typeof fakePort>[] = [];
  const runtime = { connect: vi.fn(() => { const port = fakePort(); ports.push(port); return port.port; }) };
  const channel = new PanelChannel(runtime, deadlineMs);
  channels.push(channel);
  return { channel, runtime, ports };
}

afterEach(() => { for (const channel of channels.splice(0)) channel.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('侧栏专用连接', () => {
  it('仅翻译主动建连，取消不新连，消息只包含契约字段且按 messageId 处理乱序响应', async () => {
    const { channel, runtime, ports } = setup();
    expect(runtime.connect).not.toHaveBeenCalled();
    expect(await channel.send({ type: 'CANCEL_PANEL', requestId: 'no-request' })).toEqual({ ok: true, value: null });
    expect(runtime.connect).not.toHaveBeenCalled();
    const first = channel.send(command('first'));
    const second = channel.send(command('second'));
    expect(runtime.connect).toHaveBeenCalledExactlyOnceWith({ name: PANEL_PORT_NAME });
    expect(ports[0].port.sender).toBeUndefined();
    expect(Object.keys(ports[0].sent[0]).sort()).toEqual(['message', 'messageId']);
    expect(Object.keys(ports[0].sent[0].message).sort()).toEqual(['preferences', 'requestId', 'text', 'type']);
    expect(ports[0].sent[0].messageId).not.toBe(ports[0].sent[1].messageId);
    ports[0].receive({ messageId: ports[0].sent[1].messageId, reply: { ok: true, value: { translated: '第二条' } } });
    ports[0].receive({ messageId: ports[0].sent[0].messageId, reply: { ok: true, value: { translated: '第一条' } } });
    expect(await first).toEqual({ ok: true, value: { translated: '第一条' } });
    expect(await second).toEqual({ ok: true, value: { translated: '第二条' } });
  });

  it('断连统一结束全部等待，不自动重放，主动重试新建连接且忽略旧连接消息', async () => {
    const { channel, runtime, ports } = setup();
    const first = channel.send(command('first'));
    const second = channel.send(command('second'));
    ports[0].disconnect();
    for (const reply of await Promise.all([first, second])) expect(reply).toMatchObject({ ok: false, error: { code: 'DISCONNECTED', retryable: true } });
    expect(runtime.connect).toHaveBeenCalledTimes(1);
    const retry = channel.send(command('retry'));
    expect(runtime.connect).toHaveBeenCalledTimes(2);
    const newMessageId = ports[1].sent[0].messageId;
    ports[0].receiveLate({ messageId: newMessageId, reply: { ok: true, value: { translated: '旧连接伪迟到结果' } } });
    ports[1].receive({ messageId: newMessageId, reply: { ok: true, value: { translated: '新的结果' } } });
    expect(await retry).toEqual({ ok: true, value: { translated: '新的结果' } });
    expect(ports[1].sent).toHaveLength(1);
  });

  it('两个实例即便 requestId 相同也保持独立，一方取消或断开不影响另一方', async () => {
    const { channel, runtime, ports } = setup();
    const other = new PanelChannel(runtime);
    channels.push(other);
    const first = channel.send(command('same-id'));
    const second = other.send(command('same-id'));
    const cancel = channel.send({ type: 'CANCEL_PANEL', requestId: 'same-id' });
    ports[0].receive({ messageId: ports[0].sent[1].messageId, reply: { ok: true, value: null } });
    expect(await cancel).toEqual({ ok: true, value: null });
    channel.disconnect();
    expect(await first).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } });
    expect(ports[1].closed).toBe(false);
    ports[1].receive({ messageId: ports[1].sent[0].messageId, reply: { ok: true, value: { translated: '另一个侧栏的结果' } } });
    expect(await second).toEqual({ ok: true, value: { translated: '另一个侧栏的结果' } });
  });

  it('等待到达有限期限后断连清理，不无限等待或自动重放', async () => {
    vi.useFakeTimers();
    const { channel, runtime, ports } = setup(500);
    const translation = channel.send(command('timeout'));
    await vi.advanceTimersByTimeAsync(501);
    expect(await translation).toMatchObject({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
    expect(ports[0].closed).toBe(true);
    expect(runtime.connect).toHaveBeenCalledTimes(1);
    expect(await channel.send({ type: 'CANCEL_PANEL', requestId: 'timeout' })).toEqual({ ok: true, value: null });
    expect(runtime.connect).toHaveBeenCalledTimes(1);
  });

  it('异常和服务错误只返回固定中文，不回显底层细节，销毁后不会重新连接', async () => {
    const { channel, runtime, ports } = setup();
    runtime.connect.mockImplementationOnce(() => { throw new Error('RAW_CONNECT_TEST_DETAIL'); });
    expect(JSON.stringify(await channel.send(command('failed-connect')))).not.toContain('RAW_CONNECT_TEST_DETAIL');
    const response = channel.send(command('service-error'));
    ports[0].receive({ messageId: ports[0].sent[0].messageId, reply: { ok: false, error: { code: 'AUTH', message: 'RAW_SERVICE_TEST_DETAIL', retryable: false } } });
    expect(await response).toEqual({ ok: false, error: { code: 'AUTH', message: '服务凭据无效，请在设置中检查配置。', retryable: false } });
    channel.dispose();
    const connectionCount = runtime.connect.mock.calls.length;
    expect(await channel.send(command('after-dispose'))).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } });
    expect(runtime.connect).toHaveBeenCalledTimes(connectionCount);
  });
});
