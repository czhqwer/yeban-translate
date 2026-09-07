import type { AppError, Reply } from '../shared/types';

/** 对外只提供预定义中文错误，不传播服务响应与用户配置。 */
export class TranslationError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'TranslationError';
  }
}

export function cancelled(): TranslationError {
  return new TranslationError('CANCELED', '翻译已停止，请重新开始。');
}

export function asError(error: unknown): AppError {
  if (error instanceof TranslationError) return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: 'INTERNAL', message: '操作未完成，请稍后重试。', retryable: true };
}

export function failure<T = never>(error: unknown): Reply<T> {
  return { ok: false, error: asError(error) };
}

export function invalid(message = '请求参数无效，请刷新后重试。'): never {
  throw new TranslationError('INVALID_REQUEST', message);
}
