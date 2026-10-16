"""Windows Ultra：账号申请、北京时间日界线和私有安装包。

只新增独立记录，不解释或迁移任务；下载资格与长期账号额度分开。
所有次数/到期结算均在 BEGIN IMMEDIATE 中，重启和并发不会重置计数。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Callable

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import account, mailer
from .config import settings
from .db import Database

BEIJING = timezone(timedelta(hours=8))
COOKIE_RE = re.compile(r"^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]+$")
FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,170}\.exe$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_PREFIX = "data:image/jpeg;base64,"
DEFAULT_ENTITLED_EMAIL = "bower.6868@gmail.com"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def dt(raw: str) -> datetime:
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def day_window(now: datetime) -> tuple[str, datetime]:
    local = now.astimezone(BEIJING)
    midnight = datetime.combine(local.date() + timedelta(days=1), datetime.min.time(), BEIJING)
    return local.date().isoformat(), midnight.astimezone(timezone.utc)


def fail(code: int, slug: str, message: str, **extra):
    raise HTTPException(code, {"error": slug, "message": message, **extra})


@contextmanager
def transaction(db: Database):
    c = db.conn
    c.execute("BEGIN IMMEDIATE")
    try:
        yield c
    except HTTPException:
        # 到期结算及限流在业务拒绝时仍须持久化，不能回滚成未失败。
        c.commit()
        raise
    except BaseException:
        c.rollback()
        raise
    else:
        c.commit()


def settle(c, uid: int, now: datetime):
    c.execute("INSERT OR IGNORE INTO ultra_grants(user_id) VALUES (?)", (uid,))
    grant = c.execute("SELECT * FROM ultra_grants WHERE user_id=?", (uid,)).fetchone()
    failures, locked = int(grant["failures"]), grant["locked_until"]
    if locked and dt(locked) <= now:
        failures, locked = 0, None
    rows = c.execute(
        "SELECT * FROM ultra_requests WHERE user_id=? AND state='active' AND expires_at<=?"
        " ORDER BY expires_at,id", (uid, iso(now)),
    ).fetchall()
    for row in rows:
        failures += 1
        if failures >= 3:
            locked = iso(dt(row["expires_at"]) + timedelta(days=7))
        c.execute("UPDATE ultra_requests SET state='expired',settled_at=? WHERE id=?", (iso(now), row["id"]))
    if locked and dt(locked) <= now:
        failures, locked = 0, None
    c.execute("UPDATE ultra_grants SET failures=?,locked_until=? WHERE user_id=?", (failures, locked, uid))
    return c.execute("SELECT * FROM ultra_grants WHERE user_id=?", (uid,)).fetchone()


def unlocked(grant):
    if grant["locked_until"]:
        fail(423, "ultra_locked", "连续三次申请未完成下载，七天后可重新申请", lockedUntil=grant["locked_until"])


def entitlement(user, enabled_at=None) -> dict:
    """只接受服务端账号行；默认身份不创建虚构验证/下载时间。"""
    default = bool(user["verified"]) and str(user["email"]).strip().casefold() == DEFAULT_ENTITLED_EMAIL
    return {
        "enabled": default or bool(enabled_at),
        "source": "default" if default else "verified_code" if enabled_at else None,
        "enabledAt": None if default else enabled_at,
    }


def enabled(db: Database, uid: int) -> bool:
    row = db.conn.execute(
        "SELECT u.email,u.verified,g.enabled_at FROM users u"
        " LEFT JOIN ultra_grants g ON g.user_id=u.id WHERE u.id=?", (uid,),
    ).fetchone()
    return bool(row and entitlement(row, row["enabled_at"])["enabled"])


def rate(c, key: str, cap: int, seconds: int, now: datetime):
    row = c.execute("SELECT * FROM hits WHERE key=?", (key,)).fetchone()
    if row and dt(row["window_start"]) + timedelta(seconds=seconds) > now:
        if int(row["count"]) >= cap:
            fail(429, "too_many", "操作太频繁了，稍后再试")
        c.execute("UPDATE hits SET count=count+1 WHERE key=?", (key,))
    else:
        c.execute("INSERT INTO hits(key,count,window_start) VALUES (?,1,?) ON CONFLICT(key)"
                  " DO UPDATE SET count=1,window_start=excluded.window_start", (key, iso(now)))


def code_hash(uid: int, request_id: str, code: str) -> str:
    return hmac.new(settings.jwt_secret.encode(), f"ultra:{uid}:{request_id}:{code}".encode(), hashlib.sha256).hexdigest()


def _version(version: str):
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?", version)
    return (*map(int, m.group(1, 2, 3)), 1 if m[4] is None else 0, int(m[4] or 0)) if m else (0,)


def package_path(key: str) -> Path:
    root = Path(settings.private_dir).resolve()
    public = Path(settings.public_dir).resolve()
    path = (root / key).resolve()
    if not path.is_relative_to(root) or root == public or root.is_relative_to(public) or path.is_relative_to(public):
        fail(503, "no_package", "Ultra 安装包配置暂时不可用")
    return path


def artifact(beta: bool = False) -> dict | None:
    folder = "windows/ultra/beta" if beta else "windows/ultra"
    path = package_path(f"{folder}/latest.json")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        name, sha, version = raw.get("file", ""), raw.get("sha256", ""), raw.get("version", "")
        if not isinstance(name, str) or not FILE_RE.fullmatch(name) or not isinstance(sha, str) or not SHA_RE.fullmatch(sha.lower()):
            return None
        if _version(str(version)) == (0,):
            return None
        key = f"{folder}/{name}"
        file = package_path(key)
        size = file.stat().st_size
        if not file.is_file() or size <= 0 or size != int(raw.get("size", 0)):
            return None
        # 清单和实体必须一致；不能把损坏/半传完的包发给申请人。
        with file.open("rb") as f:
            digest = hashlib.file_digest(f, "sha256").hexdigest()
        if digest != sha.lower():
            return None
        return {**raw, "file": name, "size": size, "sha256": digest, "key": key}
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def newest(admin: bool) -> dict:
    options = [x for x in (artifact(), artifact(True) if admin else None) if x]
    if not options:
        fail(503, "no_package", "Ultra 安装包还没有准备好，稍后再申请")
    return max(options, key=lambda x: _version(x["version"]))


def ticket(c, uid: int, package: dict, now: datetime, request=None) -> dict:
    token, download_id = secrets.token_urlsafe(32), secrets.token_hex(16)
    expires = min(now + timedelta(minutes=30), dt(request["expires_at"])) if request else now + timedelta(minutes=30)
    # 同一账号的已过期下载资格可清理；保留确认状态供重试幂等和到期申请结算。
    c.execute("DELETE FROM ultra_downloads WHERE user_id=? AND expires_at<? AND completed_at IS NULL", (uid, iso(now - timedelta(days=2))))
    c.execute(
        "INSERT INTO ultra_downloads(id,token_hash,user_id,request_id,package_key,version,sha256,size,expires_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (download_id, hashlib.sha256(token.encode()).hexdigest(), uid, request["id"] if request else None,
         package["key"], package["version"], package["sha256"], package["size"], iso(expires)),
    )
    return {
        "available": True, "edition": "ultra", "version": package["version"],
        "schema": int(package.get("schema") or 0), "size": package["size"], "sha256": package["sha256"],
        "url": f"{settings.download_base.rsplit('/download', 1)[0]}/api/ultra/download/{token}",
        "notes": str(package.get("notes") or ""), "publishedAt": str(package.get("publishedAt") or ""),
        "pageUrl": "https://acorn.cdpandas.com/intro/", "fileName": package["file"],
        "downloadId": download_id, "requiresAuth": True, "expiresAt": iso(expires),
    }


class VerifyIn(BaseModel):
    requestId: str = Field(min_length=1, max_length=80)
    code: str = Field(min_length=1, max_length=32)


class CompleteIn(BaseModel):
    sha256: str = Field(min_length=64, max_length=64)


class TrackedDownload(StreamingResponse):
    """只在最后一帧 body 成功发送后留完整传输证据，取消/异常不计成功。"""
    def __init__(self, path: Path, size: int, filename: str, mark: Callable[[], None]):
        self.path = path
        self.reader = None
        def chunks():
            while chunk := self.reader.read(64 * 1024):
                yield chunk
        self.mark = mark
        super().__init__(chunks(), media_type="application/x-msdownload", headers={
            "Content-Length": str(size), "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        })

    async def stream_response(self, send):
        self.reader = self.path.open("rb")
        try:
            await super().stream_response(send)
        finally:
            # StreamingResponse 的线程池迭代器不会保证关闭底层同步生成器。
            # 在发送异常/取消时也显式关文件，避免 Windows 句柄与服务器描述符泄漏。
            self.reader.close()
        # 使用事件循环当前线程的独立 SQLite 连接。不能用 background：断连也可能执行它。
        self.mark()


def mount(app, db: Database, current_user, is_admin, forward_ip, admin_identity):
    router = APIRouter(prefix="/api/ultra")

    def identity(request: Request, authorization: Annotated[str | None, Header()] = None):
        if authorization:
            try:
                return current_user(authorization)
            except (ValueError, TypeError):
                fail(401, "bad_token", "登录状态过期了，重新登录一下")
        raw = request.cookies.get(settings.cdp_cookie)
        if not raw or not COOKIE_RE.fullmatch(raw):
            fail(401, "no_token", "先登录，才能申请 Ultra")
        origin = request.headers.get("origin")
        if (origin and origin.strip().rstrip("/").lower() not in settings.site_origins) or (request.method != "GET" and not origin):
            fail(403, "bad_origin", "请从橡果介绍页操作")
        try:
            reply = account.me_by_cookie(settings.cdp_cookie, raw, forward_ip(request))
        except account.Unavailable:
            fail(503, "account_unavailable", "账号服务暂时连不上，稍后再试")
        who = reply.body if reply.status == 200 and isinstance(reply.body, dict) else None
        if reply.status == 403:
            fail(403, "blocked", "账号已被冻结或尚未通过验证")
        if not who:
            fail(401, "bad_token", "登录状态过期了，重新登录一下")
        if who.get("is_blocked"):
            fail(403, "blocked", "账号已被冻结")
        if not who.get("is_approved"):
            fail(403, "unverified", "邮箱还没有验证")
        email = str(who.get("email") or "").strip().lower()
        if not EMAIL_RE.fullmatch(email) or len(email) > 254:
            fail(503, "account_unavailable", "账号服务暂时没有认出这个账号")
        name = who.get("display_name")
        return db.adopt_account(email, bool(who.get("is_admin")), str(name)[:64] if name else None)

    def status_out(user, now: datetime, include_download=True):
        uid = int(user["id"])
        day, midnight = day_window(now)
        with transaction(db) as c:
            grant = settle(c, uid, now)
            row = c.execute("SELECT * FROM ultra_requests WHERE user_id=? AND request_day=?", (uid, day)).fetchone()
            active = row and row["state"] in ("active", "succeeded") and dt(row["expires_at"]) > now
            download = None
            if include_download and active and row["verified_at"] and not grant["locked_until"]:
                try:
                    # 网站申请有独立的 Bower 验证码门槛，首发只有 beta 时普通申请人也可取得它。
                    package = newest(True)
                except HTTPException as exc:
                    if exc.status_code != 503:
                        raise
                else:
                    download = ticket(c, uid, package, now, row)
            return {
                "email": user["email"], "enabled": enabled(db, uid), "serverNow": iso(now),
                "requestId": row["id"] if row else None, "requestDay": row["request_day"] if row else None,
                "expiresAt": row["expires_at"] if row else None, "canRequest": not row and not grant["locked_until"],
                "nextRequestAt": grant["locked_until"] or (iso(midnight) if row else iso(now)),
                "consecutiveFailures": int(grant["failures"]), "lockedUntil": grant["locked_until"],
                "verified": bool(active and row["verified_at"]), "downloaded": bool(active and row["completed_at"]),
                "download": download, "message": "验证码只寄给管理员，申请当天北京时间 24:00 失效",
            }

    @router.get("/status")
    def status(user=Depends(identity)):
        return status_out(user, utcnow())

    @router.post("/request", status_code=202)
    def apply(request: Request, user=Depends(identity)):
        now = utcnow()
        uid, request_id = int(user["id"]), secrets.token_hex(16)
        day, midnight = day_window(now)
        # 没包或未配发信时不占用申请机会，也不产生到期失败。
        newest(True)
        if not settings.mail_enabled:
            fail(503, "mail_unavailable", "验证码邮件暂时不可用，今天的申请机会没有用掉")
        code = f"{secrets.randbelow(1000000):06d}"
        with transaction(db) as c:
            grant = settle(c, uid, now)
            unlocked(grant)
            previous = c.execute("SELECT * FROM ultra_requests WHERE user_id=? AND request_day=?", (uid, day)).fetchone()
            if previous and previous["state"] == "sending" and dt(previous["created_at"]) + timedelta(minutes=2) <= now:
                c.execute("DELETE FROM ultra_requests WHERE id=?", (previous["id"],))
                previous = None
            if previous:
                fail(429, "already_requested", "这个账号今天已经申请过，请使用当天的验证码", nextRequestAt=iso(midnight))
            rate(c, f"ultra-request-ip:{forward_ip(request) or getattr(request.client, 'host', '?')}", 20, 3600, now)
            c.execute("INSERT INTO ultra_requests(id,user_id,request_day,created_at,expires_at,code_hash,state)"
                      " VALUES (?,?,?,?,?,?,'sending')", (request_id, uid, day, iso(now), iso(midnight), code_hash(uid, request_id, code)))
        try:
            mailer.send_ultra_code(str(user["email"]), code, midnight.astimezone(BEIJING).strftime("%Y-%m-%d %H:%M"))
        except Exception:
            with transaction(db) as c:
                c.execute("DELETE FROM ultra_requests WHERE id=? AND state='sending'", (request_id,))
            fail(502, "mail_failed", "验证码邮件没有发出，今天的申请机会没有用掉")
        finally:
            del code
        with transaction(db) as c:
            c.execute("UPDATE ultra_requests SET state='active' WHERE id=? AND state='sending'", (request_id,))
        returned = utcnow()
        return {**status_out(user, returned, False), "requestId": request_id, "requestDay": day,
                "expiresAt": iso(midnight), "message": "申请已提交，验证码只寄给管理员 Bower" if returned < midnight else "邮件已发送，但这次申请已经过了北京时间 24:00"}

    def get_request(c, uid: int, request_id: str, now: datetime):
        row = c.execute("SELECT * FROM ultra_requests WHERE id=? AND user_id=?", (request_id, uid)).fetchone()
        if not row:
            fail(404, "no_request", "没有找到这次申请")
        if dt(row["expires_at"]) <= now:
            fail(410, "code_expired", "这次申请已经过了北京时间 24:00，请查看能否重新申请")
        if row["state"] not in ("active", "succeeded"):
            fail(409, "request_pending", "验证码还在发送，请稍后再试")
        return row

    @router.post("/verify")
    def verify(body: VerifyIn, request: Request, user=Depends(identity)):
        now, uid = utcnow(), int(user["id"])
        package = newest(True)
        with transaction(db) as c:
            grant = settle(c, uid, now)
            unlocked(grant)
            row = get_request(c, uid, body.requestId, now)
            rate(c, f"ultra-verify:{uid}", 60, 3600, now)
            rate(c, f"ultra-verify-ip:{forward_ip(request) or getattr(request.client, 'host', '?')}", 120, 3600, now)
            if not hmac.compare_digest(code_hash(uid, row["id"], body.code.strip()), row["code_hash"]):
                fail(400, "bad_code", "验证码不正确，请核对管理员提供的当天验证码")
            c.execute("UPDATE ultra_requests SET verified_at=COALESCE(verified_at,?) WHERE id=?", (iso(now), row["id"]))
            # 授权与完整下载分开：正确验证码立即授权；未完成下载仍到期计失败。
            c.execute("UPDATE ultra_grants SET enabled_at=COALESCE(enabled_at,?) WHERE user_id=?", (iso(now), uid))
            return {"ok": True, "requestId": row["id"], "expiresAt": row["expires_at"], "download": ticket(c, uid, package, now, row)}

    def update(user, beta=False):
        uid = int(user["id"])
        if not enabled(db, uid):
            fail(403, "ultra_not_enabled", "先在介绍页完成 Ultra 下载申请")
        if beta and not is_admin(user):
            return {"available": False}
        package = artifact(beta)
        if not package:
            return {"available": False}
        with transaction(db) as c:
            return ticket(c, uid, package, utcnow())

    @router.get("/desktop/latest")
    def latest(user=Depends(identity)):
        return update(user)

    @router.get("/desktop/beta")
    def beta(user=Depends(identity)):
        return update(user, True)

    @router.get("/download/{token}")
    def download(token: str, user=Depends(identity)):
        now, uid = utcnow(), int(user["id"])
        if len(token) > 100:
            fail(404, "no_download", "没有找到这次下载")
        with transaction(db) as c:
            row = c.execute("SELECT * FROM ultra_downloads WHERE token_hash=? AND user_id=?",
                            (hashlib.sha256(token.encode()).hexdigest(), uid)).fetchone()
            if not row:
                fail(404, "no_download", "没有找到这次下载")
            if dt(row["expires_at"]) <= now:
                fail(410, "download_expired", "下载资格已过期，请刷新页面重新取得")
            if row["request_id"]:
                unlocked(settle(c, uid, now))
                get_request(c, uid, row["request_id"], now)
            elif not enabled(db, uid):
                fail(403, "ultra_not_enabled", "这个账号还没有 Ultra 授权")
            path = package_path(row["package_key"])
            if not path.is_file() or path.stat().st_size != int(row["size"]):
                fail(503, "no_package", "这个安装包暂时不可用，请刷新后重试")

        def mark():
            finished = utcnow()
            with transaction(db) as c:
                c.execute("UPDATE ultra_downloads SET streamed_at=? WHERE id=? AND expires_at>?", (iso(finished), row["id"], iso(finished)))
        return TrackedDownload(path, row["size"], path.name, mark)

    @router.post("/download/{download_id}/complete")
    def complete(download_id: str, body: CompleteIn, user=Depends(identity)):
        now, uid = utcnow(), int(user["id"])
        with transaction(db) as c:
            row = c.execute("SELECT * FROM ultra_downloads WHERE id=? AND user_id=?", (download_id, uid)).fetchone()
            if not row:
                fail(404, "no_download", "没有找到这次下载")
            if not hmac.compare_digest(body.sha256.lower(), row["sha256"]):
                fail(400, "bad_digest", "安装包校验没有通过，请重新下载")
            if not row["completed_at"]:
                if dt(row["expires_at"]) <= now:
                    # 即使有人跳过 status，也必须先结算已到期申请。
                    settle(c, uid, now)
                    fail(410, "download_expired", "下载没有在有效时间内完成，请查看能否重新申请")
                if not row["streamed_at"]:
                    fail(409, "download_incomplete", "还没有确认安装包完整传输，请稍后重试")
                if row["request_id"]:
                    unlocked(settle(c, uid, now))
                    request_row = get_request(c, uid, row["request_id"], now)
                    if not request_row["verified_at"]:
                        fail(403, "not_verified", "先正确验证这次申请")
                    c.execute("UPDATE ultra_requests SET completed_at=COALESCE(completed_at,?),settled_at=COALESCE(settled_at,?),state='succeeded' WHERE id=?", (iso(now), iso(now), row["request_id"]))
                    c.execute("UPDATE ultra_grants SET failures=0,locked_until=NULL,enabled_at=COALESCE(enabled_at,?) WHERE user_id=?", (iso(now), uid))
                c.execute("UPDATE ultra_downloads SET completed_at=? WHERE id=?", (iso(now), download_id))
            failures = c.execute("SELECT failures FROM ultra_grants WHERE user_id=?", (uid,)).fetchone()
            return {"ok": True, "enabled": enabled(db, uid), "downloaded": True,
                    "consecutiveFailures": int(failures["failures"]) if failures else 0}

    app.include_router(router)

    # 和反馈后台使用同一道新鲜管理员门禁；外部访客得到普通404。
    admin = APIRouter(prefix="/api/admin/ultra", dependencies=[Depends(admin_identity)], include_in_schema=False)

    def admin_out(row, detail=False):
        state = entitlement(row, row["enabled_at"])
        state["downloadedAt"] = row["downloaded_at"]
        if detail:
            latest = db.conn.execute(
                "SELECT MAX(created_at) AS requested,MAX(verified_at) AS verified,MAX(completed_at) AS completed"
                " FROM ultra_requests WHERE user_id=?", (int(row["id"]),),
            ).fetchone()
            state.update(consecutiveFailures=int(row["failures"] or 0), lockedUntil=row["locked_until"],
                         lastRequestAt=latest["requested"], lastVerifiedAt=latest["verified"],
                         lastCompletedAt=latest["completed"])
        return {"id": int(row["id"]), "email": row["email"], "displayName": row["display_name"],
                "verified": bool(row["verified"]), "createdAt": row["created_at"], "lastSeen": row["last_seen"],
                "ultra": state}

    columns = ("SELECT u.id,u.email,u.display_name,u.verified,u.created_at,u.last_seen,"
               "g.enabled_at,g.failures,g.locked_until,"
               "(SELECT MAX(d.completed_at) FROM ultra_downloads d WHERE d.user_id=u.id) AS downloaded_at"
               " FROM users u LEFT JOIN ultra_grants g ON g.user_id=u.id")

    @admin.get("/accounts")
    def accounts(response: Response, state: Annotated[str, Query(alias="status")] = "enabled",
                 count: Annotated[int, Query(alias="limit")] = 50, before: int | None = None):
        response.headers["Cache-Control"] = "private, no-store"
        if state not in ("enabled", "all"):
            fail(400, "bad_request", "status 只能是 enabled 或 all")
        n = max(1, min(count, 200))
        filters, args = [], []
        if state == "enabled":
            filters.append("(NULLIF(g.enabled_at,'') IS NOT NULL OR (u.verified=1 AND lower(trim(u.email))=?))")
            args.append(DEFAULT_ENTITLED_EMAIL)
        if before is not None:
            filters.append("u.id<?")
            args.append(before)
        where = " WHERE " + " AND ".join(filters) if filters else ""
        rows = db.conn.execute(columns + where + " ORDER BY u.id DESC LIMIT ?", (*args, n + 1)).fetchall()
        return {"items": [admin_out(row) for row in rows[:n]], "next": int(rows[n - 1]["id"]) if len(rows) > n else None}

    @admin.get("/accounts/{user_id}")
    def account_detail(user_id: int, response: Response):
        response.headers["Cache-Control"] = "private, no-store"
        row = db.conn.execute(columns + " WHERE u.id=?", (user_id,)).fetchone()
        if row is None:
            # 与未知路由、非管理员一致，不给外部账号枚举信号。
            from starlette.exceptions import HTTPException as NotFound
            raise NotFound(status_code=404)
        # 授权/申请详情只结算本账号的现有请求，不触碰账本。
        with transaction(db) as c:
            settle(c, user_id, utcnow())
        row = db.conn.execute(columns + " WHERE u.id=?", (user_id,)).fetchone()
        return admin_out(row, True)

    app.include_router(admin)


def image_entries(envelope):
    """只检查当前认识的可选图片路径，未知字段仍原样透传。回收站和历史也计实际大小。"""
    data = envelope.get("data") if isinstance(envelope, dict) else None
    tasks = data.get("tasks", []) if isinstance(data, dict) else []
    if not isinstance(tasks, list):
        return
    for task in tasks:
        if not isinstance(task, dict):
            continue
        owners = [task, *(s for s in task.get("subtasks", []) if isinstance(s, dict))] if isinstance(task.get("subtasks", []), list) else [task]
        for owner in owners:
            images = owner.get("images", [])
            if isinstance(images, list):
                for image in images:
                    if isinstance(image, dict) and isinstance(image.get("dataUrl"), str):
                        yield images, image


def jpeg_dimensions(raw: bytes) -> tuple[int, int] | None:
    if not raw.startswith(b"\xff\xd8") or not raw.endswith(b"\xff\xd9"):
        return None
    pos = 2
    while pos + 3 < len(raw):
        if raw[pos] != 255:
            return None
        while pos < len(raw) and raw[pos] == 255:
            pos += 1
        if pos >= len(raw):
            return None
        marker = raw[pos]
        pos += 1
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        if marker in (0xD9, 0xDA) or pos + 2 > len(raw):
            return None
        size = int.from_bytes(raw[pos:pos + 2], "big")
        if size < 2 or pos + size > len(raw):
            return None
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            if size < 8:
                return None
            return int.from_bytes(raw[pos + 5:pos + 7], "big"), int.from_bytes(raw[pos + 3:pos + 5], "big")
        pos += size
    return None


def check_new_images(incoming: dict, previous: dict | None) -> bool:
    """只拦新增内容。循环复制、删除、完成和旧设备保存不因历史图片额度卡住。"""
    def key(image):
        # 生命周期复制可换局部 id，但原图内容没有增加；未知历史依然应能编辑/删除。
        return image["dataUrl"]
    known = {key(image) for _, image in image_entries(previous) or []}
    total, new = 0, False
    for owners, image in image_entries(incoming) or []:
        uri = image["dataUrl"]
        total += len(uri.encode("utf-8"))
        if key(image) in known:
            continue
        new = True
        if len(owners) > 8:
            fail(413, "too_many_images", "一件事或一条子任务最多放 8 张图片")
        if not uri.startswith(IMAGE_PREFIX) or len(uri) > len(IMAGE_PREFIX) + 4 * ((256 * 1024 + 2) // 3):
            fail(413, "image_too_big", "图片需要压缩到 256 KiB 以内")
        try:
            raw = base64.b64decode(uri[len(IMAGE_PREFIX):], validate=True)
        except (ValueError, TypeError):
            fail(400, "bad_image", "这张图片格式不完整，请重新选择")
        dimensions = jpeg_dimensions(raw)
        if not dimensions or len(raw) > 256 * 1024 or dimensions != (image.get("width"), image.get("height")) or not all(0 < n <= 1920 for n in dimensions) or image.get("bytes") != len(raw):
            fail(400, "bad_image", "图片尺寸或大小不正确，请重新选择并压缩")
    if new and total > settings.ultra_max_image_bytes:
        fail(413, "images_full", "图片已达到 20 MiB，先移除一些图片后再添加")
    return new
