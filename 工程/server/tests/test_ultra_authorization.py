"""默认资格/验证码授权/后台隐私回归：临时库、假身份与假邮件，不接生产。"""
from __future__ import annotations
import json
import sys
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_ultra import Clock, apply, auth, client, complete, db, make_token, override, settings, ultra, user, verify, world
from app import account
from app import main as app_main

PATH = "/api/admin/ultra/accounts"

@contextmanager
def bower(verified=True):
    uid, headers, _ = user()
    with db.tx() as c:
        # 历史账号可能保留大小写/边缘空白；可信数据库身份归一化，不认客户端自报邮箱。
        c.execute("UPDATE users SET email=?,verified=? WHERE id=?", ("  BOWER.6868@GMAIL.COM  ", int(verified), uid))
    try:yield uid, headers
    finally:db.delete_user(uid)

def admin():
    uid, headers, email = user()
    return uid, headers, email

def test_default_bower_entitlement_without_code_download_or_fake_timestamp():
    with world() as (sent, binary, _), bower() as (uid, headers):
        assert ultra.enabled(db, uid)
        assert db.conn.execute("SELECT * FROM ultra_grants WHERE user_id=?", (uid,)).fetchone() is None
        me = client.get("/api/me", headers=headers).json()
        assert me["ultra"] and me["maxVaultBytes"] == 32 * 1024 * 1024
        with override(max_vault_bytes=1000, ultra_max_vault_bytes=3000):
            envelope={"app":"acorn","schema":8,"data":{"tasks":[],"lists":[],"notes":"x"*1300}}
            assert client.put("/api/sync",headers=headers,json={"base_rev":0,"data":envelope}).status_code==200
        package = client.get("/api/ultra/desktop/latest", headers=headers)
        assert package.status_code == 200 and package.json()["edition"] == "ultra"
        assert client.get(package.json()["url"], headers=headers).content == binary
        assert complete(headers,package.json()).json()=={"ok":True,"enabled":True,"downloaded":True,"consecutiveFailures":0}
        assert db.conn.execute("SELECT * FROM ultra_grants WHERE user_id=?",(uid,)).fetchone() is None
        state = client.get("/api/ultra/status", headers=headers).json()
        assert state["enabled"] and not state["verified"] and not state["downloaded"] and state["canRequest"]
        assert not sent
        # 默认资格也沿用网站当天申请次数，不把资格当作验证码验证记录。
        applied = apply(headers)
        assert applied["enabled"] and len(sent) == 1
        assert client.post("/api/ultra/request", headers=headers).status_code == 429

def test_default_identity_is_verified_server_identity_not_client_claim():
    with world(), bower(False) as (uid, headers):
        assert not ultra.enabled(db, uid)
        assert client.get("/api/me", headers=headers).status_code == 403
        assert client.get("/api/ultra/status", headers=headers).status_code == 403
    with world():
        uid, headers, _ = user()
        claimed = {**headers, "X-Email": ultra.DEFAULT_ENTITLED_EMAIL, "X-User-Email": ultra.DEFAULT_ENTITLED_EMAIL}
        assert not client.get("/api/me", headers=claimed).json()["ultra"]
        assert client.get("/api/ultra/desktop/latest", headers=claimed).status_code == 403
        assert not ultra.enabled(db, uid)

def test_default_bower_trusted_cookie_identity_and_blocked_gate():
    with world(), bower() as (uid, _):
        reply = {"email":" BOWER.6868@GMAIL.COM ","is_approved":True,"is_blocked":False,"is_admin":False}
        headers = {"Cookie":settings.cdp_cookie+"=synthetic-default-cookie", "Origin":"https://acorn.cdpandas.com"}
        # cookie身份只来自账号服务；adopt会规范化邮箱。移除测试历史空白行以免产生同名两行。
        with db.tx() as c:c.execute("UPDATE users SET email=? WHERE id=?", (ultra.DEFAULT_ENTITLED_EMAIL, uid))
        with patch.object(account, "me_by_cookie", return_value=account.Reply(200,reply)):
            result=client.get("/api/ultra/status",headers=headers)
            assert result.status_code==200 and result.json()["enabled"]
        with patch.object(account, "me_by_cookie", return_value=account.Reply(200,{**reply,"is_blocked":True})):
            assert client.get("/api/ultra/status",headers=headers).status_code==403

def test_verified_code_immediately_enables_cap_update_but_expired_download_still_counts():
    with world() as (sent, _, _):
        uid, headers, _ = user()
        applied=apply(headers)
        assert not client.get("/api/me",headers=headers).json()["ultra"]
        manifest=verify(headers,applied,sent)
        enabled_at=db.conn.execute("SELECT enabled_at FROM ultra_grants WHERE user_id=?",(uid,)).fetchone()[0]
        assert enabled_at==ultra.iso(Clock.now)
        assert client.get("/api/me",headers=headers).json()["maxVaultBytes"]==32*1024*1024
        assert client.get("/api/ultra/desktop/latest",headers=headers).status_code==200
        assert complete(headers,manifest).status_code==409
        # 大于普通5MiB的实际推送亦立即可用，而非只改状态标签。
        envelope={"app":"acorn","schema":8,"data":{"tasks":[],"lists":[],"notes":"x"*(5*1024*1024)}}
        assert client.put("/api/sync",headers=headers,json={"base_rev":0,"data":envelope}).status_code==200
        for index in range(3):
            if index:
                applied=apply(headers);verify(headers,applied,sent)
            Clock.now=ultra.dt(applied["expiresAt"])
            state=client.get("/api/ultra/status",headers=headers).json()
            assert state["enabled"] and state["consecutiveFailures"]==index+1
        assert state["lockedUntil"]==ultra.iso(Clock.now+timedelta(days=7))
        assert client.post("/api/ultra/request",headers=headers).status_code==423
        assert client.get("/api/ultra/desktop/latest",headers=headers).status_code==200
        assert db.conn.execute("SELECT enabled_at FROM ultra_grants WHERE user_id=?",(uid,)).fetchone()[0]==enabled_at

def test_admin_accounts_sources_download_time_and_no_secrets_or_vaults():
    with world() as (sent, _, _), bower() as (default_uid, _):
        admin_uid, headers, email=admin()
        uid, person, _=user();applied=apply(person);manifest=verify(person,applied,sent)
        with override(admin_emails=frozenset({email})):
            default=client.get(PATH+f"/{default_uid}",headers=headers).json()
            assert default["ultra"]["enabled"] and default["ultra"]["source"]=="default" and default["ultra"]["enabledAt"] is None
            before=client.get(PATH+f"/{uid}",headers=headers).json()
            assert before["ultra"]["source"]=="verified_code" and before["ultra"]["downloadedAt"] is None
            assert before["ultra"]["lastVerifiedAt"]==ultra.iso(Clock.now)
            assert before["ultra"]["lastCompletedAt"] is None
            listing_before=client.get(PATH,headers=headers).json()
            assert next(item for item in listing_before["items"] if item["id"]==uid)["ultra"]["downloadedAt"] is None
            assert client.get(manifest["url"],headers=person).status_code==200
            assert complete(person,manifest).status_code==200
            after=client.get(PATH+f"/{uid}",headers=headers).json()
            assert after["ultra"]["enabledAt"]==before["ultra"]["enabledAt"]
            assert after["ultra"]["downloadedAt"]==after["ultra"]["lastCompletedAt"]==ultra.iso(Clock.now)
            listing=client.get(PATH,headers=headers).json()
            assert client.get(PATH,headers=headers).headers["cache-control"]=="private, no-store"
            assert client.get(PATH+f"/{uid}",headers=headers).headers["cache-control"]=="private, no-store"
            items={item["id"]:item for item in listing["items"]}
            assert default_uid in items and uid in items and admin_uid not in items
            assert all(set(item)=={"id","email","displayName","verified","createdAt","lastSeen","ultra"} for item in items.values())
            raw=json.dumps(listing)+json.dumps(after)
            for private in ["pw_hash","code_hash","token_hash","package_key",manifest["url"],sent[-1][1]]:
                assert private not in raw

def test_admin_list_pagination_all_and_private_404_gate():
    with world():
        _, headers, email=admin()
        created=[user()[0] for _ in range(3)]
        _, ordinary, _=user()
        for path in [PATH,PATH+f"/{created[0]}",PATH+"/999999999"]:
            anonymous=client.get(path);nonadmin=client.get(path,headers=ordinary)
            assert anonymous.status_code==nonadmin.status_code==404
            assert anonymous.json()==nonadmin.json()=={"detail":"Not Found"}
        with override(admin_emails=frozenset({email})):
            first=client.get(PATH+"?status=all&limit=2",headers=headers).json()
            ids=[item["id"] for item in first["items"]]
            assert ids==sorted(ids,reverse=True) and len(ids)==2 and first["next"]==ids[-1]
            second=client.get(PATH+f"?status=all&limit=2&before={first['next']}",headers=headers).json()
            assert second["items"] and all(item["id"]<first["next"] for item in second["items"])
            assert client.get(PATH+"?status=wrong",headers=headers).status_code==400
            assert client.get(PATH+"/999999999",headers=headers).status_code==404
        assert all(not route.startswith('/api/admin/ultra') for route in client.get('/openapi.json').json()['paths'])

def test_admin_fresh_bearer_and_cookie_match_feedback_gate():
    with world():
        uid, headers, email=admin()
        with db.tx() as c:c.execute("UPDATE users SET cdp_admin=1,cdp_admin_at='2000-01-01T00:00:00Z' WHERE id=?",(uid,))
        assert client.get(PATH,headers=headers).status_code==404
        reply={"email":email,"is_approved":True,"is_blocked":False,"is_admin":True}
        cookie={"Cookie":settings.cdp_cookie+"=synthetic-ultra-admin-cookie"}
        with app_main._admin_lock:app_main._admin_cache.clear()
        with patch.object(account,"me_by_cookie",return_value=account.Reply(200,reply)):
            assert client.get(PATH,headers=cookie).status_code==200
            assert client.get(PATH,headers={**cookie,"Origin":"https://attacker.invalid"}).status_code==404

if __name__=="__main__":
    tests=[(name,fn) for name,fn in list(globals().items()) if name.startswith('test_') and callable(fn)]
    for name,fn in tests:fn();print('PASS',name)
    print(f'Ultra authorization: {len(tests)} passed')
