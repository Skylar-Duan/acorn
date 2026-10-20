import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultData, newTask } from "../src/core/model";
import { appStore, flushSave } from "../src/core/store";
import * as cloud from "../src/core/cloud";
import * as persist from "../src/core/persist";
import { signOut, syncStore } from "../src/core/syncCtl";
import { clearLocalAccountData, eraseAcornAccount } from "../src/core/accountActions";

vi.mock("../src/core/cloud", async original => ({ ...await original<typeof import("../src/core/cloud")>(),
  saveSession: vi.fn(async () => {}), deleteAccount: vi.fn(async () => ({ deleted: true, scope: "acorn", cdpandasAccountKept: true })),
  syncOnce: vi.fn(async () => { throw new Error("No upload is permitted by explicit local deletion"); }),
}));
vi.mock("../src/core/persist", async original => ({ ...await original<typeof import("../src/core/persist")>(),
  purgeLocalFiles: vi.fn(async () => { localStorage.removeItem("acorn-data"); return []; }),
}));
const identity = { token: "synthetic-delete-only", email: "synthetic@example.test", rev: 1, syncedAt: null };
beforeEach(async () => {
  await signOut(); await flushSave(); vi.clearAllMocks(); localStorage.clear();
  const data = defaultData(); data.settings.autoLogin = false; data.tasks = [newTask({ title: "local-only synthetic data", futureField: { retained: true } } as Parameters<typeof newTask>[0])];
  appStore.setState({ data, loaded: true, loadError: null, rescue: null, wiped: false });
  syncStore.setState({ session: { ...identity }, phase: "idle", dirty: true, needsUpgrade: false }); await persist.saveData(data);
});
afterEach(async () => { await signOut(); await flushSave(); vi.restoreAllMocks(); });

describe("confirmed local and Acorn account erasure", () => {
  it("explicit local deletion works without network or automatic-login credentials and never uploads", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await clearLocalAccountData(); expect(persist.purgeLocalFiles).toHaveBeenCalledWith({ confirmed: true });
    expect(cloud.syncOnce).not.toHaveBeenCalled(); expect(cloud.deleteAccount).not.toHaveBeenCalled();
    expect(syncStore.getState().session).toBeNull(); expect(localStorage.getItem("acorn-data")).toBeNull(); expect(appStore.getState().wiped).toBe(true);
  });
  it("an unauthenticated caller cannot use either explicit-clear API", async () => {
    syncStore.setState({ session: null });
    await expect(clearLocalAccountData()).rejects.toThrow("请先登录"); await expect(eraseAcornAccount()).rejects.toThrow("请先登录");
    expect(persist.purgeLocalFiles).not.toHaveBeenCalled(); expect(cloud.deleteAccount).not.toHaveBeenCalled();
  });
  it("local purge failure keeps the session available for retry and cannot resurrect partially deleted files", async () => {
    vi.mocked(persist.purgeLocalFiles).mockRejectedValueOnce(new Error("synthetic locked directory"));
    await expect(clearLocalAccountData()).rejects.toThrow("locked directory"); expect(appStore.getState().wiped).toBe(true);
    expect(syncStore.getState().session?.token).toBe(identity.token); expect(localStorage.getItem("acorn-data")).not.toBeNull();
    await clearLocalAccountData(); expect(localStorage.getItem("acorn-data")).toBeNull(); expect(syncStore.getState().session).toBeNull();
  });
  it("a failure signing out after successful purge cannot write the deleted in-memory ledger back", async () => {
    vi.mocked(cloud.saveSession).mockRejectedValueOnce(new Error("synthetic credential cleanup failure"));
    await expect(clearLocalAccountData()).rejects.toThrow("credential cleanup failure");
    expect(localStorage.getItem("acorn-data")).toBeNull(); expect(appStore.getState().wiped).toBe(true);
    await flushSave(); expect(localStorage.getItem("acorn-data")).toBeNull();
  });
  it("cloud account deletion is confirmed before local purge, and does not sync first", async () => {
    let finish!: (value: cloud.DeleteOut) => void;
    vi.mocked(cloud.deleteAccount).mockImplementationOnce(() => new Promise(resolve => finish = resolve));
    const deleting = eraseAcornAccount(); for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(cloud.deleteAccount).toHaveBeenCalledWith(identity.token); expect(persist.purgeLocalFiles).not.toHaveBeenCalled();
    finish({ deleted: true, scope: "acorn", cdpandasAccountKept: true }); await deleting;
    expect(persist.purgeLocalFiles).toHaveBeenCalledWith({ confirmed: true }); expect(syncStore.getState().session).toBeNull(); expect(cloud.syncOnce).not.toHaveBeenCalled();
  });
  it("failed cloud deletion leaves local data and session in place", async () => {
    vi.mocked(cloud.deleteAccount).mockRejectedValueOnce(new cloud.ApiError(0, "offline", "synthetic offline"));
    await expect(eraseAcornAccount()).rejects.toThrow("offline"); expect(appStore.getState().wiped).toBe(false);
    expect(persist.purgeLocalFiles).not.toHaveBeenCalled(); expect(syncStore.getState().session?.token).toBe(identity.token); expect(localStorage.getItem("acorn-data")).not.toBeNull();
  });
  it("an unexpected success response without deletion proof cannot clear the local book", async () => {
    vi.mocked(cloud.deleteAccount).mockResolvedValueOnce({}); await expect(eraseAcornAccount()).rejects.toThrow("未确认");
    expect(persist.purgeLocalFiles).not.toHaveBeenCalled(); expect(appStore.getState().wiped).toBe(false);
  });
  it("a delayed old-account deletion response cannot clear a newly switched account", async () => {
    let finish!: (value: cloud.DeleteOut) => void; vi.mocked(cloud.deleteAccount).mockImplementationOnce(() => new Promise(resolve => finish = resolve));
    const deleting = eraseAcornAccount(); for (let n = 0; n < 8; n++) await Promise.resolve();
    const next = { ...identity, token: "synthetic-other", email: "other@example.test" }; const book = defaultData();
    syncStore.setState({ session: next }); appStore.setState({ data: book, wiped: false });
    finish({ deleted: true, scope: "acorn" }); await expect(deleting).rejects.toThrow("账号已经变化");
    expect(persist.purgeLocalFiles).not.toHaveBeenCalled(); expect(syncStore.getState().session).toBe(next); expect(appStore.getState().data).toBe(book);
  });
  it("cloud success followed by failed local cleanup reports the partial result and keeps local bytes", async () => {
    vi.mocked(persist.purgeLocalFiles).mockRejectedValueOnce(new Error("synthetic local cleanup failure"));
    await expect(eraseAcornAccount()).rejects.toThrow("橡果云端账号已注销，本机清理未完成");
    expect(localStorage.getItem("acorn-data")).not.toBeNull(); expect(syncStore.getState().session).toBeNull(); expect(appStore.getState().wiped).toBe(true);
  });
});
