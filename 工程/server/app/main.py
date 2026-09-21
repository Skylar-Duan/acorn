"""橡果云同步服务。

做的事只有两件：
1. 认人——账号用 cdpandas 那一套（2026-09-21 起）：登录、注册、验证码、找回密码都转给
   cdpandas 的账号后端（app/account.py），它认过这个人，橡果再签自己的长效令牌。
2. 存一份数据——每个账号一整份 AppData（信封 JSON）+ 一个版本号 rev。
   推送时必须报出「我是基于第几版改的」，对不上就退回最新那版让客户端自己合并再推。
   合并逻辑全在客户端（src/core/merge.ts），服务器只认版本号，永远不改用户数据的内容。

为什么是整份而不是按条同步：任务数据一个人也就几百 KB，整份传省掉了一整套增量协议
和它的边界 bug；真长到几 MB 再说（有 max_vault_bytes 兜底）。
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import account
from .config import settings
from .db import Database, now_iso
from .security import TokenError, make_token, read_token, verify_password

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
    # PATCH 是反馈「标记已处理」用的（桌面 / 安卓的管理员从 webview 跨源发，要过预检）。
    # 介绍页那头是同源请求，不经 CORS；allow_credentials 保持 False——跨源的请求带 cookie
    # 浏览器也不会把回包交给页面，带 cookie 的 PATCH 预检直接过不去
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
    # true = 这次是「cdpandas 说密码不对、橡果旧密码对得上」的过渡兜底放行的。
    # 客户端现在不看它；留给以后提示「去把 cdpandas 密码改成你记得的那个」
    legacy: bool = False


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
    # cdpandas 那边密码上限 128 字符（schemas.RegisterIn），超了它回 422，这里先拦下说人话
    if len(pw) > 128 or len(pw.encode("utf-8")) > 1024:
        raise bad(400, "weak_password", "密码太长了")
    return pw


def client_ip(request: Request) -> str:
    # 真实 IP 以 nginx 设的 X-Real-IP（= $remote_addr，客户端伪造不了）为准。
    # 以前读 X-Forwarded-For 第一段——那一段是客户端自己能填的，按 IP 的限流形同虚设；
    # 现在这个 IP 还要转给 cdpandas 做失败计数和 IP 黑名单，更不能让人随便填
    real = request.headers.get("x-real-ip", "").strip()
    if real:
        return real
    return request.client.host if request.client else "?"


def limit(key: str, count: int, seconds: int, msg: str) -> None:
    if not db.hit(key, count, seconds):
        raise bad(429, "too_many", msg)


def issue_token(user_row) -> str:
    return make_token(
        settings.jwt_secret, int(user_row["id"]), int(user_row["token_epoch"]), settings.token_days
    )


# ---------- 账号转接（cdpandas 为准） ----------
#
# 用户 2026-09-21 定：橡果与 cdpandas 合成一套账号。登录、注册、验证码、找回密码全部转给
# cdpandas 的账号后端（app/account.py），橡果这边只做三件事：
#   1. 把 cdpandas 的回话翻译成橡果客户端认得的 {error, message} + 状态码
#      （客户端 src/core/cloud.ts 只看状态码与 slug：401 = 要重新登录/密码不对，别的原样显示 message）；
#   2. cdpandas 认过这个人之后，按邮箱找或建橡果自己的那一行（vault 挂在橡果 user_id 上，不迁移）；
#   3. 签**橡果自己的**令牌（60 天、token_epoch 那套照旧）。cdpandas 的令牌用完即弃。

_CJK = re.compile(r"[一-鿿]")

UNAVAILABLE_MSG = "账号服务暂时连不上，过一会儿再试（不是密码的问题）"


def _cn(detail: str, fallback: str) -> str:
    """cdpandas 自己的中文提示写得够清楚（「验证码错误，还可以再试 3 次。」），原样用；
    英文的（"Email already registered" 之类）换成橡果的说法。"""
    return detail if detail and _CJK.search(detail) else fallback


def unavailable() -> HTTPException:
    return bad(503, "account_unavailable", UNAVAILABLE_MSG)


def relay(fn, *args) -> account.Reply:
    """调一次 cdpandas；连不上 / 超时 / 它自己 5xx → 503「账号服务暂时不可用」。"""
    try:
        return fn(*args)
    except account.Unavailable:
        raise unavailable() from None


def forward_ip(request: Request) -> str | None:
    """原始客户端 IP，转给 cdpandas 用（它只认 X-Real-IP，拿来做登录失败计数和 IP 黑名单）。

    橡果的 nginx（deploy/proxy_params_acorn）把 X-Real-IP 设成 $remote_addr，客户端伪造不了；
    同步服务只听 127.0.0.1，外面的请求一定经过那层 nginx。"""
    return client_ip(request)


def upstream_error(rep: account.Reply) -> HTTPException:
    """验证码 / 注册 / 找回密码这几条路上，cdpandas 回的 4xx 统一翻译。"""
    s, d = rep.status, rep.detail
    if s == 429:
        slug = "too_soon" if "秒" in d else "too_many"
        return bad(429, slug, _cn(d, "太频繁了，过会儿再试"))
    if s == 503:
        return bad(502, "mail_failed", _cn(d, "验证码没发出去，过一会儿再试"))
    if s == 410:
        return bad(400, "code_expired", _cn(d, "验证码过期了，重新要一个"))
    if s == 404:
        return bad(400, "no_code", _cn(d, "还没申请验证码，或者它已经用过了"))
    if s == 400:
        return bad(400, "bad_code", _cn(d, "验证码不对"))
    if s == 403:
        if d == "Forbidden":
            # cdpandas 的 IP 黑名单（IpBlockMiddleware）
            return bad(403, "blocked", "这个网络被账号服务拒绝了，换个网络再试")
        return bad(403, "blocked", _cn(d, "账号已被冻结"))
    if s == 422:
        return bad(400, "bad_request", "邮箱、密码或验证码的格式不对")
    log.error("账号服务回了没见过的状态 %s", s)
    return unavailable()


def fetch_identity(access_token: str, ip: str | None) -> dict:
    """拿 cdpandas 的令牌问一句「这是谁」。令牌只在这一个函数里用，用完就丢。"""
    rep = relay(account.me, access_token, ip)
    if rep.status == 403:
        # cdpandas 的 verify-code 不查冻结：被冻结、还没验证的号交对验证码也会拿到令牌，
        # 到 /me 这一步才回 403 "Account is blocked"。这是「被冻结」，不是「服务连不上」
        raise bad(403, "blocked", "账号已被冻结")
    if rep.status != 200 or not isinstance(rep.body, dict):
        log.error("账号服务 /me 回了 %s", rep.status)
        raise unavailable()
    who = rep.body
    email = str(who.get("email") or "").strip().lower()
    if not EMAIL_RE.match(email):
        log.error("账号服务 /me 没给出像样的邮箱")
        raise unavailable()
    if who.get("is_blocked"):
        raise bad(403, "blocked", "账号已被冻结")
    if not who.get("is_approved"):
        raise bad(403, "unverified", "这个邮箱还没验证，去收验证码")
    name = who.get("display_name")
    return {
        "email": email,
        "is_admin": bool(who.get("is_admin")),
        "display_name": str(name)[:64] if isinstance(name, str) and name else None,
    }


def adopt(rep: account.Reply, ip: str | None):
    """cdpandas 签了令牌 → 问出是谁 → 找或建橡果那一行。返回橡果的 users 行。"""
    tok = rep.body.get("access_token") if isinstance(rep.body, dict) else None
    if not isinstance(tok, str) or not tok:
        log.error("账号服务成功回包里没有令牌")
        raise unavailable()
    who = fetch_identity(tok, ip)
    del tok  # 就此不再用它：不落库、不回给客户端、不进日志
    return db.adopt_account(who["email"], who["is_admin"], who["display_name"])


def token_out(user, *, legacy: bool = False) -> "TokenOut":
    db.touch(int(user["id"]))
    vault = db.get_vault(int(user["id"]))
    return TokenOut(
        token=issue_token(user), email=user["email"], rev=int(vault["rev"]), legacy=legacy
    )


def is_admin(user: Any, *, fresh: bool = False) -> bool:
    """管理员 = 邮箱在 ACORN_ADMIN_EMAILS 里，或者最近一次经 cdpandas 登录时它说是管理员。

    fresh=True（反馈后台那种能看到所有人邮箱和原文的地方）：cdp_admin 只在登录后
    cdp_admin_fresh_hours 小时内算数。cdp_admin 只在登录时刷新，橡果令牌却有 60 天——
    cdpandas 撤了他的管理员或冻结了他，不设时限的话他拿着旧令牌还能看 60 天。"""
    if str(user["email"]).strip().lower() in settings.admin_emails:
        return True
    try:
        if not user["cdp_admin"]:
            return False
        if not fresh:
            return True
        at = user["cdp_admin_at"]
    except (IndexError, KeyError):
        return False
    if not at:
        return False
    try:
        when = datetime.strptime(str(at), "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return datetime.now(timezone.utc) - when <= timedelta(hours=settings.cdp_admin_fresh_hours)


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
#
# 路径与请求体一个字都没改（老版本客户端要能接着用），里面换成了转给 cdpandas。


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "api": API_VERSION, "mail": settings.mail_enabled, "account": "cdpandas"}


@app.post("/api/auth/register", status_code=202)
def register(body: RegisterIn, request: Request) -> dict:
    email = norm_email(body.email)
    check_password(body.password)
    ip = client_ip(request)
    limit(f"reg-ip:{ip}", 20, 3600, "注册太频繁了，过会儿再试")
    limit(f"reg:{email}", 5, 3600, "这个邮箱试得太多了，过会儿再试")

    rep = relay(account.register, email, body.password, forward_ip(request))
    if rep.status < 300:
        return {"pending": True, "message": "验证码已发出，去邮箱查收"}
    if rep.status == 409:
        # 以前这里回 202 装作发了信（不当账号探测器）。现在 cdpandas 自己的注册接口本来就回 409，
        # 橡果再装也挡不住探测，反而让人在验证码那一屏干等一封永远不来的信——所以照实说
        raise bad(
            409,
            "already_registered",
            "这个邮箱已经有账号了（橡果和 cdpandas 用同一个账号），直接登录；忘了密码点「忘记密码」",
        )
    raise upstream_error(rep)


@app.post("/api/auth/resend", status_code=202)
def resend(body: EmailIn, request: Request) -> dict:
    email = norm_email(body.email)
    limit(f"resend-ip:{client_ip(request)}", 20, 3600, "太频繁了，过会儿再试")
    rep = relay(account.resend_code, email, forward_ip(request))
    if rep.status < 300:
        return {"pending": True, "message": "验证码已发出，去邮箱查收"}
    raise upstream_error(rep)


@app.post("/api/auth/verify")
def verify(body: VerifyIn, request: Request) -> TokenOut:
    email = norm_email(body.email)
    limit(f"verify-ip:{client_ip(request)}", 30, 3600, "太频繁了，过会儿再试")
    ip = forward_ip(request)
    rep = relay(account.verify_code, email, (body.code or "").strip(), ip)
    if rep.status == 200:
        return token_out(adopt(rep, ip))
    if rep.status == 409:
        raise bad(409, "already_verified", _cn(rep.detail, "这个邮箱已经验证过了，直接登录"))
    raise upstream_error(rep)


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request) -> TokenOut:
    email = norm_email(body.email)
    limit(f"login-ip:{client_ip(request)}", 60, 900, "登录太频繁了，过会儿再试")
    limit(f"login:{email}", 10, 900, "密码试得太多了，15 分钟后再试")
    ip = forward_ip(request)
    # 连不上 / 超时在 relay 里就变成 503，走不到下面「密码不对」那条
    rep = relay(account.login, email, body.password, ip)

    if rep.status == 200:
        return token_out(adopt(rep, ip))

    if rep.status == 401:
        # 过渡兜底：cdpandas 说不对，但橡果库里这个邮箱的旧密码对得上 → 仍放行，
        # 响应里带 legacy=true。ACORN_LEGACY_LOGIN=0 关掉后只认 cdpandas
        if settings.legacy_login:
            user = db.find_user(email)
            if (
                user is not None
                and user["verified"]
                and user["pw_hash"]
                and verify_password(body.password, user["pw_hash"])
            ):
                log.info("旧密码兜底放行 user_id=%s", user["id"])
                return token_out(user, legacy=True)
        raise bad(401, "bad_login", "邮箱或密码不对")

    if rep.status == 403:
        d = rep.detail
        if "冻结" in d:
            raise bad(403, "blocked", "账号已被冻结")
        if "验证" in d:
            raise bad(403, "unverified", "这个邮箱还没验证，去收验证码")
        raise bad(403, "blocked", "这个网络被账号服务拒绝了，换个网络再试")

    if rep.status == 429:
        raise bad(429, "too_many", _cn(rep.detail, "密码试得太多了，15 分钟后再试"))
    if rep.status == 422:
        raise bad(401, "bad_login", "邮箱或密码不对")
    log.error("账号服务登录回了没见过的状态 %s", rep.status)
    raise unavailable()


@app.post("/api/auth/forgot", status_code=202)
def forgot(body: EmailIn, request: Request) -> dict:
    email = norm_email(body.email)
    limit(f"forgot-ip:{client_ip(request)}", 20, 3600, "太频繁了，过会儿再试")
    rep = relay(account.forgot_password, email, forward_ip(request))
    if rep.status < 300:
        # 存不存在都回同一句（cdpandas 那边也是这个规矩）
        return {"pending": True, "message": "如果这个邮箱注册过，验证码已经发出去了"}
    raise upstream_error(rep)


@app.post("/api/auth/reset")
def reset(body: ResetIn, request: Request) -> TokenOut:
    email = norm_email(body.email)
    check_password(body.password)
    limit(f"reset-ip:{client_ip(request)}", 30, 3600, "太频繁了，过会儿再试")
    ip = forward_ip(request)
    rep = relay(account.reset_password, email, (body.code or "").strip(), body.password, ip)
    if rep.status != 200:
        raise upstream_error(rep)
    # 改密码踢下线：别的设备上的旧橡果令牌作废；橡果库里的旧密码一并作废，
    # 不然过渡兜底会让刚被换掉的旧密码还能登进来。
    # **先做这一步、再问 /me**：cdpandas 这时已经改好密码、用掉了验证码，
    # /me 要是超时，这次请求就没法重试了——踢下线不能跟着一起落空
    existing = db.find_user(email)
    if existing is not None:
        db.retire_local_password(int(existing["id"]))
    try:
        user = adopt(rep, ip)
    except HTTPException as exc:
        if exc.status_code == 503:
            raise bad(503, "account_unavailable", "密码已经改好了，账号服务一时没回话——用新密码登录就行") from None
        raise
    return token_out(user)


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
        "isAdmin": is_admin(user),
        # 能不能进反馈后台（比 isAdmin 严：cdpandas 给的管理员身份要是近期登录时确认过的）
        "feedbackAdmin": is_admin(user, fresh=True),
        "displayName": user["display_name"],
        # 账号在 cdpandas：改密码走「忘记密码」，注销只删橡果这边
        "account": "cdpandas",
    }


@app.delete("/api/account")
def delete_account(user: CurrentUser) -> dict:
    """注销：只删橡果云端数据和橡果这一行，**绝不**去动 cdpandas 账号。

    cdpandas 账号还在：下次用同一个邮箱密码登录，橡果会建一个空的新行（数据不会回来）。"""
    db.delete_user(int(user["id"]))
    return {
        "deleted": True,
        "scope": "acorn",
        "cdpandasAccountKept": True,
        "message": "橡果云端的数据已经删干净了。cdpandas 账号还在，要注销它得去 cdpandas.com。",
    }


# ---------- 同步 ----------


@app.get("/api/sync")
def pull(user: CurrentUser) -> dict:
    vault = db.get_vault(int(user["id"]))
    data = json.loads(vault["data"]) if vault["data"] else None
    return {
        "rev": int(vault["rev"]),
        "data": data,
        "updatedAt": vault["updated_at"],
        "schema": int(vault["schema"] or 0),
    }


@app.put("/api/sync")
def push(body: PushIn, user: CurrentUser) -> dict:
    schema = body.data.get("schema")
    if not isinstance(schema, int) or schema < MIN_SCHEMA:
        raise bad(400, "old_client", "这个版本的橡果太旧了，升级后再同步")

    # 旧客户端不许把新数据按老格式盖回来。桌面版会跑在手机版前面，手机上那份旧橡果
    # 如果把新版模型的数据按自己认识的样子理解一遍再推上来，新版本才有的东西就没了。
    #
    # **这道 409 在 v1.9.1 之后仍然保留，而且必须保留**（2026-09-01 定）：
    # 它守的不再是新客户端，而是**已经发到用户机器上、再也改不了的 v1.9.0 及更老客户端**——
    # 那些版本的 migrate/mergeData 会把顶层未知集合和墓碑上的未知字段整块吃掉，
    # 让它们把 schema 更高的库盖回来就是真丢数据。
    # v1.9.1 起的客户端不会撞到这里：它读进 schema 7 就照 7 报（transfer.pack 取
    # max(DATA_VERSION, data.version)），schema < stored 天然不成立。
    # 所以判据一个字都不用改，也不用加 lossless 之类的新标记 —— 靠客户端报对数字就够了。
    # db.put_vault 那个 schema = MAX(旧, 新) 的棘轮跟这条是配套的，一起别动。
    vault = db.get_vault(int(user["id"]))
    stored = int(vault["schema"] or 0)
    if schema < stored:
        raise bad(
            409,
            "client_too_old",
            f"云端的数据是更新版本的橡果存的（数据版本 {stored}，这台设备是 {schema}）。"
            f"先升级这台设备上的橡果，升级前不会同步，本地数据一条都不会动。",
        )
    payload = json.dumps(body.data, ensure_ascii=False, separators=(",", ":"))
    if len(payload.encode("utf-8")) > settings.max_vault_bytes:
        raise bad(413, "too_big", "数据太大了，同步不了")

    rev = db.put_vault(int(user["id"]), body.base_rev, payload, (body.device or "")[:64], schema)
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


# ---------- 反馈 ----------
#
# 用户 2026-09-21 定：三端设置里有「反馈」，登录了就能提交；管理员在介绍页
# acorn.cdpandas.com/intro/「网页版」右边的「反馈」按钮里看（cdpandas 管理员 / 橡果管理员都认）。
#
# 谁算管理员，两种来源都认：
#   ① 橡果令牌（Authorization: Bearer）且 is_admin（ACORN_ADMIN_EMAILS 或 cdp_admin）——三端 App 里；
#   ② 浏览器带来的 cdpandas 登录 cookie（sbg_session，域 .cdpandas.com，介绍页同源请求自动带上）
#      → 原样转给 cdpandas /api/auth/me，它说 is_admin（或邮箱在 ACORN_ADMIN_EMAILS 里）才放行。
#      结果按 cookie 的哈希在内存里缓 60 秒：不落盘、不打印，cookie 本身也不存。
# 不是管理员（含没登录）一律 404，跟没有这个接口一模一样。

FEEDBACK_PLATFORMS = frozenset({"desktop", "android", "web"})
FEEDBACK_MAX_CHARS = 2000
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")  # 除 \t \n 以外的控制字符

_ADMIN_TTL = 60.0
_ADMIN_CACHE_MAX = 1024
_admin_cache: dict[str, tuple[float, str | None]] = {}  # sha256(cookie) -> (到期, 管理员邮箱或 None)
_admin_lock = threading.Lock()
# cdpandas 连不上之后这么多秒内，cookie 那条路不再转接、直接当非管理员。
# 不这样的话：cdpandas 卡住时，任何人带一枚乱编的 cookie 就能让橡果陪着干等 5 秒，几下就把线程池占满
_CDP_DOWN_COOLDOWN = 10.0
_cdp_down_until = 0.0
# cookie 值只收这些字符（RFC 6265 的 cookie-octet 去掉引号）——防的是把怪东西拼进转发的请求头
_COOKIE_OK = re.compile(r"^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$")


class FeedbackIn(BaseModel):
    text: str = ""
    platform: str = ""
    version: str = ""
    device: str = ""


class FeedbackPatch(BaseModel):
    done: bool


def not_found() -> StarletteHTTPException:
    """跟「根本没这个路径」一字不差的 404（{"detail": "Not Found"}）。
    故意用 starlette 的异常：它不经本文件的 http_error，走框架默认那条，跟未知路由同一个出口。"""
    return StarletteHTTPException(status_code=404)


def _feedback_out(row) -> dict:
    return {
        "id": int(row["id"]),
        "email": row["email"],
        "platform": row["platform"],
        "version": row["version"],
        "device": row["device"],
        "text": row["text"],
        "createdAt": row["created_at"],
        "done": row["done_at"] is not None,
        "doneAt": row["done_at"],
        "doneBy": row["done_by"],
    }


def _short_field(raw: str, max_len: int, slug: str, msg: str) -> str:
    val = _CTRL.sub("", (raw or "").replace("\n", " ").replace("\t", " ")).strip()
    if len(val) > max_len:
        raise bad(400, slug, msg)
    return val


def _bearer_admin(authorization: str | None) -> str | None:
    """橡果令牌那条路：令牌有效、账号已验证、is_admin → 返回管理员邮箱；否则 None（不报错）。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    try:
        payload = read_token(settings.jwt_secret, authorization[7:].strip())
        user = db.get_user(int(payload.get("sub", 0)))
    except (TokenError, ValueError, TypeError):
        return None
    if user is None or int(payload.get("ep", 0)) != int(user["token_epoch"]):
        return None
    if not user["verified"] or not is_admin(user, fresh=True):
        return None
    return str(user["email"])


def _cookie_admin(request: Request) -> str | None:
    """cdpandas cookie 那条路。返回管理员邮箱或 None。"""
    raw = request.cookies.get(settings.cdp_cookie)
    if not raw or not _COOKIE_OK.match(raw):
        return None
    origin = request.headers.get("origin")
    if origin is not None and origin.strip().rstrip("/").lower() not in settings.site_origins:
        # 同源的 GET 浏览器可能不带 Origin，带了就得是介绍页自己的源
        return None
    global _cdp_down_until
    key = hashlib.sha256(raw.encode("ascii")).hexdigest()
    now = time.monotonic()
    with _admin_lock:
        hit = _admin_cache.get(key)
        if hit is not None and hit[0] > now:
            return hit[1]
        if now < _cdp_down_until:
            return None

    try:
        rep = account.me_by_cookie(settings.cdp_cookie, raw, forward_ip(request))
    except account.Unavailable:
        # 连不上不按 cookie 缓存（恢复后本人马上能用），但全局冷却几秒，别让人借它堆线程；
        # 对外照样 404，不因为账号服务挂了就露出接口
        log.error("反馈：账号服务连不上，这次按非管理员处理")
        with _admin_lock:
            _cdp_down_until = time.monotonic() + _CDP_DOWN_COOLDOWN
        return None
    who = rep.body if rep.status == 200 and isinstance(rep.body, dict) else None
    admin_email: str | None = None
    if who is not None and who.get("is_approved") and not who.get("is_blocked"):
        email = str(who.get("email") or "").strip().lower()
        if EMAIL_RE.match(email) and (bool(who.get("is_admin")) or email in settings.admin_emails):
            admin_email = email

    with _admin_lock:
        if len(_admin_cache) >= _ADMIN_CACHE_MAX:
            for k in [k for k, v in _admin_cache.items() if v[0] <= now] or list(_admin_cache):
                _admin_cache.pop(k, None)
        _admin_cache[key] = (now + _ADMIN_TTL, admin_email)
    return admin_email


def feedback_admin(request: Request, authorization: Annotated[str | None, Header()] = None) -> str:
    """反馈后台的门：两种来源任一认得是管理员就放行，返回管理员邮箱（记进 done_by）。"""
    who = _bearer_admin(authorization) or _cookie_admin(request)
    if who is None:
        raise not_found()
    return who


FeedbackAdmin = Annotated[str, Depends(feedback_admin)]


@app.post("/api/feedback", status_code=201)
def submit_feedback(body: FeedbackIn, user: CurrentUser) -> dict:
    """登录了就能提交。text 1–2000 字；platform 白名单；version / device 限长。"""
    text = _CTRL.sub("", (body.text or "").replace("\r\n", "\n").replace("\r", "\n")).strip()
    if not text:
        raise bad(400, "empty_feedback", "写点什么再发")
    if len(text) > FEEDBACK_MAX_CHARS:
        raise bad(400, "feedback_too_long", f"反馈最多 {FEEDBACK_MAX_CHARS} 字，拆成几条发")
    platform = (body.platform or "").strip().lower()
    if platform not in FEEDBACK_PLATFORMS:
        raise bad(400, "bad_platform", "不认识这个端")
    version = _short_field(body.version, 32, "bad_version", "版本号太长了")
    device = _short_field(body.device, 64, "bad_device", "设备名太长了")
    limit(
        f"fb:{int(user['id'])}",
        settings.feedback_per_hour,
        3600,
        "反馈发得太勤了，过一小时再发",
    )
    fid = db.add_feedback(int(user["id"]), str(user["email"]), platform, version, device, text)
    return {"ok": True, "id": fid, "message": "收到了，谢谢"}


@app.get("/api/feedback")
def list_feedback(
    who: FeedbackAdmin,
    # 参数名换一下：status / limit 在本模块里已经各有所指（fastapi.status、限流的 limit()）
    state: Annotated[str, Query(alias="status")] = "open",
    count: Annotated[int, Query(alias="limit")] = 200,
    before: int | None = None,
) -> dict:
    """管理员看反馈。status=open（默认，只看未处理）| all；时间倒序；before=<id> 往下翻页。"""
    if state not in ("open", "all"):
        raise bad(400, "bad_request", "status 只能是 open 或 all")
    n = max(1, min(count, 500))
    rows = db.list_feedback(state == "open", n, before)
    return {
        "items": [_feedback_out(r) for r in rows],
        "open": db.count_open_feedback(),
        "next": int(rows[-1]["id"]) if len(rows) == n else None,
    }


@app.patch("/api/feedback/{fid}")
def mark_feedback(fid: int, body: FeedbackPatch, who: FeedbackAdmin) -> dict:
    """标成已处理（done=true）或取消（done=false）。"""
    if not db.set_feedback_done(fid, body.done, who):
        raise not_found()
    return _feedback_out(db.get_feedback(fid))


# ---------- 自动更新（手机 + 桌面） ----------
#
# 不该让人「去网页点点点」找安装包。App 自己问一句「有没有新版」，
# 有就自己下、自己拉起安装。这里只负责回答那一句问话。
#
# 清单文件由 deploy/publish-apk.sh / publish-exe.sh 写到 <public_dir>/<子目录>/latest.json，
# 安装包本身由 nginx 从同一个目录静态伺服（/download/<子目录>/xxx）。
#
# 两个通道只差一个子目录名，所以共用 _channel_latest——将来加通道也只是多一行路由。
# 注意接口叫 desktop、目录叫 windows：接口名对客户端，目录名对产物，别把两个名字并成一个。


def _channel_latest(subdir: str) -> dict:
    """某个通道最新版是什么。没发过就回 available=false，客户端安静地什么都不做。"""
    path = Path(settings.public_dir) / subdir / "latest.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"available": False}  # 还没发过包，正常情况
    except (OSError, ValueError) as exc:
        # 清单在但读不了/解不开：这是配置事故，不能静默——静默的话表现成
        # 「明明发了包却查不到更新」，很难查（编码写歪过一次）
        log.error("%s 版本清单读不了 %s: %s", subdir, path, exc)
        return {"available": False}
    if not isinstance(raw, dict) or not raw.get("version") or not raw.get("file"):
        return {"available": False}
    return {
        "available": True,
        "version": str(raw["version"]),
        # 数据模型版本：客户端拿它判断「这次更新是不是为了读懂云端那份新数据」
        "schema": int(raw.get("schema") or 0),
        "url": f"{settings.download_base}/{subdir}/{raw['file']}",
        "size": int(raw.get("size") or 0),
        "sha256": str(raw.get("sha256") or ""),
        "notes": str(raw.get("notes") or ""),
        "publishedAt": str(raw.get("publishedAt") or ""),
        # 备用方案：万一 App 内安装那条路走不通，让用户能自己去下
        "pageUrl": str(raw.get("pageUrl") or ""),
    }


@app.get("/api/android/latest")
def android_latest() -> dict:
    """最新安卓版（APK）是什么。"""
    return _channel_latest("android")


@app.get("/api/desktop/latest")
def desktop_latest() -> dict:
    """最新桌面版（Windows NSIS 安装包）是什么。"""
    return _channel_latest("windows")


# 测试版通道（用户 2026-09-18 定）：只给管理员账号。测试版包放在 <端目录>/beta/ 下，
# 清单同样是 latest.json，由 publish-exe.sh / publish-apk.sh 加 --beta 写。
# 不是管理员的账号问过来，回的跟「还没发过」一样——安静地什么都没有，不报错也不露口风。
# 要登录才问得到：谁是管理员只有服务器知道，App 不自己判。


def _beta_for(user: Any, subdir: str) -> dict:
    if not is_admin(user):
        return {"available": False}
    return _channel_latest(f"{subdir}/beta")


@app.get("/api/android/beta")
def android_beta(user: CurrentUser) -> dict:
    """最新的安卓测试版（只对管理员）。"""
    return _beta_for(user, "android")


@app.get("/api/desktop/beta")
def desktop_beta(user: CurrentUser) -> dict:
    """最新的桌面测试版（只对管理员）。"""
    return _beta_for(user, "windows")


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
    # 验证码邮件现在由 cdpandas 发，橡果这边没配 SMTP 不再是事故
    log.info(
        "橡果同步服务启动，库在 %s，账号转接到 %s，旧密码兜底%s",
        settings.db_path,
        settings.account_base,
        "开" if settings.legacy_login else "关",
    )
    yield


app.router.lifespan_context = lifespan
