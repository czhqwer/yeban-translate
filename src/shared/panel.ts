import type { BackgroundMessage, Reply, TranslationResult } from './types';

/** 每个侧栏使用独立连接，身份由浏览器提供的 Port 绑定，不依赖可选文档字段。 */
export const PANEL_PORT_NAME = 'yeban-sidepanel-v1';
export type PanelCommand = Extract<BackgroundMessage, { type: 'TRANSLATE_PANEL' | 'TRANSLATE_IMAGE' | 'CANCEL_PANEL' }>;
export interface PanelRequest {
  messageId: string;
  message: PanelCommand;
}
export interface PanelResponse {
  messageId: string;
  reply: Reply<TranslationResult | null>;
}
