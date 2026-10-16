"""发信。走 cdpandas 既有那条后端通道：Resend SMTP，From = noreply@cdpandas.com。

两个已知的坑（10-Platform 踩过，别再踩）：
1. SMTP 用户名 ≠ 信封发件人。Resend 的用户名是字面量 "resend"，信封发件人必须是
   noreply@cdpandas.com，混用会被 501 Bad sender address syntax 顶回来。
2. 验证「发信能到」不能发给自己域的别名（会转回同一个 Gmail 收件箱），只有收件方
   邮件头里的 Authentication-Results 算数。

没配 SMTP 时不真发信——把验证码打进日志，本地开发和自测用。
"""

from __future__ import annotations

import logging
import smtplib
import ssl
import html
from email.message import EmailMessage
from email.utils import formataddr

from .config import settings

log = logging.getLogger("acorn.mail")

SUBJECT = "橡果 Acorn 验证码"

TEXT = """你好，

你的橡果验证码是 {code}

{purpose_line}
验证码 {minutes} 分钟内有效，用完即失效。

如果这不是你本人操作，忽略这封信就好，你的账号不会有任何变化。

—— 橡果 Acorn
"""

HTML = """<div style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;
            font-size:15px;color:#3a3a36;line-height:1.8;max-width:520px">
  <p>你好，</p>
  <p>你的橡果验证码是</p>
  <p style="font-size:30px;letter-spacing:8px;font-weight:600;color:#6b7f5e;margin:18px 0">{code}</p>
  <p>{purpose_line}<br>验证码 {minutes} 分钟内有效，用完即失效。</p>
  <p style="color:#8a8a82;font-size:13px">
    如果这不是你本人操作，忽略这封信就好，你的账号不会有任何变化。
  </p>
  <p style="color:#8a8a82;font-size:13px">—— 橡果 Acorn</p>
</div>"""

PURPOSE_LINE = {
    "verify": "输入它就能激活账号，之后手机和电脑上的事就是同一份了。",
    "reset": "输入它就能重设密码。",
}


def send_code(to_email: str, code: str, purpose: str = "verify") -> None:
    """发验证码。发不出去就抛异常，让上层告诉用户「没发出去，过会儿再试」。"""
    minutes = max(1, settings.code_ttl_seconds // 60)
    line = PURPOSE_LINE.get(purpose, PURPOSE_LINE["verify"])

    if not settings.mail_enabled:
        log.warning("[没配 SMTP，不真发信] %s 的验证码是 %s（%s）", to_email, code, purpose)
        return

    msg = EmailMessage()
    msg["Subject"] = SUBJECT
    msg["From"] = formataddr((settings.mail_from_name, settings.mail_from))
    msg["To"] = to_email
    msg.set_content(TEXT.format(code=code, purpose_line=line, minutes=minutes))
    msg.add_alternative(HTML.format(code=code, purpose_line=line, minutes=minutes), subtype="html")

    _deliver(msg, to_email)


ALREADY_TEXT = """你好，

有人用这个邮箱注册橡果，但它已经注册过了。

直接用它登录就行。想不起密码就在登录页点「忘记密码」，我们会再发一封验证码给你。

如果这不是你本人操作，忽略这封信，你的账号不会有任何变化。

—— 橡果 Acorn
"""


def send_already_registered(to_email: str) -> None:
    """这个邮箱已经注册过时发这封，而不是「验证码」。

    为什么不直接在接口里说「该邮箱已注册」：那等于给了外人一个查「谁注册过」的工具。
    把答案送进邮箱，只有本人看得到，既不泄漏又不让本人干等一封永远不来的验证码。
    """
    if not settings.mail_enabled:
        log.warning("[没配 SMTP，不真发信] %s 已注册，本该收到「直接登录」提示信", to_email)
        return
    msg = EmailMessage()
    msg["Subject"] = "橡果 Acorn · 这个邮箱已经注册过了"
    msg["From"] = formataddr((settings.mail_from_name, settings.mail_from))
    msg["To"] = to_email
    msg.set_content(ALREADY_TEXT)
    _deliver(msg, to_email)


def _deliver(msg: EmailMessage, to_email: str) -> None:
    ctx = ssl.create_default_context()
    if settings.smtp_port == 465:
        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, context=ctx, timeout=20) as s:
            s.login(settings.smtp_user, settings.smtp_password)
            # 信封发件人显式给 mail_from，不能用 SMTP 用户名（见文件头坑 1）
            s.send_message(msg, from_addr=settings.mail_from, to_addrs=[to_email])
    else:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as s:
            s.starttls(context=ctx)
            s.login(settings.smtp_user, settings.smtp_password)
            s.send_message(msg, from_addr=settings.mail_from, to_addrs=[to_email])


# 收件人固定为用户指定的个人邮箱，不复用管理员名单，也不接收请求提供的目标地址。
ULTRA_RECIPIENT = "bower.6868@gmail.com"


def send_ultra_code(requester: str, code: str, expires_beijing: str) -> None:
    """Ultra 申请码只送管理员。没配邮件直接失败，验证码绝不进入日志。"""
    if not settings.mail_enabled:
        raise RuntimeError("ultra_mail_unavailable")
    msg = EmailMessage()
    msg["Subject"] = "橡果 Ultra 下载申请"
    msg["From"] = formataddr((settings.mail_from_name, settings.mail_from))
    msg["To"] = ULTRA_RECIPIENT
    msg.set_content(
        f"账号 {requester} 申请下载 Windows Ultra。\n\n验证码：{code}\n"
        f"有效至北京时间 {expires_beijing}。验证码只用于这次申请。\n"
        "正确验证并完整下载后才算成功；未完成的申请会在到期时计入连续失败。\n"
    )
    msg.add_alternative(
        f"<p>账号 <b>{html.escape(requester)}</b> 申请下载 Windows Ultra。</p>"
        f"<p>验证码：<b>{html.escape(code)}</b></p>"
        f"<p>有效至北京时间 {html.escape(expires_beijing)}，只用于这次申请。</p>"
        "<p>正确验证并完整下载后才算成功。</p>", subtype="html",
    )
    _deliver(msg, ULTRA_RECIPIENT)
