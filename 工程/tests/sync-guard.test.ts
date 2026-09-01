// 同步这条出口的闸门。
//
// 背景：loadError / dataTooNew / rescue 这三种状态下 loaded 都是 true、data 里那份都不是
// 用户真正的账本。落盘那条路（store.doSave）和快速添加那条路都堵了，同步这条一度没堵——
// 后果是每启动一次就把一本空账本合进云端再 PUT 回去，所有设备上都多出东西。
// 这几条用例就是钉住「三种状态一条都不许往云上推」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { defaultData, newTask } from "../src/core/model";
import { appStore } from "../src/core/store";
import * as cloud from "../src/core/cloud";
import { syncNow, syncStore } from "../src/core/syncCtl";

vi.mock("../src/core/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/cloud")>();
  return {
    ...actual,
    syncOnce: vi.fn(),
    saveSession: vi.fn(async () => {}),
  };
});

const syncOnce = cloud.syncOnce as unknown as Mock;

const SESSION: cloud.Session = {
  token: "tok",
  email: "a@b.c",
  rev: 1,
  syncedAt: null,
};

function readyData() {
  const d = defaultData();
  d.tasks = [newTask({ title: "对账" })];
  return d;
}

describe("数据没真正读进来之前，一律不往云上推", () => {
  beforeEach(() => {
    syncOnce.mockReset();
    syncOnce.mockResolvedValue({
      rev: 2,
      data: readyData(),
      changed: false,
      summary: { added: 0, updated: 0, removed: 0 },
    });
    syncStore.setState({
      session: SESSION,
      phase: "idle",
      message: "",
      dirty: true,
      needsUpgrade: false,
      lastAttemptAt: null,
    });
    appStore.setState({
      data: readyData(),
      loaded: true,
      loadError: null,
      dataTooNew: null,
      rescue: null,
    });
  });

  it("对照组：一切正常时确实会推一轮", async () => {
    await syncNow();
    expect(syncOnce).toHaveBeenCalledTimes(1);
  });

  it("dataTooNew：磁盘上那份比本机新，一次都不碰云", async () => {
    appStore.setState({ dataTooNew: { schema: 99 }, data: { ...defaultData(), lists: [], tasks: [] } });
    await syncNow();
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("rescue：数据疑似在别的文件夹，等用户拍板之前不推", async () => {
    appStore.setState({ rescue: [], data: { ...defaultData(), lists: [], tasks: [] } });
    await syncNow();
    expect(syncOnce).not.toHaveBeenCalled();
  });

  it("loadError：读都没读出来，更不能推", async () => {
    appStore.setState({ loaded: false, loadError: "数据文件夹打不开" });
    await syncNow();
    expect(syncOnce).not.toHaveBeenCalled();
  });
});
