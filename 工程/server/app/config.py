"""运行配置：全部从环境变量来，代码里不写任何凭据。

服务器上由 systemd 的 EnvironmentFile（/etc/acorn-sync/env，chmod 600）注入；
本地开发不设就用安全的默认值（内存/临时库 + 不真发信，验证码打到日志）。
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


@dataclass(frozen=True)
class Settings:
    # 数据库文件。生产在 /var/lib/acorn-sync/acorn.db
    db_path: str = os.environ.get("ACORN_DB", "acorn.db")

    # 登录令牌签名密钥。没给就现生成一个——**进程重启即失效**，
    # 所以生产必须显式给，否则每次重启所有人都被登出。
    jwt_secret: str = os.environ.get("ACORN_JWT_SECRET") or secrets.token_urlsafe(48)
    token_days: int = _int("ACORN_TOKEN_DAYS", 60)

    # 发信（cdpandas 那套：Resend SMTP，From = noreply@cdpandas.com）
    smtp_host: str = os.environ.get("SMTP_HOST", "")
    smtp_port: int = _int("SMTP_PORT", 465)
    smtp_user: str = os.environ.get("SMTP_USER", "")
    smtp_password: str = os.environ.get("SMTP_PASSWORD", "")
    mail_from: str = os.environ.get("ACORN_MAIL_FROM", "noreply@cdpandas.com")
    mail_from_name: str = os.environ.get("ACORN_MAIL_FROM_NAME", "橡果 Acorn")

    # 一份数据最大多少字节（防止有人把服务器当网盘）。5MB 够存几万条任务
    max_vault_bytes: int = _int("ACORN_MAX_VAULT_BYTES", 5 * 1024 * 1024)

    # 安装包与版本清单放哪（android/ 是 APK，windows/ 是桌面 exe；
    # nginx 以 /download/ 静态伺服同一个目录）
    public_dir: str = os.environ.get("ACORN_PUBLIC_DIR", "public")
    # 对外下载地址前缀，写进版本清单给客户端用
    download_base: str = os.environ.get(
        "ACORN_DOWNLOAD_BASE", "https://acorn.cdpandas.com/download"
    )

    # 管理员账号：只有它们能从 /api/<端>/beta 拿到测试版（用户 2026-09-18 定）。
    # 逗号隔开，一律按小写比。换人改环境变量 ACORN_ADMIN_EMAILS，不用改代码
    admin_emails: frozenset = frozenset(
        e.strip().lower()
        for e in os.environ.get(
            "ACORN_ADMIN_EMAILS", "bower.6868@gmail.com,skylar@cdpandas.com,1254823795@qq.com"
        ).split(",")
        if e.strip()
    )

    # 账号转接（用户 2026-09-21 定：橡果与 cdpandas 合成一套账号，以 cdpandas 为准）。
    # 登录 / 注册 / 验证码 / 找回密码一律转给 cdpandas 的账号后端（10-Platform，
    # 同一台机器上 docker 发布在 127.0.0.1:8000，路由前缀 /api/auth）。
    # 橡果只认它回来的「这个人是谁」，再签自己的令牌——cdpandas 的令牌不落库、不回给客户端
    account_base: str = os.environ.get("ACORN_ACCOUNT_BASE", "http://127.0.0.1:8000").rstrip("/")
    # 连 cdpandas 最多等几秒。超时一律当「账号服务暂时不可用」，绝不报成密码错
    account_timeout: float = _float("ACORN_ACCOUNT_TIMEOUT", 5.0)
    # 过渡兜底：cdpandas 说密码不对时，橡果库里这个邮箱的旧密码对得上也放行。
    # 默认开；正式发布后设 ACORN_LEGACY_LOGIN=0 关掉，从此只认 cdpandas
    legacy_login: bool = _bool("ACORN_LEGACY_LOGIN", True)
    # 同时转接给 cdpandas 的请求上限：cdpandas 卡住时别把同步接口的工作线程也拖进去
    account_concurrency: int = _int("ACORN_ACCOUNT_CONCURRENCY", 8)
    # 「cdpandas 说他是管理员」这个记录（users.cdp_admin）只在登录时刷新一次；
    # 反馈后台走橡果令牌时，只认这么多小时内刚被 cdpandas 确认过的，过期了要重新登录（或走介绍页 cookie）。
    # ACORN_ADMIN_EMAILS 里的不受这个限制
    cdp_admin_fresh_hours: float = _float("ACORN_CDP_ADMIN_FRESH_HOURS", 24.0)

    # 反馈（用户 2026-09-21 定）：三端设置里提交，管理员在介绍页 acorn.cdpandas.com/intro/ 看。
    # 介绍页那头是浏览器同源请求，带的是 cdpandas 的登录 cookie（10 的 COOKIE_NAME，默认
    # sbg_session，域 .cdpandas.com）——橡果把它原样转给 cdpandas /api/auth/me 问是不是管理员。
    # 10 那边哪天改了 cookie 名，这里跟着改环境变量 ACORN_CDP_COOKIE
    cdp_cookie: str = os.environ.get("ACORN_CDP_COOKIE", "sbg_session")
    # 靠 cookie 认管理员的请求，若带了 Origin 头，必须是这几个源之一（逗号隔开）。
    # 防的是 *.cdpandas.com 其它子站被人塞了脚本、借着同站 cookie 来改反馈状态
    site_origins: frozenset = frozenset(
        o.strip().rstrip("/").lower()
        for o in os.environ.get("ACORN_SITE_ORIGINS", "https://acorn.cdpandas.com").split(",")
        if o.strip()
    )
    # 每个账号每小时最多提交几条反馈
    feedback_per_hour: int = _int("ACORN_FEEDBACK_PER_HOUR", 20)

    # 验证码有效期与重发间隔（转接之后验证码由 cdpandas 发，这两项只剩老代码参考）
    code_ttl_seconds: int = _int("ACORN_CODE_TTL", 15 * 60)
    code_resend_seconds: int = _int("ACORN_CODE_RESEND", 60)

    @property
    def mail_enabled(self) -> bool:
        """没配 SMTP 就不真发信——本地开发时验证码直接打进日志，方便自测。"""
        return bool(self.smtp_host and self.smtp_password)


settings = Settings()
