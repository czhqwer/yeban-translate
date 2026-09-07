import { PANEL_PORT_NAME, type PanelCommand, type PanelRequest, type PanelResponse } from '../shared/panel';
import type { Reply, TranslationResult } from '../shared/types';

type PanelReply = Reply<TranslationResult | null>;
interface PendingMessage { resolve: (reply: PanelReply) => void; timer: ReturnType<typeof setTimeout>; }
interface Connection {
  port: chrome.runtime.Port;
  onMessage: (message: unknown) => void;
  onDisconnect: () => void;
}

/** 只展示本地固定错误文案，不回显连接异常、服务原始响应或鉴权内容。 */
function connectionError(timeout = false): PanelReply {
  return { ok: false, error: { code: timeout ? 'TIMEOUT' : 'DISCONNECTED', message: timeout ? '翻译等待超时，连接已关闭。请点击重试；已提交请求仍可能计入用量。' : '侧栏连接已中断，请点击翻译或重试重新连接。', retryable: true } };
}

/** 每个侧栏实例独立拥有连接与响应表，身份完全由浏览器 Port 提供。 */
export class PanelChannel {
  private connection?: Connection;
  private pending = new Map<string, PendingMessage>();
  private disposed = false;

  constructor(private readonly runtime: Pick<typeof chrome.runtime, 'connect'> = chrome.runtime, private readonly deadlineMs = 120_000) {}

  /** 只有用户主动翻译才可建立连接；取消不得为了发消息而重新连接。 */
  send(message: PanelCommand): Promise<PanelReply> {
    if (this.disposed) return Promise.resolve(connectionError());
    if (message.type === 'CANCEL_PANEL' && !this.connection) return Promise.resolve({ ok: true, value: null });
    let connection: Connection;
    try {
      connection = this.connection ?? this.connect();
    } catch {
      this.disconnect();
      return Promise.resolve(connectionError());
    }
    return new Promise(resolve => {
      let messageId: string;
      try { messageId = crypto.randomUUID(); }
      catch { this.closeConnection(connection, connectionError()); resolve(connectionError()); return; }
      const timer = setTimeout(() => this.closeConnection(connection, connectionError(true)), this.deadlineMs);
      this.pending.set(messageId, { resolve, timer });
      const envelope: PanelRequest = { messageId, message };
      try { connection.port.postMessage(envelope); }
      catch { this.closeConnection(connection, connectionError()); }
    });
  }

  /** 断连清理所有等待者，不自动重连或重放；下一次主动翻译可新建连接。 */
  disconnect(): void {
    if (this.connection) this.closeConnection(this.connection, connectionError());
  }

  /** 文档离开后永久失效，即便旧回调触发也不能创建新连接。 */
  dispose(): void { this.disposed = true; this.disconnect(); }

  private connect(): Connection {
    const port = this.runtime.connect({ name: PANEL_PORT_NAME });
    const connection: Connection = {
      port,
      onMessage: message => this.receive(connection, message),
      onDisconnect: () => {
        // 消费浏览器连接错误状态，避免其自动输出原始错误；不保存或展示细节。
        try { void (this.runtime as { lastError?: unknown }).lastError; } catch { /* 错误状态不可读时仍正常结束等待。 */ }
        this.closeConnection(connection, connectionError());
      },
    };
    this.connection = connection;
    try {
      port.onMessage.addListener(connection.onMessage);
      port.onDisconnect.addListener(connection.onDisconnect);
    } catch {
      this.closeConnection(connection, connectionError());
      throw new Error('侧栏连接初始化失败。');
    }
    return connection;
  }

  private receive(connection: Connection, message: unknown): void {
    if (this.connection !== connection || !message || typeof message !== 'object') return;
    const envelope = message as Partial<PanelResponse>;
    if (typeof envelope.messageId !== 'string') return;
    const pending = this.pending.get(envelope.messageId);
    if (!pending) return;
    const reply = this.validateReply(envelope.reply);
    if (!reply) { this.closeConnection(connection, connectionError()); return; }
    this.pending.delete(envelope.messageId);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }

  private validateReply(value: unknown): PanelReply | undefined {
    if (!value || typeof value !== 'object') return;
    const reply = value as Partial<PanelReply>;
    if (reply.ok === true) {
      if (reply.value === null) return { ok: true, value: null };
      if (reply.value && typeof reply.value.translated === 'string') return { ok: true, value: { translated: reply.value.translated } };
      return;
    }
    if (reply.ok !== false || !reply.error || typeof reply.error.code !== 'string' || typeof reply.error.retryable !== 'boolean') return;
    const messages: Record<string, string> = {
      AUTH: '服务凭据无效，请在设置中检查配置。',
      QUOTA: '服务额度不足，请检查服务用量。',
      CONFIG: '翻译服务配置不可用，请在设置中检查。',
      CONSENT: '请先在设置中确认文本发送说明。',
      RATE_LIMIT: '服务请求过于频繁，请稍后重试。',
      COOLDOWN: '服务正在等待限流恢复，请稍后重试。',
      SERVICE_REMOVED: '翻译服务配置已删除，请恢复配置或开始新的翻译。',
      PERMISSION: '侧栏暂时无法取得翻译权限，请重新打开后重试。',
      STALE_JOB: '此次翻译已失效，请重新开始。',
      CONFIG_CHANGED: '服务配置已变化，请重新开始翻译。',
      TIMEOUT: '翻译请求超时，请点击重试；已提交请求仍可能计入用量。',
      NETWORK: '暂时无法连接翻译服务，请稍后重试。',
      INVALID_RESULT: '服务未返回有效译文，请重试。',
      DISCONNECTED: '侧栏连接已中断，请点击翻译或重试重新连接。',
      CANCELLED: '此次翻译已停止。',
      CANCELED: '此次翻译已停止。',
    };
    const code = Object.prototype.hasOwnProperty.call(messages, reply.error.code) ? reply.error.code : 'TRANSLATION_FAILED';
    return { ok: false, error: { code, message: messages[code] ?? '翻译未完成，请检查配置后重试。', retryable: reply.error.retryable } };
  }

  private closeConnection(connection: Connection, reply: PanelReply): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    try { connection.port.onMessage.removeListener(connection.onMessage); } catch { /* 清理失败不影响等待者结束。 */ }
    try { connection.port.onDisconnect.removeListener(connection.onDisconnect); } catch { /* 清理失败不影响等待者结束。 */ }
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.resolve(reply); }
    this.pending.clear();
    try { connection.port.disconnect(); } catch { /* 已断开的连接无需再处理。 */ }
  }
}
