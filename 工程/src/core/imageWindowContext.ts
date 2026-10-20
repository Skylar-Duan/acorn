import { appStore } from "./store";
import { syncStore } from "./syncCtl";
import { newId } from "./model";
import { ledgerImageBytes } from "./taskImages";
import { plusStore } from "./plus";

let contextId = newId();
let started = false;
/** 只下发随机代号与已用容量，不把账号或令牌传给图片浮窗。 */
export function imageWindowContext(): { imageContextId: string; imageBudgetUsed: number } {
  if (!started) {
    started = true;
    const key = () => { const s = syncStore.getState().session; return s ? `${s.email}\n${s.token}` : ""; };
    let previous = key();
    syncStore.subscribe(() => { const next = key(); if (next !== previous) { previous = next; contextId = newId(); } });
    plusStore.subscribe((next, old) => { if (next.revision !== old.revision) contextId = newId(); });
    appStore.subscribe((s) => { if (!s.loaded || s.loadError || s.wiped) contextId = newId(); });
  }
  return { imageContextId: contextId, imageBudgetUsed: ledgerImageBytes(appStore.getState().data) };
}
