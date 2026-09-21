"""转接 cdpandas 账号后端（10-Platform/platform-api，同机 127.0.0.1:8000，前缀 /api/auth）。

用户 2026-09-21 定：橡果与 cdpandas 合成一套账号，以 cdpandas 为准。
这里只做一件事：把橡果收到的请求原样转过去，把回来的「状态码 + detail」交给 main.py 翻译。

几条底线：
- 只用标准库 urllib（requirements 故意只有两个包，别为这点事加 httpx / requests）。
- cdpandas 的 access_token 只活在一次请求里：不落库、不回给客户端、**不写日志**。
  日志里只许出现路径和状态码。
- 连不上 / 超时 / 5xx（发信那几条路上带 detail 的 503 除外）一律抛 Unavailable，由 main.py 回「账号服务暂时不可用」，
  绝不能让它落进「密码不对」那条分支。
- 不走系统代理：本机回环地址，走代理只会莫名其妙地超时。
"""

from __future__ import annotations

import ipaddress
import json
import logging
import socket
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .config import settings

log = logging.getLogger("acorn.account")

# 回包最多读这么多：cdpandas 的账号接口回的都是几百字节的 JSON，读多了只可能是出事了
_MAX_BODY = 64 * 1024

# 不认系统代理（HTTP_PROXY 之类）。同机转接走代理是纯粹的故障源
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 同时在转接中的请求最多这么多。cdpandas 卡住（连上了但不回话）时，每个转接都要干等到超时；
# 不设上限的话，登录 / 反馈 cookie 这几条路能把 uvicorn 那 40 个工作线程占满，连带同步接口一起超时。
# 拿不到名额就当「暂时不可用」，别排队
_slots = threading.BoundedSemaphore(max(1, settings.account_concurrency))
_SLOT_WAIT = 0.5


class Unavailable(Exception):
    """cdpandas 连不上、超时、或者自己出错（5xx / 回包不是 JSON）。"""


@dataclass
class Reply:
    status: int
    body: Any  # 解开的 JSON；解不开是 None

    @property
    def detail(self) -> str:
        """FastAPI 的错误是 {"detail": "..."}；422 的 detail 是个列表，这里一律转成字符串。"""
        if isinstance(self.body, dict):
            d = self.body.get("detail")
            if isinstance(d, str):
                return d
            if d is not None:
                return json.dumps(d, ensure_ascii=False)
        return ""


def base_url() -> str:
    """单独成函数：测试要把它指到一个没人监听的端口，验证「连不上」那条路。"""
    return settings.account_base


def _forwardable_ip(ip: str | None) -> str | None:
    """只转合法 IP。cdpandas 的 client_ip 只认 X-Real-IP（10 那边 2026-07-08 定的），
    它拿这个做登录失败计数和 IP 黑名单，塞进去乱七八糟的东西只会污染它的审计。"""
    if not ip:
        return None
    try:
        return str(ipaddress.ip_address(ip.strip()))
    except ValueError:
        return None


def call(
    method: str,
    path: str,
    body: dict | None = None,
    *,
    token: str | None = None,
    cookie: str | None = None,
    ip: str | None = None,
    mail: bool = False,
) -> Reply:
    """发一个请求给 cdpandas。4xx 正常返回（交给调用方翻译），连不上 / 5xx 抛 Unavailable。

    mail=True（注册 / 重发验证码 / 找回密码这几条会发信的路）：cdpandas 发信失败时回的
    503 + 中文 detail 是业务错误（「验证码邮件发送失败…」），原样交回去，由 main.py 翻成 502 mail_failed，
    不跟「账号服务整个挂了」混为一谈。"""
    url = f"{base_url()}{path}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json", "User-Agent": "acorn-sync (account relay)"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if cookie:
        headers["Cookie"] = cookie
    real_ip = _forwardable_ip(ip)
    if real_ip:
        headers["X-Real-IP"] = real_ip
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    if not _slots.acquire(timeout=_SLOT_WAIT):
        log.error("账号服务转接排满了 %s %s", method, path)
        raise Unavailable(path)
    try:
        with _opener.open(req, timeout=settings.account_timeout) as resp:
            status, raw = resp.status, resp.read(_MAX_BODY)
    except urllib.error.HTTPError as exc:
        status = exc.code
        try:
            raw = exc.read(_MAX_BODY)
        except Exception:  # noqa: BLE001 —— 读错误回包失败也只当没有回包
            raw = b""
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as exc:
        # 注意：只记路径与异常类型，不记请求体（里面有密码）
        log.error("账号服务连不上 %s %s: %s", method, path, type(exc).__name__)
        raise Unavailable(path) from None
    finally:
        _slots.release()

    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, ValueError):
        parsed = None
    if status >= 500:
        if mail and status == 503 and isinstance(parsed, dict) and isinstance(parsed.get("detail"), str):
            return Reply(status=status, body=parsed)
        log.error("账号服务出错 %s %s -> %s", method, path, status)
        raise Unavailable(path)
    if status < 300 and parsed is None and raw:
        # 2xx 却不是 JSON：多半是端口上跑的不是 cdpandas（配错了），别当成功
        log.error("账号服务回包不是 JSON %s %s -> %s", method, path, status)
        raise Unavailable(path)
    return Reply(status=status, body=parsed)


# ---------- 各接口 ----------


def login(email: str, password: str, ip: str | None) -> Reply:
    return call("POST", "/api/auth/login", {"email": email, "password": password}, ip=ip)


def register(email: str, password: str, ip: str | None) -> Reply:
    return call("POST", "/api/auth/register", {"email": email, "password": password}, ip=ip, mail=True)


def verify_code(email: str, code: str, ip: str | None) -> Reply:
    return call("POST", "/api/auth/verify-code", {"email": email, "code": code}, ip=ip)


def resend_code(email: str, ip: str | None) -> Reply:
    return call("POST", "/api/auth/resend-code", {"email": email}, ip=ip, mail=True)


def forgot_password(email: str, ip: str | None) -> Reply:
    return call("POST", "/api/auth/forgot-password", {"email": email}, ip=ip, mail=True)


def reset_password(email: str, code: str, password: str, ip: str | None) -> Reply:
    return call(
        "POST",
        "/api/auth/reset-password",
        {"email": email, "code": code, "password": password},
        ip=ip,
    )


def me(access_token: str, ip: str | None) -> Reply:
    return call("GET", "/api/auth/me", token=access_token, ip=ip)


def me_by_cookie(cookie_name: str, cookie_value: str, ip: str | None) -> Reply:
    """拿浏览器带来的 cdpandas 登录 cookie 原样问一句「这是谁」（介绍页上的管理员）。
    cookie 跟令牌一个待遇：不落库、不回给客户端、不写日志。"""
    return call("GET", "/api/auth/me", cookie=f"{cookie_name}={cookie_value}", ip=ip)
