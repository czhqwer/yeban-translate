/** 页伴翻译的公开类型；此文件不包含真实服务配置。 */
export type ProviderId = 'bailian' | 'aliyun';
export type ProviderChoice = 'auto' | ProviderId;
export type SourceLanguage = 'auto' | 'zh' | 'en';
export type TargetLanguage = 'zh' | 'en';
export type TranslationMode = 'page' | 'selection';

export interface Preferences {
  provider: ProviderId;
  source: SourceLanguage;
  target: TargetLanguage;
}

/** 页面选择保留“自动”意图，实际任务使用解析后固定的 Preferences。 */
export interface TranslationSelection {
  provider: ProviderChoice;
  source: SourceLanguage;
  target: TargetLanguage;
}

/** 用户输入只在扩展可信页面与后台之间传递，不向网页返回。 */
export interface ServiceInput {
  endpoint: string;
  model?: string;
  apiKey?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
}

export interface PublicService {
  endpoint: string;
  model?: string;
  configured: boolean;
}

export interface PublicSettings {
  preferences: Preferences;
  services: Record<ProviderId, PublicService>;
  sites: string[];
  dataNoticeAccepted: boolean;
  providerPriority?: ProviderId[];
  selectionEnabled?: boolean;
  allSitesEnabled?: boolean;
  allSitesGranted?: boolean;
  blockedSites?: string[];
}

export interface PageContext {
  preferences: Preferences;
  services: Record<ProviderId, PublicService>;
  selectionEnabled: boolean;
  dataNoticeAccepted: boolean;
  providerPriority?: ProviderId[];
  floatingEnabled?: boolean;
  /** 悬浮按钮在可移动高度内的比例，仅包含界面位置。 */
  floatingPosition?: number;
  sidePanel?: SidePanelState;
}

/** 原生侧栏是窗口级状态；启用配置不等于已经打开。 */
export interface SidePanelState {
  windowId?: number;
  open: boolean;
  ready: boolean;
  canOpen: boolean;
  canToggle: boolean;
  version: number;
}

export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface BeginJobResult {
  revision: number;
}

export interface TranslationResult {
  translated: string;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: AppError };
export type PageState = 'idle' | 'running' | 'waiting' | 'partial' | 'stopped' | 'unavailable';
export interface PageStatus {
  state: PageState;
  completed: number;
  failed: number;
  pending: number;
  message?: string;
  preferences?: Preferences;
  selection?: TranslationSelection;
  canRestore?: boolean;
  sidePanel?: SidePanelState;
  actionError?: AppError;
}

export type BackgroundMessage =
  | { type: 'GET_SETTINGS' }
  | { type: 'GET_CONTEXT' }
  | { type: 'SET_FLOATING_POSITION'; position: number }
  | { type: 'SAVE_SETTINGS'; preferences?: Preferences; provider?: ProviderId; config?: ServiceInput; dataNoticeAccepted?: boolean; providerPriority?: ProviderId[]; selectionEnabled?: boolean }
  | { type: 'DELETE_SERVICE'; provider: ProviderId }
  | { type: 'TEST_SERVICE'; provider: ProviderId }
  | { type: 'ENABLE_SITE'; origin: string }
  | { type: 'DISABLE_SITE'; origin: string }
  | { type: 'ENABLE_ALL_SITES' }
  | { type: 'DISABLE_ALL_SITES' }
  | { type: 'OPEN_SIDE_PANEL'; tabId?: number }
  | { type: 'GET_SIDE_PANEL_STATE'; tabId?: number }
  | { type: 'SET_SIDE_PANEL'; open: boolean; tabId?: number; windowId?: number }
  | { type: 'TRANSLATE_PANEL'; requestId: string; preferences: Preferences; text: string }
  | { type: 'CANCEL_PANEL'; requestId: string }
  | { type: 'BEGIN_JOB'; mode: TranslationMode; jobId: string; preferences: Preferences }
  | { type: 'TRANSLATE'; mode: TranslationMode; jobId: string; itemId: string; text: string }
  | { type: 'CANCEL_JOB'; mode: TranslationMode; jobId?: string };

export type ContentMessage =
  | { type: 'PAGE_START'; preferences: Preferences; selection?: TranslationSelection }
  | { type: 'SET_SELECTION'; selection: TranslationSelection }
  | { type: 'SET_PREFERENCES'; preferences: Preferences }
  | { type: 'PAGE_STOP' }
  | { type: 'PAGE_RETRY' }
  | { type: 'RESTORE' }
  | { type: 'STATUS' }
  | { type: 'SITE_CHANGED'; enabled: boolean }
  | { type: 'SERVICE_REMOVED'; provider: ProviderId }
  | { type: 'FEATURES_CHANGED' }
  | { type: 'SIDE_PANEL_STATE'; state: SidePanelState };

export const DEFAULT_PREFERENCES: Preferences = { provider: 'bailian', source: 'auto', target: 'zh' };
export const PROVIDER_NAMES: Record<ProviderId, string> = { bailian: '百炼大模型', aliyun: '阿里云机器翻译' };
export const DEFAULT_SERVICES: Record<ProviderId, PublicService> = {
  bailian: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', configured: false },
  aliyun: { endpoint: 'https://mt.cn-hangzhou.aliyuncs.com', configured: false },
};
export const SELECTION_LIMIT = 2000;

/** 所有消息回复统一归类，界面不展示底层请求原文。 */
export async function send<T>(message: BackgroundMessage): Promise<Reply<T>> {
  try {
    return await chrome.runtime.sendMessage(message) as Reply<T>;
  } catch {
    return { ok: false, error: { code: 'DISCONNECTED', message: '扩展连接已中断，请刷新页面后重试。', retryable: true } };
  }
}
