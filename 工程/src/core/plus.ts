// Plus是账号资格，与正式/beta版本通道无关；缓存与本机开关不进账本。
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { inTauri, isAndroid, isDesktopShell, isWebBuild } from "./platform";

export const PLUS_OWNER_EMAIL = "bower.6868@gmail.com";
export interface PlusMetadata { email: string; plus?: boolean; ultra?: boolean; plusCanToggle?: boolean }
type Identity = { email: string; token: string } | null;
interface PlusState { account: string | null; entitled: boolean; canToggle: boolean; enabled: boolean; revision: number }
interface Cache { version: 1; account: string; entitled: boolean; canToggle: boolean }
interface Dependencies {
  supported: () => boolean;
  storage: () => Pick<Storage, "getItem" | "setItem"> | null;
}
const normalize = (email: string) => email.trim().toLowerCase();
const CACHE = "acorn-plus-entitlement:";
const PREFERENCE = "acorn-plus-enabled:";

/** DI controller keeps metadata/session races testable without credentials or real storage. */
export function createPlusController(deps: Dependencies) {
  const store = createStore<PlusState>(() => ({ account: null, entitled: false, canToggle: false, enabled: false, revision: 0 }));
  let activeToken: string | null = null;
  let identityEpoch = 0;
  const preferences = new Map<string, boolean>();
  function read(key: string): string | null { try { return deps.storage()?.getItem(key) ?? null; } catch { return null; } }
  function write(key: string, value: string) { try { deps.storage()?.setItem(key, value); } catch { /* memory remains usable */ } }
  function commit(account: string | null, entitled: boolean, canToggle: boolean, identityChanged = false) {
    canToggle = entitled && canToggle && account === PLUS_OWNER_EMAIL;
    if (account && !preferences.has(account)) preferences.set(account, read(PREFERENCE + account) !== "false");
    const enabled = deps.supported() && entitled && (!canToggle || preferences.get(account!) !== false);
    const before = store.getState();
    if (!identityChanged && before.account === account && before.entitled === entitled && before.canToggle === canToggle && before.enabled === enabled) return;
    store.setState({ account, entitled, canToggle, enabled, revision: before.revision + 1 });
  }
  function setSession(identity: Identity) {
    const account = identity ? normalize(identity.email) : null;
    const token = identity?.token || null;
    const before = store.getState();
    if (account === before.account && token === activeToken) return;
    activeToken = token;
    identityEpoch++;
    let cached: Partial<Cache> | null = null;
    try { cached = account && token ? JSON.parse(read(CACHE + account) ?? "null") : null; } catch { /* invalid cache is unentitled */ }
    const valid = cached?.version === 1 && cached.account === account;
    commit(account, !!valid && cached?.entitled === true, !!valid && cached?.canToggle === true, true);
  }
  function applyMetadata(token: string, metadata: PlusMetadata, expectedEpoch?: number): boolean {
    const account = store.getState().account;
    if (expectedEpoch !== undefined && expectedEpoch !== identityEpoch || !account || !activeToken || token !== activeToken || normalize(metadata.email) !== account) return false;
    const entitled = typeof metadata.plus === "boolean" ? metadata.plus : metadata.ultra === true;
    // A local email string alone never creates the owner's switch or a grant.
    const canToggle = entitled && metadata.plusCanToggle === true && account === PLUS_OWNER_EMAIL;
    write(CACHE + account, JSON.stringify({ version: 1, account, entitled, canToggle } satisfies Cache));
    commit(account, entitled, canToggle);
    return true;
  }
  function metadataReceiver(token: string) {
    const epoch = identityEpoch;
    const validAtStart = !!activeToken && token === activeToken;
    return (metadata: PlusMetadata) => validAtStart && applyMetadata(token, metadata, epoch);
  }
  function setEnabled(on: boolean): boolean {
    const state = store.getState();
    if (!deps.supported() || !state.account || !state.entitled || !state.canToggle || state.account !== PLUS_OWNER_EMAIL) return false;
    write(PREFERENCE + state.account, String(on));
    preferences.set(state.account, on);
    const enabled = deps.supported() && on;
    if (enabled !== state.enabled) store.setState({ enabled, revision: state.revision + 1 });
    return true;
  }
  /** Only the main-window bridge supplies this to the standalone quick-add window. */
  function setWindowContext(enabled: boolean) {
    identityEpoch++;
    activeToken = null;
    const before = store.getState();
    enabled = deps.supported() && enabled;
    if (before.account === null && before.enabled === enabled && before.entitled === enabled) return;
    store.setState({ account: null, entitled: enabled, canToggle: false, enabled, revision: before.revision + 1 });
  }
  return { store, setSession, applyMetadata, metadataReceiver, setEnabled, setWindowContext };
}

// 认得 Plus 的端：装在 Windows 上的橡果，和（10-30 起）装在安卓上的橡果。网页版仍然不认。
// 资格只看账号（服务器判），这里只回答「这一端有没有做图片功能」
// VITE_ACORN_PLUS_PREVIEW 只给验收截图用的那份构建（vite build --mode plus-preview）：浏览器里冒充安卓 App，
// 并把控制器挂到 window 上好塞一个演示账号。正式包里这个常量是 false，整段被打包器删掉
const PLUS_PREVIEW = import.meta.env.VITE_ACORN_PLUS_PREVIEW === "1";
const supported = () => !isWebBuild && typeof navigator !== "undefined"
  && (isDesktopShell && /Windows/i.test(navigator.userAgent) || (inTauri || PLUS_PREVIEW) && isAndroid);
const controller = createPlusController({
  supported,
  storage: () => typeof localStorage === "undefined" ? null : localStorage,
});
if (PLUS_PREVIEW && typeof window !== "undefined") (window as unknown as { __acornPlus: typeof controller }).__acornPlus = controller;
export const plusStore = controller.store;
export const setPlusSession = controller.setSession;
export const applyPlusMetadata = controller.applyMetadata;
export const plusMetadataReceiver = controller.metadataReceiver;
export const setPlusEnabled = controller.setEnabled;
export const setPlusWindowContext = controller.setWindowContext;
export function plusEnabled(): boolean { return plusStore.getState().enabled; }
export function usePlus(): boolean { return useStore(plusStore, (s) => s.enabled); }
export function usePlusCanToggle(): boolean { return useStore(plusStore, (s) => s.canToggle && supported()); }
