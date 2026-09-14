// 账号那张纸（v1.15.0）——「今天」右上角那颗头像点开的。
//
// 账本原话：「手机：自动登录可选，自动启动可选，登陆头像可上传，名称设置，主页面。右上角。
// 方便一键登入登出。」——这张纸就是那一整句。
//
// 为什么不直接跳设置页：手机上退出登录原来要走四步（更多 → 账号那一行 → 跳设置页 →
// 展开「云账号」→ 在一堆按钮里找到「只退出登录，保留本机」）。换个账号本来是两下的事。
//
// 三条底线：
// ① 这张纸上那颗「退出登录」接的**只是** syncCtl.signOut（断登录态，本机数据一条不动）。
//    「退出并清空本机」那条路必须先过 wipe.checkWipeGate 那道闸（当场同步成功才敢清），
//    它继续留在设置 → 云账号里，绝不许搬到一颗一点就中的按钮上来。
// ② 头像、名字、自动登录都存在 data.settings 里，而**设置不参与云同步**
//    （merge.ts 的 `settings: local.settings`，「从云端覆盖本机」也保留本机设置）——
//    所以它们天然是「这台设备的事」，手机上换个名字不会把电脑上的也改了。
// ③ 头像**必须压过再存**：整份数据每次同步都会连它一起传，服务端单账号只给 5MB。

import { useRef, useState } from "react";
import { showToast, updateSettings, useApp } from "../core/store";
import { applyAutoLogin, autoLoginOn, signOut, syncNow, useSync } from "../core/syncCtl";
import { CommitMark, useCommitFlash } from "../components/commitFlash";
import Sheet from "./Sheet";
import { closeSheet, openLogin, topSheet, useSheet } from "./sheetStore";
import { IcoWho } from "./icons";
import "../styles/mobile-sheet.css";

/** 头像存多大。128 见方的 JPEG 大约 6～10KB：屏幕上最大也才 64 逻辑像素，
 *  再大一档除了让每次同步多传几十 KB 之外看不出任何区别 */
export const AVATAR_PX = 128;
/** JPEG 画质。.82 是「放大看不出压缩痕迹」和「别太大」之间的常用一档 */
export const AVATAR_QUALITY = 0.82;

/** 头像上显示哪个字（跟顶栏那颗圆钮同一份口径，见 MobileHead.avatarInitial） */
export function accountInitial(name: string | undefined, email: string | undefined): string {
  const src = (name ?? "").trim() || (email ?? "").trim();
  return src ? [...src][0].toUpperCase() : "";
}

/**
 * 选中的那张图 → 128×128 的 JPEG dataURL。
 *
 * 走的是 WebView 自带的 `input type=file` + FileReader + canvas，一个插件都不用：
 * 安卓端目前全应用一处文件读写都没有（导入导出在手机上整节是关掉的），
 * 现成的原生选择器是这条路上唯一不用动 Rust 那一侧的办法。
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

export function AccountSheetHost() {
  const top = useSheet((s) => topSheet(s.stack));
  const open = top?.kind === "account";
  return (
    <Sheet open={open} onClose={closeSheet} label="账号" className="msh-acct">
      {open && <Body />}
    </Sheet>
  );
}

function Body() {
  const session = useSync((s) => s.session);
  const phase = useSync((s) => s.phase);
  const message = useSync((s) => s.message);
  const settings = useApp((s) => s.data.settings);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState(settings.profileName ?? "");
  const nameFlash = useCommitFlash();
  const picker = useRef<HTMLInputElement | null>(null);

  const autoOn = autoLoginOn(settings);
  const initial = accountInitial(settings.profileName, session?.email);

  function commitName() {
    const v = draft.trim();
    if (v === (settings.profileName ?? "")) return;
    updateSettings({ profileName: v });
    nameFlash.flash();
  }

  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    setErr(null);
    try {
      updateSettings({ profileAvatar: await shrinkToAvatar(file) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "这张图没能用上，换一张试试");
    }
  }

  function toggleAutoLogin() {
    const next = !autoOn;
    updateSettings({ autoLogin: next });
    // 关掉的那一刻就把本机那份令牌删掉。**这次照常用**——下次打开才需要重新输密码
    void applyAutoLogin(next);
  }

  // ---------- 没登录：整张纸就一颗按钮 ----------

  if (!session) {
    return (
      <div className="msh-acct-body">
        <div className="msheet-label">账号</div>
        <div className="msh-acct-none">
          <span className="msh-acct-pic big" aria-hidden="true"><IcoWho size={28} /></span>
          <p>现在记的事只存在这台手机上。登录之后，手机和电脑看到的就是同一本。</p>
        </div>
        <button
          className="msh-acct-go"
          onClick={() => {
            closeSheet();
            openLogin("manual");
          }}
        >
          登录 / 注册
        </button>
      </div>
    );
  }

  // ---------- 登录着 ----------

  return (
    <div className="msh-acct-body">
      <div className="msheet-label">账号</div>

      <div className="msh-acct-top">
        {/* 头像本身就是那颗「换一张」的按钮：手机上没有右键，也没有别的地方能放这个动作 */}
        <button className="msh-acct-pic" onClick={() => picker.current?.click()} aria-label="换张头像">
          {settings.profileAvatar ? (
            <img src={settings.profileAvatar} alt="" />
          ) : initial ? (
            <span>{initial}</span>
          ) : (
            <IcoWho size={28} />
          )}
          <span className="edit" aria-hidden="true">换</span>
        </button>
        <div className="msh-acct-id">
          <div className="msh-acct-namerow">
            <input
              className={`msh-field wide${nameFlash.on ? " commit-lit" : ""}`}
              value={draft}
              aria-label="名字"
              placeholder="给自己起个名字"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setDraft(settings.profileName ?? "");
                }
              }}
              // 点走就存下（跟清单改名、快捷键那两处同一道闸）。
              // **窗口失焦不算点走**：切出去接个电话回来，打了一半的名字还在框里等他自己了结
              onBlur={() => { if (document.hasFocus()) commitName(); }}
            />
            <CommitMark on={nameFlash.on} />
          </div>
          <div className="msh-acct-mail">{session.email}</div>
        </div>
      </div>
      {/* 原生选择器：安卓的 WebView 自己会弹相册/文件，不用插件。
          value 每次清空，连选两次同一张图也还会触发 change */}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void pickAvatar(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div className="msh-acct-sync">
        <span className={`msh-acct-state ${phase}`}>{message}</span>
        <button className="msh-opt" disabled={phase === "syncing"} onClick={() => void syncNow()}>
          {phase === "syncing" ? "同步中" : "立即同步"}
        </button>
      </div>

      <button
        className="msh-acct-row"
        role="switch"
        aria-checked={autoOn}
        onClick={toggleAutoLogin}
      >
        <span className="t">
          下次打开还认这台手机
          <span className="why">
            {autoOn
              ? "关掉之后，下次打开橡果要重新输一次密码"
              : "这次照常同步；下次打开要重新输密码。没登录那段时间记的东西不会传上去，再登录时可能要在「云端和本机两份档案」里挑一份"}
          </span>
        </span>
        <span className={`msh-switch${autoOn ? " on" : ""}`} aria-hidden="true" />
      </button>

      {/* 自启动：这一版只说实话，不做一颗按了没反应的按钮（跟清单设置里「调整清单顺序」同一个做法）。
          真要做「开机自己起来」，得给安卓加开机广播 + 一个常驻通知的前台服务：
          通知栏常年挂个图标、耗电、国产手机还得用户自己一层层放行——那是另一件事，得用户单独点头 */}
      <div className="msh-acct-row dim">
        <span className="t">
          让提醒准时响
          <span className="why">
            橡果没开着的时候提醒不会响。到手机的「设置 → 应用 → 橡果」里允许自启动、
            把省电策略改成「不限制」，它才叫得动你。
          </span>
        </span>
      </div>

      {err && <p className="msh-acct-err">{err}</p>}

      {/* 一键退出：接的是「只退出登录，保留本机」那条路——这台设备上的东西一条都不动。
          「退出并清空本机」得先过那道「当场同步成功了吗」的闸，继续留在设置 → 云账号里 */}
      <button
        className="msh-acct-out"
        onClick={() => {
          void signOut().then(() => {
            closeSheet();
            showToast("已退出登录。这台设备上的数据原样留着，一条都没清", false);
          });
        }}
      >
        退出登录
        <span className="why">这台设备上的事一条都不动，想清空要去设置 → 云账号</span>
      </button>
    </div>
  );
}
