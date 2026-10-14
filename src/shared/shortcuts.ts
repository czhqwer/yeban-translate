const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const KEY_NAMES = new Set(['Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)]);

function normalizedKey(raw: string): string | undefined {
  if (raw.length === 1 && /[a-z0-9]/iu.test(raw)) return raw.toUpperCase();
  if (raw === ' ') return 'Space';
  return KEY_NAMES.has(raw) ? raw : undefined;
}

/** 快捷键必须包含 Ctrl、Alt 或 Meta，避免普通输入过程误触发翻译。 */
export function normalizeShortcut(value: string): string | undefined {
  const parts = value.split('+').map(part => part.trim()).filter(Boolean);
  const key = normalizedKey(parts.at(-1) ?? '');
  if (!key) return;
  const modifiers = new Set(parts.slice(0, -1));
  if ([...modifiers].some(part => !MODIFIER_ORDER.includes(part as typeof MODIFIER_ORDER[number]))) return;
  if (!modifiers.has('Ctrl') && !modifiers.has('Alt') && !modifiers.has('Meta')) return;
  return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), key].join('+');
}

/** 从一次真实键盘操作生成可保存的规范快捷键。 */
export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  const key = normalizedKey(event.key);
  if (!key) return;
  const modifiers = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta'].filter(Boolean) as string[];
  return normalizeShortcut([...modifiers, key].join('+'));
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const pressed = shortcutFromEvent(event);
  return Boolean(pressed && pressed === normalizeShortcut(shortcut));
}
