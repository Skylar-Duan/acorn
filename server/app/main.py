"""橡果云同步服务。

做的事只有两件：
1. 认人——邮箱 + 密码注册，邮件验证码激活，登录换一枚长效令牌。
2. 存一份数据——每个账号一整份 AppData（信封 JSON）+ 一个版本号 rev。
   推送时必须报出「我是基于第几版改的」，对不上就退回最新那版让客户端自己合并再推。
   合并逻辑全在客户端（src/core/merge.ts），服务器只认版本号，永远不改用户数据的内容。

为什么是整份而不是按条同步：任务数据一个人也就几百 KB，整份传省掉了一整套增量协议
和它的边界 bug；真长到几 MB 再说（有 max_vault_bytes 兜底）。
"""

from __future__ import annotations

import json
import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import mailer
from .config import settings
from .db import Database, now_iso
from .security import (
    TokenError,
    code_matches,
    hash_code,
    hash_password,
    make_token,
    new_code,
    read_token,
    verify_password,
)

log = logging.getLogger("acorn.api")

API_VERSION = "1"
# 客户端数据模型版本。服务器不解释数据内容，但要挡住「更老的客户端把新数据覆盖回去」
MIN_SCHEMA = 3

app = FastAPI(title="橡果 Acorn 同步服务", version=API_VERSION, docs_url=None, redoc_url=None)

# 桌面端与安卓端的 webview 源是 tauri://localhost / http://tauri.localhost，
# 不是固定网页域名；接口只认 Authorization 头、不用 cookie，所以放开来源是安全的。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

db = Database(settings.db_path)

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]+$")


# ---------- 出入参 ----------


class RegisterIn(BaseModel):
    email: str
    password: str


class VerifyIn(BaseModel):
    email: str
    code: str


class EmailIn(BaseModel):
    email: str


class LoginIn(BaseModel):
    email: str
    password: str


class ResetIn(BaseModel):
    email: str
    code: str
    password: str


class PushIn(BaseModel):
    base_rev: int = Field(ge=0)
    data: dict[str, Any]
    device: str = ""


class TokenOut(BaseModel):
    token: str
    email: str
    rev: int


# ---------- 小工具 ----------


def bad(code: int, slug: str, msg: str) -> HTTPException:
    """错误一律给「机器看的 slug + 人看的中文」，客户端不用猜字符串。"""
    return HTTPException(status_code=code, detail={"error": slug, "message": msg})


def norm_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if not EMAIL_RE.match(email) or len(email) > 254:
        raise bad(400, "bad_email", "这个邮箱地址看起来不对")
    return email


def check_password(pw: str) -> str:
    if not isinstance(pw, str) or len(pw) < 8:
        raise bad(400, "weak_password", "密码至少 8 位")
    if len(pw.encode("utf-8")) > 1024:
        raise bad(400, "weak_password", "密码太长了")
    return pw


def client_ip(request: Request) -> str:
    # nginx 反代后真实 IP 在 X-Forwarded-For 第一段
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"


def limit(key: str, count: int, seconds: int, msg: str) -> None:
    if not db.hit(key, count, seconds):
        raise bad(429, "too_many", msg)


def issue_token(user_row) -> str:
    return make_token(
        settings.jwt_secret, int(user_row["id"]), int(user_row["token_epoch"]), settings.token_days
    )


def send_new_code(email: str, purpose: str) -> None:
    """生成验证码 → 入库（只存哈希）→ 发信。发信失败要把码撤掉，别留个发不出去的码。"""
    prev = db.get_code(email)
    now = datetime.now(timezone.utc)
    if prev is not None:
        sent = datetime.fromisoformat(prev["sent_at"].replace("Z", "+00:00"))
        wait = settings.code_resend_seconds - (now - sent).total_seconds()
        if wait > 0:
            raise bad(429, "too_soon", f"验证码刚发过，{int(wait) + 1} 秒后再试")
        if prev["day"] == now.strftime("%Y-%m-%d") and prev["day_count"] >= 10:
            raise bad(429, "too_many", "今天发得太多了，明天再试")

    code = new_code()
    expires = (now + timedelta(seconds=settings.code_ttl_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")
    db.put_code(email, hash_code(code, email), purpose, expires)
    try:
        mailer.send_code(email, code, purpose)
    except Exception as exc:  # noqa: BLE001 —— 发信失败的原因五花八门，一律当作暂时性失败
        db.drop_code(email)
        log.error("发信失败 %s: %s", email, exc)
        raise bad(502, "mail_failed", "验证码没发出去，过一会儿再试") from exc


def consume_code(email: str, code: str, purpose: str):
    """校验验证码。对了就当场作废（一次性），错了记次数，5 次就作废重来。"""
    row = db.get_code(email)
    if row is None or row["purpose"] != purpose:
        raise bad(400, "no_code", "还没申请验证码，或者它已经用过了")
    expires = datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) > expires:
        db.drop_code(email)
        raise bad(400, "code_expired", "验证码过期了，重新要一个")
    if not code_matches((code or "").strip(), email, row["code_hash"]):
        tries = db.bump_code_tries(email)
        if tries >= 5:
            db.drop_code(email)
            raise bad(400, "code_expired", "错太多次了，重新要一个验证码")
        raise bad(400, "bad_code", f"验证码不对（还能试 {5 - tries} 次）")
    db.drop_code(email)


def current_user(authorization: Annotated[str | None, Header()] = None):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise bad(401, "no_token", "还没登录")
    try:
        payload = read_token(settings.jwt_secret, authorization[7:].strip())
    except TokenError:
        raise bad(401, "bad_token", "登录状态过期了，重新登录一下") from None
    user = db.get_user(int(payload.get("sub", 0)))
    if user is None:
        raise bad(401, "bad_token", "账号不存在")
    if int(payload.get("ep", 0)) != int(user["token_epoch"]):
        raise bad(401, "bad_token", "密码改过了，重新登录一下")
    if not user["verified"]:
        raise bad(403, "unverified", "邮箱还没验证")
    return user


CurrentUser = Annotated[Any, Depends(current_user)]


# ---------- 账号 ----------


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "api": API_VERSION, "mail": settings.mail_enabled}


@app.post("/api/auth/register", status_code=202)
def register(body: RegisterIn, request: Request) -> dict:
    email = norm_email(body.email)
    check_password(body.password)
    limit(f"reg-ip:{client_ip(request)}", 20, 3600, "注册太频繁了，过会儿再试")
    limit(f"reg:{email}", 5, 3600, "这个邮箱试得太多了，过会儿再试")

    user = db.find_user(email)
    if user is not None and user["verified"]:
        # 已注册且已验证：接口一律回同一句话（不然就成了「谁注册过」的查询工具），
        # 但给本人发一封「直接登录 / 忘记密码」的信，免得他干等一封永远不来的验证码
        try:
            mailer.send_already_registered(email)
        except Exception as exc:  # noqa: BLE001
            log.error("已注册提示信发失败 %s: %s", email, exc)
        return {"pending": True, "message": "验证码已发出，去邮箱查收"}
    if user is None:
        db.create_user(email, hash_password(body.password))
    else:
        # 注册了没验证的，允许用新密码盖掉——不然填错密码就永远卡住了
        db.set_password(int(user["id"]), hash_password(body.password))
    send_new_code(email, "verify")
    return {"pending": True, "message": "验证码已发出，去邮箱查收"}


@app.post("/api/auth/resend", status_code=202)
def resend(body: EmailIn, request: Request) -> dict:
    email = norm_email(body.email)
    limit(f"resend-ip:{client_ip(request)}", 20, 3600, "太频繁了，过会儿再试")
    user = db.find_user(email)
    if user is not None and not user["verified"]:
        send_new_code(email, "verify")
    return {"pending": True, "message": "验证码已发出，去邮箱查收"}


@app.post("/api/auth/verify")
def verify(body: VerifyIn, request: Request) -> TokenOut:
    email = norm_email(body.email)
    limit(f"verify-ip:{client_ip(request)}", 30, 3600, "太频繁了，过会儿再试")
    user = db.find_user(email)
    if user is None:
        raise bad(400, "no_code", "还没申请验证码，或者它已经用过了")
    consume_code(email, body.code, "verify")
    db.mark_verified(int(user["id"]))
    user = db.get_user(int(user["id"]))
    vault = db.get_vault(int(user["id"]))
    return TokenOut(token=issue_token(user), email=email, rev=int(vault["rev"]))


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request) -> TokenOut:
    email = norm_email(body.email)
    limit(f"login-ip:{client_ip(request)}", 60, 900, "登录太频繁了，过会儿再试")
    limit(f"login:{email}", 10, 900, "密码试得太多了，15 分钟后再试")
    user = db.find_user(email)
    if user is None or not verify_password(body.password, user["pw_hash"]):
        raise bad(401, "bad_login", "邮箱或密码不对")
    if not user["verified"]:
        raise bad(403, "unverified", "这个邮箱还没验证，去收验证码")
    db.touch(int(user["id"]))
    vault = db.get_vault(int(user["id"]))
    return TokenOut(token=issue_token(user), email=email, rev=int(vault["rev"]))


@app.post("/api/auth/forgot", status_code=202)
def forgot(body: EmailIn, request: Request) -> dict:
    email = norm_email(body.email)
    limit(f"forgot-ip:{client_ip(request)}", 20, 3600, "太频繁了，过会儿再试")
    user = db.find_user(email)
    if user is not None and user["verified"]:
        send_new_code(email, "reset")
    # 存不存在都回同一句，别让人拿它探测哪些邮箱注册过
    return {"pending": True, "message": "如果这个邮箱注册过，验证码已经发出去了"}


@app.post("/api/auth/reset")
def reset(body: ResetIn, request: Request) -> TokenOut:
    email = norm_email(body.email)
    check_password(body.password)
    limit(f"reset-ip:{client_ip(request)}", 30, 3600, "太频繁了，过会儿再试")
    user = db.find_user(email)
    if user is None:
        raise bad(400, "no_code", "还没申请验证码，或者它已经用过了")
    consume_code(email, body.code, "reset")
    db.set_password(int(user["id"]), hash_password(body.password))
    user = db.get_user(int(user["id"]))
    vault = db.get_vault(int(user["id"]))
    return TokenOut(token=issue_token(user), email=email, rev=int(vault["rev"]))


@app.get("/api/me")
def me(user: CurrentUser) -> dict:
    vault = db.get_vault(int(user["id"]))
    return {
        "email": user["email"],
        "createdAt": user["created_at"],
        "rev": int(vault["rev"]),
        "updatedAt": vault["updated_at"],
        "device": vault["device"],
        "hasData": vault["data"] is not None,
    }


@app.delete("/api/account")
def delete_account(user: CurrentUser) -> dict:
    """注销：连数据一起删干净，不留副本。"""
    db.delete_user(int(user["id"]))
    return {"deleted": True}


# ---------- 同步 ----------


@app.get("/api/sync")
def pull(user: CurrentUser) -> dict:
    vault = db.get_vault(int(user["id"]))
    data = json.loads(vault["data"]) if vault["data"] else None
    return {"rev": int(vault["rev"]), "data": data, "updatedAt": vault["updated_at"]}


@app.put("/api/sync")
def push(body: PushIn, user: CurrentUser) -> dict:
    schema = body.data.get("schema")
    if not isinstance(schema, int) or schema < MIN_SCHEMA:
        raise bad(400, "old_client", "这个版本的橡果太旧了，升级后再同步")
    payload = json.dumps(body.data, ensure_ascii=False, separators=(",", ":"))
    if len(payload.encode("utf-8")) > settings.max_vault_bytes:
        raise bad(413, "too_big", "数据太大了，同步不了")

    rev = db.put_vault(int(user["id"]), body.base_rev, payload, (body.device or "")[:64])
    if rev is None:
        # 别的设备先推过了：把最新那版原样退回去，客户端合并完再推一次
        vault = db.get_vault(int(user["id"]))
        return JSONResponse(
            status_code=409,
            content={
                "error": "conflict",
                "message": "另一台设备先同步过了，正在合并",
                "rev": int(vault["rev"]),
                "data": json.loads(vault["data"]) if vault["data"] else None,
            },
        )
    db.touch(int(user["id"]))
    return {"rev": rev, "updatedAt": now_iso()}


# ---------- 收尾 ----------


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        return JSONResponse(status_code=exc.status_code, content=detail)
    return JSONResponse(
        status_code=exc.status_code, content={"error": "error", "message": str(detail)}
    )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.purge_hits()
    if not settings.mail_enabled:
        log.warning("SMTP 没配，验证码只会打进日志——生产环境这是配置事故")
    log.info("橡果同步服务启动，库在 %s", settings.db_path)
    yield


app.router.lifespan_context = lifespan
