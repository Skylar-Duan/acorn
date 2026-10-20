/** 明确确认后的账号动作。纯退出保留本机，清本机与注销都不擅自上传仅本机图片。 */
import * as cloud from "./cloud";
import * as persist from "./persist";
import { appStore, haltPersistence } from "./store";
import { signOut, syncStore } from "./syncCtl";

function sameSession(session: cloud.Session): boolean {
  const current = syncStore.getState().session;
  return current?.token === session.token && current.email === session.email;
}

function requireSession(): cloud.Session {
  const session = syncStore.getState().session;
  if (!session) throw new Error("请先登录要处理的账号");
  return session;
}

async function purgeAndSignOut(session: cloud.Session, onPurged: () => void, onAttempt: () => void): Promise<void> {
  if (!sameSession(session)) throw new Error("账号已经变化，本机数据未删除");
  // confirmed由已弹出确认框的专用流程传入；旧purge调用保留原生登录文件护栏。
  onAttempt();
  await persist.purgeLocalFiles({ confirmed: true });
  onPurged();
  if (!sameSession(session)) throw new Error("账号已经变化，请检查当前设备的登录状态");
  await signOut();
  persist.clearLocalPrefs();
}

/** 用户确认删除本机：离线也可执行，不强制把未勾选同步的图片上传。 */
export async function clearLocalAccountData(): Promise<void> {
  const session = requireSession();
  const book = appStore.getState().data;
  let purged = false;
  let attempted = false;
  await haltPersistence();
  try {
    await purgeAndSignOut(session, () => { purged = true; }, () => { attempted = true; });
  } catch (error) {
    // 文件可能已删了一部分，不能把旧内存写回去复活；当前会话仍可点删除重试。
    if (!attempted && appStore.getState().data === book) appStore.setState({ wiped: false });
    if (attempted && !purged) throw new Error(`删除未完成，请重试；为避免已删内容恢复，本机暂不保存：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** 注销橡果云端后再清本机；共享cdpandas统一账号不在删除范围。 */
export async function eraseAcornAccount(): Promise<cloud.DeleteOut> {
  const session = requireSession();
  const book = appStore.getState().data;
  await haltPersistence();
  let deleted = false;
  let attempted = false;
  try {
    if (!sameSession(session)) throw new Error("账号已经变化，未执行注销");
    const response = await cloud.deleteAccount(session.token);
    if (response.deleted !== true || (response.scope && response.scope !== "acorn")) {
      throw new Error("服务器未确认橡果账号已注销，本机数据已保留");
    }
    deleted = true;
    await purgeAndSignOut(session, () => {}, () => { attempted = true; });
    return response;
  } catch (error) {
    // 旧请求不可恢复或清空已经切换到的新账本。
    if (!attempted && appStore.getState().data === book) appStore.setState({ wiped: false });
    if (deleted && sameSession(session)) {
      await signOut().catch(() => {});
      throw new Error(`橡果云端账号已注销，本机清理未完成：${String(error instanceof Error ? error.message : error)}`);
    }
    throw error;
  }
}
