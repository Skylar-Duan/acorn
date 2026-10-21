/** KeyboardEvent.code 与 Tauri 使用相同的实体键名，避开 Shift 后的 !、+ 和输入法字符。 */
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta)(Left|Right)$/;
const NAMED_KEYS = new Set([
  "Space", "Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote",
  "Backquote", "Comma", "Period", "Slash", "NumpadAdd", "NumpadSubtract", "NumpadMultiply",
  "NumpadDivide", "NumpadDecimal", "NumpadEnter",
]);

export function shortcutKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^(F([1-9]|1[0-9]|2[0-4])|Numpad[0-9])$/.test(code) || NAMED_KEYS.has(code)) return code;
  return null;
}

export function isShortcutModifier(code: string): boolean { return MODIFIER_CODES.test(code); }

export function recordShortcut(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">, held: Set<string>) {
  const modifiers = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super"].filter(Boolean) as string[];
  const codes = [...held].filter((code) => !isShortcutModifier(code));
  const keys = codes.map(shortcutKey);
  const parts = [...modifiers, ...keys.filter((key): key is string => key !== null)];
  let error = "";
  if (keys.some((key) => key === null)) error = "暂不支持这个按键，请换一组。";
  else if (parts.length > 3) error = "最多三个键，请松开后重新按。";
  else if (keys.length > 1) error = "请使用修饰键加一个字母、数字或功能键。";
  else if (keys.length === 0) error = "再按一个字母、数字或功能键。";
  else if (modifiers.length === 0 && !/^F\d+$/.test(keys[0]!)) error = "请加上 Ctrl、Alt、Shift 或 Win，避免误触。";
  const value = parts.slice(0, 3).join("+");
  if (!error) error = shortcutConflict(parts);
  return { value, error };
}

function shortcutConflict(parts: string[]): string {
  const key = parts[parts.length - 1];
  if ((parts.includes("Ctrl") || parts.includes("Super")) && ["1", "2", "3", "4", "5", "K", "F", "Z", "D", "ArrowRight"].includes(key)) {
    return "这组按键已用于橡果的其他操作，请换一组。";
  }
  if ((parts.includes("Alt") && ["Tab", "F4", "Escape"].includes(key)) ||
      (parts.includes("Ctrl") && parts.includes("Alt") && key === "Delete") ||
      (parts.includes("Super") && ["L", "D", "E", "R", "Tab"].includes(key))) {
    return "这组按键由系统使用，请换一组。";
  }
  return "";
}
