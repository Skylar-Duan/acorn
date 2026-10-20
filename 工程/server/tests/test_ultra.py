"""Ultra 的隔离测试；只用临时库/合成包/假邮件，不碰真实账号和安装包。"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_api import app, auth, cdp, client, db, override, settings
from app import mailer, ultra
from app.security import make_token


class Clock:
    now = datetime(2026, 10, 16, 15, 0, tzinfo=timezone.utc)  # 北京时间23点


@contextmanager
def world():
    with db.tx() as c:
        c.execute("DELETE FROM hits WHERE key LIKE 'ultra-%'")
    with tempfile.TemporaryDirectory(prefix="acorn-ultra-") as directory:
        root = Path(directory)
        binary = b"MZ" + bytes(range(256)) * 1024
        folder = root / "windows" / "ultra"
        folder.mkdir(parents=True)
        filename = "Acorn_Ultra_1.16.1_x64-setup.exe"
        (folder / filename).write_bytes(binary)
        manifest = {"file": filename, "version": "1.16.1", "size": len(binary), "sha256": hashlib.sha256(binary).hexdigest(), "schema": 8}
        (folder / "latest.json").write_text(json.dumps(manifest), encoding="utf-8")
        sent = []
        Clock.now = datetime(2026, 10, 16, 15, 0, tzinfo=timezone.utc)
        with override(private_dir=str(root), smtp_host="synthetic.invalid", smtp_password="synthetic-not-a-secret"), \
             patch.object(ultra, "utcnow", lambda: Clock.now), \
             patch.object(mailer, "send_ultra_code", lambda who, code, expires: sent.append((who, code, expires))):
            yield sent, binary, root


_seq = 0
def user(admin=False):
    global _seq
    _seq += 1
    email = f"ultra-{_seq}-{threading.get_ident()}@example.test"
    uid = db.create_user(email, "")
    db.mark_verified(uid)
    if admin:
        with db.tx() as c:
            c.execute("UPDATE users SET cdp_admin=1 WHERE id=?", (uid,))
    return uid, auth(make_token(settings.jwt_secret, uid, 1, 60)), email


def apply(headers):
    result = client.post("/api/ultra/request", headers=headers)
    assert result.status_code == 202, result.text
    return result.json()


def verify(headers, applied, sent):
    result = client.post("/api/ultra/verify", headers=headers, json={"requestId": applied["requestId"], "code": sent[-1][1]})
    assert result.status_code == 200, result.text
    return result.json()["download"]


def complete(headers, manifest):
    return client.post(f"/api/ultra/download/{manifest['downloadId']}/complete", headers=headers, json={"sha256": manifest["sha256"]})


def test_ultra_natural_day_midnight_and_wrong_code_not_failures():
    with world() as (sent, _, _):
        _, headers, _ = user()
        applied = apply(headers)
        assert applied["expiresAt"] == "2026-10-16T16:00:00.000Z"
        assert applied["requestDay"] == "2026-10-16"
        repeat = client.post("/api/ultra/request", headers=headers)
        assert repeat.status_code == 429 and repeat.json()["error"] == "already_requested"
        assert len(sent) == 1
        wrong = "111111" if sent[0][1] != "111111" else "222222"
        for _ in range(4):
            result = client.post("/api/ultra/verify", headers=headers, json={"requestId": applied["requestId"], "code": wrong})
            assert result.status_code == 400
        status = client.get("/api/ultra/status", headers=headers).json()
        assert status["consecutiveFailures"] == 0 and status["lockedUntil"] is None
        Clock.now = datetime(2026, 10, 16, 16, 0, tzinfo=timezone.utc)
        expired = client.post("/api/ultra/verify", headers=headers, json={"requestId": applied["requestId"], "code": sent[0][1]})
        assert expired.status_code == 410
        status = client.get("/api/ultra/status", headers=headers).json()
        assert status["canRequest"] and status["consecutiveFailures"] == 1
        assert client.get("/api/ultra/status", headers=headers).json()["consecutiveFailures"] == 1


def test_ultra_three_expired_applications_lock_at_expiry_and_persist():
    with world() as (sent, _, _):
        uid, headers, _ = user()
        for n in range(3):
            # 空过一个日历日仍算连续申请，不是连续三个日历日。
            Clock.now = datetime(2026, 10, 16 + n * 2, 15, tzinfo=timezone.utc)
            applied = apply(headers)
            if n == 1:
                verify(headers, applied, sent)  # 只验证未下载也算未完成
            Clock.now = ultra.dt(applied["expiresAt"])
            status = client.get("/api/ultra/status", headers=headers).json()
            assert status["consecutiveFailures"] == n + 1
        locked_until = "2026-10-27T16:00:00.000Z"
        assert status["lockedUntil"] == locked_until
        # 同库另一实例体现持久化，而不是只存在当前进程内。
        from app.db import Database
        other = Database(db.path)
        assert other.conn.execute("SELECT locked_until FROM ultra_grants WHERE user_id=?", (uid,)).fetchone()[0] == locked_until
        result = client.post("/api/ultra/request", headers=headers)
        assert result.status_code == 423
        Clock.now = ultra.dt(locked_until) - timedelta(milliseconds=1)
        assert client.get("/api/ultra/status", headers=headers).json()["lockedUntil"]
        Clock.now += timedelta(milliseconds=1)
        status = client.get("/api/ultra/status", headers=headers).json()
        assert status["lockedUntil"] is None and status["consecutiveFailures"] == 0 and status["canRequest"]
        # 一日一次的唯一约束保留在数据库，不依赖设备时间。
        assert other.conn.execute("SELECT COUNT(*) FROM ultra_requests WHERE user_id=?", (uid,)).fetchone()[0] == 3


def test_ultra_success_requires_entire_transfer_and_digest_then_resets():
    with world() as (sent, binary, _):
        uid, headers, _ = user()
        first = apply(headers)
        Clock.now = ultra.dt(first["expiresAt"])
        assert client.get("/api/ultra/status", headers=headers).json()["consecutiveFailures"] == 1
        applied = apply(headers)
        manifest = verify(headers, applied, sent)
        assert ultra.enabled(db, uid)  # 正确验证码即授权；完整下载才清零失败计数。
        assert complete(headers, manifest).status_code == 409  # 知道公开sha也不能假确认
        assert client.get("/api/ultra/status", headers=headers).json()["consecutiveFailures"] == 1
        result = client.get(manifest["url"], headers=headers)
        assert result.status_code == 200 and result.content == binary
        wrong = {**manifest, "sha256": "0" * 64}
        assert complete(headers, wrong).status_code == 400
        done = complete(headers, manifest)
        assert done.status_code == 200 and done.json()["consecutiveFailures"] == 0
        assert ultra.enabled(db, uid)
        assert complete(headers, manifest).json() == done.json()
        status = client.get("/api/ultra/status", headers=headers).json()
        assert status["downloaded"] and status["download"] and not status["canRequest"]
        # 次日网站重新申请，但安装好的Ultra可以长期查自己的更新。
        Clock.now = ultra.dt(applied["expiresAt"])
        assert client.get("/api/ultra/status", headers=headers).json()["canRequest"]
        update = client.get("/api/ultra/desktop/latest", headers=headers)
        assert update.status_code == 200 and update.json()["edition"] == "ultra"
        assert client.get(update.json()["url"], headers=headers).content == binary


def test_ultra_expired_during_download_cannot_complete_after_midnight():
    with world() as (sent, _, _):
        uid, headers, _ = user()
        applied = apply(headers)
        manifest = verify(headers, applied, sent)
        assert client.get(manifest["url"], headers=headers).status_code == 200
        Clock.now = ultra.dt(applied["expiresAt"])
        result = complete(headers, manifest)
        assert result.status_code == 410 and ultra.enabled(db, uid)
        assert client.get("/api/ultra/status", headers=headers).json()["consecutiveFailures"] == 1


def test_ultra_download_belongs_to_account_and_cannot_escape_private_root():
    with world() as (sent, _, root):
        _, headers, _ = user()
        _, stranger, _ = user()
        applied = apply(headers)
        assert client.get("/api/ultra/status").status_code == 401
        assert client.post("/api/ultra/verify", headers=stranger, json={"requestId": applied["requestId"], "code": sent[0][1]}).status_code == 404
        manifest = verify(headers, applied, sent)
        assert client.get(manifest["url"]).status_code == 401
        assert client.get(manifest["url"], headers=stranger).status_code == 404
        assert complete(stranger, manifest).status_code == 404
        assert client.get("/api/ultra/desktop/latest", headers=stranger).status_code == 403
        for name in ("../outside.exe", "../../public/visible.exe", "/absolute.exe"):
            raw = {"file": name, "version": "1.16.1", "size": 3, "sha256": "0" * 64}
            (root / "windows/ultra/latest.json").write_text(json.dumps(raw), encoding="utf-8")
            assert ultra.artifact() is None
        with override(private_dir=str(Path(settings.public_dir) / "ultra")):
            try:
                ultra.package_path("windows/ultra/latest.json")
                assert False
            except ultra.HTTPException as exc:
                assert exc.status_code == 503


def test_ultra_mail_fail_closed_and_failed_send_does_not_spend_day():
    with world():
        _, headers, _ = user()
        with override(smtp_password=""):
            result = client.post("/api/ultra/request", headers=headers)
            assert result.status_code == 503 and result.json()["error"] == "mail_unavailable"
        with patch.object(mailer, "send_ultra_code", side_effect=RuntimeError("synthetic failure")):
            assert client.post("/api/ultra/request", headers=headers).status_code == 502
        assert client.get("/api/ultra/status", headers=headers).json()["canRequest"]
        assert apply(headers)["requestId"]


def test_ultra_concurrent_requests_reserve_once_before_mail():
    with world():
        _, headers, _ = user()
        entered, release = threading.Event(), threading.Event()
        sent = []
        def slow_mail(*args):
            sent.append(args)
            entered.set()
            assert release.wait(5)
        with patch.object(mailer, "send_ultra_code", slow_mail), ThreadPoolExecutor(2) as pool:
            first = pool.submit(client.post, "/api/ultra/request", headers=headers)
            assert entered.wait(5)
            second = client.post("/api/ultra/request", headers=headers)
            release.set()
            assert second.status_code == 429 and first.result().status_code == 202
            assert len(sent) == 1


def test_ultra_cookie_verified_user_mapping_and_origin_gate():
    with world():
        _, _, email = user()
        cdp.add_user(email, "synthetic-password")
        cookie = cdp.session_for(email)
        headers = {"Cookie": f"{settings.cdp_cookie}={cookie}", "Origin": "https://acorn.cdpandas.com"}
        assert client.get("/api/ultra/status", headers=headers).json()["email"] == email
        assert client.post("/api/ultra/request", headers={**headers, "Origin": "https://other.cdpandas.com"}).status_code == 403
        assert client.post("/api/ultra/request", headers={"Cookie": headers["Cookie"]}).status_code == 403
        assert apply(headers)["requestId"]
        cdp.USERS[email]["blocked"] = True
        assert client.get("/api/ultra/status", headers=headers).status_code in (401, 403)


def test_ultra_only_bower_receives_code_no_log_fallback():
    with override(smtp_host="fake.invalid", smtp_password="fake-password"), patch.object(mailer, "_deliver") as send:
        mailer.send_ultra_code("applicant@example.test", "123456", "2026-10-17 00:00")
        message, recipient = send.call_args.args
        assert recipient == mailer.ULTRA_RECIPIENT == "bower.6868@gmail.com"
        assert message["To"] == "bower.6868@gmail.com"
        assert "applicant@example.test" in message.get_body(preferencelist=("plain",)).get_content()
    with override(smtp_password=""), patch.object(mailer.log, "warning") as log:
        try:
            mailer.send_ultra_code("applicant@example.test", "123456", "2026-10-17 00:00")
            assert False
        except RuntimeError:
            pass
        assert not log.called


def test_ultra_stream_cancel_or_write_error_never_marks_full_transfer():
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "synthetic.exe"
        path.write_bytes(b"x" * 160000)
        marks = []
        async def run():
            response = ultra.TrackedDownload(path, path.stat().st_size, path.name, lambda: marks.append(True))
            count = 0
            async def send(message):
                nonlocal count
                if message["type"] == "http.response.body":
                    count += 1
                    if count == 2:
                        raise OSError("synthetic client disconnected")
            try:
                await response.stream_response(send)
                assert False
            except OSError:
                pass
        asyncio.run(run())
        assert marks == []


def image(n=1):
    # 仅用于服务端JPEG头尺寸和配额检查，真实浏览器压缩在客户端用实际解码另测。
    raw = b"\xff\xd8\xff\xc0\x00\x11\x08\x00\x01\x00\x01\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00\xff\xd9"
    return {"id": f"image-{n}", "name": "合成图片.jpg", "dataUrl": ultra.IMAGE_PREFIX + base64.b64encode(raw).decode(), "width": 1, "height": 1, "bytes": len(raw)}


def envelope(images):
    return {"app": "acorn", "schema": 8, "data": {"tasks": [{"id": "t", "images": images, "subtasks": []}]}}


def test_ultra_new_images_limits_but_known_history_completion_can_sync():
    one = image()
    assert ultra.check_new_images(envelope([one]), None)
    with override(ultra_max_image_bytes=len(one["dataUrl"]) - 1):
        try:
            ultra.check_new_images(envelope([one]), None)
            assert False
        except ultra.HTTPException as exc:
            assert exc.detail["error"] == "images_full"
        # 已有图复制进循环历史仍保留；只有新增图时才拦总图片额度。
        assert not ultra.check_new_images(envelope([one, one]), envelope([one]))
        assert not ultra.check_new_images(envelope([one, {**one, "id": "copied-history-image"}]), envelope([one]))
    assert ultra.check_new_images(envelope([image(n) for n in range(9)]), None)
    for images in ([{**one, "width": 99999}], [{**one, "dataUrl": "data:image/svg+xml;base64,YQ=="}], [{**one, "bytes": 999}]):
        try:
            ultra.check_new_images(envelope(images), None)
            assert False
        except ultra.HTTPException:
            pass


def test_ultra_account_specific_vault_cap_is_hard_and_edition_independent():
    with world():
        uid, headers, _ = user()
        _, normal, _ = user()
        with db.tx() as c:
            c.execute("INSERT INTO ultra_grants(user_id,enabled_at) VALUES (?,?)", (uid, ultra.iso(Clock.now)))
        with override(max_vault_bytes=1000, ultra_max_vault_bytes=3000):
            body = {"base_rev": 0, "data": {**envelope([]), "padding": "x" * 1300}}
            assert client.put("/api/sync", headers=normal, json=body).status_code == 413
            result = client.put("/api/sync", headers=headers, json=body)
            assert result.status_code == 200
            # 普通构建也用同账号，不带edition仍享同份账本额度。
            assert client.get("/api/me", headers=headers).json()["maxVaultBytes"] == 3000
            too_large = {"base_rev": result.json()["rev"], "data": {**envelope([]), "padding": "x" * 3000}}
            rejected = client.put("/api/sync", headers=headers, json=too_large)
            assert rejected.status_code == 413 and "本机记录仍保留" in rejected.json()["message"]
            assert client.get("/api/sync", headers=headers).json()["rev"] == result.json()["rev"]


def test_ultra_real_twenty_mebibyte_images_and_thirty_two_mebibyte_hard_limit():
    with world():
        uid, headers, _ = user()
        with db.tx() as c:
            c.execute("INSERT INTO ultra_grants(user_id,enabled_at) VALUES (?,?)", (uid, ultra.iso(Clock.now)))
        sample = image()
        raw = base64.b64decode(sample["dataUrl"][len(ultra.IMAGE_PREFIX):])
        raw = raw[:-2] + b"\x00" * (256 * 1024 - len(raw)) + raw[-2:]
        uri = ultra.IMAGE_PREFIX + base64.b64encode(raw).decode()
        def data(count):
            return {"app": "acorn", "schema": 8, "data": {"tasks": [
                {"id": f"t-{n}", "subtasks": [], "images": [{**sample, "id": f"i-{n}", "dataUrl": uri, "bytes": len(raw)}]}
                for n in range(count)
            ]}}
        allowed = data(59)
        assert sum(len(entry[1]["dataUrl"]) for entry in ultra.image_entries(allowed)) < 20 * 1024 * 1024
        rejected = client.put("/api/sync", headers=headers, json={"base_rev": 0, "data": data(60)})
        assert rejected.status_code == 413 and rejected.json()["error"] == "images_full"
        allowed["data"]["notes"] = "x" * (10 * 1024 * 1024)
        assert 29 * 1024 * 1024 < len(json.dumps(allowed).encode()) < 32 * 1024 * 1024
        result = client.put("/api/sync", headers=headers, json={"base_rev": 0, "data": allowed})
        assert result.status_code == 200, result.text
        # 没有新图也必须尊重整本硬限，回收/历史不会无限撑破nginx边界。
        allowed["data"]["notes"] = "x" * (13 * 1024 * 1024)
        rejected = client.put("/api/sync", headers=headers, json={"base_rev": result.json()["rev"], "data": allowed})
        assert rejected.status_code == 413 and rejected.json()["error"] == "too_big"
        assert "本机记录仍保留" in rejected.json()["message"]


def test_ultra_old_complete_replay_cannot_reset_later_failed_attempt():
    with world() as (sent, _, _):
        _, headers, _ = user()
        first = apply(headers)
        package = verify(headers, first, sent)
        assert client.get(package["url"], headers=headers).status_code == 200
        assert complete(headers, package).status_code == 200
        Clock.now = ultra.dt(first["expiresAt"])
        second = apply(headers)
        Clock.now = ultra.dt(second["expiresAt"])
        assert client.get("/api/ultra/status", headers=headers).json()["consecutiveFailures"] == 1
        assert complete(headers, package).status_code == 200
        assert client.get("/api/ultra/status", headers=headers).json()["consecutiveFailures"] == 1


def test_ultra_activated_account_delete_cascades_requests_grants_and_downloads():
    with world() as (sent, _, _):
        uid, headers, _ = user()
        first = apply(headers)
        package = verify(headers, first, sent)
        assert client.get(package["url"], headers=headers).status_code == 200
        assert complete(headers, package).status_code == 200
        assert client.delete("/api/account", headers=headers).status_code == 200
        for table in ("ultra_grants", "ultra_requests", "ultra_downloads"):
            assert db.conn.execute(f"SELECT COUNT(*) FROM {table} WHERE user_id=?", (uid,)).fetchone()[0] == 0
        assert client.get(package["url"], headers=headers).status_code == 401


def test_ultra_first_beta_available_via_bower_code_for_non_admin_not_public_update():
    with world() as (sent, binary, root):
        _, headers, _ = user()  # 普通申请人
        folder = root / "windows/ultra"
        package = json.loads((folder / "latest.json").read_text())
        beta = folder / "beta"
        beta.mkdir()
        package["version"] = "1.16.1-beta.4"
        (beta / "latest.json").write_text(json.dumps(package), encoding="utf-8")
        (beta / package["file"]).write_bytes(binary)
        (folder / "latest.json").unlink()
        first = apply(headers)
        manifest = verify(headers, first, sent)
        assert manifest["version"] == "1.16.1-beta.4"
        assert client.get(manifest["url"], headers=headers).content == binary
        assert complete(headers, manifest).status_code == 200
        assert client.get("/api/ultra/desktop/latest", headers=headers).json() == {"available": False}
        assert client.get("/api/ultra/desktop/beta", headers=headers).json() == {"available": False}
        assert client.get("/api/ultra/status", headers=headers).json()["download"]["version"] == "1.16.1-beta.4"


if __name__ == "__main__":
    tests = [(name, fn) for name, fn in list(globals().items()) if name.startswith("test_") and callable(fn)]
    for name, fn in tests:
        fn()
        print("PASS", name)
    print(f"Ultra: {len(tests)} passed")
