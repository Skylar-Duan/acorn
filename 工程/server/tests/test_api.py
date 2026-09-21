"""同步服务的接口测试。不装 pytest 也能跑：`python tests/test_api.py`；装了也能 `python -m pytest tests`。

覆盖：账号转接到 cdpandas 的整条路（注册→验证→登录、验证码各种错法、找回密码、冻结 / 没验证 /
连不上 / 超时、旧密码兜底、老令牌继续有效、管理员判定）、限流、同步的推拉与冲突退回、
以及最要紧的那条——**别人的数据绝不能串到我这里**。还有反馈（提交 / 管理员两种来源看与标记 / 非管理员 404 /
校验 / 限流 / 注销连带删除）。

cdpandas 用 tests/fake_cdpandas.py 顶替（真 HTTP，本机随机端口）。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import fake_cdpandas as cdp  # noqa: E402

# 必须在 import app 之前设好：配置是模块级读环境变量的
_TMP = tempfile.mkdtemp(prefix="acorn-test-")
os.environ["ACORN_DB"] = str(Path(_TMP) / "test.db")
# 版本清单目录也指到临时目录：Settings 是 frozen dataclass，只能在 import 前用环境变量改
PUBLIC = Path(_TMP) / "public"
os.environ["ACORN_PUBLIC_DIR"] = str(PUBLIC)
os.environ["ACORN_JWT_SECRET"] = "test-secret-not-used-anywhere-real"
os.environ["ACORN_ACCOUNT_BASE"] = cdp.start()
os.environ["ACORN_ACCOUNT_TIMEOUT"] = "1"
os.environ.pop("ACORN_LEGACY_LOGIN", None)  # 默认开
os.environ.pop("SMTP_HOST", None)
os.environ.pop("SMTP_PASSWORD", None)

from fastapi.testclient import TestClient  # noqa: E402

from app import account  # noqa: E402
from app.config import settings  # noqa: E402
from app import main as app_main  # noqa: E402
from app.main import app, db  # noqa: E402
from app.security import hash_password, make_token, read_token  # noqa: E402

client = TestClient(app)

PW = "hunter2hunter"


def last_code(email: str, purpose: str | None = None) -> str:
    """邮箱一律按小写找——橡果收下时就归一化了，转给 cdpandas 的也是小写。"""
    return cdp.last_code(email.strip().lower(), purpose)


def reset_limits() -> None:
    """限流表在测试之间清掉（橡果自己的 + 假 cdpandas 的冷却），不然后面的用例会被前面的次数拖累。"""
    with db.tx() as c:
        c.execute("DELETE FROM hits")
    cdp.reset_cooldowns()


def signup(email: str, password: str = PW) -> str:
    """走完整条注册路，返回橡果令牌。"""
    reset_limits()
    r = client.post("/api/auth/register", json={"email": email, "password": password})
    assert r.status_code == 202, r.text
    r = client.post("/api/auth/verify", json={"email": email, "code": last_code(email)})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def login(email: str, password: str = PW, headers: dict | None = None):
    reset_limits()
    return client.post("/api/auth/login", json={"email": email, "password": password}, headers=headers)


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def old_acorn_user(email: str, password: str) -> tuple[int, str]:
    """造一个转接之前就在橡果注册好的老用户（有橡果自己的密码），外加一枚当时发出去的令牌。"""
    uid = db.create_user(email, hash_password(password))
    db.mark_verified(uid)
    row = db.get_user(uid)
    return uid, make_token(settings.jwt_secret, uid, int(row["token_epoch"]), settings.token_days)


class override:
    """临时改 frozen 的 settings（只在测试里这么干）。"""

    def __init__(self, **kw):
        self.kw, self.old = kw, {}

    def __enter__(self):
        for k, v in self.kw.items():
            self.old[k] = getattr(settings, k)
            object.__setattr__(settings, k, v)

    def __exit__(self, *_):
        for k, v in self.old.items():
            object.__setattr__(settings, k, v)


DATA = {"app": "acorn", "schema": 3, "appVersion": "1.4.0", "data": {"tasks": [], "lists": []}}


# ---------- 用例：账号（转接 cdpandas） ----------


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_register_verify_login():
    email = "a@example.com"
    reset_limits()
    r = client.post("/api/auth/register", json={"email": email, "password": PW})
    assert r.status_code == 202 and r.json()["pending"] is True
    code = last_code(email)
    assert len(code) == 6 and code.isdigit()

    # 没验证之前登录要被挡住，并且明确告诉用户为什么（cdpandas 回 403「尚未验证」）
    r = client.post("/api/auth/login", json={"email": email, "password": PW})
    assert r.status_code == 403 and r.json()["error"] == "unverified", r.text

    r = client.post("/api/auth/verify", json={"email": email, "code": code})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["email"] == email and body["rev"] == 0 and body["token"]
    assert body["legacy"] is False
    # 发回来的是**橡果自己的**令牌，不是 cdpandas 的
    assert read_token(settings.jwt_secret, body["token"])["sub"]
    assert body["token"] not in cdp.issued_tokens()

    r = login(email)
    assert r.status_code == 200 and r.json()["token"]
    assert client.get("/api/me", headers=auth(r.json()["token"])).json()["email"] == email


def test_email_and_password_validation():
    reset_limits()
    r = client.post("/api/auth/register", json={"email": "不是邮箱", "password": PW})
    assert r.status_code == 400 and r.json()["error"] == "bad_email"
    r = client.post("/api/auth/register", json={"email": "b@example.com", "password": "短"})
    assert r.status_code == 400 and r.json()["error"] == "weak_password"
    r = client.post("/api/auth/register", json={"email": "b@example.com", "password": "x" * 129})
    assert r.status_code == 400 and r.json()["error"] == "weak_password"


def test_email_case_and_space_insensitive():
    token = signup("Mixed.Case@Example.COM ".strip())
    assert token
    r = login("  MIXED.case@example.com  ")
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "mixed.case@example.com"


def test_wrong_code_then_right():
    email = "c@example.com"
    reset_limits()
    client.post("/api/auth/register", json={"email": email, "password": PW})
    wrong = "000000" if last_code(email) != "000000" else "111111"
    r = client.post("/api/auth/verify", json={"email": email, "code": wrong})
    assert r.status_code == 400 and r.json()["error"] == "bad_code"
    assert "还可以再试" in r.json()["message"]  # cdpandas 的中文提示原样带回
    r = client.post("/api/auth/verify", json={"email": email, "code": last_code(email)})
    assert r.status_code == 200


def test_code_locks_after_five_wrong_tries():
    email = "d@example.com"
    reset_limits()
    client.post("/api/auth/register", json={"email": email, "password": PW})
    real = last_code(email)
    wrong = "111111" if real != "111111" else "222222"
    for _ in range(5):
        client.post("/api/auth/verify", json={"email": email, "code": wrong})
    r = client.post("/api/auth/verify", json={"email": email, "code": real})
    assert r.status_code == 429 and r.json()["error"] == "too_many"


def test_code_is_single_use():
    email = "e@example.com"
    reset_limits()
    client.post("/api/auth/register", json={"email": email, "password": PW})
    code = last_code(email)
    assert client.post("/api/auth/verify", json={"email": email, "code": code}).status_code == 200
    r = client.post("/api/auth/verify", json={"email": email, "code": code})
    # cdpandas：已验证过的邮箱再交验证码 → 409「直接登录」，绝不再发令牌
    assert r.status_code == 409 and r.json()["error"] == "already_verified"


def test_acorn_never_stores_cdpandas_password():
    signup("g@example.com")
    row = db.find_user("g@example.com")
    assert row["pw_hash"] == ""  # 密码只在 cdpandas
    assert row["verified"] == 1


def test_cdpandas_token_never_leaks():
    """cdpandas 的令牌：不回给客户端、不落橡果库。"""
    signup("leak@example.com")
    r = login("leak@example.com")
    text = r.text
    dump = "\n".join(" ".join(str(v) for v in tuple(row)) for row in db.conn.execute("SELECT * FROM users"))
    for tok in cdp.issued_tokens():
        assert tok not in text and tok not in dump


def test_registering_existing_email_says_go_login():
    email = "h@example.com"
    signup(email)
    reset_limits()
    r = client.post("/api/auth/register", json={"email": email, "password": "otherpassword"})
    assert r.status_code == 409 and r.json()["error"] == "already_registered"
    assert "cdpandas" in r.json()["message"]
    # 而且原密码必须没被改掉
    assert login(email).status_code == 200


def test_resend_too_soon():
    email = "i@example.com"
    reset_limits()
    client.post("/api/auth/register", json={"email": email, "password": PW})
    r = client.post("/api/auth/resend", json={"email": email})
    assert r.status_code == 429 and r.json()["error"] == "too_soon"


def test_resend_after_cooldown():
    email = "i2@example.com"
    reset_limits()
    client.post("/api/auth/register", json={"email": email, "password": PW})
    first = last_code(email)
    cdp.reset_cooldowns()
    assert client.post("/api/auth/resend", json={"email": email}).status_code == 202
    assert len([s for s in cdp.SENT if s[0] == email]) == 2
    assert first  # 新码可能巧合跟上一封相同，这里只关心确实发了第二封


def test_login_wrong_password_is_401():
    signup("wrong@example.com")
    r = login("wrong@example.com", "not-the-password")
    assert r.status_code == 401 and r.json()["error"] == "bad_login"


def test_login_rate_limited():
    email = "j@example.com"
    signup(email)
    reset_limits()
    codes = [
        client.post("/api/auth/login", json={"email": email, "password": "wrongwrongwrong"}).status_code
        for _ in range(12)
    ]
    assert 429 in codes, codes


def test_blocked_account():
    cdp.add_user("frozen@example.com", PW, blocked=True)
    r = login("frozen@example.com")
    assert r.status_code == 403 and r.json()["error"] == "blocked"


def test_forgot_and_reset_password():
    email = "k@example.com"
    old_token = signup(email)
    reset_limits()
    assert client.post("/api/auth/forgot", json={"email": email}).status_code == 202
    code = last_code(email, "reset")
    r = client.post("/api/auth/reset", json={"email": email, "code": code, "password": "brandnewpass"})
    assert r.status_code == 200, r.text
    new_token = r.json()["token"]
    # 新密码能登，旧密码不能
    assert login(email, "brandnewpass").status_code == 200
    assert login(email, PW).status_code == 401
    # 改了密码，别处登着的旧令牌当场失效；这次发的新令牌照常能用
    assert client.get("/api/me", headers=auth(old_token)).status_code == 401
    assert client.get("/api/me", headers=auth(new_token)).status_code == 200


def test_reset_with_wrong_code():
    email = "k2@example.com"
    signup(email)
    reset_limits()
    client.post("/api/auth/forgot", json={"email": email})
    real = last_code(email, "reset")
    wrong = "000000" if real != "000000" else "111111"
    r = client.post("/api/auth/reset", json={"email": email, "code": wrong, "password": "brandnewpass"})
    assert r.status_code == 400 and r.json()["error"] == "bad_code"


def test_forgot_unknown_email_says_the_same_thing():
    reset_limits()
    r = client.post("/api/auth/forgot", json={"email": "nobody-here@example.com"})
    assert r.status_code == 202


# ---------- 用例：cdpandas 连不上 / 超时 / 出错 ----------


def test_account_service_down_is_not_bad_password():
    signup("down@example.com")
    real = account.base_url
    account.base_url = lambda: "http://127.0.0.1:9"  # 没人监听的端口
    try:
        for path, body in [
            ("/api/auth/login", {"email": "down@example.com", "password": PW}),
            ("/api/auth/register", {"email": "down2@example.com", "password": PW}),
            ("/api/auth/verify", {"email": "down@example.com", "code": "123456"}),
            ("/api/auth/resend", {"email": "down@example.com"}),
            ("/api/auth/forgot", {"email": "down@example.com"}),
            ("/api/auth/reset", {"email": "down@example.com", "code": "123456", "password": PW}),
        ]:
            reset_limits()
            r = client.post(path, json=body)
            assert r.status_code == 503, (path, r.text)
            assert r.json()["error"] == "account_unavailable", path
    finally:
        account.base_url = real


def test_account_service_down_does_not_fall_back_to_legacy():
    """兜底只在「cdpandas 说密码不对」时生效；连不上不许偷偷改走橡果旧密码。"""
    old_acorn_user("legacy-down@example.com", PW)
    real = account.base_url
    account.base_url = lambda: "http://127.0.0.1:9"
    try:
        r = login("legacy-down@example.com")
        assert r.status_code == 503, r.text
    finally:
        account.base_url = real


def test_account_service_timeout():
    cdp.add_user("slow@example.com", PW)
    cdp.SLOW.add("slow@example.com")
    try:
        r = login("slow@example.com")
        assert r.status_code == 503 and r.json()["error"] == "account_unavailable", r.text
    finally:
        cdp.SLOW.discard("slow@example.com")


def test_account_service_500():
    cdp.add_user("boom@example.com", PW)
    cdp.STATE["broken"] = True
    try:
        r = login("boom@example.com")
        assert r.status_code == 503 and r.json()["error"] == "account_unavailable"
    finally:
        cdp.STATE["broken"] = False


# ---------- 用例：真实 IP 转给 cdpandas ----------


def test_real_ip_forwarded():
    cdp.add_user("ip@example.com", PW)
    login("ip@example.com", headers={"X-Real-IP": "203.0.113.9"})
    sent = [q for q in cdp.REQUESTS if q["path"] == "/api/auth/login" and (q["body"] or {}).get("email") == "ip@example.com"]
    assert sent and sent[-1]["headers"].get("x-real-ip") == "203.0.113.9"


def test_spoofed_forwarded_for_is_ignored():
    """X-Forwarded-For 是客户端能填的：既不拿来限流，也不转给 cdpandas。"""
    cdp.add_user("xff@example.com", PW)
    login("xff@example.com", headers={"X-Forwarded-For": "198.51.100.77"})
    sent = [q for q in cdp.REQUESTS if (q["body"] or {}).get("email") == "xff@example.com"]
    assert sent and sent[-1]["headers"].get("x-real-ip") != "198.51.100.77"


def test_garbage_ip_not_forwarded():
    cdp.add_user("junkip@example.com", PW)
    login("junkip@example.com", headers={"X-Real-IP": "not-an-ip"})
    sent = [q for q in cdp.REQUESTS if (q["body"] or {}).get("email") == "junkip@example.com"]
    assert sent and "x-real-ip" not in sent[-1]["headers"]


# ---------- 用例：老用户过渡 ----------


def test_old_tokens_keep_working():
    """转接之前发出去的橡果令牌照样有效；经 cdpandas 登录后还是同一行、同一份数据。"""
    uid, old_token = old_acorn_user("veteran@example.com", PW)
    assert client.put("/api/sync", json={"base_rev": 0, "data": DATA}, headers=auth(old_token)).status_code == 200
    cdp.add_user("veteran@example.com", PW)

    r = login("veteran@example.com")
    assert r.status_code == 200 and r.json()["legacy"] is False
    assert r.json()["rev"] == 1  # 数据还在
    assert read_token(settings.jwt_secret, r.json()["token"])["sub"] == str(uid)
    # 老令牌不受影响（没改密码，token_epoch 没动）
    assert client.get("/api/me", headers=auth(old_token)).status_code == 200


def test_legacy_login_when_cdpandas_says_no():
    """cdpandas 说密码不对，但橡果旧密码对得上 → 兜底放行，带 legacy=true。"""
    uid, _ = old_acorn_user("legacy@example.com", "the-old-acorn-pw")
    cdp.add_user("legacy@example.com", "a-different-cdp-pw")
    r = login("legacy@example.com", "the-old-acorn-pw")
    assert r.status_code == 200, r.text
    assert r.json()["legacy"] is True
    assert read_token(settings.jwt_secret, r.json()["token"])["sub"] == str(uid)
    # cdpandas 的密码当然也能进，而且不是兜底
    r = login("legacy@example.com", "a-different-cdp-pw")
    assert r.status_code == 200 and r.json()["legacy"] is False
    # 两个都不对 → 401
    assert login("legacy@example.com", "neither-of-them").status_code == 401


def test_legacy_login_user_missing_in_cdpandas():
    old_acorn_user("only-acorn@example.com", PW)
    r = login("only-acorn@example.com")
    assert r.status_code == 200 and r.json()["legacy"] is True


def test_unverified_old_row_password_is_not_trusted():
    """橡果老库里注册了没验证的行：那个密码没证明过邮箱归属，本人经 cdpandas 认领后不许拿它兜底。"""
    db.create_user("squat@example.com", hash_password("squatter-pw"))  # verified=0
    cdp.add_user("squat@example.com", "owner-pw")
    assert login("squat@example.com", "owner-pw").status_code == 200
    assert login("squat@example.com", "squatter-pw").status_code == 401


def test_legacy_login_switched_off():
    old_acorn_user("legacy-off@example.com", PW)
    with override(legacy_login=False):
        r = login("legacy-off@example.com")
        assert r.status_code == 401 and r.json()["error"] == "bad_login"


def test_reset_retires_legacy_password():
    """在 cdpandas 重设过密码之后，橡果旧密码不许再靠兜底登进来，旧令牌全部下线。"""
    _, old_token = old_acorn_user("rotate@example.com", "the-old-acorn-pw")
    cdp.add_user("rotate@example.com", "cdp-pw-before")
    reset_limits()
    client.post("/api/auth/forgot", json={"email": "rotate@example.com"})
    code = last_code("rotate@example.com", "reset")
    r = client.post("/api/auth/reset", json={"email": "rotate@example.com", "code": code, "password": "cdp-pw-after"})
    assert r.status_code == 200, r.text
    assert login("rotate@example.com", "the-old-acorn-pw").status_code == 401
    assert login("rotate@example.com", "cdp-pw-after").status_code == 200
    assert client.get("/api/me", headers=auth(old_token)).status_code == 401


def test_adopted_row_loses_legacy_password():
    """cdpandas 认过一次之后，橡果旧密码永久作废：之后在 cdpandas.com 改密码、被冻结，
    旧密码都不许再经兜底拿到新令牌（cdpandas 先比密码再查冻结，密码不对只回 401）。"""
    _, old_token = old_acorn_user("adopted@example.com", "shared-pw-123")
    cdp.add_user("adopted@example.com", "shared-pw-123")
    assert login("adopted@example.com", "shared-pw-123").json()["legacy"] is False  # 认领
    assert db.find_user("adopted@example.com")["pw_hash"] == ""
    # 情形一：本人在 cdpandas.com 直接改了密码（不经橡果）
    cdp.USERS["adopted@example.com"]["pw"] = "changed-on-cdpandas"
    assert login("adopted@example.com", "shared-pw-123").status_code == 401
    assert login("adopted@example.com", "changed-on-cdpandas").status_code == 200
    # 情形二：cdpandas 冻结了他——拿旧密码也进不来
    cdp.USERS["adopted@example.com"]["blocked"] = True
    assert login("adopted@example.com", "shared-pw-123").status_code == 401
    r = login("adopted@example.com", "changed-on-cdpandas")
    assert r.status_code == 403 and r.json()["error"] == "blocked"
    # 已发出去的老令牌不受认领影响（openIssues 里记着：冻结不追溯已发令牌）
    assert client.get("/api/me", headers=auth(old_token)).status_code == 200


def test_reset_logs_out_even_if_me_fails_afterwards():
    """cdpandas 已经改好密码、用掉验证码，随后 /me 失败：踢下线与旧密码作废照样生效，文案说清密码已改。"""
    _, old_token = old_acorn_user("half-reset@example.com", "the-old-acorn-pw")
    cdp.add_user("half-reset@example.com", "cdp-pw-before")
    reset_limits()
    client.post("/api/auth/forgot", json={"email": "half-reset@example.com"})
    code = last_code("half-reset@example.com", "reset")
    cdp.STATE["me_broken"] = True
    try:
        r = client.post(
            "/api/auth/reset", json={"email": "half-reset@example.com", "code": code, "password": "cdp-pw-after"}
        )
    finally:
        cdp.STATE["me_broken"] = False
    assert r.status_code == 503 and r.json()["error"] == "account_unavailable", r.text
    assert "改好" in r.json()["message"]
    assert client.get("/api/me", headers=auth(old_token)).status_code == 401
    assert login("half-reset@example.com", "the-old-acorn-pw").status_code == 401
    assert login("half-reset@example.com", "cdp-pw-after").status_code == 200


def test_verify_of_blocked_unverified_account_is_blocked():
    """cdpandas 的 verify-code 不查冻结，/me 才回 403——要报「被冻结」，不是「服务连不上」。"""
    cdp.add_user("frozen-new@example.com", PW, approved=False, blocked=True)
    reset_limits()
    assert client.post("/api/auth/resend", json={"email": "frozen-new@example.com"}).status_code == 202
    code = last_code("frozen-new@example.com")
    r = client.post("/api/auth/verify", json={"email": "frozen-new@example.com", "code": code})
    assert r.status_code == 403 and r.json()["error"] == "blocked", r.text
    assert db.find_user("frozen-new@example.com") is None


def test_mail_failure_is_mail_failed_not_unavailable():
    """cdpandas 发信失败回 503 + 中文 detail：这是「信没发出去」，不是「账号服务挂了」。"""
    reset_limits()
    cdp.add_user("mailfail-known@example.com", PW)
    cdp.add_user("mailfail-pending@example.com", PW, approved=False)
    cdp.STATE["smtp_down"] = True
    try:
        for path, body in (
            ("/api/auth/register", {"email": "mailfail-new@example.com", "password": PW}),
            ("/api/auth/resend", {"email": "mailfail-pending@example.com"}),
            ("/api/auth/forgot", {"email": "mailfail-known@example.com"}),
        ):
            r = client.post(path, json=body)
            assert r.status_code == 502 and r.json()["error"] == "mail_failed", (path, r.text)
            assert "邮件" in r.json()["message"]
        # 登录不发信，不受影响
        assert login("mailfail-known@example.com").status_code == 200
    finally:
        cdp.STATE["smtp_down"] = False


def test_account_500_on_mail_path_is_still_unavailable():
    """发信那几条路上，没有 detail 的 500 仍是「暂时不可用」，只有 503 + detail 才算发信失败。"""
    reset_limits()
    cdp.STATE["broken"] = True
    try:
        r = client.post("/api/auth/forgot", json={"email": "whoever@example.com"})
        assert r.status_code == 503 and r.json()["error"] == "account_unavailable"
    finally:
        cdp.STATE["broken"] = False


def test_relay_slots_full_is_unavailable_not_hang():
    """转接名额占满（cdpandas 卡住时的样子）：立刻回 503，不排队、不占着同步接口的线程。"""
    import threading as _t

    real = account._slots
    account._slots = _t.BoundedSemaphore(1)
    account._slots.acquire()
    try:
        cdp.add_user("slots@example.com", PW)
        r = login("slots@example.com")
        assert r.status_code == 503 and r.json()["error"] == "account_unavailable"
    finally:
        account._slots.release()
        account._slots = real
    assert login("slots@example.com").status_code == 200


def test_old_database_gets_new_columns():
    """线上老库（转接前的 users 表，没有 cdp_admin / display_name / cdp_admin_at）：启动时自动补列，
    老令牌照样能用，/api/me 给出 isAdmin=false、displayName=null；重复打开不报错。"""
    import sqlite3

    from app.db import Database

    path = str(Path(_TMP) / "old-shape.db")
    raw = sqlite3.connect(path)
    raw.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
          pw_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, token_epoch INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, last_seen TEXT);
        CREATE TABLE vaults (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          rev INTEGER NOT NULL DEFAULT 0, data TEXT, updated_at TEXT, device TEXT);
        INSERT INTO users (email, pw_hash, verified, token_epoch, created_at)
          VALUES ('oldshape@example.com', 'x', 1, 1, '2026-01-01T00:00:00.000Z');
        INSERT INTO vaults (user_id, rev) VALUES (1, 7);
        """
    )
    raw.commit()
    raw.close()
    token = make_token(settings.jwt_secret, 1, 1, settings.token_days)

    old_db = Database(path)
    Database(path)  # 再开一次：幂等
    cols = {r["name"] for r in old_db.conn.execute("PRAGMA table_info(users)")}
    assert {"cdp_admin", "display_name", "cdp_admin_at"} <= cols
    assert "schema" in {r["name"] for r in old_db.conn.execute("PRAGMA table_info(vaults)")}
    assert old_db.get_user(1)["cdp_admin"] == 0

    real = app_main.db
    app_main.db = old_db
    try:
        me = client.get("/api/me", headers=auth(token))
        assert me.status_code == 200, me.text
        body = me.json()
        assert body["rev"] == 7 and body["isAdmin"] is False and body["displayName"] is None
        assert body["feedbackAdmin"] is False
    finally:
        app_main.db = real


# ---------- 用例：管理员 ----------


def test_admin_from_cdpandas():
    write_manifest("windows/beta", manifest_json("Acorn_1.15.1-beta.3_x64-setup.exe", "1.15.1-beta.3"))
    try:
        cdp.add_user("boss@example.com", PW, admin=True, display_name="老板")
        token = login("boss@example.com").json()["token"]
        me = client.get("/api/me", headers=auth(token)).json()
        assert me["isAdmin"] is True and me["displayName"] == "老板"
        assert client.get("/api/desktop/beta", headers=auth(token)).json()["available"] is True
        # cdpandas 撤了管理员 → 下次登录后就不是了
        cdp.USERS["boss@example.com"]["admin"] = False
        token = login("boss@example.com").json()["token"]
        assert client.get("/api/me", headers=auth(token)).json()["isAdmin"] is False
        assert client.get("/api/desktop/beta", headers=auth(token)).json() == {"available": False}
    finally:
        drop_manifest("windows/beta")


def test_admin_from_env_list():
    token = signup("1254823795@qq.com")
    assert client.get("/api/me", headers=auth(token)).json()["isAdmin"] is True
    token = signup("plain@example.com")
    assert client.get("/api/me", headers=auth(token)).json()["isAdmin"] is False


def test_me_requires_token():
    assert client.get("/api/me").status_code == 401
    # 注意：请求头只能是 ASCII，别在这里塞中文（httpx 会在客户端就报错，测的就不是服务端了）
    assert client.get("/api/me", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    assert client.get("/api/me", headers={"Authorization": "Basic nonsense"}).status_code == 401


def test_push_pull_roundtrip():
    token = signup("sync1@example.com")
    r = client.get("/api/sync", headers=auth(token))
    assert r.status_code == 200
    assert r.json() == {"rev": 0, "data": None, "updatedAt": None, "schema": 0}

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


def test_older_client_cannot_overwrite_newer_data():
    """桌面版会跑在手机版前面。手机上那份旧橡果**不许**把新版模型的数据按老格式盖回来——
    盖回来就等于把新版本才有的东西（比如习惯）悄悄抹掉。"""
    token = signup("schema@example.com")
    newer = dict(DATA, schema=9, data={"version": 9, "tasks": [{"id": "t1", "title": "新版才有的东西"}]})
    r = client.put("/api/sync", json={"base_rev": 0, "data": newer}, headers=auth(token))
    assert r.status_code == 200, r.text

    older = dict(DATA, schema=3, data={"version": 3, "tasks": []})
    r = client.put("/api/sync", json={"base_rev": 1, "data": older}, headers=auth(token))
    assert r.status_code == 409 and r.json()["error"] == "client_too_old", r.text

    # 而且云端那份必须原封不动
    r = client.get("/api/sync", headers=auth(token))
    assert r.json()["schema"] == 9
    assert r.json()["data"]["data"]["tasks"][0]["title"] == "新版才有的东西"


def test_same_schema_still_allowed():
    """同版本当然照推不误，别把正常同步也拦了。"""
    token = signup("schema2@example.com")
    assert client.put("/api/sync", json={"base_rev": 0, "data": DATA}, headers=auth(token)).status_code == 200
    assert client.put("/api/sync", json={"base_rev": 1, "data": DATA}, headers=auth(token)).status_code == 200


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
    before = len(cdp.REQUESTS)
    r = client.delete("/api/account", headers=auth(token))
    assert r.status_code == 200
    body = r.json()
    assert body["deleted"] is True and body["cdpandasAccountKept"] is True
    assert "cdpandas" in body["message"]
    assert client.get("/api/me", headers=auth(token)).status_code == 401
    assert db.find_user("gone@example.com") is None
    # 注销**绝不**碰 cdpandas：一个请求都没发过去，那边的账号原样还在
    assert len(cdp.REQUESTS) == before
    assert "gone@example.com" in cdp.USERS
    # 同一个 cdpandas 账号再登录：橡果建一行新的，数据不会回来
    r = login("gone@example.com")
    assert r.status_code == 200 and r.json()["rev"] == 0
    assert client.get("/api/me", headers=auth(r.json()["token"])).json()["hasData"] is False


def test_token_from_other_secret_rejected():
    from app.security import make_token

    forged = make_token("不是真的密钥", 1, 1, 30)
    assert client.get("/api/me", headers=auth(forged)).status_code == 401


# ---------- 版本清单（自动更新的那一问） ----------
#
# 这三种情况都得分清楚，否则表现全一样：「明明发了包却查不到更新」。
# 客户端那头只认 available 这一个字段，所以清单坏了必须回 false，不能 500。


def write_manifest(subdir: str, raw: str) -> None:
    d = PUBLIC / subdir
    d.mkdir(parents=True, exist_ok=True)
    (d / "latest.json").write_text(raw, encoding="utf-8")


def drop_manifest(subdir: str) -> None:
    p = PUBLIC / subdir / "latest.json"
    if p.exists():
        p.unlink()


def manifest_json(file: str, version: str) -> str:
    return json.dumps(
        {
            "file": file,
            "version": version,
            "schema": 6,
            "size": 27411625,
            "sha256": "a" * 64,
            "notes": "修了几个小问题",
            "publishedAt": "2026-08-31T10:00:00Z",
            "pageUrl": "https://github.com/Skylar-Duan/acorn/releases/latest",
        },
        ensure_ascii=False,
    )


def test_android_latest_without_manifest():
    """还没发过包：安静地回 available=false，不是 404 也不是 500。"""
    drop_manifest("android")
    r = client.get("/api/android/latest")
    assert r.status_code == 200
    assert r.json() == {"available": False}


def test_android_latest_broken_manifest():
    """清单在但解不开（编码写歪过一次）：也回 false，别把 500 甩给客户端。"""
    write_manifest("android", "{ 这不是 JSON")
    r = client.get("/api/android/latest")
    assert r.status_code == 200
    assert r.json()["available"] is False
    drop_manifest("android")


def test_android_latest_ok():
    write_manifest("android", manifest_json("Acorn_1.9.0_arm64.apk", "1.9.0"))
    body = client.get("/api/android/latest").json()
    assert body["available"] is True
    assert body["version"] == "1.9.0"
    assert body["schema"] == 6
    # 下载地址必须落在 /download/android/ 下——客户端只认自家域名，拼错就一律不下载
    assert body["url"].endswith("/download/android/Acorn_1.9.0_arm64.apk")
    drop_manifest("android")


def test_desktop_latest_without_manifest():
    drop_manifest("windows")
    assert client.get("/api/desktop/latest").json() == {"available": False}


def test_desktop_latest_broken_manifest():
    write_manifest("windows", "{ 这不是 JSON")
    assert client.get("/api/desktop/latest").json()["available"] is False
    drop_manifest("windows")


def test_desktop_latest_ok():
    """接口名是 desktop，目录名是 windows——两个名字不一样，别并成一个。"""
    write_manifest("windows", manifest_json("Acorn_1.9.0_x64-setup.exe", "1.9.0"))
    body = client.get("/api/desktop/latest").json()
    assert body["available"] is True
    assert body["version"] == "1.9.0"
    assert body["url"].endswith("/download/windows/Acorn_1.9.0_x64-setup.exe")
    drop_manifest("windows")


def test_channels_do_not_leak_into_each_other():
    """只发了桌面包时，手机那头必须还是「没有更新」。"""
    drop_manifest("android")
    write_manifest("windows", manifest_json("Acorn_1.9.0_x64-setup.exe", "1.9.0"))
    assert client.get("/api/android/latest").json() == {"available": False}
    assert client.get("/api/desktop/latest").json()["available"] is True
    drop_manifest("windows")


# ---------- 测试版通道：只给管理员 ----------


def test_beta_needs_login():
    assert client.get("/api/desktop/beta").status_code == 401
    assert client.get("/api/android/beta").status_code == 401


def test_beta_hidden_from_normal_accounts():
    """不是管理员：跟「还没发过」一模一样，不露口风。"""
    write_manifest("windows/beta", manifest_json("Acorn_1.15.1-beta.3_x64-setup.exe", "1.15.1-beta.3"))
    token = signup("someone-else@example.com")
    assert client.get("/api/desktop/beta", headers=auth(token)).json() == {"available": False}
    drop_manifest("windows/beta")


def test_beta_for_admin():
    """管理员（大小写不同也认）拿得到，下载地址落在 /download/windows/beta/ 下。"""
    write_manifest("windows/beta", manifest_json("Acorn_1.15.1-beta.3_x64-setup.exe", "1.15.1-beta.3"))
    token = signup("Skylar@CDPandas.com")
    body = client.get("/api/desktop/beta", headers=auth(token)).json()
    assert body["available"] is True
    assert body["version"] == "1.15.1-beta.3"
    assert body["url"].endswith("/download/windows/beta/Acorn_1.15.1-beta.3_x64-setup.exe")
    # 安卓那条没发过测试版：照样是没有
    assert client.get("/api/android/beta", headers=auth(token)).json() == {"available": False}
    drop_manifest("windows/beta")


def test_beta_does_not_touch_public_channel():
    """测试版清单跟正式版是两份：发了测试版，正式版接口还是原来那个。"""
    write_manifest("windows", manifest_json("Acorn_1.15.0_x64-setup.exe", "1.15.0"))
    write_manifest("windows/beta", manifest_json("Acorn_1.15.1-beta.3_x64-setup.exe", "1.15.1-beta.3"))
    assert client.get("/api/desktop/latest").json()["version"] == "1.15.0"
    drop_manifest("windows/beta")
    drop_manifest("windows")


# ---------- 反馈 ----------
#
# 提交：橡果令牌登录就行。看 / 标记：只给管理员，两种来源（橡果令牌 + is_admin、
# 浏览器带来的 cdpandas 会话 cookie → 问 cdpandas /me）。不是管理员一律 404，
# 而且那个 404 要跟「根本没这个路径」长得一模一样。


def fb(token: str, text: str = "设置页的字有点小", platform: str = "desktop", **kw):
    body = {"text": text, "platform": platform, "version": "1.15.1-beta.4", "device": "Windows · 橡果 beta"}
    body.update(kw)
    return client.post("/api/feedback", json=body, headers=auth(token))


def cdp_cookie(session: str, origin: str | None = None) -> dict:
    """浏览器从介绍页同源发请求时带的样子：Cookie 头里有 sbg_session（域 .cdpandas.com）。"""
    h = {"Cookie": f"sbg_session={session}"}
    if origin is not None:
        h["Origin"] = origin
    return h


def clear_admin_cache() -> None:
    with app_main._admin_lock:
        app_main._admin_cache.clear()
        app_main._cdp_down_until = 0.0


def me_calls_with_cookie() -> int:
    return sum(
        1 for r in cdp.REQUESTS if r["path"] == "/api/auth/me" and "sbg_session=" in r["headers"].get("cookie", "")
    )


def acorn_token(email: str) -> str:
    """已经在假 cdpandas 里的就登录，没有就走注册（管理员邮箱会被好几条用例用到）。"""
    if email.strip().lower() in cdp.USERS:
        r = login(email)
        assert r.status_code == 200, r.text
        return r.json()["token"]
    return signup(email)


def ids(r) -> list[int]:
    return [x["id"] for x in r.json()["items"]]


def test_feedback_needs_login():
    r = client.post("/api/feedback", json={"text": "hi", "platform": "web"})
    assert r.status_code == 401, r.text
    r = client.post("/api/feedback", json={"text": "hi", "platform": "web"}, headers=auth("nonsense"))
    assert r.status_code == 401


def test_feedback_normal_user_can_submit_but_not_read():
    clear_admin_cache()
    token = signup("fb-user@example.com")
    r = fb(token)
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    assert r.json()["ok"] is True
    row = db.get_feedback(fid)
    assert row["email"] == "fb-user@example.com" and row["platform"] == "desktop"
    assert row["version"] == "1.15.1-beta.4" and row["done_at"] is None

    # 普通账号：列表 / 标记都是 404，跟一个根本不存在的路径回的一模一样
    ghost = client.get("/api/definitely-not-here").json()
    for resp in (
        client.get("/api/feedback", headers=auth(token)),
        client.get("/api/feedback"),  # 没登录也是 404，不是 401
        client.get("/api/feedback?status=all&limit=abc", headers=auth(token)),
        client.patch(f"/api/feedback/{fid}", json={"done": True}, headers=auth(token)),
        client.patch("/api/feedback/not-a-number", json={"x": 1}),
    ):
        assert resp.status_code == 404, resp.text
        assert resp.json() == ghost
    assert db.get_feedback(fid)["done_at"] is None


def test_feedback_admin_by_acorn_token():
    """橡果管理员（邮箱在 ACORN_ADMIN_EMAILS 里，大小写不同也认）拿 App 里的令牌就能看、能标。"""
    user = signup("fb-reporter@example.com")
    f1 = fb(user, "第一条", "android").json()["id"]
    f2 = fb(user, "第二条", "web").json()["id"]
    admin = acorn_token("Bower.6868@Gmail.com")

    r = client.get("/api/feedback", headers=auth(admin))
    assert r.status_code == 200, r.text
    got = ids(r)
    assert got.index(f2) < got.index(f1)  # 时间倒序
    item = next(x for x in r.json()["items"] if x["id"] == f2)
    assert item["text"] == "第二条" and item["platform"] == "web" and item["done"] is False
    assert item["email"] == "fb-reporter@example.com" and item["createdAt"]
    open_before = r.json()["open"]

    r = client.patch(f"/api/feedback/{f1}", json={"done": True}, headers=auth(admin))
    assert r.status_code == 200, r.text
    assert r.json()["done"] is True and r.json()["doneBy"] == "bower.6868@gmail.com" and r.json()["doneAt"]
    # 默认只看未处理：f1 不见了；status=all 还在
    r = client.get("/api/feedback", headers=auth(admin))
    assert f1 not in ids(r) and f2 in ids(r) and r.json()["open"] == open_before - 1
    assert f1 in ids(client.get("/api/feedback?status=all", headers=auth(admin)))
    # 取消标记
    r = client.patch(f"/api/feedback/{f1}", json={"done": False}, headers=auth(admin))
    assert r.json()["done"] is False and r.json()["doneBy"] is None
    assert f1 in ids(client.get("/api/feedback", headers=auth(admin)))
    # 管理员面前才说真话：没这条 → 404；status 乱填 → 400
    assert client.patch("/api/feedback/999999", json={"done": True}, headers=auth(admin)).status_code == 404
    assert client.get("/api/feedback?status=weird", headers=auth(admin)).status_code == 400


def test_feedback_admin_from_cdpandas_login_counts_too():
    """cdpandas 说是管理员（cdp_admin）的橡果账号，拿橡果令牌也认。"""
    cdp.add_user("fb-cdpboss@example.com", PW, admin=True)
    token = login("fb-cdpboss@example.com").json()["token"]
    assert client.get("/api/feedback", headers=auth(token)).status_code == 200


def test_feedback_bearer_cdp_admin_goes_stale():
    """cdp_admin 只在登录时刷新；反馈后台走橡果令牌时，只认近期（默认 24 小时）确认过的。
    cdpandas 撤了管理员 / 冻结了他，旧令牌最多再看这么久，不是 60 天。测试版通道不受影响。"""
    cdp.add_user("fb-stale@example.com", PW, admin=True)
    token = login("fb-stale@example.com").json()["token"]
    assert client.get("/api/feedback", headers=auth(token)).status_code == 200
    assert client.get("/api/me", headers=auth(token)).json()["feedbackAdmin"] is True
    with db.tx() as c:
        c.execute(
            "UPDATE users SET cdp_admin_at = '2026-01-01T00:00:00.000Z' WHERE email = 'fb-stale@example.com'"
        )
    assert client.get("/api/feedback", headers=auth(token)).status_code == 404
    me = client.get("/api/me", headers=auth(token)).json()
    assert me["isAdmin"] is True and me["feedbackAdmin"] is False
    # 重新登录（cdpandas 再确认一次）就回来了
    token = login("fb-stale@example.com").json()["token"]
    assert client.get("/api/feedback", headers=auth(token)).status_code == 200
    # 橡果名单里的管理员不看这个时间
    admin = acorn_token("skylar@cdpandas.com")
    with db.tx() as c:
        c.execute("UPDATE users SET cdp_admin_at = NULL WHERE email = 'skylar@cdpandas.com'")
    assert client.get("/api/feedback", headers=auth(admin)).status_code == 200


def test_feedback_paging():
    user = signup("fb-pager@example.com")
    made = [fb(user, f"第 {i} 条").json()["id"] for i in range(5)]
    admin = acorn_token("skylar@cdpandas.com")
    r = client.get("/api/feedback?status=all&limit=2", headers=auth(admin))
    assert ids(r) == made[:-3:-1] and r.json()["next"] == made[-2]
    r = client.get(f"/api/feedback?status=all&limit=2&before={r.json()['next']}", headers=auth(admin))
    assert ids(r) == [made[2], made[1]]


def test_feedback_admin_by_cdpandas_cookie():
    """介绍页那条路：浏览器带着 cdpandas 的会话 cookie，同源请求。橡果原样转给 cdpandas /me 问。"""
    clear_admin_cache()
    user = signup("fb-cookie-user@example.com")
    fid = fb(user, "从手机发的", "android").json()["id"]
    cdp.add_user("fb-siteadmin@example.com", PW, admin=True)
    session = cdp.session_for("fb-siteadmin@example.com")

    before = me_calls_with_cookie()
    r = client.get("/api/feedback", headers=cdp_cookie(session))
    assert r.status_code == 200, r.text
    assert fid in ids(r)
    assert me_calls_with_cookie() == before + 1
    # 转过去的就是那枚 cookie 本身，没有被改成别的
    sent = [x for x in cdp.REQUESTS if x["path"] == "/api/auth/me"][-1]["headers"]["cookie"]
    assert sent == f"sbg_session={session}"

    # 60 秒内再问：走内存缓存，不再打扰 cdpandas；缓存键是哈希，不是 cookie 原文
    r = client.patch(f"/api/feedback/{fid}", json={"done": True}, headers=cdp_cookie(session))
    assert r.status_code == 200 and r.json()["doneBy"] == "fb-siteadmin@example.com"
    assert me_calls_with_cookie() == before + 1
    assert session not in app_main._admin_cache and all(len(k) == 64 for k in app_main._admin_cache)
    # 介绍页自己的源带 Origin 也放行；别的子站带着同一枚 cookie 来改 → 404
    ok = client.get("/api/feedback", headers=cdp_cookie(session, "https://acorn.cdpandas.com"))
    assert ok.status_code == 200
    evil = client.patch(
        f"/api/feedback/{fid}", json={"done": False}, headers=cdp_cookie(session, "https://evil.cdpandas.com")
    )
    assert evil.status_code == 404
    assert db.get_feedback(fid)["done_at"] is not None


def test_feedback_cookie_of_normal_cdpandas_user_is_404():
    clear_admin_cache()
    cdp.add_user("fb-plain-site@example.com", PW)
    session = cdp.session_for("fb-plain-site@example.com")
    assert client.get("/api/feedback", headers=cdp_cookie(session)).status_code == 404
    # 乱填的 cookie、过期的 cookie
    assert client.get("/api/feedback", headers=cdp_cookie("cdp-nope")).status_code == 404
    assert client.get("/api/feedback", headers={"Cookie": 'sbg_session="a b"'}).status_code == 404
    # cdpandas 那边被冻结的管理员
    cdp.add_user("fb-frozen-admin@example.com", PW, admin=True, blocked=True)
    frozen = cdp.session_for("fb-frozen-admin@example.com")
    assert client.get("/api/feedback", headers=cdp_cookie(frozen)).status_code == 404


def test_feedback_cookie_admin_email_list_case_insensitive():
    """cdpandas 里不是管理员、但邮箱在 ACORN_ADMIN_EMAILS 里（存的是大小写混写）也认——橡果管理员。"""
    clear_admin_cache()
    cdp.add_user("1254823795@QQ.com", PW)
    session = cdp.session_for("1254823795@QQ.com")
    assert client.get("/api/feedback", headers=cdp_cookie(session)).status_code == 200


def test_feedback_cookie_when_cdpandas_down():
    """cdpandas 连不上：当非管理员（404），且不缓存——恢复后马上能用。"""
    clear_admin_cache()
    cdp.add_user("fb-downadmin@example.com", PW, admin=True)
    session = cdp.session_for("fb-downadmin@example.com")
    cdp.STATE["broken"] = True
    try:
        assert client.get("/api/feedback", headers=cdp_cookie(session)).status_code == 404
    finally:
        cdp.STATE["broken"] = False
    # 冷却期内：不再转接（防有人趁 cdpandas 卡住拿乱编的 cookie 堆线程），照样 404
    before = me_calls_with_cookie()
    assert client.get("/api/feedback", headers=cdp_cookie("cdp-made-up")).status_code == 404
    assert client.get("/api/feedback", headers=cdp_cookie(session)).status_code == 404
    assert me_calls_with_cookie() == before
    # 冷却过了（这里直接拨表）：这枚 cookie 没被当成「非管理员」缓存下来，马上能用
    with app_main._admin_lock:
        app_main._cdp_down_until = 0.0
    assert client.get("/api/feedback", headers=cdp_cookie(session)).status_code == 200


def test_feedback_validation():
    token = signup("fb-validate@example.com")
    assert fb(token, "").status_code == 400
    assert fb(token, "   \n\t ").json()["error"] == "empty_feedback"
    assert fb(token, "字" * 2001).json()["error"] == "feedback_too_long"
    assert fb(token, "字" * 2000).status_code == 201
    assert fb(token, platform="ios").json()["error"] == "bad_platform"
    assert fb(token, platform="").status_code == 400
    assert fb(token, platform="Web").status_code == 201  # 大小写不计较
    assert fb(token, version="1" * 33).json()["error"] == "bad_version"
    assert fb(token, device="d" * 65).json()["error"] == "bad_device"
    # 控制字符剥掉、首尾空白去掉，正文里的换行保留
    fid = fb(token, "  第一行\r\n第二行\x00  ").json()["id"]
    assert db.get_feedback(fid)["text"] == "第一行\n第二行"


def test_feedback_rate_limited_per_account():
    # 两个号先都注册好（signup 会清限流表，放在刷屏之前）
    other = signup("fb-other@example.com")
    token = signup("fb-spammer@example.com")
    for i in range(settings.feedback_per_hour):
        assert fb(token, f"第 {i} 条").status_code == 201
    r = fb(token, "再来一条")
    assert r.status_code == 429 and r.json()["error"] == "too_many"
    # 按账号算：别人不受影响，刷屏那位照样被挡
    assert fb(other, "我只发一条").status_code == 201
    assert fb(token, "还想发").status_code == 429


def test_feedback_deleted_with_account():
    token = signup("fb-leaver@example.com")
    fid = fb(token, "我要走了").json()["id"]
    assert client.delete("/api/account", headers=auth(token)).status_code == 200
    assert db.get_feedback(fid) is None
    admin = acorn_token("bower.6868@gmail.com")
    assert fid not in ids(client.get("/api/feedback?status=all", headers=auth(admin)))


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
