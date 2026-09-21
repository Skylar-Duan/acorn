"""SQLite 存取层。用标准库 sqlite3，开 WAL——读写不打架，单机够用到几万用户。

五张表：users（谁）、codes（验证码）、vaults（他的任务数据）、hits（限流计数）、
feedback（用户反馈，2026-09-21 加）。
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL UNIQUE,          -- 一律小写存
  pw_hash     TEXT    NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0,
  token_epoch INTEGER NOT NULL DEFAULT 1,       -- +1 即让该用户所有旧令牌失效
  created_at  TEXT    NOT NULL,
  last_seen   TEXT,
  -- 以下几列是账号转接（2026-09-21）后加的，老库由 init_schema 补列
  cdp_admin    INTEGER NOT NULL DEFAULT 0,      -- 最近一次经 cdpandas 登录时，它说这人是不是管理员
  display_name TEXT,                            -- cdpandas 那边的昵称，只做展示
  cdp_admin_at TEXT                             -- cdpandas 最近一次确认他是管理员的时间（不是管理员就 NULL）
);

CREATE TABLE IF NOT EXISTS codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT    NOT NULL,
  purpose    TEXT    NOT NULL,                  -- verify | reset
  expires_at TEXT    NOT NULL,
  sent_at    TEXT    NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  day        TEXT    NOT NULL,                  -- 当天发了几封，防轰炸
  day_count  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vaults (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev        INTEGER NOT NULL DEFAULT 0,        -- 每次成功推送 +1，用来发现「有人先我一步」
  data       TEXT,                              -- 一整份 AppData 的 JSON（信封格式）
  updated_at TEXT,
  device     TEXT,
  -- 这份数据是第几版模型存的。**只升不降**：旧客户端不许把新数据按老格式盖回来
  schema     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start TEXT    NOT NULL
);

-- 反馈（2026-09-21 加）。三端设置里提交，管理员在介绍页看。
-- 注销账号时这个人的反馈一并删掉（不留副本）：外键级联 + delete_user 里再显式删一遍
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT    NOT NULL,                  -- 提交时的邮箱快照（小写）
  platform   TEXT    NOT NULL,                  -- desktop | android | web
  version    TEXT    NOT NULL DEFAULT '',
  device     TEXT    NOT NULL DEFAULT '',
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  done_at    TEXT,                              -- 标成已处理的时间；NULL = 未处理
  done_by    TEXT                               -- 谁标的（管理员邮箱）
);
CREATE INDEX IF NOT EXISTS feedback_user ON feedback(user_id);
CREATE INDEX IF NOT EXISTS feedback_open ON feedback(done_at);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class Database:
    """一个进程一个实例。sqlite3 连接不跨线程，所以每线程各持一条。"""

    def __init__(self, path: str) -> None:
        self.path = path
        self._local = threading.local()
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # :memory: 每条连接是独立的库，测试要共享，用 shared cache 的 URI
        self._uri = path == ":memory:"
        if self._uri:
            self.path = "file:acorn_test?mode=memory&cache=shared"
            # 留一条常驻连接吊着，否则最后一条连接关掉内存库就没了
            self._keepalive = sqlite3.connect(self.path, uri=True, check_same_thread=False)
        self.init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, uri=self._uri, check_same_thread=False, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "conn", None)
        if c is None:
            c = self._connect()
            self._local.conn = c
        return c

    def init_schema(self) -> None:
        self.conn.executescript(SCHEMA)
        # 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(vaults)")}
        if "schema" not in cols:
            self.conn.execute("ALTER TABLE vaults ADD COLUMN schema INTEGER NOT NULL DEFAULT 0")
        ucols = {r["name"] for r in self.conn.execute("PRAGMA table_info(users)")}
        if "cdp_admin" not in ucols:
            self.conn.execute("ALTER TABLE users ADD COLUMN cdp_admin INTEGER NOT NULL DEFAULT 0")
        if "display_name" not in ucols:
            self.conn.execute("ALTER TABLE users ADD COLUMN display_name TEXT")
        if "cdp_admin_at" not in ucols:
            self.conn.execute("ALTER TABLE users ADD COLUMN cdp_admin_at TEXT")
        self.conn.commit()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        conn = self.conn
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    # ---------- 用户 ----------

    def find_user(self, email: str):
        return self.conn.execute(
            "SELECT * FROM users WHERE email = ?", (email.lower(),)
        ).fetchone()

    def get_user(self, user_id: int):
        return self.conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

    def create_user(self, email: str, pw_hash: str) -> int:
        with self.tx() as c:
            cur = c.execute(
                "INSERT INTO users (email, pw_hash, verified, token_epoch, created_at)"
                " VALUES (?, ?, 0, 1, ?)",
                (email.lower(), pw_hash, now_iso()),
            )
            uid = int(cur.lastrowid)
            c.execute("INSERT INTO vaults (user_id, rev, data) VALUES (?, 0, NULL)", (uid,))
        return uid

    def set_password(self, user_id: int, pw_hash: str) -> None:
        """改密码连带把令牌纪元 +1：别处登着的旧令牌立刻作废。"""
        with self.tx() as c:
            c.execute(
                "UPDATE users SET pw_hash = ?, token_epoch = token_epoch + 1 WHERE id = ?",
                (pw_hash, user_id),
            )

    def adopt_account(self, email: str, cdp_admin: bool, display_name: str | None):
        """cdpandas 认过的人：按邮箱（小写）找橡果这一行，没有就建一行（直接 verified=1）。

        新建的行没有橡果自己的密码（pw_hash 留空串，verify_password 永远不过）——
        密码只在 cdpandas 那边。老用户那一行保留：user_id 不变，vault 不迁移，
        已经发出去的橡果令牌（sub=user_id、ep=token_epoch）照样有效。

        老行的橡果旧密码**一律清掉**：cdpandas 认过这个人一次，过渡兜底对他就完成了使命。
        不清的话，之后他在 cdpandas.com 改了密码、或者被 cdpandas 冻结，拿旧密码还能经兜底
        拿到新的橡果令牌（cdpandas 的登录先比密码再查冻结，密码不对只回 401，兜底看不出他被冻结了）。
        没验证过的老行更要清：那个密码是「谁都能填」的。
        代价：回滚到转接前的老服务端后，这些人没法再用密码登录（已发的令牌照样有效）。
        """
        email = email.lower()
        with self.tx() as c:
            stamp = now_iso()
            c.execute(
                "INSERT INTO users"
                " (email, pw_hash, verified, token_epoch, created_at, cdp_admin, display_name, cdp_admin_at)"
                " VALUES (?, '', 1, 1, ?, ?, ?, ?)"
                " ON CONFLICT(email) DO UPDATE SET"
                "   pw_hash = '', verified = 1, cdp_admin = excluded.cdp_admin,"
                "   display_name = excluded.display_name, cdp_admin_at = excluded.cdp_admin_at",
                (email, stamp, 1 if cdp_admin else 0, display_name, stamp if cdp_admin else None),
            )
            row = c.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
            c.execute(
                "INSERT OR IGNORE INTO vaults (user_id, rev, data) VALUES (?, 0, NULL)", (row["id"],)
            )
        return self.get_user(int(row["id"]))

    def retire_local_password(self, user_id: int) -> None:
        """在 cdpandas 重设过密码：橡果旧密码作废（免得过渡兜底让旧密码还能进），
        令牌纪元 +1（别的设备上的旧橡果令牌当场失效，保持「改密码踢下线」）。"""
        with self.tx() as c:
            c.execute(
                "UPDATE users SET pw_hash = '', token_epoch = token_epoch + 1 WHERE id = ?",
                (user_id,),
            )

    def mark_verified(self, user_id: int) -> None:
        with self.tx() as c:
            c.execute("UPDATE users SET verified = 1 WHERE id = ?", (user_id,))

    def touch(self, user_id: int) -> None:
        with self.tx() as c:
            c.execute("UPDATE users SET last_seen = ? WHERE id = ?", (now_iso(), user_id))

    def delete_user(self, user_id: int) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM vaults WHERE user_id = ?", (user_id,))
            # 反馈也跟着走（不留副本）。外键本来就级联，显式再删一遍，不指望 PRAGMA 一定开着
            c.execute("DELETE FROM feedback WHERE user_id = ?", (user_id,))
            c.execute("DELETE FROM users WHERE id = ?", (user_id,))

    # ---------- 反馈 ----------

    def add_feedback(
        self, user_id: int, email: str, platform: str, version: str, device: str, text: str
    ) -> int:
        with self.tx() as c:
            cur = c.execute(
                "INSERT INTO feedback (user_id, email, platform, version, device, text, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (user_id, email.lower(), platform, version, device, text, now_iso()),
            )
            return int(cur.lastrowid)

    def get_feedback(self, fid: int):
        return self.conn.execute("SELECT * FROM feedback WHERE id = ?", (fid,)).fetchone()

    def list_feedback(self, open_only: bool, limit: int, before: int | None = None) -> list:
        """时间倒序（id 自增，跟提交时间同序）。before = 只要 id 比它小的，翻页用。"""
        sql = "SELECT * FROM feedback WHERE 1=1"
        args: list = []
        if open_only:
            sql += " AND done_at IS NULL"
        if before is not None:
            sql += " AND id < ?"
            args.append(before)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        return self.conn.execute(sql, args).fetchall()

    def count_open_feedback(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) AS n FROM feedback WHERE done_at IS NULL").fetchone()
        return int(row["n"])

    def set_feedback_done(self, fid: int, done: bool, by: str) -> bool:
        """标成已处理 / 取消。返回 False = 没这条。"""
        with self.tx() as c:
            if done:
                cur = c.execute(
                    "UPDATE feedback SET done_at = ?, done_by = ? WHERE id = ?",
                    (now_iso(), by.lower(), fid),
                )
            else:
                cur = c.execute(
                    "UPDATE feedback SET done_at = NULL, done_by = NULL WHERE id = ?", (fid,)
                )
            return cur.rowcount > 0

    # ---------- 验证码 ----------

    def get_code(self, email: str):
        return self.conn.execute(
            "SELECT * FROM codes WHERE email = ?", (email.lower(),)
        ).fetchone()

    def put_code(self, email: str, code_hash: str, purpose: str, expires_at: str) -> None:
        email = email.lower()
        day = today_str()
        prev = self.get_code(email)
        day_count = prev["day_count"] + 1 if prev and prev["day"] == day else 1
        with self.tx() as c:
            c.execute(
                "INSERT INTO codes (email, code_hash, purpose, expires_at, sent_at, tries, day, day_count)"
                " VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
                " ON CONFLICT(email) DO UPDATE SET"
                "   code_hash=excluded.code_hash, purpose=excluded.purpose,"
                "   expires_at=excluded.expires_at, sent_at=excluded.sent_at,"
                "   tries=0, day=excluded.day, day_count=excluded.day_count",
                (email, code_hash, purpose, expires_at, now_iso(), day, day_count),
            )

    def bump_code_tries(self, email: str) -> int:
        with self.tx() as c:
            c.execute("UPDATE codes SET tries = tries + 1 WHERE email = ?", (email.lower(),))
        row = self.get_code(email)
        return int(row["tries"]) if row else 0

    def drop_code(self, email: str) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM codes WHERE email = ?", (email.lower(),))

    # ---------- 数据 ----------

    def get_vault(self, user_id: int):
        row = self.conn.execute("SELECT * FROM vaults WHERE user_id = ?", (user_id,)).fetchone()
        if row is None:
            with self.tx() as c:
                c.execute("INSERT INTO vaults (user_id, rev, data) VALUES (?, 0, NULL)", (user_id,))
            row = self.conn.execute(
                "SELECT * FROM vaults WHERE user_id = ?", (user_id,)
            ).fetchone()
        return row

    def put_vault(
        self, user_id: int, base_rev: int, data_json: str, device: str, schema: int
    ) -> int | None:
        """乐观锁：base_rev 必须等于库里当前 rev，否则说明别的设备先推过，返回 None。

        schema 取 max(旧, 新)：一旦有设备用新版模型存过，就再也不会被记成老版本。
        """
        with self.tx() as c:
            cur = c.execute(
                "UPDATE vaults SET rev = rev + 1, data = ?, updated_at = ?, device = ?,"
                " schema = MAX(schema, ?)"
                " WHERE user_id = ? AND rev = ?",
                (data_json, now_iso(), device, schema, user_id, base_rev),
            )
            if cur.rowcount == 0:
                return None
        row = self.get_vault(user_id)
        return int(row["rev"])

    # ---------- 限流 ----------

    def hit(self, key: str, limit: int, window_seconds: int) -> bool:
        """返回 True = 放行。同一个 key 在窗口内超过 limit 次就拒。"""
        now = datetime.now(timezone.utc)
        row = self.conn.execute("SELECT * FROM hits WHERE key = ?", (key,)).fetchone()
        if row is not None:
            started = datetime.fromisoformat(row["window_start"].replace("Z", "+00:00"))
            if (now - started).total_seconds() < window_seconds:
                if row["count"] >= limit:
                    return False
                with self.tx() as c:
                    c.execute("UPDATE hits SET count = count + 1 WHERE key = ?", (key,))
                return True
        with self.tx() as c:
            c.execute(
                "INSERT INTO hits (key, count, window_start) VALUES (?, 1, ?)"
                " ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start",
                (key, now_iso()),
            )
        return True

    def purge_hits(self, older_than_seconds: int = 86400) -> None:
        cutoff = datetime.now(timezone.utc).timestamp() - older_than_seconds
        rows = self.conn.execute("SELECT key, window_start FROM hits").fetchall()
        stale = [
            r["key"]
            for r in rows
            if datetime.fromisoformat(r["window_start"].replace("Z", "+00:00")).timestamp() < cutoff
        ]
        if stale:
            with self.tx() as c:
                c.executemany("DELETE FROM hits WHERE key = ?", [(k,) for k in stale])
