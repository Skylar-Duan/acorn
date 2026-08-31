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

    # 验证码有效期与重发间隔
    code_ttl_seconds: int = _int("ACORN_CODE_TTL", 15 * 60)
    code_resend_seconds: int = _int("ACORN_CODE_RESEND", 60)

    @property
    def mail_enabled(self) -> bool:
        """没配 SMTP 就不真发信——本地开发时验证码直接打进日志，方便自测。"""
        return bool(self.smtp_host and self.smtp_password)


settings = Settings()
