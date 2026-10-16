import { appStore } from "./store";
import { syncStore } from "./syncCtl";

export interface ImageOperation { valid: () => boolean; dispose: () => void }

/** 操作开始后发生过登出、换账号、卸载目标或账本清空，就不能把结果写入新上下文。 */
export function imageEditContext(canEdit: () => boolean = () => true): ImageOperation {
  const sessionKey = () => { const session = syncStore.getState().session; return session ? `${session.email}\n${session.token}` : ""; };
  const original = sessionKey();
  let invalid = false;
  const offSession = syncStore.subscribe(() => { if (sessionKey() !== original) invalid = true; });
  const offData = appStore.subscribe((s) => { if (!s.loaded || s.loadError || s.wiped || !canEdit()) invalid = true; });
  return {
    valid: () => { const s = appStore.getState(); return !invalid && sessionKey() === original && s.loaded && !s.loadError && !s.wiped && canEdit(); },
    dispose: () => { offSession(); offData(); },
  };
}
