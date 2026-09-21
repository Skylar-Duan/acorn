// 主区右上角那颗头像 + 点开的账号小面板（v1.15.1）。只挂在桌面那一套界面上
// （装好的橡果和电脑浏览器里的网页版都算，App.tsx 里 !isMobile 那一段挂一次，各页不各写）。
//
// 用户原话：「电脑版：头像显示在右上角，头像账号页面没有做出来（手机版设置了名称、头像，
// 电脑版没有地方显示）」。手机那边是「今天」右上角的圆钮 + 账号纸（mobile/AccountSheet），
// 这里是同一件事的桌面长相：
//   · 圆钮：有图显示图，没图显示名字或邮箱的第一个字，没登录画个人形——**点了直接去登录**
//   · 面板：贴着右上角的小浮层，点外面或按 Esc 关。换头像、改名字、同步状态 + 立即同步、
//     「下次打开还认这台电脑」、退出登录、「更多账号设置」跳设置页并展开账号那一节
//
// 两条底线（跟账号纸同一套，见 AccountSheet.tsx 顶上）：
// ① 这儿的「退出登录」接的**只是** syncCtl.signOut：断登录态，本机数据一条不动。
//    「退出并清空本机」要先过 wipe.checkWipeGate 那道闸，它和「注销」一起继续只留在设置页。
// ② 名字和头像读写只走 core/profile.ts（跟着账号走、参与云同步），这里不自己存一份。

import { useEffect, useRef, useState } from "react";
import { navigate, showToast, updateSettings, useApp } from "../core/store";
import { applyAutoLogin, autoLoginOn, signOut, syncNow, useSync } from "../core/syncCtl";
import { avatarInitial, getProfile, setProfileAvatar, setProfileName, shrinkToAvatar } from "../core/profile";
import { forceFoldOpen } from "../core/useFold";
import { CommitMark, useCommitFlash } from "./commitFlash";
import { openLogin } from "../mobile/sheetStore";
import { IcoWho } from "../mobile/icons";
import "../styles/account-pop.css";

/** 圆钮里画什么：图 > 首字 > 人形。圆钮和面板里那颗大的用同一份 */
function Face({ avatar, initial, size }: { avatar: string; initial: string; size: number }) {
  if (avatar) return <img src={avatar} alt="" />;
  if (initial) return <span>{initial}</span>;
  return <IcoWho size={size} />;
}

export default function AccountCorner() {
  const session = useSync((s) => s.session);
  const email = session?.email;
  // 选两个字符串而不是一个对象：选择器每次返回新对象，zustand 会当成一直在变
  const name = useApp((s) => getProfile(s.data, email).name);
  const avatar = useApp((s) => getProfile(s.data, email).avatar);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  // 登出了（这里点的、设置页点的、令牌过期被踢的都算）面板跟着收，不留一张空壳
  useEffect(() => {
    if (!session) setOpen(false);
  }, [session]);

  // 点外面、按 Esc 都关。按下那一刻就判，不等 click：拖着选字拖出框外也算点了外面
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initial = avatarInitial(name, email);

  return (
    <div className="acct-corner" ref={wrap}>
      <button
        className={`acct-fab${open ? " on" : ""}`}
        title={session ? "账号" : "登录"}
        aria-label={session ? "账号" : "登录"}
        aria-expanded={session ? open : undefined}
        onClick={() => {
          // 没登录：面板里本来也只会剩一颗「登录」，不如直接去登录
          if (!session) {
            openLogin("manual");
            return;
          }
          setOpen((v) => !v);
        }}
      >
        <Face avatar={session ? avatar : ""} initial={session ? initial : ""} size={18} />
      </button>
      {open && session && (
        <Panel email={session.email} name={name} avatar={avatar} initial={initial} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function Panel({
  email,
  name,
  avatar,
  initial,
  onClose,
}: {
  email: string;
  name: string;
  avatar: string;
  initial: string;
  onClose: () => void;
}) {
  const phase = useSync((s) => s.phase);
  const message = useSync((s) => s.message);
  const settings = useApp((s) => s.data.settings);
  const [draft, setDraft] = useState(name);
  const [err, setErr] = useState<string | null>(null);
  const nameFlash = useCommitFlash();
  const picker = useRef<HTMLInputElement | null>(null);
  const autoOn = autoLoginOn(settings);

  function commitName() {
    const v = draft.trim();
    if (v === name) return;
    setProfileName(email, v);
    nameFlash.flash();
  }

  // 面板收起时（点外面、Esc、点圆钮）名字框还攥着没存的字，就在这一刻存下。
  // 不能指望 blur：面板是直接拆掉的，拆掉一个正聚焦的框，浏览器不一定再补发一次失焦
  const commitRef = useRef(commitName);
  commitRef.current = commitName;
  useEffect(() => () => commitRef.current(), []);

  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    setErr(null);
    try {
      setProfileAvatar(email, await shrinkToAvatar(file));
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

  return (
    <div className="acct-pop" role="dialog" aria-label="账号">
      <div className="acct-pop-top">
        {/* 头像本身就是「换一张」的按钮，跟账号纸一样 */}
        <button className="acct-pop-pic" onClick={() => picker.current?.click()} title="换张头像" aria-label="换张头像">
          <Face avatar={avatar} initial={initial} size={26} />
          <span className="edit" aria-hidden="true">换</span>
        </button>
        <div className="acct-pop-id">
          <div className="acct-pop-namerow">
            <input
              className={`input acct-pop-name${nameFlash.on ? " commit-lit" : ""}`}
              value={draft}
              aria-label="名字"
              placeholder="给自己起个名字"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
                // 改了一半按 Esc：先把字退回去，这一下不关面板；没改过的时候 Esc 照常关
                if (e.key === "Escape" && draft !== name) {
                  e.stopPropagation();
                  setDraft(name);
                }
              }}
              // 点走就存下。**窗口失焦不算点走**：切出去回来，打了一半的名字还在框里
              onBlur={() => { if (document.hasFocus()) commitName(); }}
            />
            <CommitMark on={nameFlash.on} />
          </div>
          <div className="acct-pop-mail">{email}</div>
        </div>
      </div>
      {/* WebView2 和浏览器都认 input type=file，不用插件。value 每次清空，连选两次同一张也会触发 */}
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

      <div className="acct-pop-sync">
        <span className={`acct-pop-state ${phase}`}>{message}</span>
        <button className="btn" disabled={phase === "syncing"} onClick={() => void syncNow()}>
          {phase === "syncing" ? "同步中" : "立即同步"}
        </button>
      </div>

      <button className="acct-pop-row" role="switch" aria-checked={autoOn} onClick={toggleAutoLogin}>
        <span className="t">
          下次打开还认这台电脑
          <span className="why">
            {autoOn ? "关掉之后，下次打开橡果要重新输一次密码" : "这次照常同步；下次打开要重新输密码"}
          </span>
        </span>
        <span className={`acct-pop-switch${autoOn ? " on" : ""}`} aria-hidden="true" />
      </button>

      {err && <p className="acct-pop-err">{err}</p>}

      <div className="acct-pop-foot">
        <button
          className="acct-pop-more"
          onClick={() => {
            onClose();
            // 设置页每次进来本来就展开账号那一节；已经在设置页里时靠这一下把它掰开
            forceFoldOpen("cloud", "acorn-set-");
            navigate("settings");
          }}
        >
          更多账号设置
        </button>
        {/* 只接 signOut：这台设备上的东西一条都不动。清空本机和注销只在设置页里 */}
        <button
          className="btn ghost"
          onClick={() => {
            void signOut().then(() => {
              onClose();
              showToast("已退出登录。这台设备上的数据原样留着，一条都没清", false);
            });
          }}
        >
          退出登录
        </button>
      </div>
      <p className="acct-pop-hint">退出登录不动这台设备上的事。想清空要去设置 → 账号</p>
    </div>
  );
}
