"""Only synthetic users in test_api's temporary DB; never connect to production."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_api import app_main, auth, cdp, client, db, old_acorn_user


def seed(label: str):
    email = f"{label}@example.test"
    uid, token = old_acorn_user(email, "synthetic-password-only")
    with db.tx() as connection:
        connection.execute("UPDATE vaults SET data=?,rev=4 WHERE user_id=?", ('{"synthetic":true}', uid))
        connection.execute("INSERT INTO ultra_grants(user_id,enabled_at) VALUES (?,?)", (uid, "2026-10-20T01:00:00Z"))
        connection.execute("INSERT INTO ultra_requests(id,user_id,request_day,created_at,expires_at,code_hash,state) VALUES (?,?,?,?,?,?,?)", (f"req-{uid}", uid, "2026-10-20", "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z", "synthetic-only", "verified"))
        connection.execute("INSERT INTO ultra_downloads(id,token_hash,user_id,request_id,package_key,version,sha256,size,expires_at) VALUES (?,?,?,?,?,?,?,?,?)", (f"download-{uid}", f"synthetic-{uid}", uid, f"req-{uid}", "synthetic-package", "1.17.1", "a" * 64, 123, "2026-10-21T00:00:00Z"))
        connection.execute("INSERT INTO codes(email,code_hash,purpose,expires_at,sent_at,day) VALUES (?,?,?,?,?,?)", (email, "synthetic-only", "verify", "2026-10-21", "2026-10-20", "2026-10-20"))
        for key in [f"reg:{email}", f"login:{email.upper()}", f"fb:{uid}", f"ultra-verify:{uid}"]:
            connection.execute("INSERT INTO hits(key,count,window_start) VALUES (?,1,?)", (key, "2026-10-20T00:00:00Z"))
    feedback = db.add_feedback(uid, email, "desktop", "1.17.1", "synthetic-device", "synthetic feedback")
    return uid, token, email, feedback


def test_delete_removes_all_owned_records_without_deleting_another_account():
    uid, token, email, feedback = seed("erase-owner")
    other, _, other_email, other_feedback = seed("erase-other")
    with db.tx() as connection:
        connection.execute("UPDATE feedback SET done_by=?,done_at=? WHERE id=?", (email.upper(), "2026-10-20T01:00:00Z", other_feedback))
        connection.execute("INSERT INTO hits(key,count,window_start) VALUES ('login-ip:127.0.0.1',1,'2026-10-20')")
    before_calls = len(cdp.REQUESTS)
    with app_main._admin_lock:
        app_main._admin_cache["synthetic-owner-cookie-hash"] = (999999999999.0, email.upper())
        app_main._admin_cache["synthetic-other-cookie-hash"] = (999999999999.0, other_email)
    response = client.delete("/api/account", headers=auth(token))
    assert response.status_code == 200, response.text
    out = response.json()
    assert out["deleted"] and out["scope"] == "acorn" and out["cdpandasAccountKept"]
    assert set(out["retainedData"]) == {"cdpandasAccount", "infrastructureAccessLogs", "externalBackups"}
    assert "plusDownloads" in out["deletedData"] and "accountRateLimits" in out["deletedData"]
    assert len(cdp.REQUESTS) == before_calls, "Acorn erasure must not invoke shared account deletion"
    assert "synthetic-owner-cookie-hash" not in app_main._admin_cache
    assert app_main._admin_cache["synthetic-other-cookie-hash"][1] == other_email
    assert db.get_user(uid) is None
    for table in ["vaults", "feedback", "ultra_grants", "ultra_requests", "ultra_downloads"]:
        assert db.conn.execute(f"SELECT count(*) FROM {table} WHERE user_id=?", (uid,)).fetchone()[0] == 0
        assert db.conn.execute(f"SELECT count(*) FROM {table} WHERE user_id=?", (other,)).fetchone()[0] > 0
    assert db.get_code(email) is None and db.get_code(other_email) is not None
    assert db.conn.execute("SELECT count(*) FROM hits WHERE key IN (?,?,?,?)", (f"reg:{email}", f"login:{email.upper()}", f"fb:{uid}", f"ultra-verify:{uid}")).fetchone()[0] == 0
    assert db.conn.execute("SELECT count(*) FROM hits WHERE key=?", (f"fb:{other}",)).fetchone()[0] == 1
    assert db.conn.execute("SELECT count(*) FROM hits WHERE key=?", (f"ultra-verify:{other}",)).fetchone()[0] == 1
    assert db.conn.execute("SELECT count(*) FROM hits WHERE key='login-ip:127.0.0.1'").fetchone()[0] == 1
    other_row = db.conn.execute("SELECT * FROM feedback WHERE id=?", (other_feedback,)).fetchone()
    assert other_row["email"] == other_email and other_row["text"] == "synthetic feedback"
    assert other_row["done_by"] is None and other_row["done_at"] == "2026-10-20T01:00:00Z"
    assert client.get("/api/me", headers=auth(token)).status_code == 401
    db.delete_user(other)


def test_erasure_is_atomic_and_does_not_forget_records_when_user_delete_fails():
    uid, _, email, feedback = seed("erase-rollback")
    with db.tx() as connection:
        connection.execute(f"CREATE TEMP TRIGGER prevent_synthetic_erasure BEFORE DELETE ON users WHEN OLD.id={uid} BEGIN SELECT RAISE(ABORT, 'synthetic blocked delete'); END")
    try:
        try:
            db.delete_user(uid)
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("Synthetic rollback trigger did not fire")
        assert db.get_user(uid) is not None and db.get_code(email) is not None
        assert db.conn.execute("SELECT count(*) FROM feedback WHERE id=?", (feedback,)).fetchone()[0] == 1
        assert db.conn.execute("SELECT count(*) FROM ultra_downloads WHERE user_id=?", (uid,)).fetchone()[0] == 1
        assert db.conn.execute("SELECT count(*) FROM hits WHERE key=?", (f"fb:{uid}",)).fetchone()[0] == 1
    finally:
        with db.tx() as connection:
            connection.execute("DROP TRIGGER prevent_synthetic_erasure")
        db.delete_user(uid)


def test_missing_user_erasure_is_idempotent_and_does_not_touch_others():
    uid, _, email, _ = seed("erase-idempotent")
    db.delete_user(uid)
    db.delete_user(uid)
    assert db.find_user(email) is None


if __name__ == "__main__":
    tests = [value for name, value in globals().copy().items() if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print("PASS", test.__name__)
    print(f"{len(tests)} synthetic erasure tests passed")
