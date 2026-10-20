// 真实云同步/下载路径；只替换fetch为合成服务端，不读真实身份或账本。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultData, newTask, type AppData, type TaskImage } from "../src/core/model";
import { syncOnce, type Session } from "../src/core/cloud";
import { addTask, appStore, flushSave } from "../src/core/store";
import { stopAutoPull, syncStore } from "../src/core/syncCtl";
import { restoreFromCloud } from "../src/core/wipe";
import { migrate } from "../src/core/model";
import { pack, toJsonFile, unpack } from "../src/core/transfer";
import * as persist from "../src/core/persist";

const session: Session = { email: "ordinary-roundtrip@example.test", token: "synthetic-roundtrip-only", rev: 1, syncedAt: null };
const STAMP = "2026-10-20T04:00:00.000Z";
function image(id: string, sync = true): TaskImage & { sync: boolean; futureField: unknown } {
  return { id, name: id + ".jpg", dataUrl: "data:image/jpeg;base64,/9j/2Q==", width: 1, height: 1, bytes: 4, sync, futureField: { preserve: true } };
}
function book(): AppData {
  const data = defaultData();
  data.tasks = [newTask({ id: "mother", title: "本机任务", priority: 1, updatedAt: STAMP, images: [image("local-parent", false), image("cloud-parent")], subtasks: [
    { id: "child", title: "本机子任务", done: false, images: [image("local-child", false), image("cloud-child")] },
  ] })];
  Object.assign(data, { imageSync: {
    "local-parent": { sync: false, updatedAt: STAMP }, "cloud-parent": { sync: true, updatedAt: STAMP },
    "local-child": { sync: false, updatedAt: STAMP }, "cloud-child": { sync: true, updatedAt: STAMP },
  }, futureTopField: { preserve: true } });
  return data;
}
function remoteBook(local = book(), stamp = "2026-10-20T05:00:00.000Z"): AppData {
  const remote = structuredClone(local);
  remote.tasks[0] = { ...remote.tasks[0], title: "云端改过的任务", updatedAt: stamp, images: [image("cloud-parent")], subtasks: [
    { ...remote.tasks[0].subtasks[0], title: "云端改过的子任务", images: [image("cloud-child")] },
  ] };
  return remote;
}
function response(body: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response; }
function cloudServer(remote: AppData | null, conflict?: AppData) {
  let current = remote, rev = 1, conflicts = conflict ? 1 : 0;
  const uploads: AppData[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    if (!String(url).endsWith("/api/sync")) throw new Error("Blocked non-sync synthetic request");
    if (options?.method === "PUT") {
      const incoming = JSON.parse(String(options.body));
      uploads.push(incoming.data.data);
      if (conflicts-- > 0) { current = conflict!; rev++; return response({ error: "conflict", message: "synthetic race" }, 409); }
      current = incoming.data.data; return response({ rev: ++rev });
    }
    return response({ rev, data: current ? pack(current, "synthetic-remote") : null, updatedAt: STAMP });
  }));
  return { uploads, current: () => current };
}
const ids = (images?: TaskImage[]) => (images ?? []).map(value => value.id);

beforeEach(async () => {
  stopAutoPull(); await flushSave(); localStorage.clear();
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, rescue: null, wiped: false });
  syncStore.setState({ session: null, phase: "off", dirty: false, needsUpgrade: false });
});
afterEach(async () => { stopAutoPull(); syncStore.setState({ session: null, phase: "off" }); await flushSave(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("图片云投影与完整本地账本的真实往返", () => {
  it.each([false, true])("单任务9图可以本地保存；同步勾选=%s时仅受云总额度控制", async (sync) => {
    const pictures = Array.from({ length: 9 }, (_, index) => image("many-" + index, sync));
    const id = addTask({ title: "超过旧张数上限", images: pictures });
    const local = appStore.getState().data;
    expect(local.tasks.find(task => task.id === id)?.images).toHaveLength(9);
    const server = cloudServer(null);
    const result = await syncOnce(session, local);
    expect(result.data.tasks.find(task => task.id === id)?.images).toHaveLength(9);
    expect(server.uploads[0].tasks.find(task => task.id === id)?.images ?? []).toHaveLength(sync ? 9 : 0);
  });

  it("普通/Plus关闭状态也只上传勾选母子图，本地结果和完整导出保留全部图片与未知字段", async () => {
    const local = book(), before = structuredClone(local), server = cloudServer(null);
    const result = await syncOnce(session, local);
    expect(server.uploads).toHaveLength(1);
    expect(ids(server.uploads[0].tasks[0].images)).toEqual(["cloud-parent"]);
    expect(ids(server.uploads[0].tasks[0].subtasks[0].images)).toEqual(["cloud-child"]);
    expect(result.data.tasks[0].images).toEqual(before.tasks[0].images);
    expect(result.data.tasks[0].subtasks[0].images).toEqual(before.tasks[0].subtasks[0].images);
    expect(local).toEqual(before);
    const reopened = unpack(JSON.parse(toJsonFile(migrate(result.data), "ordinary")));
    expect(reopened.ok).toBe(true); if (!reopened.ok) throw new Error(reopened.error);
    expect(reopened.data.tasks[0].images).toEqual(before.tasks[0].images);
    expect(reopened.data.tasks[0].subtasks[0].images).toEqual(before.tasks[0].subtasks[0].images);
    expect(reopened.data).toHaveProperty("futureTopField", { preserve: true });
  });

  it("远端较新文字获胜时，缺失的同owner本地only图仍在；PUT不泄漏本地only bytes", async () => {
    const local = book(), server = cloudServer(remoteBook(local));
    const result = await syncOnce(session, local);
    expect(result.data.tasks[0].title).toBe("云端改过的任务");
    expect(ids(result.data.tasks[0].images)).toEqual(expect.arrayContaining(["local-parent", "cloud-parent"]));
    expect(ids(result.data.tasks[0].subtasks[0].images)).toEqual(expect.arrayContaining(["local-child", "cloud-child"]));
    expect(ids(server.uploads[server.uploads.length - 1].tasks[0].images)).toEqual(["cloud-parent"]);
    expect(ids(server.uploads[server.uploads.length - 1].tasks[0].subtasks[0].images)).toEqual(["cloud-child"]);
  });

  it("409取得第三份远端再重推，仍保本地图与最新远端改字，所有尝试均不上传未选图", async () => {
    const local = book(), next = remoteBook(local, "2026-10-20T06:00:00.000Z");
    next.tasks[0].title = "并发设备最终标题";
    const server = cloudServer(remoteBook(local), next), result = await syncOnce(session, local);
    expect(server.uploads).toHaveLength(2);
    expect(result.data.tasks[0].title).toBe("并发设备最终标题");
    expect(ids(result.data.tasks[0].images)).toContain("local-parent");
    expect(ids(result.data.tasks[0].subtasks[0].images)).toContain("local-child");
    for (const upload of server.uploads) {
      expect(ids(upload.tasks[0].images)).toEqual(["cloud-parent"]);
      expect(ids(upload.tasks[0].subtasks[0].images)).toEqual(["cloud-child"]);
    }
  });

  it("关闭已经上传的图片后，下一轮去掉云端引用、本机仍保图；再一轮不复活云图", async () => {
    const local = book(), oldCloud = structuredClone(local);
    // 云端的文字比本机更晚，但图片控制有独立时刻，不能随整件任务赢家倒退。
    oldCloud.tasks[0].updatedAt = "2026-10-20T07:00:00.000Z";
    oldCloud.tasks[0].title = "云端更新的文字应保留";
    local.tasks[0].updatedAt = "2026-10-20T06:00:00.000Z";
    Object.assign(local, { imageSync: { ...(local as AppData & { imageSync: object }).imageSync, "cloud-parent": { sync: false, updatedAt: "2026-10-20T06:00:00.000Z" } } });
    Object.assign(local.tasks[0].images![1], { sync: false });
    const server = cloudServer(oldCloud), result = await syncOnce(session, local);
    expect(result.data.tasks[0].title).toBe("云端更新的文字应保留");
    expect(ids(result.data.tasks[0].images)).toContain("cloud-parent");
    expect(server.uploads[0].tasks[0].images ?? []).toEqual([]);
    await syncOnce({ ...session, rev: result.rev }, result.data);
    expect(server.uploads[server.uploads.length - 1].tasks[0].images ?? []).toEqual([]);
  });

  it("真实云端下载保留同owner本地图，先备份完整旧账本；云端内容确实更新", async () => {
    const local = book(), server = cloudServer(remoteBook(local));
    appStore.setState({ data: local }); syncStore.setState({ session, phase: "idle" });
    const backup = vi.spyOn(persist, "snapshotBackup").mockImplementation(async () => {
      expect(appStore.getState().data.tasks[0].images).toEqual(local.tasks[0].images);
      expect(appStore.getState().data.tasks[0].subtasks[0].images).toEqual(local.tasks[0].subtasks[0].images);
      return "synthetic-pre-download.json";
    });
    const result = await restoreFromCloud();
    expect(result.backup).toBe("synthetic-pre-download.json"); expect(backup).toHaveBeenCalledTimes(1);
    expect(server.uploads).toHaveLength(0);
    const downloaded = appStore.getState().data;
    expect(downloaded.tasks[0].title).toBe("云端改过的任务");
    expect(ids(downloaded.tasks[0].images)).toEqual(expect.arrayContaining(["local-parent", "cloud-parent"]));
    expect(ids(downloaded.tasks[0].subtasks[0].images)).toEqual(expect.arrayContaining(["local-child", "cloud-child"]));
    const saved = await persist.loadData();
    expect(saved.data).not.toBeNull(); if (!saved.data) throw new Error("Expected complete synthetic ledger after cloud download");
    expect(ids(saved.data.tasks[0].images)).toContain("local-parent");
  });

  it("远端整任务删除墓碑优先，本地图不能复活幽灵母任务", async () => {
    const local = book(), remote = defaultData();
    remote.graveyard = [{ id: "mother", at: "2026-10-20T07:00:00.000Z" }];
    const server = cloudServer(remote), result = await syncOnce(session, local);
    expect(result.data.tasks).toEqual([]); expect(server.uploads[0].tasks).toEqual([]);
  });
});
