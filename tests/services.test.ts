import { describe, expect, it } from 'vitest';
import { defaultSelection, normalizePriority, resolvePreferences, resolveProvider } from '../src/shared/services';
import type { PublicSettings } from '../src/shared/types';

/** 测试仅构造公开配置状态，不含凭据，不发送请求。 */
function state(bailian = false, aliyun = false): PublicSettings {
  return {
    preferences: { provider: 'aliyun', source: 'auto', target: 'zh' },
    services: { bailian: { endpoint: '', configured: bailian }, aliyun: { endpoint: '', configured: aliyun } },
    providerPriority: ['aliyun', 'bailian'], sites: [], dataNoticeAccepted: true,
  };
}

describe('统一服务优先级解析', () => {
  it('两个服务均未配置时不选择服务', () => expect(resolvePreferences(undefined, state())).toBeUndefined());
  it('只配置阿里时自动跳过百炼', () => expect(resolvePreferences(undefined, state(false, true))?.provider).toBe('aliyun'));
  it('只配置百炼时使用百炼', () => expect(resolvePreferences(undefined, state(true, false))?.provider).toBe('bailian'));
  it('两者已配置时遵循用户顺序', () => {
    const value = state(true, true); value.providerPriority = ['aliyun', 'bailian'];
    expect(resolvePreferences(undefined, value)?.provider).toBe('aliyun');
  });
  it('自动意图随新的优先级解析，不永久固定旧默认', () => {
    const value = state(true, true); const choice = defaultSelection(value);
    const first = resolvePreferences(choice, value);
    value.providerPriority = ['bailian', 'aliyun'];
    expect(first?.provider).toBe('aliyun');
    expect(resolvePreferences(choice, value)?.provider).toBe('bailian');
    expect(first?.provider).toBe('aliyun');
  });
  it('显式选择优先，未配置不替用户改选', () => {
    expect(resolveProvider('aliyun', state(true, true).services)).toBe('aliyun');
    expect(resolveProvider('aliyun', state(true, false).services)).toBeUndefined();
  });
  it('仅修改语言不改变自动选择意图', () => {
    const value = state(false, true); const selection = { ...defaultSelection(value), target: 'en' as const };
    expect(selection.provider).toBe('auto');
    expect(resolvePreferences(selection, value)).toEqual({ provider: 'aliyun', source: 'auto', target: 'en' });
  });
  it('旧设置迁移保留原默认顺序并补齐另一项', () => {
    expect(normalizePriority(undefined, 'aliyun')).toEqual(['aliyun', 'bailian']);
    expect(normalizePriority(undefined)).toEqual(['aliyun', 'bailian']);
  });
  it('只在读取旧数据时去重并补齐，忽略未知项目', () => expect(normalizePriority(['aliyun', 'invalid', 'aliyun'])).toEqual(['aliyun', 'bailian']));
  it('配置删除后自动选择其他服务，显式选择仍返回不可用', () => {
    const value = state(true, true); value.services.bailian.configured = false;
    expect(resolvePreferences(defaultSelection(value), value)?.provider).toBe('aliyun');
    expect(resolvePreferences({ provider: 'bailian', source: 'en', target: 'zh' }, value)).toBeUndefined();
  });
});
