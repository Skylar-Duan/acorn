// 设置页的「反馈」一节（2026-09-21，用户：「三端：反馈入口做出来（放到设置里面）」）。
//
// 两屏：
//   · 没登录 → 一行灰字「登录后就能发反馈」+「去登录」（反馈要知道是谁发的，好回他）
//   · 登录了 → 一个会自己长高的框 +「发送」。端、版本、设备自动带上（core/feedback.feedbackPayload），
//     发成了清空框子、说一声「收到了，谢谢」；没成就一行人话，框里写的字留着不动。
// 管理员（/api/me 的 feedbackAdmin，跟服务端反馈后台放行的条件一样）底下多一行「查看大家的反馈」，
// 开的是介绍页；是管理员但隔了一阵没登录（isAdmin 真、feedbackAdmin 假）只说一句「先退出再登录一次」。
// 发送撞上 401：跟同步一样断开登录态（syncCtl.expireSession），本机数据不动。
//
// 判据和说法都在 core/feedback.ts，这里只管长相；网络请求走 core/cloud.submitFeedback。

import { useEffect, useRef, useState } from "react";
import * as cloud from "../core/cloud";
import { expireSession, useSync } from "../core/syncCtl";
import { showToast } from "../core/store";
import { openLogin } from "../mobile/sheetStore";
import {
  FEEDBACK_ADMIN_STALE_TEXT, FEEDBACK_ADMIN_URL, canSendFeedback, feedbackAdminStale, feedbackCountText,
  feedbackErr, feedbackPayload, isFeedbackAdmin, openExternal,
} from "../core/feedback";
import { growArea } from "./autogrow";

export default function FeedbackPanel() {
  const session = useSync((s) => s.session);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; login: boolean } | null>(null);
  // 刚才发送撞上 401 被断开的：没登录那一屏说清为什么，别让人以为是自己点了退出
  const [expired, setExpired] = useState(false);
  const [admin, setAdmin] = useState<"yes" | "stale" | "no">("no");
  const area = useRef<HTMLTextAreaElement>(null);

  // 高度跟着内容走：打字长高，发出去清空了也要缩回去（光靠 onChange 缩不回来）
  useEffect(() => growArea(area.current), [text]);

  // 是不是管理员：登录着就问一句 /api/me。问不出来（断网、老服务器）就当不是——
  // 那一行链接只是个方便，不该为它报错
  useEffect(() => {
    setAdmin("no");
    setErr(null);
    if (!session) return;
    setExpired(false);
    let alive = true;
    cloud
      .whoAmI(session.token)
      .then((info) => {
        if (alive) setAdmin(isFeedbackAdmin(info) ? "yes" : feedbackAdminStale(info) ? "stale" : "no");
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session?.token]);

  if (!session) {
    return (
      <div className="set-row col">
        <p className="hint">{expired ? "登录已经过期，重新登录后再发。写的字还在。" : "登录后就能发反馈。"}</p>
        <div className="acct-actions">
          <button className="btn" onClick={() => openLogin("manual")}>去登录</button>
        </div>
      </div>
    );
  }

  const token = session.token;
  const count = feedbackCountText(text);
  const ready = canSendFeedback(text) && !busy;

  async function send() {
    if (!ready) return;
    setBusy(true);
    setErr(null);
    try {
      await cloud.submitFeedback(token, feedbackPayload(text));
      setText("");
      showToast("收到了，谢谢", false);
    } catch (e) {
      // 令牌不认了：跟同步撞上 401 一样断开登录态（本机数据不动），这一节随之换成「登录后就能发反馈」。
      // 写的字留在 text 里，重新登录回来还在
      if (e instanceof cloud.ApiError && e.needsLogin) {
        setExpired(true);
        await expireSession();
        return;
      }
      setErr(feedbackErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function openAdmin() {
    if (!(await openExternal(FEEDBACK_ADMIN_URL))) {
      showToast(`打不开浏览器，请自己打开：${FEEDBACK_ADMIN_URL}`, false);
    }
  }

  return (
    <div className="set-row col">
      <textarea
        className="input fb-input"
        rows={3}
        placeholder="哪里不好用、想要什么，都可以写在这里"
        value={text}
        ref={area}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="acct-actions">
        <button className="btn primary" disabled={!ready} onClick={() => void send()}>
          {busy ? "发送中…" : "发送"}
        </button>
        {count && <span className={`fb-count${count.startsWith("超出") ? " over" : ""}`}>{count}</span>}
      </div>
      {err && (
        <div className="acct-actions">
          <p className="acct-err">{err.text}</p>
          {err.login && (
            <button className="btn ghost" onClick={() => openLogin("manual")}>去登录</button>
          )}
        </div>
      )}
      {admin === "yes" && (
        <button className="fb-admin" onClick={() => void openAdmin()}>查看大家的反馈</button>
      )}
      {admin === "stale" && <p className="hint">{FEEDBACK_ADMIN_STALE_TEXT}</p>}
    </div>
  );
}
