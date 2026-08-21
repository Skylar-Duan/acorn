"""同步服务的接口测试。不装 pytest 也能跑：`python tests/test_api.py`。

覆盖：注册→验证→登录整条路、验证码的各种错法、限流、同步的推拉与冲突退回、
以及最要紧的那条——**别人的数据绝不能串到我这里**。
"""

from __future__ import annotations

import os
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 必须在 import app 之前设好：配置是模块级读环境变量的
_TMP = tempfile.mkdtemp(prefix="acorn-test-")
os.environ["ACORN_DB"] = str(Path(_TMP) / "test.db")
os.environ["ACORN_JWT_SECRET"] = "test-secret-not-used-anywhere-real"
os.environ.pop("SMTP_HOST", None)
os.environ.pop("SMTP_PASSWORD", None)

from fastapi.testclient import TestClient  # noqa: E402

from app import mailer  # noqa: E402
from app.main import app, db  # noqa: E402
from app.security import hash_code  # noqa: E402

client = TestClient(app)

# 不真发信：把验证码截下来供测试断言
SENT: list[tuple[str, str, str]] = []
NOTICES: list[str] = []
mailer.send_code = lambda to, code, purpose="verify": SENT.append((to, code, purpose))
mailer.send_already_registered = lambda to: NOTICES.append(to)


def last_code(email: str) -> str:
    """邮箱一律按小写找——接口收下时就归一化了，测试里大小写混写也要找得到。"""
    want = email.strip().lower()
    for to, code, _ in reversed(SENT):
        if to.lower() == want:
            return code
    raise AssertionError(f"没有发给 {email} 的验证码")


def reset_limits() -> None:
    """限流表在测试之间清掉，不然后面的用例会被前面的次数拖累。"""
    with db.tx() as c:
        c.execute("DELETE FROM hits")


def signup(email: str, password: str = "hunter2hunter") -> str:
    """走完整条注册路，返回令牌。"""
    reset_limits()
    r = client.post("/api/auth/register", json={"email": email, "password": password})
    assert r.status_code == 202, r.text
    r = client.post("/api/auth/verify", json={"email": email, "code": last_code(email)})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


DATA = {"app": "acorn", "schema": 3, "appVersion": "1.4.0", "data": {"tasks": [], "lists": []}}


# ---------- 用例 ----------


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_register_verify_login():
    email = "a@example.com"
    reset_limits()
    r = client.post("/api/auth/register", json={"email": email, "password": "hunter2hunter"})
    assert r.status_code == 202
    code = last_code(email)
    assert len(code) == 6 and code.isdigit()

    # 没验证之前登录要被挡住，并且明确告诉用户为什么
    r = client.post("/api/auth/login", json={"email": email, "password": "hunter2hunter"})
    assert r.status_code == 403 and r.json()["error"] == "unverified"

    r = client.post("/api/auth/verify", json={"email": email, "code": code})
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == email and body["rev"] == 0 and body["token"]

    r = client.post("/api/auth/login", json={"email": email, "password": "hunter2hunter"})
    assert r.status_code == 200 and r.json()["token"]


def test_email_and_password_validation():
    reset_limits()
    r = client.post("/api/auth/register", json={"email": "不是邮箱", "password": "hunter2hunter"})
    assert r.status_code == 400 and r.json()["error"] == "bad_email"
    r = client.post("/api/auth/register", json={"email": "b@example.com", "password": "短"})
    assert r.status_code == 400 and r.json()["error"] == "weak_password"


def test_email_case_and_space_insensitive():
    token = signup("Mixed.Case@Example.COM ".strip())
    assert token
    reset_limits()
    r = client.post(
        "/api/auth/login", json={"email": "  MIXED.case@example.com  ", "password": "hunter2hunter"}
    )
    assert r.status_code == 200, r.text


def test_wrong_code_then_right():
    email = "c@example.com"
    reset_limits()
    client.post("/api/auth/register", json={"email": email, "password": "hunter2hunter"})
    r = client.post("/api/auth/verify", json={"email": email, "code": "000000"})
    # 极小概率真码就是 000000，那就换一个错的再试
    if r.status_code == 200:
        return
    assert r.status_code == 400 and r.json()["error"] == "bad_code"
    r = client.post("/api/auth/verify", json={"email": email, "code": last_code(email)})
    assert r.status_code == 200


def test_code_dies_after_five_wrong_tries():
    email = "d@example.com"
    reset_limits()
    client.post("/api/auth/register", json={"email": email, "password": "hunter2hunter"})
    real = last_code(email)
    wrong = "111111" if real != "111111" else "222222"
    for _ in range(5):
        client.post("/api/auth/verify", json={"email": email, "code": wrong})
    r = client.post("/api/auth/verify", json={"email": email, "code": real})
    assert r.status_code == 400 and r.json()["error"] == "no_code"


def test_code_is_single_use():
    email = "e@example.com"
    reset_limits()
    client.post("/api/auth/register", json={"email": email, "password": "hunter2hunter"})
    code = last_code(email)
    assert client.post("/api/auth/verify", json={"email": email, "code": code}).status_code == 200
    r = client.post("/api/auth/verify", json={"email": email, "code": code})
    assert r.status_code == 400 and r.json()["error"] == "no_code"


def test_code_not_stored_in_plaintext():
    email = "f@example.com"
    reset_limits()
    client.post("/api/auth/register", json={"email": email, "password": "hunter2hunter"})
    row = db.get_code(email)
    code = last_code(email)
    assert row["code_hash"] != code
    assert row["code_hash"] == hash_code(code, email)


def test_password_not_stored_in_plaintext():
    signup("g@example.com")
    row = db.find_user("g@example.com")
    assert "hunter2hunter" not in row["pw_hash"]
    assert row["pw_hash"].startswith("scrypt$")


def test_registering_existing_email_sends_notice_not_code():
    email = "h@example.com"
    signup(email)
    before_codes, before_notices = len(SENT), len(NOTICES)
    reset_limits()
    r = client.post("/api/auth/register", json={"email": email, "password": "otherpassword"})
    # 接口回一样的话（不当账号探测器），但发的是「已注册」提示信而不是验证码
    assert r.status_code == 202
    assert len(SENT) == before_codes
    assert NOTICES[before_notices:] == [email]
    # 而且原密码必须没被改掉
    r = client.post("/api/auth/login", json={"email": email, "password": "hunter2hunter"})
    assert r.status_code == 200


def test_resend_too_soon():
    email = "i@example.com"
    reset_limits()
    client.post("/api/auth/register", json={"email": email, "password": "hunter2hunter"})
    r = client.post("/api/auth/resend", json={"email": email})
    assert r.status_code == 429 and r.json()["error"] == "too_soon"


def test_login_rate_limited():
    email = "j@example.com"
    signup(email)
    reset_limits()
    codes = [
        client.post("/api/auth/login", json={"email": email, "password": "wrongwrongwrong"}).status_code
        for _ in range(12)
    ]
    assert 429 in codes, codes


def test_forgot_and_reset_password():
    email = "k@example.com"
    old_token = signup(email)
    reset_limits()
    assert client.post("/api/auth/forgot", json={"email": email}).status_code == 202
    code = last_code(email)
    r = client.post(
        "/api/auth/reset", json={"email": email, "code": code, "password": "brandnewpass"}
    )
    assert r.status_code == 200
    # 新密码能登，旧密码不能
    reset_limits()
    assert (
        client.post("/api/auth/login", json={"email": email, "password": "brandnewpass"}).status_code
        == 200
    )
    assert (
        client.post("/api/auth/login", json={"email": email, "password": "hunter2hunter"}).status_code
        == 401
    )
    # 改了密码，别处登着的旧令牌当场失效
    assert client.get("/api/me", headers=auth(old_token)).status_code == 401


def test_forgot_unknown_email_says_the_same_thing():
    reset_limits()
    r = client.post("/api/auth/forgot", json={"email": "nobody-here@example.com"})
    assert r.status_code == 202


def test_me_requires_token():
    assert client.get("/api/me").status_code == 401
    # 注意：请求头只能是 ASCII，别在这里塞中文（httpx 会在客户端就报错，测的就不是服务端了）
    assert client.get("/api/me", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    assert client.get("/api/me", headers={"Authorization": "Basic nonsense"}).status_code == 401


def test_push_pull_roundtrip():
    token = signup("sync1@example.com")
    r = client.get("/api/sync", headers=auth(token))
    assert r.status_code == 200 and r.json() == {"rev": 0, "data": None, "updatedAt": None}

    payload = dict(DATA, data={"tasks": [{"id": "t1", "title": "买猫粮"}], "lists": []})
    r = client.put("/api/sync", json={"base_rev": 0, "data": payload, "device": "win-书房"}, headers=auth(token))
    assert r.status_code == 200 and r.json()["rev"] == 1

    r = client.get("/api/sync", headers=auth(token))
    body = r.json()
    assert body["rev"] == 1
    assert body["data"]["data"]["tasks"][0]["title"] == "买猫粮"


def test_push_conflict_returns_latest():
    token = signup("sync2@example.com")
    client.put("/api/sync", json={"base_rev": 0, "data": DATA}, headers=auth(token))
    # 另一台设备还以为自己是基于第 0 版改的
    r = client.put("/api/sync", json={"base_rev": 0, "data": DATA}, headers=auth(token))
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "conflict" and body["rev"] == 1 and body["data"] is not None
    # 拿最新版本号重推就成功
    r = client.put("/api/sync", json={"base_rev": body["rev"], "data": DATA}, headers=auth(token))
    assert r.status_code == 200 and r.json()["rev"] == 2


def test_old_client_rejected():
    token = signup("sync3@example.com")
    r = client.put(
        "/api/sync", json={"base_rev": 0, "data": {"app": "acorn", "schema": 2}}, headers=auth(token)
    )
    assert r.status_code == 400 and r.json()["error"] == "old_client"


def test_oversized_payload_rejected():
    token = signup("sync4@example.com")
    fat = dict(DATA, data={"blob": "х" * 3_000_000})
    r = client.put("/api/sync", json={"base_rev": 0, "data": fat}, headers=auth(token))
    assert r.status_code == 413 and r.json()["error"] == "too_big"


def test_data_never_leaks_between_accounts():
    """最要紧的一条：两个账号的数据绝不能串。"""
    a = signup("alice@example.com")
    b = signup("bob@example.com")
    mine = dict(DATA, data={"tasks": [{"id": "t1", "title": "爱丽丝的秘密"}]})
    client.put("/api/sync", json={"base_rev": 0, "data": mine}, headers=auth(a))

    r = client.get("/api/sync", headers=auth(b))
    assert r.json()["data"] is None, "串号了！"
    assert r.json()["rev"] == 0

    # bob 推自己的，也不能盖掉 alice 的
    his = dict(DATA, data={"tasks": [{"id": "t9", "title": "鲍勃的事"}]})
    client.put("/api/sync", json={"base_rev": 0, "data": his}, headers=auth(b))
    r = client.get("/api/sync", headers=auth(a))
    assert r.json()["data"]["data"]["tasks"][0]["title"] == "爱丽丝的秘密"


def test_delete_account_wipes_data():
    token = signup("gone@example.com")
    client.put("/api/sync", json={"base_rev": 0, "data": DATA}, headers=auth(token))
    assert client.delete("/api/account", headers=auth(token)).status_code == 200
    assert client.get("/api/me", headers=auth(token)).status_code == 401
    assert db.find_user("gone@example.com") is None


def test_token_from_other_secret_rejected():
    from app.security import make_token

    forged = make_token("不是真的密钥", 1, 1, 30)
    assert client.get("/api/me", headers=auth(forged)).status_code == 401


# ---------- 跑起来 ----------


def main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = []
    for name, fn in tests:
        try:
            fn()
            print(f"  ok  {name}")
        except Exception:  # noqa: BLE001
            failed.append(name)
            print(f"FAIL  {name}")
            traceback.print_exc()
    print(f"\n{len(tests) - len(failed)}/{len(tests)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
