"""口令与令牌。只用标准库——服务器上不用装编译型依赖，迁机器就是拷贝文件。

口令：scrypt（内存硬，比 bcrypt 更抗显卡爆破），格式 `scrypt$n$r$p$salt$hash`（都是 base64url）。
令牌：自签 JWT（HS256）。载荷带 `ep`（token epoch）——改密码时把用户的 epoch +1，
      所有旧令牌当场失效，不用维护黑名单。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

# scrypt 参数：约 16MB 内存 / 次。够狠，又不至于让 2C2G 的机器登录变慢
_N, _R, _P = 2**14, 8, 1
_DKLEN = 32


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ---------- 口令 ----------


def hash_password(plain: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(plain.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    return f"scrypt${_N}${_R}${_P}${_b64e(salt)}${_b64e(dk)}"


def verify_password(plain: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(
            plain.encode("utf-8"),
            salt=_b64d(salt_b64),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(_b64d(hash_b64)),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, _b64d(hash_b64))


# ---------- 验证码 ----------


def new_code() -> str:
    """6 位数字，允许前导零。"""
    return f"{secrets.randbelow(1000000):06d}"


def hash_code(code: str, email: str) -> str:
    """验证码也不明文入库：万一库被看到，也不能拿去顶替别人验证。"""
    return hashlib.sha256(f"{email.lower()}:{code}".encode("utf-8")).hexdigest()


def code_matches(code: str, email: str, stored_hash: str) -> bool:
    return hmac.compare_digest(hash_code(code, email), stored_hash)


# ---------- 令牌 ----------


class TokenError(Exception):
    pass


def make_token(secret: str, user_id: int, epoch: int, days: int, now: float | None = None) -> str:
    iat = int(now if now is not None else time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"sub": str(user_id), "ep": epoch, "iat": iat, "exp": iat + days * 86400}
    segments = [
        _b64e(json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")),
        _b64e(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")),
    ]
    signing_input = ".".join(segments).encode("ascii")
    sig = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    segments.append(_b64e(sig))
    return ".".join(segments)


def read_token(secret: str, token: str, now: float | None = None) -> dict:
    """验签 + 验过期，返回载荷。任何不对劲一律抛 TokenError，不告诉调用方细节。"""
    parts = token.split(".")
    if len(parts) != 3:
        raise TokenError("malformed")
    signing_input = f"{parts[0]}.{parts[1]}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    try:
        got = _b64d(parts[2])
    except (ValueError, TypeError):
        raise TokenError("malformed") from None
    if not hmac.compare_digest(expected, got):
        raise TokenError("bad signature")
    try:
        payload = json.loads(_b64d(parts[1]))
    except (ValueError, TypeError):
        raise TokenError("malformed") from None
    if not isinstance(payload, dict):
        raise TokenError("malformed")
    exp = payload.get("exp")
    if not isinstance(exp, int) or exp <= int(now if now is not None else time.time()):
        raise TokenError("expired")
    return payload
