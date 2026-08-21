// 同步的调度层：什么时候同步、同步失败了怎么办、界面上显示成什么样。
//
// 一条底线：**本地永远能用**。断网、服务器挂了、令牌过期，统统只影响那行小字，
// 不拦任何操作、不弹窗打断、不阻塞退出。

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { AppData } from "./model";
import { appStore, applyRemoteData, flushSave } from "./store";
import * as cloud from "./cloud";
import type { Session, SyncPhase } from "./cloud";

interface SyncStore {
  session: Session | null;
  phase: SyncPhase;
  message: string;
  /** 有没有攒着还没同步上去的改动 */
  dirty: boolean;
}

export const syncStore = createStore<SyncStore>(() => ({
  session: null,
  phase: "off",
  message: "没登录，数据只存在这台设备上",
  dirty: false,
}));

export function useSync<T>(selector: (s: SyncStore) => T): T {
  return useStore(syncStore, selector);
}

/** 改完东西静置多久才同步。太短会把每个字都发上去，太长又怕关机前没传上 */
const QUIET_MS = 4000;

let debounce: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let lastSeenData: AppData | null = null;

function set(patch: Partial<SyncStore>) {
  syncStore.setState({ ...syncStore.getState(), ...patch });
}

function humanTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hhmm : `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

function idleMessage(session: Session | null): string {
  if (!session) return "没登录，数据只存在这台设备上";
  return session.syncedAt ? `已同步 · ${humanTime(session.syncedAt)}` : "已登录，还没同步过";
}

// ---------- 对外 ----------

/** 应用启动时调一次：有登录态就恢复出来，并立刻同步一轮 */
export async function initSync(): Promise<void> {
  const session = await cloud.loadSession();
  if (!session) {
    set({ session: null, phase: "off", message: idleMessage(null) });
    return;
  }
  set({ session, phase: "idle", message: idleMessage(session) });
  watchData();
  void syncNow();
}

/** 登录 / 注册验证成功后调：存下登录态，立刻把两边并起来 */
export async function adoptSession(session: Session): Promise<void> {
  await cloud.saveSession(session);
  set({ session, phase: "idle", message: idleMessage(session), dirty: false });
  watchData();
  await syncNow();
}

/** 退出登录。默认只是断开——本机数据一个字都不动 */
export async function signOut(): Promise<void> {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  stopWatching();
  await cloud.saveSession(null);
  set({ session: null, phase: "off", message: idleMessage(null), dirty: false });
}

/** 立刻同步一轮。同一时间只会有一轮在跑，重复调用等同一个 promise */
export function syncNow(): Promise<void> {
  if (running) return running;
  const session = syncStore.getState().session;
  if (!session) return Promise.resolve();
  const state = appStore.getState();
  if (!state.loaded || state.loadError) return Promise.resolve(); // 数据都没读好，别往云上推

  set({ phase: "syncing", message: "正在同步…" });
  running = (async () => {
    try {
      const outcome = await cloud.syncOnce(session, appStore.getState().data);
      if (outcome.changed) applyRemoteData(outcome.data);
      lastSeenData = appStore.getState().data;
      const next: Session = {
        ...session,
        rev: outcome.rev,
        syncedAt: new Date().toISOString(),
      };
      await cloud.saveSession(next);
      const { added, updated, removed } = outcome.summary;
      const detail =
        added + updated + removed > 0
          ? `（收到 ${added} 条新的、${updated} 条改动${removed ? `、清掉 ${removed} 条` : ""}）`
          : "";
      set({
        session: next,
        phase: "idle",
        dirty: false,
        message: `${idleMessage(next)}${detail}`,
      });
    } catch (e) {
      const err = e as cloud.ApiError;
      if (err?.needsLogin) {
        // 令牌过期或密码改过：断开登录态，但**本机数据一个字都不动**
        await cloud.saveSession(null);
        stopWatching();
        set({
          session: null,
          phase: "error",
          message: "登录状态过期了，重新登录一下就能继续同步",
        });
        return;
      }
      set({
        phase: "error",
        message: err?.message ? `同步没成功：${err.message}` : "同步没成功，过会儿再试",
      });
    } finally {
      running = null;
    }
  })();
  return running;
}

/** 数据变过就排一次同步（静置 QUIET_MS 后真发） */
export function requestSync(): void {
  if (!syncStore.getState().session) return;
  set({ dirty: true });
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void syncNow();
  }, QUIET_MS);
}

/** 退出前最后一次：先把盘落了，再尽力推一把。**推不上去也不能拦着退出** */
export async function flushSync(): Promise<void> {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  await flushSave();
  if (!syncStore.getState().session || !syncStore.getState().dirty) return;
  try {
    await Promise.race([
      syncNow(),
      new Promise((resolve) => setTimeout(resolve, 3000)), // 最多等 3 秒，不能让人关不掉窗口
    ]);
  } catch {
    /* 退出路径上不打扰用户 */
  }
}

// ---------- 数据变动监听 ----------

function watchData(): void {
  if (unsubscribe) return;
  lastSeenData = appStore.getState().data;
  unsubscribe = appStore.subscribe(() => {
    const d = appStore.getState().data;
    if (d === lastSeenData) return;
    lastSeenData = d;
    requestSync();
  });
}

function stopWatching(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  lastSeenData = null;
}
