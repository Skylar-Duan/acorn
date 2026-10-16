import type { AppData, TaskImage } from "./model";

export const IMAGE_MAX_COUNT = 8;
export const IMAGE_MAX_BYTES = 256 * 1024;
export const IMAGE_LEDGER_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_EDGE = 1920;
export const IMAGE_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_SOURCE_MAX_PIXELS = 40_000_000;
export const IMAGE_SOURCE_MAX_EDGE = 16384;

/** 只读取认识的字段，不重建记录；未知字段随原对象保留。 */
export function taskImages(value: unknown): TaskImage[] {
  return Array.isArray(value) ? value as TaskImage[] : [];
}
export function imageUrlLength(image: TaskImage): number { return image && typeof image.dataUrl === "string" ? image.dataUrl.length : 0; }
export function imageDataBytes(dataUrl: string): number {
  const body = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.max(0, body.length * 3 / 4 - padding);
}
export function ledgerImageBytes(data: Pick<AppData, "tasks">): number {
  let bytes = 0;
  for (const task of data.tasks) {
    for (const image of taskImages(task.images)) bytes += imageUrlLength(image);
    for (const sub of task.subtasks) for (const image of taskImages(sub.images)) bytes += imageUrlLength(image);
  }
  return bytes;
}
export function imageSourceError(bytes: number, width?: number, height?: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > IMAGE_SOURCE_MAX_BYTES) return "原图需小于 20 MB";
  if (width !== undefined && height !== undefined && (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > IMAGE_SOURCE_MAX_EDGE || height > IMAGE_SOURCE_MAX_EDGE || width * height > IMAGE_SOURCE_MAX_PIXELS)) return "原图尺寸过大，请先缩小到 4000 万像素以内";
  return null;
}
export function validNewTaskImage(image: TaskImage): boolean {
  return !!image && typeof image.id === "string" && !!image.id && typeof image.name === "string" &&
    /^data:image\/jpeg;base64,[a-zA-Z0-9+/]+={0,2}$/.test(image.dataUrl) &&
    Number.isInteger(image.width) && image.width > 0 && image.width <= IMAGE_MAX_EDGE &&
    Number.isInteger(image.height) && image.height > 0 && image.height <= IMAGE_MAX_EDGE &&
    Number.isInteger(image.bytes) && image.bytes > 0 && image.bytes <= IMAGE_MAX_BYTES && imageDataBytes(image.dataUrl) === image.bytes;
}

/** 只限制新增图片。删图、完成任务、回收/撤销等已有操作不因配额被挡。 */
export function imageListUpdateError(data: Pick<AppData, "tasks">, current: TaskImage[], next: TaskImage[], usedBytes = ledgerImageBytes(data)): string | null {
  const previous = new Map(current.map((i) => [i?.id, i?.dataUrl]));
  const added = next.filter((i) => previous.get(i?.id) !== i?.dataUrl);
  if (!added.length) return null;
  if (next.length > IMAGE_MAX_COUNT) return "每件任务或子任务最多放 8 张图片";
  if (new Set(next.map((i) => i?.id)).size !== next.length || added.some((i) => !validNewTaskImage(i))) return "图片格式或大小不合适，请重新选择";
  const total = usedBytes - current.reduce((n, i) => n + imageUrlLength(i), 0) + next.reduce((n, i) => n + imageUrlLength(i), 0);
  return total > IMAGE_LEDGER_MAX_BYTES ? "账本图片已满 20 MB，请先删除不需要的图片" : null;
}

export function imageTargetSize(width: number, height: number, maxEdge = IMAGE_MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
