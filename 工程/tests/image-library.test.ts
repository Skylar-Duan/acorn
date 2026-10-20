import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultData, migrate, newTask, type AppData, type TaskImage } from "../src/core/model";
import { bulkDeleteImages, bulkSetImageSync, cloudImageBytes, listLedgerImages, prepareImageAdditions, restoreLocalOnlyImages, toCloudData } from "../src/core/imageLibrary";
import { IMAGE_LEDGER_MAX_BYTES, imageListUpdateError, ledgerImageBytes } from "../src/core/taskImages";
import { mergeData, sideDataChanged } from "../src/core/merge";
import { toJsonFile, unpack } from "../src/core/transfer";
import { addTask, appStore, deleteManagedImages, flushSave, setManagedImageSync, undo, updateTask } from "../src/core/store";
import * as persist from "../src/core/persist";

const now = "2026-10-20T05:00:00.000Z";
const photo = (id: string, sync?: boolean): TaskImage => ({ id, name: id + ".jpg", dataUrl: "data:image/jpeg;base64,/9j/2Q==", width: 1, height: 1, bytes: 4, ...(sync === undefined ? {} : { sync }) });
const ledger = (image = photo("shared")): AppData => ({ ...defaultData(), tasks: [
  newTask({ id: "parent", title: "母任务", updatedAt: now, images: [image], subtasks: [{ id: "sub", title: "子任务", done: false, images: [image] }] }),
  newTask({ id: "history", title: "循环历史", updatedAt: now, done: true, deletedAt: now, images: [image] }),
] });

beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth) undo(); await flushSave();
  vi.spyOn(persist, "saveData").mockResolvedValue(undefined);
  localStorage.clear(); appStore.setState({ data: defaultData(), loaded: true, loadError: null, wiped: false, saveError: null, undoDepth: 0 });
});
afterEach(async () => { await flushSave(); vi.restoreAllMocks(); });

describe("图片管理：聚合、批量与云空间", () => {
  it("同id聚合母/子/循环历史与回收引用，空间按实际引用计量", () => {
    const data = ledger(); const before = structuredClone(data); const images = listLedgerImages(data);
    expect(images).toHaveLength(1); expect(images[0]).toMatchObject({ key: "shared", cloud: true, referenceCount: 3, conflict: false });
    expect(images[0].references.map((ref) => ref.subId ?? ref.taskId)).toEqual(["parent", "sub", "history"]);
    expect(cloudImageBytes(data)).toBe(photo("shared").dataUrl.length * 3); expect(data).toEqual(before);
  });

  it("同id不同内容明确报冲突，不静默合并删除或切换", () => {
    const data = ledger(); data.tasks[1].images = [{ ...photo("shared"), dataUrl: "different future payload" }];
    expect(listLedgerImages(data)[0].conflict).toBe(true);
    for (const result of [bulkDeleteImages(data, ["shared"], now), bulkSetImageSync(data, ["shared"], false, now)]) {
      expect(result.error).toContain("编号"); expect(result.data).toBe(data); expect(result.changed).toBe(false);
    }
  });

  it("批量删图移除所有引用并留图墓碑，未知字段不丢", () => {
    const data = ledger(); Object.assign(data, { futureCollection: { keep: true } }); Object.assign(data.tasks[0], { futureTask: 1 });
    const result = bulkDeleteImages(data, ["shared"], now);
    expect(result.changed).toBe(true); expect(listLedgerImages(result.data)).toEqual([]);
    expect(result.data.tasks[0].images).toEqual([]); expect(result.data.tasks[0].subtasks[0].images).toEqual([]); expect(result.data.tasks[1].images).toEqual([]);
    expect(result.data.imageSync?.shared).toMatchObject({ sync: false, deletedAt: expect.any(String) });
    expect(result.data).toHaveProperty("futureCollection", { keep: true }); expect(result.data.tasks[0]).toHaveProperty("futureTask", 1);
    expect(mergeData(data, result.data).data.tasks[0].images).toEqual([]);
  });

  it("关同步保留全部本机内容，云投影去图，完整备份仍有图和状态", () => {
    const data = ledger(); Object.assign(data.tasks[0].images![0], { futureImage: { keep: true } });
    const off = bulkSetImageSync(data, ["shared"], false, now).data;
    expect(cloudImageBytes(off)).toBe(0); expect(ledgerImageBytes(off)).toBe(ledgerImageBytes(data));
    expect(toCloudData(off).tasks[0].images).toEqual([]); expect(toCloudData(off).tasks[0].subtasks[0].images).toEqual([]);
    expect(toCloudData(off).imageSync?.shared.sync).toBe(false);
    const backed = unpack(JSON.parse(toJsonFile(off, "beta"))); if (!backed.ok) throw new Error(backed.error);
    expect(backed.data.tasks[0].images?.[0]).toMatchObject({ sync: false, futureImage: { keep: true } });
    expect(backed.data.imageSync).toEqual(off.imageSync); expect(backed.schema).toBe(8);
  });

  it("云容量按全部引用检查，开启超额时不改本机开关或内容", () => {
    const data = ledger(photo("selected", false));
    const base = "data:image/jpeg;base64," + "A".repeat(349528) + "==";
    data.tasks.push(newTask({ title: "已有很多云图", images: Array.from({ length: 61 }, (_, i) => ({ ...photo("cloud-" + i), dataUrl: base })) }));
    expect(cloudImageBytes(data)).toBeGreaterThan(IMAGE_LEDGER_MAX_BYTES);
    const result = bulkSetImageSync(data, ["selected"], true, now);
    expect(result.error).toContain("20 MB"); expect(result.data).toBe(data); expect(result.changed).toBe(false);
    expect(data.tasks[0].images?.[0].sync).toBe(false);
  });

  it("云满后新图仍可本机保存且明确提示，已有图与unknown字段不动", () => {
    const data = ledger(); const original = photo("new"); Object.assign(original, { future: 9 });
    const prepared = prepareImageAdditions(data, [], [original], { usedCloudBytes: IMAGE_LEDGER_MAX_BYTES, currentInLedger: false });
    expect(prepared.message).toContain("仅保存在本机"); expect(prepared.images[0]).toMatchObject({ id: "new", sync: false, future: 9 });
    expect(original.sync).toBeUndefined(); expect(imageListUpdateError(data, [], prepared.images, IMAGE_LEDGER_MAX_BYTES)).toBeNull();
  });

  it("仅本机图不会挤占新图云空间；现有本地图仍保留开关", () => {
    const data = ledger(photo("offline", false));
    const existing = data.tasks[0].images!;
    const next = [...existing, photo("new")];
    expect(prepareImageAdditions(data, existing, next).images).toBe(next);
    expect(next[0].sync).toBe(false); expect(cloudImageBytes(data)).toBe(0);
  });
});

describe("独立图控制不覆盖正文与本机图片", () => {
  it("远端正文较新且无图，新开启同步仍恢复本机图供上传，正文由远端赢", () => {
    const local = ledger(photo("shared", false));
    const enabled = bulkSetImageSync(local, ["shared"], true, "2026-10-20T05:10:00Z").data;
    const remote = ledger(); remote.tasks = remote.tasks.map((task) => ({ ...task, title: "云端较新正文", updatedAt: "2026-10-20T06:00:00Z", images: [], subtasks: task.subtasks.map((sub) => ({ ...sub, images: [] })) }));
    remote.imageSync = { shared: { sync: false, updatedAt: "2026-10-20T05:05:00Z" } };
    const merged = mergeData(enabled, remote).data;
    expect(merged.tasks[0].title).toBe("云端较新正文"); expect(merged.tasks[0].images?.[0]).toMatchObject({ id: "shared", sync: true });
    expect(cloudImageBytes(merged)).toBe(photo("shared").dataUrl.length * 3);
    expect(toCloudData(merged).tasks[0].images).toHaveLength(1);
    expect(mergeData(remote, enabled).data.tasks[0].images).toHaveLength(1);
  });

  it("旧的sync:false本地图即使另一端仍带相同内容，也不被重新开启", () => {
    const local = ledger(photo("shared", false)); const remote = ledger();
    remote.tasks[0].updatedAt = "2026-10-20T06:00:00Z";
    const merged = mergeData(local, remote).data;
    expect(merged.tasks[0].images?.[0].sync).toBe(false); expect(toCloudData(merged).tasks[0].images).toEqual([]);
  });

  it("云下载只补仍存在同owner的本地图，不复活已删除的任务或子任务", () => {
    const local = ledger(photo("local", false)); const remote = ledger(photo("cloud"));
    remote.tasks[0].subtasks = [];
    const restored = restoreLocalOnlyImages(remote, local);
    expect(restored.tasks[0].images?.map((image) => image.id)).toEqual(["cloud", "local"]);
    expect(restored.tasks[0].subtasks).toEqual([]);
    expect(restoreLocalOnlyImages({ ...remote, tasks: [] }, local).tasks).toEqual([]);
  });

  it("仅图片控制变化也触发side data接收，迁移继续保留未知控制字段", () => {
    const local = ledger(); const remote = { ...local, imageSync: { absent: { sync: false, updatedAt: now, future: { keep: true } } } };
    const merged = mergeData(local, remote).data;
    expect(sideDataChanged(merged, local)).toBe(true);
    expect(migrate(merged).imageSync?.absent).toMatchObject({ future: { keep: true } });
  });
});

describe("管理动作一次撤销与新图不限量", () => {
  it("删除全部引用只压一次快照，撤销后新图控制阻止远端旧墓碑覆盖", () => {
    appStore.setState({ data: ledger() }); expect(deleteManagedImages(["shared"])).toBeNull();
    expect(appStore.getState().undoDepth).toBe(1); const deleted = appStore.getState().data;
    undo(); const restored = appStore.getState().data;
    expect(listLedgerImages(restored)[0].referenceCount).toBe(3); expect(restored.imageSync!.shared.updatedAt > deleted.imageSync!.shared.updatedAt).toBe(true);
    expect(mergeData(restored, deleted).data.tasks[0].images).toHaveLength(1);
    expect(mergeData(deleted, restored).data.tasks[0].images).toHaveLength(1);
  });

  it("批量关同步与撤销保持本机图/未知字段，普通改字不重新上传", () => {
    const data = ledger(); Object.assign(data, { future: { keep: true } }); appStore.setState({ data });
    expect(setManagedImageSync(["shared"], false)).toBeNull(); expect(appStore.getState().undoDepth).toBe(1);
    updateTask("parent", { title: "普通账号只改字" }); expect(toCloudData(appStore.getState().data).tasks[0].images).toEqual([]);
    undo(); expect(cloudImageBytes(appStore.getState().data)).toBe(0);
    undo(); expect(listLedgerImages(appStore.getState().data)[0].cloud).toBe(true); expect(appStore.getState().data).toHaveProperty("future", { keep: true });
  });

  it("本机单任务超过20MiB且61张仍可保存，多余新图只留本机并提示", () => {
    const bytes = 256 * 1024;
    const dataUrl = "data:image/jpeg;base64," + "A".repeat(349526) + "==";
    const images = Array.from({ length: 61 }, (_, i) => ({ ...photo("large-" + i), dataUrl, bytes, width: 800, height: 600 }));
    expect(imageListUpdateError(defaultData(), [], images)).toBeNull();
    addTask({ title: "很多本地图", images });
    expect(appStore.getState().data.tasks[0].images).toHaveLength(61);
    expect(ledgerImageBytes(appStore.getState().data)).toBeGreaterThan(IMAGE_LEDGER_MAX_BYTES);
    expect(cloudImageBytes(appStore.getState().data)).toBeLessThanOrEqual(IMAGE_LEDGER_MAX_BYTES);
    expect(listLedgerImages(appStore.getState().data).some((image) => !image.cloud)).toBe(true);
    expect(appStore.getState().ui.toast?.msg).toContain("仅保存在本机");
  });
});
