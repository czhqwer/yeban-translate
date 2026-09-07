import { LANGUAGE_OPTIONS } from '../shared/languages';

/** 三个扩展界面共用同一语言清单，避免支持范围逐处漂移。 */
export function populateLanguageSelect(select: HTMLSelectElement, includeAuto: boolean): void {
  const previous = select.value;
  select.replaceChildren();
  if (includeAuto) select.add(new Option('自动识别', 'auto'));
  for (const language of LANGUAGE_OPTIONS) select.add(new Option(language.name, language.code));
  const fallback = includeAuto ? 'auto' : 'zh';
  select.value = Array.from(select.options).some(option => option.value === previous) ? previous : fallback;
}
