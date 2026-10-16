import { LIST_COLORS } from "./model";

/** 记录里的颜色可用既有主题 token 或 CSS 十六进制颜色；其它值回到默认陶土色。 */
export function listColor(value: unknown): string {
  if (typeof value !== "string") return "var(--list-clay)";
  const color = value.trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return color;
  return LIST_COLORS.some((token) => token === color) ? `var(--list-${color})` : "var(--list-clay)";
}
