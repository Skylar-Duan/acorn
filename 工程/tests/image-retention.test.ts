import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultData, migrate, newTask, type AppData, type TaskImage } from "../src/core/model";
import { bulkDeleteImages, bulkSetImageSync, cleanupCompletedCloudImages, cloudImageBytes, completedImageCleanupEnabled, filterLedgerImages, listLedgerImages, toCloudData } from "../src/core/imageLibrary";
import { cleanupImagesForActiveAccount } from "../src/core/imageRetention";
import { plusStore } from "../src/core/plus";
import { syncOnce, type Session } from "../src/core/cloud";
import { mergeData } from "../src/core/merge";
import { appStore, flushSave, setManagedImageSync, undo, updateSettings, updateTask } from "../src/core/store";
import { pack, toJsonFile, unpack } from "../src/core/transfer";
import * as persist from "../src/core/persist";
import { IMAGE_LEDGER_MAX_BYTES } from "../src/core/taskImages";

const account = "images-a@example.test", other = "images-b@example.test";
const stamp = "2026-10-21T01:00:00.000Z";
const image = (id: string): TaskImage => ({ id, name: id + ".jpg", dataUrl: "data:image/jpeg;base64,/9j/2Q==", width: 1, height: 1, bytes: 4 });
const session: Session = { email: account, token: "synthetic-image-retention-only", rev: 1, syncedAt: null };
function book(): AppData {
  const data = defaultData();
  data.tasks = [newTask({ id: "done", title: "已完成", done: true, doneAt: stamp, updatedAt: stamp, images: [image("done")], subtasks: [{ id: "child", title: "母任务已完成", done: false, images: [image("child")] }] }), newTask({ id: "pending", title: "未完成", updatedAt: stamp, images: [image("pending")] })];
  return data;
}
const on = (data: AppData): AppData => ({ ...data, settings: { ...data.settings, completedImageCleanup: { [account]: true } } });
const ids = (images?: TaskImage[]) => images?.map((entry) => entry.id) ?? [];
function response(body: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response; }
function server(remote: AppData | null, conflict?: AppData) {
  let current = remote, race = !!conflict, rev = 1;
  const uploads: AppData[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, options?: RequestInit) => {
    if (!String(url).endsWith("/api/sync")) throw new Error("Blocked non-sync synthetic request");
    if (options?.method === "PUT") {
      const data = JSON.parse(String(options.body)).data.data as AppData; uploads.push(data);
      if (race) { race = false; current = conflict!; rev++; return response({ error: "conflict", message: "synthetic" }, 409); }
      current = data; return response({ rev: ++rev });
    }
    return response({ rev, data: current ? pack(current, "synthetic") : null, updatedAt: stamp });
  }));
  return uploads;
}
beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth) undo(); await flushSave();
  vi.spyOn(persist, "saveData").mockResolvedValue(undefined);
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, rescue: null, wiped: false, saveError: null });
  plusStore.setState({ account, enabled: true, entitled: true });
});
afterEach(async () => { await flushSave(); plusStore.setState({ account: null, enabled: false, entitled: false }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("已完成图片自动清理安全边界", () => {
  it("旧数据默认关，邮箱规范化且账号隔离，Plus关闭或长请求换号不执行", () => {
    const data = book(); expect(cleanupCompletedCloudImages(data, account)).toBe(data);
    const enabled = on(data);
    expect(completedImageCleanupEnabled(enabled.settings, " IMAGES-A@EXAMPLE.TEST ")).toBe(true);
    expect(cleanupCompletedCloudImages(enabled, other)).toBe(enabled);
    expect(cleanupImagesForActiveAccount(enabled, other)).toBe(enabled);
    plusStore.setState({ enabled: false }); expect(cleanupImagesForActiveAccount(enabled)).toBe(enabled);
    plusStore.setState({ enabled: true, account: other }); expect(cleanupImagesForActiveAccount(enabled, account)).toBe(enabled);
  });

  it("只清已完成母子云图；本机、引用、正文时间和未知字段经迁移/备份/改字后全保留", () => {
    const data = on(book()); Object.assign(data, { futureTop: { keep: true } }); Object.assign(data.tasks[0], { futureTask: 1 }); Object.assign(data.tasks[0].images![0], { futureImage: 2 });
    data.imageSync = { done: { sync: true, updatedAt: stamp, futureControl: 3 } };
    const before = structuredClone(data), cleaned = cleanupCompletedCloudImages(data, account, stamp);
    expect(data).toEqual(before); expect(cleaned.tasks[0]).toMatchObject({ updatedAt: stamp, futureTask: 1 });
    expect(cleaned.tasks[0].images?.[0]).toMatchObject({ id: "done", dataUrl: image("done").dataUrl, sync: false, futureImage: 2 });
    expect(cleaned.imageSync?.done).toMatchObject({ sync: false, completedCleanup: true, futureControl: 3, deletedAt: null });
    expect(toCloudData(cleaned).tasks[0].images).toEqual([]); expect(toCloudData(cleaned).tasks[0].subtasks[0].images).toEqual([]);
    expect(ids(toCloudData(cleaned).tasks[1].images)).toEqual(["pending"]);
    const saved = unpack(JSON.parse(toJsonFile(migrate(cleaned), "synthetic"))); expect(saved.ok).toBe(true); if (!saved.ok) throw new Error(saved.error);
    expect(saved.data).toHaveProperty("futureTop", { keep: true }); expect(saved.data.tasks[0].images?.[0]).toHaveProperty("futureImage", 2);
    appStore.setState({ data: saved.data }); updateTask("done", { title: "普通改字" });
    expect(ids(appStore.getState().data.tasks[0].images)).toEqual(["done"]); expect(toCloudData(appStore.getState().data).tasks[0].images).toEqual([]);
  });

  it("共享图仍被未完成引用使用时不清，放弃不算完成，编号内容冲突也不清", () => {
    const data = on(book()); data.tasks[1].images = [image("done")];
    data.tasks.push(newTask({ id: "dropped", title: "已放弃", droppedAt: stamp, images: [image("dropped")] }));
    data.tasks[0].images!.push(image("conflict")); data.tasks[0].subtasks[0].images!.push({ ...image("conflict"), dataUrl: "future-different-content" });
    const cleaned = cleanupCompletedCloudImages(data, account, stamp);
    expect(listLedgerImages(cleaned).find((entry) => entry.key === "done")).toMatchObject({ cloud: true, completed: false, referenceCount: 2 });
    expect(listLedgerImages(cleaned).find((entry) => entry.key === "dropped")).toMatchObject({ cloud: true, completed: false });
    expect(listLedgerImages(cleaned).find((entry) => entry.key === "conflict")).toMatchObject({ cloud: true, conflict: true });
  });

  it("子任务自身完成可清，四筛选满足来源并集与状态交集", () => {
    const data = on(book()); data.tasks[1].subtasks = [{ id: "done-step", title: "已完成步骤", done: true, images: [image("step")] }];
    const entries = listLedgerImages(cleanupCompletedCloudImages(data, account, stamp));
    expect(filterLedgerImages(entries, ["local", "completed"]).map((entry) => entry.key)).toEqual(["done", "child", "step"]);
    expect(filterLedgerImages(entries, ["local", "cloud", "pending"]).map((entry) => entry.key)).toEqual(["pending"]);
    expect(filterLedgerImages(entries, ["completed", "pending"])).toEqual(entries);
  });

  it("已清理控制抵挡旧云图；永久删图墓碑不因清理或旧同步复活", () => {
    const data = on(book()), cleaned = cleanupCompletedCloudImages(data, account, stamp);
    const oldCloud = structuredClone(data); oldCloud.tasks[0].updatedAt = "2026-10-21T02:00:00Z";
    const merged = mergeData(cleaned, oldCloud).data;
    expect(ids(merged.tasks[0].images)).toEqual(["done"]); expect(toCloudData(merged).tasks[0].images).toEqual([]);
    const deleted = bulkDeleteImages(cleaned, ["done"], stamp).data;
    expect(cleanupCompletedCloudImages(mergeData(deleted, oldCloud).data, account).tasks[0].images).toEqual([]);
  });

  it("另一端撤回完成后自动清理图恢复同步，手动仅本机的图仍保留原意", () => {
    const data = on(book()), cleaned = cleanupCompletedCloudImages(data, account, stamp);
    const remote = structuredClone(data); remote.tasks[0].done = false; remote.tasks[0].subtasks = [];
    remote.tasks[0].updatedAt = "2026-10-21T02:00:00Z";
    const reopened = cleanupCompletedCloudImages(mergeData(cleaned, remote).data, account, stamp);
    expect(listLedgerImages(reopened).find((entry) => entry.key === "done")).toMatchObject({ completed: false, cloud: true });
    const manual = bulkSetImageSync(cleaned, ["done"], false, stamp).data;
    expect(manual.imageSync?.done.completedCleanup).toBe(false);
    expect(listLedgerImages(cleanupCompletedCloudImages(mergeData(manual, remote).data, account)).find((entry) => entry.key === "done")).toMatchObject({ cloud: false });
  });

  it("设置当场清已有图，完成新任务也清；关闭不擅自补传，手动同步提示与撤销一致", () => {
    appStore.setState({ data: book() }); updateSettings({ completedImageCleanup: { [account]: true } });
    expect(toCloudData(appStore.getState().data).tasks[0].images).toEqual([]);
    expect(setManagedImageSync(["done"], true)).toContain("先关闭");
    updateTask("pending", { done: true, doneAt: stamp }); expect(cloudImageBytes(appStore.getState().data)).toBe(0);
    undo(); expect(appStore.getState().data.tasks[1].done).toBe(false); expect(ids(toCloudData(appStore.getState().data).tasks[1].images)).toEqual(["pending"]);
    updateSettings({ completedImageCleanup: { [account]: false } }); expect(toCloudData(appStore.getState().data).tasks[0].images).toEqual([]);
    expect(setManagedImageSync(["done"], true)).toBeNull(); expect(ids(toCloudData(appStore.getState().data).tasks[0].images)).toEqual(["done"]);
  });

  it("云额度正满时先清完成图腾空间，待办图在同一轮恢复同步", () => {
    const data = on(book());
    const prefix = "data:image/jpeg;base64,";
    data.tasks[0].images = [{ ...image("full"), dataUrl: prefix + "A".repeat(IMAGE_LEDGER_MAX_BYTES - prefix.length) }];
    data.tasks[0].subtasks = [];
    data.tasks[1].images = [{ ...image("pending"), sync: false }];
    data.imageSync = { pending: { sync: false, updatedAt: stamp, completedCleanup: true } };
    const before = data.tasks.map((task) => task.images?.map((entry) => entry.dataUrl));
    expect(cloudImageBytes(data)).toBe(IMAGE_LEDGER_MAX_BYTES);
    const cleaned = cleanupCompletedCloudImages(data, account, stamp);
    expect(cleaned.tasks.map((task) => task.images?.map((entry) => entry.dataUrl))).toEqual(before);
    expect(cleaned.imageSync?.full).toMatchObject({ sync: false, completedCleanup: true });
    expect(cleaned.imageSync?.pending).toMatchObject({ sync: true, completedCleanup: false });
    expect(toCloudData(cleaned).tasks[0].images).toEqual([]);
    expect(ids(toCloudData(cleaned).tasks[1].images)).toEqual(["pending"]);
    expect(cloudImageBytes(cleaned)).toBe(image("pending").dataUrl.length);
  });

  it("真实同步先合后清，服务器只收清理后的云投影，本机继续保留图", async () => {
    const data = on(book()), uploads = server(book()); const result = await syncOnce(session, data);
    expect(uploads).toHaveLength(1); expect(uploads[0].tasks[0].images).toEqual([]);
    expect(uploads[0].imageSync?.done).toMatchObject({ sync: false, completedCleanup: true });
    expect(ids(result.data.tasks[0].images)).toEqual(["done"]); expect(result.changed).toBe(true);
    expect(toCloudData(mergeData(result.data, book()).data).tasks[0].images).toEqual([]);
  });

  it("409重试合入未完成新引用后重新判定，不误删有效云图", async () => {
    const data = on(book()), conflict = book(); conflict.tasks[0].done = false; conflict.tasks[0].subtasks = [];
    conflict.tasks[0].updatedAt = "2026-10-21T02:00:00Z";
    const uploads = server(book(), conflict); const result = await syncOnce(session, data);
    expect(uploads).toHaveLength(2); expect(uploads[0].tasks[0].images).toEqual([]);
    expect(ids(uploads[1].tasks[0].images)).toEqual(["done"]); expect(result.data.tasks[0].done).toBe(false);
    expect(listLedgerImages(result.data).find((entry) => entry.key === "done")).toMatchObject({ cloud: true, completed: false });
  });
});
