import type { PublicSettings } from '../shared/types';

/** 功能偏好与浏览器授权分开判断，迁移数据缺少划词开关时默认开启。 */
export function websiteFeatures(settings: PublicSettings, origin: string): { authorized: boolean; selection: boolean; floating: boolean } {
  const allAuthorized = settings.allSitesEnabled === true && settings.allSitesGranted === true;
  const authorized = Boolean(origin) && !settings.blockedSites?.includes(origin) && (allAuthorized || settings.sites.includes(origin));
  return { authorized, selection: authorized && settings.selectionEnabled !== false, floating: authorized };
}

/** 原生 textarea 的 maxlength 按 UTF-16 计数，这里按完整 Unicode 字符检查。 */
export function unicodeLength(value: string): number {
  return Array.from(value).length;
}

/** 每次主动操作都递增代次，使取消、清空和改选后的迟到结果失效。 */
export class RequestVersion {
  private current = 0;

  begin(): number { this.current += 1; return this.current; }
  invalidate(): void { this.current += 1; }
  isCurrent(version: number): boolean { return version === this.current; }
}
