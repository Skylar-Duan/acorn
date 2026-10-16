import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { defaultData, newTask } from "../src/core/model";
import { appStore, clearUndo, flushSave, requestSave, resolveRescue, switchDataDirectory } from "../src/core/store";
import * as cloud from "../src/core/cloud";
import * as persist from "../src/core/persist";
import { autoPullIfDue, autoSyncHeld, signOut, syncNow, syncStore } from "../src/core/syncCtl";

vi.mock("../src/core/cloud", async (original) => ({
  ...await original<typeof import("../src/core/cloud")>(), syncOnce: vi.fn(), whoAmI: vi.fn(), saveSession: vi.fn(async () => {}),
}));
vi.mock("../src/core/persist", async (original) => ({
  ...await original<typeof import("../src/core/persist")>(), setDataDir: vi.fn(async () => {}), saveData: vi.fn(async () => {}),
}));

const originalLocation = window.location;
const reload = vi.fn();
const syncOnce = cloud.syncOnce as Mock;
const whoAmI = cloud.whoAmI as Mock;
const setDataDir = persist.setDataDir as Mock;
const saveData = persist.saveData as Mock;
const session = { token: "synthetic", email: "demo@example.test", rev: 1, syncedAt: null };

async function settle() { for (let n = 0; n < 12; n++) await Promise.resolve(); }

beforeEach(async () => {
  await signOut();
  await flushSave();
  clearUndo();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
  Object.defineProperty(window, "location", { value: { ...originalLocation, reload }, writable: true, configurable: true });
  for (const mock of [syncOnce, whoAmI, setDataDir, saveData, reload]) mock.mockReset();
  syncOnce.mockImplementation(async (_session, data) => ({ rev: 2, data, changed: false, summary: { added: 0, updated: 0, removed: 0 } }));
  setDataDir.mockResolvedValue(undefined);
  saveData.mockResolvedValue(undefined);
  appStore.setState({ data: { ...defaultData(), tasks: [newTask({ title: "原目录的合成任务" })] }, loaded: true, wiped: false, loadError: null, rescue: null, saveError: null });
  syncStore.setState({ session, phase: "idle", dirty: false, needsUpgrade: false, upgradeRetryAt: null });
});
afterEach(async () => {
  await signOut();
  await flushSave();
  Object.defineProperty(window, "location", { value: originalLocation, writable: true, configurable: true });
  vi.clearAllTimers(); vi.useRealTimers();
});

describe("换目录不会把旧主窗结果写到新账本", () => {
  it("先等旧同步落地并存好原账本，再换指针；新指针生效时loaded已关闭", async () => {
    let finish!: (value: unknown) => void;
    syncOnce.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    requestSave();
    const before = appStore.getState().data;
    const inFlight = syncNow();
    const switching = switchDataDirectory("S:/synthetic-next-directory");
    await settle();
    expect(autoSyncHeld()).toBe(true);
    expect(setDataDir).not.toHaveBeenCalled();
    finish({ rev: 2, data: before, changed: false, summary: { added: 0, updated: 0, removed: 0 } });
    await inFlight;
    setDataDir.mockImplementationOnce(async () => {
      expect(saveData).toHaveBeenCalledWith(before);
      expect(appStore.getState().loaded).toBe(false);
      expect(autoSyncHeld()).toBe(true);
    });
    await switching;
    expect(setDataDir).toHaveBeenCalledWith("S:/synthetic-next-directory");
    expect(reload).toHaveBeenCalledOnce();
    expect(appStore.getState().loaded).toBe(false);
    expect(autoSyncHeld()).toBe(false);
    expect(await autoPullIfDue()).toBe(false);
  });

  it("指针更换失败时恢复原loaded与后台闸门，仍保留原账本", async () => {
    const before = appStore.getState().data;
    setDataDir.mockRejectedValueOnce(new Error("合成目标目录不可写"));
    await expect(switchDataDirectory("S:/synthetic-unavailable")).rejects.toThrow("目标目录不可写");
    expect(appStore.getState().loaded).toBe(true);
    expect(appStore.getState().data).toBe(before);
    expect(autoSyncHeld()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("找回数据选择已有账本沿用保护，不清rescue也不覆盖目标数据", async () => {
    const rescue = [{ dir: "S:/synthetic-rescued", tasks: 9, lists: 2, modified: "2026-10-16" }];
    appStore.setState({ rescue, loadError: "合成读取失败" });
    await resolveRescue(rescue[0].dir);
    expect(setDataDir).toHaveBeenCalledWith(rescue[0].dir);
    expect(appStore.getState().rescue).toBe(rescue);
    expect(appStore.getState().loadError).toBe("合成读取失败");
    expect(saveData).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("轻探测不算running，但换目录置loaded=false会让它的旧结果失效", async () => {
    await syncNow();
    syncOnce.mockClear();
    vi.setSystemTime(Date.now() + 61_000);
    let reply!: (value: unknown) => void;
    whoAmI.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const probe = autoPullIfDue();
    await settle();
    expect(whoAmI).toHaveBeenCalledOnce();
    await switchDataDirectory("S:/synthetic-new-book");
    reply({ rev: 8 });
    await probe;
    expect(syncOnce).not.toHaveBeenCalled();
    expect(appStore.getState().loaded).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });
});
