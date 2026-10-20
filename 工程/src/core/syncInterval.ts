import type { Settings } from "./model";

/** 本机检查云端新内容的周期；本机修改后的上传和手动同步不受它影响。 */
export const SYNC_INTERVAL_CHOICES = [
  { minutes: 5, label: "5分钟" },
  { minutes: 60, label: "1小时" },
  { minutes: 360, label: "6小时" },
  { minutes: 1440, label: "1天" },
] as const;

export type SyncIntervalMinutes = typeof SYNC_INTERVAL_CHOICES[number]["minutes"];
export const DEFAULT_SYNC_INTERVAL_MINUTES: SyncIntervalMinutes = 5;

/** 缺字段或未来版本使用了不支持的值时正常工作，原始设置由账本原样保留。 */
export function syncIntervalMinutes(settings?: Pick<Settings, "syncIntervalMinutes">): SyncIntervalMinutes {
  const value = settings?.syncIntervalMinutes;
  return SYNC_INTERVAL_CHOICES.some((choice) => choice.minutes === value)
    ? value as SyncIntervalMinutes : DEFAULT_SYNC_INTERVAL_MINUTES;
}

export function syncIntervalMs(settings?: Pick<Settings, "syncIntervalMinutes">): number {
  return syncIntervalMinutes(settings) * 60 * 1000;
}
