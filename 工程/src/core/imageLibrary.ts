// 图片内容仍随本机账本与备份保存；只在云请求边界投影，绝不把云投影写回本机。
import type { AppData, ImageSyncState, Settings, Subtask, Task, TaskImage } from "./model";
import { IMAGE_LEDGER_MAX_BYTES, imageUrlLength, taskImages } from "./taskImages";

export interface ImageReference { taskId: string; subId?: string; taskTitle: string; ownerTitle: string; completed: boolean }
export interface ManagedImage extends ImageReference {
  key: string;
  image: TaskImage;
  cloud: boolean;
  references: ImageReference[];
  referenceCount: number;
  conflict: boolean;
}
export interface ImageLibraryChange { data: AppData; changed: boolean; error?: string }

const stateOf = (data: Pick<AppData, "imageSync">, id: string): ImageSyncState | undefined => {
  const value = data.imageSync?.[id];
  return value && typeof value === "object" && typeof value.sync === "boolean" && typeof value.updatedAt === "string" ? value : undefined;
};
export function imageCloudEnabled(data: Pick<AppData, "imageSync">, image: TaskImage): boolean {
  const state = stateOf(data, image?.id);
  return !state?.deletedAt && (state ? state.sync : image?.sync !== false);
}
const deleted = (data: Pick<AppData, "imageSync">, image: TaskImage) => !!stateOf(data, image?.id)?.deletedAt;

function owners(data: Pick<AppData, "tasks">): { owner: Task | Subtask; reference: ImageReference }[] {
  return data.tasks.flatMap((task) => [
    { owner: task, reference: { taskId: task.id, taskTitle: task.title, ownerTitle: task.title, completed: task.done === true } },
    ...task.subtasks.map((sub) => ({ owner: sub, reference: { taskId: task.id, subId: sub.id, taskTitle: task.title, ownerTitle: sub.title, completed: task.done === true || sub.done === true } })),
  ]);
}

/** 按id聚合同一图片的全部引用；不同payload不能静默合并成同一项。 */
export function listLedgerImages(data: Pick<AppData, "tasks" | "imageSync">): ManagedImage[] {
  const byId = new Map<string, ManagedImage>();
  for (const { owner, reference } of owners(data)) for (const image of taskImages(owner.images)) {
    if (!image || typeof image.id !== "string" || !image.id || deleted(data, image)) continue;
    const current = byId.get(image.id);
    if (current) {
      current.references.push(reference); current.referenceCount++;
      current.completed = current.completed && reference.completed;
      if (current.image.dataUrl !== image.dataUrl) current.conflict = true;
      if (!imageCloudEnabled(data, image)) current.cloud = false;
    } else byId.set(image.id, { ...reference, key: image.id, image, cloud: imageCloudEnabled(data, image), references: [reference], referenceCount: 1, conflict: false });
  }
  return [...byId.values()];
}

export type ImageFilter = "local" | "cloud" | "completed" | "pending";
/** 来源与完成状态各自取并集，再取交集；空组不限。共享图全部引用完成才归入已完成。 */
export function filterLedgerImages(entries: ManagedImage[], filters: readonly ImageFilter[]): ManagedImage[] {
  const selected = new Set(filters);
  return entries.filter((entry) =>
    ((!selected.has("local") && !selected.has("cloud")) || selected.has(entry.cloud ? "cloud" : "local")) &&
    ((!selected.has("completed") && !selected.has("pending")) || selected.has(entry.completed ? "completed" : "pending")));
}

export const imageCleanupAccountKey = (account: string) => account.trim().toLowerCase();
export function completedImageCleanupEnabled(settings: Pick<Settings, "completedImageCleanup">, account: string | null | undefined): boolean {
  return !!account && settings.completedImageCleanup?.[imageCleanupAccountKey(account)] === true;
}

/** 只关闭已完成图的云同步，复用独立操作戳；本机字节、引用、未知字段全部保留。 */
export function cleanupCompletedCloudImages(data: AppData, account: string | null | undefined, now = new Date().toISOString()): AppData {
  if (!completedImageCleanupEnabled(data.settings, account)) return data;
  const entries = listLedgerImages(data);
  // 先腾出已完成图的空间，再恢复待办图；满额时不能因为顺序而多等一轮同步。
  const keys = entries.filter((entry) => entry.completed && entry.cloud && !entry.conflict).map((entry) => entry.key);
  let next = data;
  if (keys.length) {
    next = bulkSetImageSync(next, keys, false, now).data;
    const imageSync = { ...next.imageSync };
    for (const id of keys) imageSync[id] = { ...imageSync[id], completedCleanup: true };
    next = { ...next, imageSync };
  }
  // 另一端撤回完成/加了待办引用时，不把刚合进来的有效云图一并清掉。
  // 只还原自动清理过的图；用户手动选择仅本机的图不能因此开启。
  const pending = entries.filter((entry) => !entry.completed && !entry.cloud && !entry.conflict && stateOf(data, entry.key)?.completedCleanup === true).map((entry) => entry.key);
  return pending.length ? bulkSetImageSync(next, pending, true, now).data : next;
}

/** 云空间按实际发送的每处dataURL引用计量，历史与回收站同样占云空间。 */
export function cloudImageBytes(data: Pick<AppData, "tasks" | "imageSync">): number {
  return owners(data).reduce((total, { owner }) => total + taskImages(owner.images).reduce((sum, image) => sum + (imageCloudEnabled(data, image) ? imageUrlLength(image) : 0), 0), 0);
}

function mapOwnerImages(data: AppData, map: (images: TaskImage[]) => TaskImage[]): AppData {
  let changed = false;
  const update = <T extends Task | Subtask>(owner: T): T => {
    if (!Array.isArray(owner.images)) return owner;
    const images = map(owner.images);
    if (images === owner.images) return owner;
    changed = true;
    return { ...owner, images };
  };
  const tasks = data.tasks.map((task) => {
    let next = update(task);
    const subtasks = task.subtasks.map(update);
    if (subtasks.some((sub, i) => sub !== task.subtasks[i])) next = { ...next, subtasks };
    return next;
  });
  return changed ? { ...data, tasks } : data;
}

function nextStamp(data: Pick<AppData, "imageSync">, now: string): string {
  let at = Date.parse(now);
  if (!Number.isFinite(at)) at = Date.now();
  for (const value of Object.values(data.imageSync ?? {})) {
    const previous = value && typeof value === "object" ? Date.parse(value.updatedAt) : NaN;
    if (Number.isFinite(previous) && previous >= at) at = previous + 1;
  }
  return new Date(at).toISOString();
}

function selectedImages(data: AppData, keys: readonly string[]): { selected: ManagedImage[]; error?: string } {
  const wanted = new Set(keys);
  const selected = listLedgerImages(data).filter((image) => wanted.has(image.key));
  return { selected, ...(selected.some((image) => image.conflict) ? { error: "有图片编号对应了不同内容，请先在原任务中核对，未作任何修改" } : {}) };
}

export function bulkDeleteImages(data: AppData, keys: readonly string[], now = new Date().toISOString()): ImageLibraryChange {
  const { selected, error } = selectedImages(data, keys);
  if (error || !selected.length) return { data, changed: false, ...(error ? { error } : {}) };
  const ids = new Set(selected.map((image) => image.key));
  const at = nextStamp(data, now);
  const imageSync = { ...data.imageSync };
  for (const id of ids) imageSync[id] = { ...imageSync[id], sync: false, updatedAt: at, deletedAt: at };
  const next = mapOwnerImages(data, (images) => images.some((image) => ids.has(image?.id)) ? images.filter((image) => !ids.has(image?.id)) : images);
  return { data: { ...next, imageSync }, changed: true };
}

export function bulkSetImageSync(data: AppData, keys: readonly string[], sync: boolean, now = new Date().toISOString()): ImageLibraryChange {
  const { selected, error } = selectedImages(data, keys);
  if (error) return { data, changed: false, error };
  const ids = new Set(selected.filter((image) => image.cloud !== sync || !sync && stateOf(data, image.key)?.completedCleanup === true).map((image) => image.key));
  if (!ids.size) return { data, changed: false };
  const at = nextStamp(data, now);
  const imageSync = { ...data.imageSync };
  for (const id of ids) imageSync[id] = { ...imageSync[id], sync, updatedAt: at, deletedAt: null, completedCleanup: false };
  const next = mapOwnerImages({ ...data, imageSync }, (images) => images.some((image) => ids.has(image?.id)) ? images.map((image) => ids.has(image?.id) ? { ...image, sync } : image) : images);
  if (sync && cloudImageBytes(next) > IMAGE_LEDGER_MAX_BYTES) return { data, changed: false, error: "云端图片空间不足20 MB，请减少勾选或先关闭其他图片的同步；本机图片仍保留" };
  return { data: next, changed: true };
}

/** 新图默认同步，云空间不足只降为本机保存并交还明确提示。 */
export function prepareImageAdditions(data: Pick<AppData, "tasks" | "imageSync">, current: TaskImage[], next: TaskImage[], options: { usedCloudBytes?: number; currentInLedger?: boolean } = {}): { images: TaskImage[]; message?: string } {
  const previous = new Map(current.map((image) => [image?.id, image?.dataUrl]));
  let used = options.usedCloudBytes ?? cloudImageBytes(data);
  if (options.currentInLedger !== false) used -= current.reduce((sum, image) => sum + (imageCloudEnabled(data, image) ? imageUrlLength(image) : 0), 0);
  let local = false;
  const images = next.map((image) => {
    if (!imageCloudEnabled(data, image)) return image;
    const size = imageUrlLength(image);
    if (previous.get(image?.id) !== image?.dataUrl && used + size > IMAGE_LEDGER_MAX_BYTES) { local = true; return { ...image, sync: false }; }
    used += size;
    return image;
  });
  return { images: local ? images : next, ...(local ? { message: "云端图片空间已满，新图片已仅保存在本机，可在图片管理中调整同步" } : {}) };
}

/** 可选控制表按各自时刻合并；未知条目原样保留。 */
export function mergeImageSync(local: AppData["imageSync"], remote: AppData["imageSync"]): AppData["imageSync"] {
  if (!remote) return local;
  if (!local) return remote;
  const result = { ...remote, ...local };
  for (const id of Object.keys(remote)) {
    const a = local[id], b = remote[id];
    if (!a || typeof a !== "object") continue;
    if (b && typeof b === "object" && typeof b.updatedAt === "string" &&
      (typeof a.updatedAt !== "string" || b.updatedAt > a.updatedAt || b.updatedAt === a.updatedAt && JSON.stringify(b) > JSON.stringify(a))) result[id] = b;
  }
  return Object.keys(result).length === Object.keys(local).length && Object.keys(result).every((id) => JSON.stringify(result[id]) === JSON.stringify(local[id])) ? local : result;
}

function projectImageState(data: AppData, image: TaskImage): TaskImage {
  const state = stateOf(data, image?.id);
  return state && (state.sync ? image?.sync === false : image?.sync !== false) ? { ...image, sync: state.sync } : image;
}

/** 同owner的本机图在云端下载/任务赢家替换后保留；不复活已被删掉的task/sub。 */
export function restoreLocalOnlyImages(remote: AppData, local: AppData, incomingImageSync = remote.imageSync): AppData {
  const imageSync = mergeImageSync(local.imageSync, remote.imageSync);
  const base = imageSync === remote.imageSync ? remote : imageSync ? { ...remote, imageSync } : remote;
  const cached = new Map(owners(local).map(({ owner, reference }) => [JSON.stringify([reference.taskId, reference.subId ?? null]), taskImages(owner.images).filter((image) => {
    const control = stateOf(local, image?.id);
    const incoming = stateOf({ imageSync: incomingImageSync }, image?.id);
    // 刚勾回同步的图即使远端正文更晚也保留bytes；只补图片，不覆盖远端正文。
    const pendingEnable = control?.sync && !control.deletedAt && (!incoming || control.updatedAt > incoming.updatedAt);
    return !deleted(base, image) && (!imageCloudEnabled(local, image) || !imageCloudEnabled(base, image) || pendingEnable);
  })]));
  let changed = false;
  function update<T extends Task | Subtask>(owner: T, taskId: string, subId?: string): T {
    const original = taskImages(owner.images);
    let images = original.filter((image) => !deleted(base, image));
    for (const image of cached.get(JSON.stringify([taskId, subId ?? null])) ?? []) {
      const same = images.findIndex((other) => other?.id === image.id && other?.dataUrl === image.dataUrl);
      if (same < 0) images.push(image);
      else if (!stateOf(base, image.id) && image.sync === false && images[same].sync !== false) images[same] = { ...images[same], sync: false };
    }
    images = images.map((image) => projectImageState(base, image));
    if (images.length === original.length && images.every((image, i) => image === original[i])) return owner;
    changed = true;
    return { ...owner, images };
  }
  const tasks = base.tasks.map((task) => {
    let next = update(task, task.id);
    const subtasks = task.subtasks.map((sub) => update(sub, task.id, sub.id));
    if (subtasks.some((sub, i) => sub !== task.subtasks[i])) next = { ...next, subtasks };
    return next;
  });
  return changed ? { ...base, tasks } : base;
}

/** 云投影不包含仅本机图片的内容；备份/导入导出不能调用这份投影。 */
export function toCloudData(data: AppData): AppData {
  return mapOwnerImages(data, (images) => {
    const next = images.filter((image) => imageCloudEnabled(data, image));
    return next.length === images.length ? images : next;
  });
}

/** 本机变更与撤销共用：为图片操作盖独立新戳，防止云端旧图或旧开关回流。 */
export function finalizeImageMutation(previous: AppData, requested: AppData, now = new Date().toISOString()): { data: AppData; message?: string } {
  if (previous === requested) return { data: previous };
  const before = new Map(listLedgerImages(previous).map((image) => [image.key, image]));
  const after = new Map(listLedgerImages(requested).map((image) => [image.key, image]));
  const imageSync = { ...requested.imageSync };
  const at = nextStamp(previous, now);
  let stateChanged = false;
  const ids = new Set([...before.keys(), ...after.keys(), ...Object.keys(previous.imageSync ?? {}), ...Object.keys(requested.imageSync ?? {})]);
  for (const id of ids) {
    const old = before.get(id), next = after.get(id);
    const from = stateOf(previous, id), to = stateOf(requested, id);
    if (old && !next && !to?.deletedAt) { imageSync[id] = { ...imageSync[id], sync: false, updatedAt: at, deletedAt: at }; stateChanged = true; }
    else if (next && (!old || JSON.stringify(from) !== JSON.stringify(to) || old.cloud !== next.cloud)) {
      imageSync[id] = { ...imageSync[id], sync: next.cloud, updatedAt: at, deletedAt: null }; stateChanged = true;
    }
  }
  let data = stateChanged ? { ...requested, imageSync } : requested;
  const added = listLedgerImages(data).filter((image) => !before.has(image.key) && image.cloud);
  let total = cloudImageBytes(data), fallback = false;
  for (const image of added.slice().reverse()) {
    if (total <= IMAGE_LEDGER_MAX_BYTES) break;
    imageSync[image.key] = { ...imageSync[image.key], sync: false, updatedAt: at, deletedAt: null };
    total -= image.references.reduce((sum) => sum + imageUrlLength(image.image), 0); fallback = true;
  }
  if (fallback) data = { ...data, imageSync };
  if (stateChanged || fallback) data = restoreLocalOnlyImages(data, data);
  return { data, ...(fallback ? { message: "云端图片空间已满，新图片已仅保存在本机，可在图片管理中调整同步" } : {}) };
}
