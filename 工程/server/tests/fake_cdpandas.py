"""测试用的假 cdpandas 账号后端：标准库 http.server，起在本机随机端口。

照着 10-Platform/platform-api/backend/app/routers/auth.py 的**状态码与 detail 写法**仿的
（2026-09-21 读过那份代码）：登录错 401、冻结 / 没验证都是 403（只靠 detail 文字分）、
验证码错 400 / 过期 410 / 找不到 404 / 锁定与冷却 429、注册已验证的邮箱 409。
真 cdpandas 改了这些，这里要跟着改，不然测试就是在测一个不存在的对手。

走真 HTTP 而不是 monkeypatch 函数：这样 app/account.py 里 urllib 那一截（超时、4xx 读回包、
连不上）也一起被测到。
"""

from __future__ import annotations

import json
import secrets
import threading
import time
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
USERS: dict[str, dict] = {}  # email -> {id, pw, approved, blocked, admin, display_name}
CODES: dict[str, dict] = {}  # email -> {code, purpose, attempts, sent}
TOKENS: dict[str, int] = {}  # 假 cdpandas 令牌 -> user id
SENT: list[tuple[str, str, str]] = []  # (email, code, purpose)
REQUESTS: list[dict] = []  # 收到过的请求：method / path / headers（小写键）
FAILS: dict[tuple[str, str], int] = {}
SLOW: set[str] = set()  # 这些邮箱登录时故意拖 2 秒（测超时）
# broken：一切请求回 500；me_broken：只有 /me 回 500（测「reset 已成功、/me 失败」）；
# smtp_down：发信的几条路回 503 + 中文 detail（照 10 的 services/verification.py smtp_error）
STATE = {"broken": False, "me_broken": False, "smtp_down": False, "next_id": 1000}

COOLDOWN = 60
MAX_ATTEMPTS = 5


def add_user(
    email: str,
    pw: str,
    *,
    approved: bool = True,
    blocked: bool = False,
    admin: bool = False,
    display_name: str | None = None,
) -> dict:
    with LOCK:
        STATE["next_id"] += 1
        u = {
            "id": STATE["next_id"],
            "email": email,
            "pw": pw,
            "approved": approved,
            "blocked": blocked,
            "admin": admin,
            "display_name": display_name,
        }
        USERS[email] = u
        return u


def session_for(email: str) -> str:
    """造一枚「这个人在 cdpandas.com 登录过」的会话 cookie 值（浏览器里 sbg_session 那个）。"""
    with LOCK:
        return _token_for(USERS[email])["access_token"]


def reset_cooldowns() -> None:
    with LOCK:
        for row in CODES.values():
            row["sent"] = 0.0
        FAILS.clear()


def last_code(email: str, purpose: str | None = None) -> str:
    for to, code, p in reversed(SENT):
        if to == email and (purpose is None or p == purpose):
            return code
    raise AssertionError(f"假 cdpandas 没给 {email} 发过验证码")


def issued_tokens() -> list[str]:
    return list(TOKENS)


def _issue_code(email: str, purpose: str) -> tuple[int, dict] | None:
    now = time.time()
    row = CODES.get(email)
    if row is not None and now - row["sent"] < COOLDOWN:
        wait = int(COOLDOWN - (now - row["sent"]))
        return 429, {"detail": f"请等 {wait} 秒后再重新发送验证码。"}
    code = f"{secrets.randbelow(1000000):06d}"
    CODES[email] = {"code": code, "purpose": purpose, "attempts": 0, "sent": now}
    SENT.append((email, code, purpose))
    return None


def _check_code(email: str, code: str, purpose: str) -> tuple[int, dict] | None:
    row = CODES.get(email)
    if row is None or row["purpose"] != purpose:
        return 404, {"detail": "没有找到这个邮箱的验证申请，请重新发送验证码。"}
    if row["attempts"] >= MAX_ATTEMPTS:
        return 429, {"detail": "错误次数过多，请 15 分钟后再试。"}
    if row["code"] != code:
        row["attempts"] += 1
        if row["attempts"] >= MAX_ATTEMPTS:
            return 429, {"detail": "错误次数过多，已锁定 15 分钟。"}
        return 400, {"detail": f"验证码错误，还可以再试 {MAX_ATTEMPTS - row['attempts']} 次。"}
    del CODES[email]
    return None


def _token_for(u: dict) -> dict:
    tok = "cdp-" + secrets.token_urlsafe(24)
    TOKENS[tok] = u["id"]
    return {"access_token": tok, "token_type": "bearer"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # 别往测试输出里刷访问日志
        pass

    def _send(self, status: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except ConnectionError:
            pass  # 测超时那条：橡果那头已经等不及挂了，写不回去是预期内的

    def _record(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"null") if n else None
        REQUESTS.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": body,
            }
        )
        return body or {}

    def _ip(self) -> str:
        return self.headers.get("X-Real-IP") or self.client_address[0]

    def do_GET(self):  # noqa: N802
        self._record()
        if STATE["broken"]:
            return self._send(500, {"detail": "boom"})
        if self.path != "/api/auth/me":
            return self._send(404, {"detail": "Not Found"})
        if STATE["me_broken"]:
            return self._send(500, {"detail": "boom"})
        # 跟 10 的 deps._extract_token 一样：先认 cookie（sbg_session），再认 Bearer
        jar = SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
        except CookieError:
            pass
        auth = self.headers.get("Authorization", "")
        if "sbg_session" in jar:
            uid = TOKENS.get(jar["sbg_session"].value)
        else:
            uid = TOKENS.get(auth[7:]) if auth.lower().startswith("bearer ") else None
        u = next((x for x in USERS.values() if x["id"] == uid), None)
        if u is None:
            return self._send(401, {"detail": "Invalid or expired token"})
        if u["blocked"]:
            return self._send(403, {"detail": "Account is blocked"})
        return self._send(
            200,
            {
                "id": u["id"],
                "email": u["email"],
                "display_name": u["display_name"],
                "is_admin": u["admin"],
                "is_approved": u["approved"],
                "is_blocked": u["blocked"],
                "daily_limit": 3,
                "admin_note": None,
                "created_at": "2026-01-01T00:00:00",
                "boards": [],
            },
        )

    def do_POST(self):  # noqa: N802
        body = self._record()
        if STATE["broken"]:
            return self._send(500, {"detail": "boom"})
        email = str(body.get("email") or "")
        with LOCK:
            out = self._route(email, body)
        if email in SLOW and self.path == "/api/auth/login":
            time.sleep(2)
        self._send(*out)

    def _route(self, email: str, body: dict) -> tuple[int, dict]:
        u = USERS.get(email)
        p = self.path
        if STATE["smtp_down"] and p in ("/api/auth/register", "/api/auth/resend-code", "/api/auth/forgot-password"):
            return 503, {"detail": "验证码邮件发送失败，请稍后重试或换个邮箱。"}
        if p == "/api/auth/register":
            if u and u["approved"]:
                return 409, {"detail": "Email already registered"}
            if u:
                u["pw"] = body["password"]
            else:
                STATE["next_id"] += 1
                USERS[email] = {
                    "id": STATE["next_id"], "email": email, "pw": body["password"],
                    "approved": False, "blocked": False, "admin": False, "display_name": None,
                }
            err = _issue_code(email, "verify")
            return err or (202, {"message": "验证码已发送至你的邮箱，请查收。", "email": email, "cooldown_sec": 60})
        if p == "/api/auth/verify-code":
            if u is None:
                return 404, {"detail": "没有找到这个邮箱的注册记录。"}
            if u["approved"]:
                return 409, {"detail": "这个邮箱已经完成验证，请直接登录。"}
            err = _check_code(email, str(body.get("code")), "verify")
            if err:
                return err
            u["approved"] = True
            return 200, _token_for(u)
        if p == "/api/auth/resend-code":
            if not u or u["approved"]:
                return 202, {"message": "验证码已发送（如果该邮箱有待验证的注册）。", "cooldown_sec": 60}
            err = _issue_code(email, "verify")
            return err or (202, {"message": "验证码已重新发送。", "cooldown_sec": 60})
        if p == "/api/auth/login":
            key = (email, self._ip())
            if FAILS.get(key, 0) >= 5:
                return 429, {"detail": "登录尝试次数过多，请 15 分钟后再试。"}
            if not u or u["pw"] != body.get("password"):
                FAILS[key] = FAILS.get(key, 0) + 1
                return 401, {"detail": "邮箱或密码不正确。"}
            if u["blocked"]:
                return 403, {"detail": "账号已被冻结。"}
            if not u["approved"]:
                return 403, {"detail": "邮箱尚未验证，请完成邮箱验证后再登录。"}
            FAILS.pop(key, None)
            return 200, _token_for(u)
        if p == "/api/auth/forgot-password":
            if u and u["approved"] and not u["blocked"]:
                _issue_code(email, "reset")  # 冷却中也吞掉，跟真的一样不露口风
            return 202, {"message": "如果这个邮箱注册过，验证码已经发出，请查收。", "email": email, "cooldown_sec": 60}
        if p == "/api/auth/reset-password":
            if u is None or not u["approved"]:
                return 404, {"detail": "没有找到这个邮箱的验证申请，请重新发送验证码。"}
            if u["blocked"]:
                return 403, {"detail": "账号已被冻结。"}
            err = _check_code(email, str(body.get("code")), "reset")
            if err:
                return err
            u["pw"] = body["password"]
            return 200, _token_for(u)
        return 404, {"detail": "Not Found"}


def start() -> str:
    """起服务，返回 base url（http://127.0.0.1:端口）。守护线程，测试进程退出就没了。"""
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}"
