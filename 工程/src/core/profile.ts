// 名字和头像（v1.15.1 起跟着账号走）。
//
// 用户原话：手机上设了名字和头像，电脑上看不到。原因是它们原来住在 settings 里，
// 而设置不参与云同步（merge.ts 的 `settings: local.settings`）。现在挪到账本顶层的
// `profiles`，按账号邮箱分键，合并时每个账号那一条谁改得晚听谁的（merge.mergeProfiles）。
//
// 几条口径：
// ① **按账号分键，读的时候只认当前账号那一条**：这台设备退出 A 登上 B，
//    A 的那张脸不会被当成 B 的显示出来，合并时也不会盖掉 B 自己那条。
// ② **缺失 = 没有信息**：一边没有，另一边那条原样留着；没登录就什么都不显示（画个人形）。
// ③ **老客户端（v1.15.0）不认 profiles**：它读进来原样留着、推上去原样带着（migrate 和
//    mergeData 顶层都先铺开原对象），不会抹掉。它唯一做不对的是「同名听本机」——
//    它手里要是揣着一份旧的，同步时会把云端推回旧的那张；新版本这边按 updatedAt 比，
//    下一轮就把新的那张再推回去，头像不会丢，只是那台老设备升级之前可能看到旧的。
// ④ 旧字段 settings.profileName / profileAvatar 在第一次登录着打开新版时迁进来一次
//    （adoptLegacyProfile），盖 1970 年的戳：任何一端的真实修改都盖得过它，
//    而对面完全没有时它又能传过去。旧字段本身不删，还没升级的那台设备照旧靠它显示。
//
// 这里放纯函数和两个写入口；界面（手机账号纸、顶栏头像，以后桌面那颗）只从这儿读写。

import type { AppData, Profile } from "./model";
import { appStore, setProfiles } from "./store";

/** 旧字段迁进来的那一条盖的戳。比任何一次真实修改都早 */
export const LEGACY_PROFILE_AT = new Date(0).toISOString();

/** 头像存多大。128 见方的 JPEG 大约 6～10KB：屏幕上最大也才 64 逻辑像素，
 *  再大一档除了让每次同步多传几十 KB 之外看不出任何区别 */
export const AVATAR_PX = 128;
/** JPEG 画质。.82 是「放大看不出压缩痕迹」和「别太大」之间的常用一档 */
export const AVATAR_QUALITY = 0.82;
/** 一张头像最多多长（dataURL 的字符数）。正常压出来 1 万上下，这道闸只防别的路径塞进来原图：
 *  整份数据每次同步都连它一起传，服务端单账号只给 5MB */
export const AVATAR_MAX_CHARS = 200 * 1024;

/** 账号邮箱 → profiles 里的键。大小写、前后空格不算，免得同一个账号分出两条 */
export function profileKey(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** 这个账号的名字和头像。没登录、没设过、那一条形状不对，一律两个空串 */
export function getProfile(
  data: Pick<AppData, "profiles">,
  email: string | null | undefined,
): { name: string; avatar: string } {
  const key = profileKey(email);
  const p = key ? (data.profiles as Record<string, unknown> | undefined)?.[key] : undefined;
  if (!p || typeof p !== "object") return { name: "", avatar: "" };
  const { name, avatar } = p as Partial<Profile>;
  return {
    name: typeof name === "string" ? name : "",
    avatar: typeof avatar === "string" ? avatar : "",
  };
}

/**
 * 头像上显示哪个字。名字优先于邮箱——用户自己起的名字才是他认得的自己。
 * 两边都空着（还没登录）返回空串，由调用处画一个人形轮廓。
 *
 * 取「第一个字」而不是首字母缩写：中文名取一个字正好，邮箱取一个字母也够认。
 * **全仓库只有这一份口径**：手机顶栏那颗圆钮、账号纸、以后桌面那颗都用它。
 */
export function avatarInitial(name: string | undefined, email: string | undefined): string {
  const src = (name ?? "").trim() || (email ?? "").trim();
  return src ? [...src][0].toUpperCase() : "";
}

/** 改完之后该盖的戳：一般就是现在；这台设备的钟要是比上一次改动还慢，就在上一次后面挪 1 毫秒，
 *  否则「谁改得晚听谁的」会让这次真实的修改输给那条旧的 */
function nextStamp(prev: string | undefined, now = new Date()): string {
  const at = now.toISOString();
  if (prev === undefined || at > prev) return at;
  const t = Date.parse(prev);
  return Number.isFinite(t) ? new Date(t + 1).toISOString() : at;
}

/** 写这个账号那一条。**条目里不认识的字段原样留着**（更新版本可能往里加东西）；
 *  跟现在一模一样就什么都不做，不白白改一次戳、推一轮同步 */
function writeProfile(email: string | null | undefined, patch: Partial<Pick<Profile, "name" | "avatar">>): boolean {
  const key = profileKey(email);
  if (!key) return false;
  const d = appStore.getState().data;
  const all = (d.profiles ?? {}) as Record<string, unknown>;
  const raw = all[key];
  const cur = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<Profile>) : {};
  const was = getProfile(d, email);
  const name = patch.name ?? was.name;
  const avatar = patch.avatar ?? was.avatar;
  if (name === was.name && avatar === was.avatar) return false;
  const prevAt = typeof cur.updatedAt === "string" ? cur.updatedAt : undefined;
  setProfiles({ ...all, [key]: { ...cur, name, avatar, updatedAt: nextStamp(prevAt) } } as Record<string, Profile>);
  return true;
}

/** 改名字（前后空格去掉）。没登录不写——名字是账号的，不是这台设备的 */
export function setProfileName(email: string | null | undefined, name: string): boolean {
  return writeProfile(email, { name: name.trim() });
}

/** 换头像。只收图片 dataURL、而且不许超过 AVATAR_MAX_CHARS；空串 = 不要头像了 */
export function setProfileAvatar(email: string | null | undefined, avatar: string): boolean {
  if (avatar !== "" && (!avatar.startsWith("data:image/") || avatar.length > AVATAR_MAX_CHARS)) return false;
  return writeProfile(email, { avatar });
}

/**
 * 旧字段迁进来（纯函数，不碰 store）。返回新的一份，不用迁就原样返回同一个对象。
 *
 * 只在「这台设备上一个账号的名字头像都还没有」时迁：一旦有过任何一条，
 * 旧字段就不再代表谁了——它是这台设备从前的事，那时登着的是谁，就算谁的。
 * 迁给的是**此刻登录着的这个账号**；没登录不迁（没有主人可认）。
 */
export function adoptLegacyProfile(data: AppData, email: string | null | undefined): AppData {
  const key = profileKey(email);
  if (!key) return data;
  const existing = data.profiles;
  if (existing && typeof existing === "object" && Object.keys(existing).length > 0) return data;
  const name = typeof data.settings?.profileName === "string" ? data.settings.profileName.trim() : "";
  const avatar = typeof data.settings?.profileAvatar === "string" ? data.settings.profileAvatar : "";
  if (!name && !avatar) return data;
  return {
    ...data,
    profiles: { ...(existing ?? {}), [key]: { name, avatar, updatedAt: LEGACY_PROFILE_AT } },
  };
}

/**
 * 选中的那张图 → 128×128 的 JPEG dataURL。
 *
 * 走的是 WebView 自带的 `input type=file` + FileReader + canvas，一个插件都不用：
 * 安卓端目前全应用一处文件读写都没有（导入导出在手机上整节是关掉的），
 * 现成的原生选择器是这条路上唯一不用动 Rust 那一侧的办法；桌面的 WebView2 和浏览器同样认它。
 *
 * **居中裁成正方形再缩**：直接缩到 128×128 会把竖着拍的人像压扁，
 * 而头像框本来就是个圆，裁掉的正是圆外面看不见的那两条。
 */
export function shrinkToAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("这张图读不出来，换一张试试"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("这张图打不开，换一张试试"));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        if (!side) {
          reject(new Error("这张图打不开，换一张试试"));
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_PX;
        canvas.height = AVATAR_PX;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("这台设备处理不了这张图"));
          return;
        }
        ctx.drawImage(
          img,
          (img.width - side) / 2, (img.height - side) / 2, side, side,
          0, 0, AVATAR_PX, AVATAR_PX,
        );
        resolve(canvas.toDataURL("image/jpeg", AVATAR_QUALITY));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
