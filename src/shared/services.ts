import type { PageContext, Preferences, ProviderChoice, ProviderId, PublicService, PublicSettings, TranslationSelection } from './types';

export const DEFAULT_PRIORITY: ProviderId[] = ['aliyun', 'bailian'];
type AvailableServices = Record<ProviderId, PublicService>;
type ServiceState = Pick<PublicSettings | PageContext, 'preferences' | 'services' | 'providerPriority'>;

/** 读取旧数据时补齐去重；保存端仍需严格验证用户提交的顺序。 */
export function normalizePriority(value: unknown, previous?: ProviderId): ProviderId[] {
  const input: unknown[] = Array.isArray(value) ? value : previous ? [previous] : [];
  const output: ProviderId[] = [];
  for (const item of [...input, ...DEFAULT_PRIORITY]) {
    if ((item === 'bailian' || item === 'aliyun') && !output.includes(item)) output.push(item);
  }
  return output;
}

/** 只查配置状态，不发送连接测试；显式选择不可被其他服务替代。 */
export function resolveProvider(choice: ProviderChoice, services: AvailableServices, priority?: ProviderId[]): ProviderId | undefined {
  if (choice !== 'auto') return services[choice]?.configured ? choice : undefined;
  return normalizePriority(priority).find(id => services[id]?.configured);
}

/** 新任务统一解析；开始后保留返回快照，不因排序变化改换服务。 */
export function resolvePreferences(selection: TranslationSelection | undefined, state: ServiceState): Preferences | undefined {
  const current = selection ?? { provider: 'auto', source: state.preferences.source, target: state.preferences.target };
  const provider = resolveProvider(current.provider, state.services, state.providerPriority);
  return provider ? { provider, source: current.source, target: current.target } : undefined;
}

/** 全局默认只决定语言，服务按最新优先级自动解析。 */
export function defaultSelection(state: ServiceState): TranslationSelection {
  return { provider: 'auto', source: state.preferences.source, target: state.preferences.target };
}
