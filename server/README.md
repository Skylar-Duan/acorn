# 橡果云同步服务

橡果的账号与跨设备同步后端。跑在 `cdpandas-prod`（阿里云 47.85.52.202），地址
`https://acorn.cdpandas.com`。

## 它只做两件事

1. **认人**：邮箱 + 密码注册 → 邮件验证码激活 → 登录换一枚长效令牌（60 天）。
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
| POST | `/api/auth/register` | 注册 → 发验证码。已注册的邮箱回同样的话，但发的是「直接登录」提示信 |
| POST | `/api/auth/resend` | 重发验证码（60 秒一次，一天 10 封） |
| POST | `/api/auth/verify` | 验证码激活 → 令牌 |
| POST | `/api/auth/login` | 登录 → 令牌 |
| POST | `/api/auth/forgot` | 忘记密码 → 发验证码 |
| POST | `/api/auth/reset` | 验证码 + 新密码 → 令牌（旧令牌全部失效） |
| GET | `/api/me` | 账号与云端数据现状 |
| DELETE | `/api/account` | 注销：账号与数据一起删干净 |
| GET | `/api/sync` | 拉云端那份 |
| PUT | `/api/sync` | 推一份（要报 `base_rev`），冲突回 409 + 最新那版 |

错误一律是 `{ "error": "机器看的 slug", "message": "人看的中文" }`。

## 安全上的取舍

- **口令**用标准库 `hashlib.scrypt`（内存硬，比 bcrypt 更抗显卡爆破），格式
  `scrypt$n$r$p$salt$hash`。
- **验证码不明文入库**，存 `sha256(email:code)`；错 5 次当场作废；一次性。
- **令牌**是自签 JWT（HS256），载荷带 `ep`（token epoch）。改密码时把用户的 epoch +1，
  所有旧令牌当场失效——不用维护黑名单。
- **不当账号探测器**：注册已存在的邮箱、给不存在的邮箱找回密码，接口回的话都一模一样，
  真相只送进邮箱（只有本人看得到）。
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
python tests/test_api.py          # 22 条，不装 pytest 也能跑
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
