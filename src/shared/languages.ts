/** 两种翻译服务共同覆盖的常用语言，代码直接用于服务请求。 */
export const LANGUAGE_OPTIONS = [
  { code: 'zh', name: '简体中文', htmlLang: 'zh-CN' },
  { code: 'en', name: '英语', htmlLang: 'en' },
  { code: 'ja', name: '日语', htmlLang: 'ja' },
  { code: 'ko', name: '韩语', htmlLang: 'ko' },
  { code: 'fr', name: '法语', htmlLang: 'fr' },
  { code: 'de', name: '德语', htmlLang: 'de' },
  { code: 'es', name: '西班牙语', htmlLang: 'es' },
  { code: 'pt', name: '葡萄牙语', htmlLang: 'pt' },
  { code: 'it', name: '意大利语', htmlLang: 'it' },
  { code: 'ru', name: '俄语', htmlLang: 'ru' },
  { code: 'ar', name: '阿拉伯语', htmlLang: 'ar' },
  { code: 'tr', name: '土耳其语', htmlLang: 'tr' },
  { code: 'id', name: '印度尼西亚语', htmlLang: 'id' },
  { code: 'vi', name: '越南语', htmlLang: 'vi' },
  { code: 'th', name: '泰语', htmlLang: 'th' },
  { code: 'pl', name: '波兰语', htmlLang: 'pl' },
] as const;

export type LanguageCode = typeof LANGUAGE_OPTIONS[number]['code'];
export type SourceLanguage = 'auto' | LanguageCode;

const languageCodes = new Set<string>(LANGUAGE_OPTIONS.map(language => language.code));

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && languageCodes.has(value);
}

export function isSourceLanguage(value: unknown): value is SourceLanguage {
  return value === 'auto' || isLanguageCode(value);
}

export function languageName(code: LanguageCode): string {
  return LANGUAGE_OPTIONS.find(language => language.code === code)?.name ?? code;
}

export function htmlLanguage(code: LanguageCode): string {
  return LANGUAGE_OPTIONS.find(language => language.code === code)?.htmlLang ?? code;
}
