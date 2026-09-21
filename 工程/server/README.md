# 橡果云同步服务

橡果的账号与跨设备同步后端。跑在 `cdpandas-prod`（阿里云 47.85.52.202），地址
`https://acorn.cdpandas.com`。

## 它只做两件事

1. **认人**：账号跟 cdpandas 是**同一套**（2026-09-21 起，以 cdpandas 为准）。登录、注册、验证码、
   找回密码都由这里转给同机的 cdpandas 账号后端（`127.0.0.1:8000/api/auth/*`），它认过这个人，
   橡果再签**自己的**长效令牌（60 天）。见下文「账号转接」。
2. **存一份数据**：每个账号一整份 `AppData`（信封 JSON）+ 一个版本号 `rev`。

**合并逻辑不在这里**，在客户端 `src/core/merge.ts`。服务器只认版本号，永远不解释、
不改动用户数据的内容——这样以后加端（安卓、网页、iOS）只要复用同一份合并代码，
不会出现「服务器一套口径、客户端另一套」的经典 bug。

## 同步怎么走

```
客户端                                服务器
  │ GET /api/sync                       │
  │ ←──── { rev: 7, data: {...} } ──────│
  │                                     │
  │ 本地那份 + 云端那份 → merge.ts       │
  │                                     │
  │ PUT /api/sync { base_rev: 7, data } │
  │ ────────────────────────────────→   │  rev 还是 7？ → 存下，rev=8
  │                                     │  rev 已经是 8？ → 409 + 把第 8 版退回来
  │ ←──── 409 { rev: 8, data } ─────────│
  │ 再 merge 一次，用 base_rev: 8 重推   │  （最多三轮）
```

**为什么是整份传而不是按条增量**：一个人的任务数据也就几百 KB，整份传省掉一整套
增量协议和它的边界 bug。真长到几 MB 再说（`ACORN_MAX_VAULT_BYTES` 兜底，默认 5MB）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 活着没、发信配了没 |
| POST | `/api/auth/register` | 注册 → cdpandas 发验证码。已注册的邮箱回 409 `already_registered`（cdpandas 自己就回 409，装不了） |
| POST | `/api/auth/resend` | 重发验证码（cdpandas 60 秒一次） |
| POST | `/api/auth/verify` | 验证码激活 → 令牌 |
| POST | `/api/auth/login` | 登录 → 令牌 |
| POST | `/api/auth/forgot` | 忘记密码 → 发验证码 |
| POST | `/api/auth/reset` | 验证码 + 新密码 → 令牌（旧令牌全部失效） |
| GET | `/api/me` | 账号与云端数据现状（含 `isAdmin`、`feedbackAdmin`、`displayName`、`account: "cdpandas"`） |
| DELETE | `/api/account` | 注销：只删橡果云端数据与橡果这一行，**cdpandas 账号不动**（回 `cdpandasAccountKept: true`） |
| GET | `/api/sync` | 拉云端那份 |
| PUT | `/api/sync` | 推一份（要报 `base_rev`），冲突回 409 + 最新那版 |
| POST | `/api/feedback` | 提交反馈（橡果令牌）。见下文「反馈」 |
| GET | `/api/feedback` | 看反馈（只给管理员，别人 404） |
| PATCH | `/api/feedback/{id}` | 标成已处理 / 取消（只给管理员，别人 404） |

错误一律是 `{ "error": "机器看的 slug", "message": "人看的中文" }`。

## 账号转接（cdpandas 为准）

代码在 `app/account.py`（只用标准库 urllib）+ `app/main.py`「账号转接」一节。

- **登录**：`{email,password}` → cdpandas `/api/auth/login` → 拿它的令牌问 `/api/auth/me`
  （email / is_admin / is_approved / is_blocked / display_name）→ 按邮箱（小写）找或建橡果那一行
  （verified=1，没有橡果自己的密码）→ 签橡果令牌。**cdpandas 的令牌不落库、不回给客户端、不进日志。**
- **验证 / 重设成功**同上；重设还会让该用户 `token_epoch +1`（别的设备下线）并清掉橡果旧密码。
  这一步在 cdpandas 回 200 后**立刻**做、不等 `/me`：`/me` 失败也照样踢下线，回 503 并说「密码已经改好了」。
- **错误**：密码错 401 `bad_login`、没验证 403 `unverified`、冻结 403 `blocked`（包括验证码对了、
  `/me` 才说冻结的情况）、太频繁 429、发信失败 502 `mail_failed`（cdpandas 回 503 + detail）、
  cdpandas 连不上 / 超时 / 其它 5xx → **503 `account_unavailable`**（绝不报成密码错）。
  同时转接的请求最多 `ACORN_ACCOUNT_CONCURRENCY` 个，排不上当场 503，免得 cdpandas 卡住时拖垮同步接口。
- **旧密码兜底**（`ACORN_LEGACY_LOGIN`，默认开）：cdpandas 说密码不对、但橡果库里这个邮箱的旧密码
  对得上 → 放行，响应带 `legacy: true`。连不上 cdpandas 时不兜底。正式发布后设 `0` 关掉。
  **只对还没经 cdpandas 登录成功过的老行有效**：cdpandas 认过一次（登录 / 验证 / 重设），这一行的旧密码
  就清掉了——否则之后在 cdpandas.com 改了密码或被冻结，旧密码还能经兜底拿新令牌
  （cdpandas 先比密码再查冻结，密码不对只回 401，兜底看不出冻结）。
  回滚提醒：退回转接前的老服务端后，已被认领的人不能再用密码登录（已发令牌照样有效），要走找回密码。
- **真实 IP**：cdpandas 只认 `X-Real-IP`；这里把橡果 nginx 给的 `X-Real-IP` 原样转过去
  （不合法的不转）。橡果自己的按 IP 限流也改成只认 `X-Real-IP`，不再信 `X-Forwarded-For`。
- **管理员**：`ACORN_ADMIN_EMAILS` 里的邮箱，或最近一次登录时 cdpandas 说是管理员（`users.cdp_admin`）。
  反馈后台（能看到所有人的邮箱和原文）更严：`cdp_admin` 只在 `users.cdp_admin_at` 起
  `ACORN_CDP_ADMIN_FRESH_HOURS` 小时内算数（`/api/me` 的 `feedbackAdmin`），过期重新登录即可；
  测试版通道和 `isAdmin` 不受这个时限。
- 老令牌、老 user_id、vault 一律不动，已登录的人不用重新登录。
- 已登录改密码：橡果没有这个接口；要改就走「忘记密码」（cdpandas 也只有这一条）。

| 配置 | 默认 | 说明 |
|---|---|---|
| `ACORN_ACCOUNT_BASE` | `http://127.0.0.1:8000` | cdpandas 账号后端 |
| `ACORN_ACCOUNT_TIMEOUT` | `5` | 秒 |
| `ACORN_LEGACY_LOGIN` | `1` | 旧密码兜底；`0` 关 |
| `ACORN_ACCOUNT_CONCURRENCY` | `8` | 同时转接给 cdpandas 的请求上限 |
| `ACORN_CDP_ADMIN_FRESH_HOURS` | `24` | 反馈后台走橡果令牌时，cdpandas 给的管理员身份认多久 |

## 反馈（2026-09-21）

三端设置里提交，存在橡果库的 `feedback` 表；管理员在介绍页 `acorn.cdpandas.com/intro/`
「网页版」右边的「反馈」按钮里看（介绍页归 10-Platform 管，跟 `/api/` 同一个 server 块，同源）。

- **提交** `POST /api/feedback`，要橡果令牌（没登录 401）。
  请求 `{text, platform, version, device}`：`text` 去首尾空白后 1–2000 字（`empty_feedback` /
  `feedback_too_long`）；`platform` 只认 `desktop | android | web`（`bad_platform`）；`version` ≤ 32、
  `device` ≤ 64（`bad_version` / `bad_device`）。按账号限流，每小时 `ACORN_FEEDBACK_PER_HOUR` 条（429 `too_many`）。
  回 201 `{ok: true, id, message}`。
- **看** `GET /api/feedback?status=open|all&limit=200&before=<id>`：默认只看未处理，时间倒序，
  `limit` 最大 500。回 `{items: [{id, email, platform, version, device, text, createdAt, done, doneAt, doneBy}], open: 未处理总数, next: 下一页的 before 或 null}`。
- **标记** `PATCH /api/feedback/{id}` `{done: true|false}` → 回那一条。
- **谁是管理员**（两种都认）：① 橡果令牌且 `feedbackAdmin`（`ACORN_ADMIN_EMAILS`，或近期确认过的 `cdp_admin`）；
  ② 浏览器带来的 cdpandas 会话 cookie（`sbg_session`，域 `.cdpandas.com`）→ 原样转给 cdpandas
  `/api/auth/me`，`is_admin` 为真、或邮箱在 `ACORN_ADMIN_EMAILS` 里，且已验证、没冻结，才放行。
  结果按 cookie 的 sha256 在内存里缓 60 秒（不落盘、不打印）；cdpandas 连不上时按非管理员处理、不按 cookie 缓存，
  但之后 10 秒内 cookie 这条路整体不再转接（防有人趁 cdpandas 卡住拿乱编的 cookie 堆线程）。
  靠 cookie 的请求若带 `Origin`，必须在 `ACORN_SITE_ORIGINS` 里（防别的 `*.cdpandas.com` 子站借同站 cookie 改状态）。
- **不是管理员一律 404**，而且是框架默认那个 `{"detail": "Not Found"}`，跟不存在的路径一字不差。
- **`text` / `version` / `device` / `email` 都是用户随便填的原文**，服务端只剥控制字符、不转义。
  介绍页和网页版同源（网页版的橡果令牌就在同一个源的 localStorage 里），渲染时**只能用 `textContent`
  或框架默认转义**，绝不能 `innerHTML` 拼接，否则就是存储型 XSS。
- **注销账号**时这个人的反馈一起删（外键级联 + `delete_user` 显式删）。
- CORS 不动 `allow_credentials`（仍是 False）：介绍页同源不经 CORS；只给 `allow_methods` 加了 PATCH，
  桌面 / 安卓的管理员从 webview 带 Bearer 跨源标记时预检要用。

| 配置 | 默认 | 说明 |
|---|---|---|
| `ACORN_CDP_COOKIE` | `sbg_session` | cdpandas 会话 cookie 名（10 的 `COOKIE_NAME`） |
| `ACORN_SITE_ORIGINS` | `https://acorn.cdpandas.com` | 靠 cookie 认管理员时允许的 Origin，逗号隔开 |
| `ACORN_FEEDBACK_PER_HOUR` | `20` | 每个账号每小时最多几条 |

## 安全上的取舍

- **口令**用标准库 `hashlib.scrypt`（内存硬，比 bcrypt 更抗显卡爆破），格式
  `scrypt$n$r$p$salt$hash`。
- **验证码**（2026-09-21 起由 cdpandas 发、由 cdpandas 存）：错 5 次锁定，一次性。橡果的 `codes` 表与
  `mailer.py` 暂留不用，回滚时还用得上。
- **令牌**是自签 JWT（HS256），载荷带 `ep`（token epoch）。改密码时把用户的 epoch +1，
  所有旧令牌当场失效——不用维护黑名单。
- **不当账号探测器**：给不存在的邮箱找回密码，接口回的话一模一样。注册已存在的邮箱现在回 409——
  cdpandas 自己的注册接口就这么回，橡果这边装不装都挡不住探测。
- **限流**在两层：nginx 按 IP，应用按邮箱 + IP（见 `main.py` 里的 `limit(...)`）。
- **令牌不进 data.json**：客户端存在单独的 `auth.json`，永远不参与同步、不参与导出。

## 本地跑

```bash
cd server
python -m uvicorn app.main:app --reload --port 8787
```

没配 `SMTP_*` 时**不真发信**，验证码直接打进日志——本地自测就靠这个。
客户端指过来：`VITE_ACORN_API=http://127.0.0.1:8787 npm run vite:dev`。

## 测试

```bash
python tests/test_api.py          # 74 条，不装 pytest 也能跑；装了也能 python -m pytest tests
# cdpandas 由 tests/fake_cdpandas.py 顶替（真 HTTP、本机随机端口），不用连真的
```

端到端（两个浏览器当两台设备，走注册→验证码→登录→双向合并→冲突→删除同步）的脚本
在会话 scratchpad 里，不入库——它依赖本机的 Playwright。

## 部署

```bash
bash deploy/deploy.sh             # 全量：建用户/venv/凭据/systemd/nginx/证书
bash deploy/deploy.sh --code      # 日常：只推代码 + 重启
```

只新增自己的东西，**不改这台机器上任何已有站点的配置**：

| 路径 | 是什么 |
|---|---|
| `/var/www/acorn-sync` | 代码 + venv |
| `/var/lib/acorn-sync/acorn.db` | 数据库（只有 `acorn` 用户能写） |
| `/etc/acorn-sync/env` | 凭据（chmod 600，属主 root） |
| `/etc/systemd/system/acorn-sync.service` | 服务 |
| `/etc/nginx/conf.d/acorn.conf` | 新增的 server 块 |

DNS 不用配：`*.cdpandas.com` 已有通配符 A 记录指到本机。证书由 certbot 单独签。

**凭据从不经过屏幕**：JWT 密钥在服务器上 `openssl rand` 现生成（生成一次，重生成会
把所有人登出）；SMTP 口令从资产中枢 `api_keys.env` 直接管道进 ssh 写入 env 文件。

## 搬家

服务自带数据库、零编译依赖，搬到腾讯云或别处就是三步：

1. `rsync /var/lib/acorn-sync/` 过去（停服务再拷，或先 `sqlite3 acorn.db ".backup"`）
2. 在新机器上跑一遍 `deploy.sh`（把 `ACORN_DEPLOY_HOST` 指过去）
3. 把 `/etc/acorn-sync/env` 里的 `ACORN_JWT_SECRET` **原样搬过去**，否则所有人被登出
