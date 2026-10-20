import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(new URL("../package.json", import.meta.url));
const { JSDOM, VirtualConsole } = require("jsdom");
const script = readFileSync(new URL("../../网站/assets/feedback-admin.js", import.meta.url), "utf8");
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const account = (id, source = "verified_code") => ({ id, email: `demo${id}@example.test`, displayName: `演示账号 ${id}`, verified: true, createdAt: "2026-10-01T00:00:00Z", lastSeen: "2026-10-16T07:00:00Z", ultra: { enabled: !!source, source, enabledAt: source === "verified_code" ? "2026-10-16T08:00:00Z" : null, downloadedAt: null } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), "界面没有到达预期状态"); }
const button = (w, text) => Array.from(w.document.querySelectorAll("button")).find((el) => el.textContent === text);

async function fixture(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><span data-feedback-mount hidden></span></body></html>', { url: "https://acorn.cdpandas.com/intro/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window, calls = [];
  t.after(() => w.close());
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
  if (options.token !== false) w.localStorage.setItem("acorn-auth", JSON.stringify({ token: "synthetic-admin-token" }));
  w.fetch = async (path, init = {}) => {
    calls.push({ path, init });
    if (options.fetch) { const response = await options.fetch(path, init); if (response) return response; }
    if (path.startsWith("/api/feedback?")) return json({ items: options.feedback || [], open: options.open || 0, next: null });
    if (path.startsWith("/api/admin/ultra/accounts?")) return json({ items: options.items || [account(2), account(1, "default")], next: null });
    if (/\/api\/admin\/ultra\/accounts\/\d+$/.test(path)) return json({ ...account(Number(path.split("/").pop())), ultra: { ...account(2).ultra, consecutiveFailures: 2, lockedUntil: "2026-10-23T16:00:00Z", lastRequestAt: "2026-10-16T06:00:00Z", lastVerifiedAt: "2026-10-16T08:00:00Z", lastCompletedAt: null } });
    throw new Error("非预期接口 " + path);
  };
  w.eval(script); await tick(); await tick();
  async function openUltra() { w.document.querySelector(".fbk-btn").click(); button(w, "Plus 授权").click(); await waitFor(() => !w.document.querySelector(".fbk-msg")); }
  return { w, calls, openUltra };
}

test("非管理员门禁不出入口，不提前探测授权账号", async (t) => {
  const f = await fixture(t, { fetch: () => json({}, 404) });
  await tick();
  assert.equal(f.w.document.querySelector(".fbk-btn"), null);
  assert.equal(f.w.document.querySelector("dialog"), null);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.path.startsWith("/api/feedback?")));
});

test("Plus只读页保留原门禁与兼容API，失效Bearer后复用CDP Cookie", async (t) => {
  const f = await fixture(t, { fetch: (path, init) => path.includes("/api/feedback?") && init.headers.Authorization ? json({}, 401) : null });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => !c.path.startsWith("/api/admin/ultra/")));
  await f.openUltra();
  assert.match(f.w.document.querySelector("dialog").textContent, /Plus 授权/);
  assert.doesNotMatch(f.w.document.querySelector("dialog").textContent, /Ultra/);
  const calls = f.calls.filter((c) => c.path.startsWith("/api/admin/ultra/"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/admin/ultra/accounts?status=enabled&limit=50");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.method, "GET");
});

test("默认资格不伪造授权时间，验证码授权与完整下载分别显示北京时间", async (t) => {
  const verified = account(2); verified.ultra.downloadedAt = "2026-10-16T08:05:00Z";
  const f = await fixture(t, { items: [verified, account(1, "default")] }); await f.openUltra();
  const cards = f.w.document.querySelectorAll(".fbk-account");
  assert.match(cards[0].textContent, /验证码验证.*2026\/10\/16 16:00:00.*2026\/10\/16 16:05:00/);
  assert.match(cards[1].textContent, /管理员默认资格.*默认资格，无验证码验证时间.*尚无完整下载记录/);
  assert.equal(f.w.document.querySelectorAll(".fbk-account .btn").length, 2);
  assert.ok(!f.w.document.querySelector("input"));
});

test("已授权与全部筛选切换，旧响应不能覆盖新筛选", async (t) => {
  let release;
  const f = await fixture(t, { fetch: (path) => path.includes("/api/admin/ultra/accounts?status=enabled") ? new Promise((resolve) => { release = resolve; }) : path.includes("/api/admin/ultra/accounts?status=all") ? json({ items: [account(9, null)], next: null }) : null });
  f.w.document.querySelector(".fbk-btn").click(); button(f.w, "Plus 授权").click();
  await waitFor(() => release); button(f.w, "全部账号").click();
  await waitFor(() => f.w.document.querySelector(".fbk-account"));
  release(json({ items: [account(1)], next: null })); await tick(); await tick();
  assert.match(f.w.document.querySelector(".fbk-account").textContent, /demo9@example.test.*未授权/);
  assert.equal(f.w.document.querySelector('[aria-pressed="true"].fbk-tab').textContent, "全部账号");
});

test("分页before排他，暂时失败保留已读内容并可重试", async (t) => {
  let fail = true;
  const f = await fixture(t, { fetch: (path) => path.includes("/api/admin/ultra/accounts?") ? path.includes("before=5") ? (fail ? Promise.reject(new Error("offline")) : json({ items: [account(4)], next: null })) : json({ items: [account(5)], next: 5 }) : null });
  await f.openUltra(); button(f.w, "再看更早的账号").click();
  await waitFor(() => button(f.w, "没读到，再点一次"));
  assert.match(f.w.document.querySelector(".fbk-account").textContent, /demo5/);
  fail = false; button(f.w, "没读到，再点一次").click();
  await waitFor(() => f.w.document.querySelectorAll(".fbk-account").length === 2);
  assert.equal(button(f.w, "再看更早的账号"), undefined);
  assert.equal(f.calls.filter((c) => c.path.endsWith("&before=5")).length, 2);
});

test("详情展示失败次数锁定与各事件，返回保留筛选且Ultra只读", async (t) => {
  const f = await fixture(t); await f.openUltra(); button(f.w, "全部账号").click(); await tick();
  button(f.w, "查看详情").click(); await waitFor(() => button(f.w, "返回账号列表"));
  assert.match(f.w.document.querySelector(".fbk-account").textContent, /连续到期未完成2 次.*2026\/10\/24 00:00:00/);
  assert.equal(f.w.document.querySelector(".fbk-tabs").hidden, true);
  assert.equal(f.w.document.activeElement.textContent, "返回账号列表");
  button(f.w, "返回账号列表").click(); await tick();
  assert.equal(f.w.document.querySelector('[aria-pressed="true"].fbk-tab').textContent, "全部账号");
  assert.ok(f.calls.filter((c) => c.path.startsWith("/api/admin/ultra/")).every((c) => c.init.method === "GET" && c.init.body === undefined));
});

test("账号切换不使用旧Bearer请求；详情被拒后清除旧记录", async (t) => {
  const f = await fixture(t); await f.openUltra();
  const count = f.calls.length;
  f.w.localStorage.setItem("acorn-auth", JSON.stringify({ token: "other-account-token" }));
  button(f.w, "查看详情").click(); await waitFor(() => f.w.document.querySelector(".fbk-msg")); await tick();
  assert.equal(f.calls.length, count);
  assert.equal(f.w.document.querySelector(".fbk-account"), null);
  assert.match(f.w.document.querySelector(".fbk-msg").textContent, /管理员登录已失效/);
  assert.ok(button(f.w, "返回账号列表"));
});

test("关闭后到达的详情不恢复内容，恶意账号字段只当文本", async (t) => {
  let release;
  const malicious = account(2); malicious.displayName = '<img src=x onerror="alert(1)">';
  const f = await fixture(t, { items: [malicious], fetch: (path) => /accounts\/2$/.test(path) ? new Promise((resolve) => { release = resolve; }) : null }); await f.openUltra();
  assert.equal(f.w.document.querySelector("img"), null);
  assert.match(f.w.document.querySelector(".fbk-account-name").textContent, /<img/);
  button(f.w, "查看详情").click(); await waitFor(() => release);
  f.w.document.querySelector("dialog").close(); release(json(account(2))); await tick(); await tick();
  assert.equal(f.w.document.querySelector(".fbk-account"), null);
  assert.equal(f.w.document.querySelector(".fbk-body").textContent, "");
});

test("空列表与读取失败有可操作重试", async (t) => {
  let fail = true;
  const f = await fixture(t, { fetch: (path) => path.startsWith("/api/admin/ultra/") ? (fail ? Promise.reject(new Error("offline")) : json({ items: [], next: null })) : null });
  f.w.document.querySelector(".fbk-btn").click(); button(f.w, "Plus 授权").click();
  await waitFor(() => button(f.w, "重试")); fail = false; button(f.w, "重试").click();
  await waitFor(() => f.w.document.querySelector(".fbk-empty"));
  assert.equal(f.w.document.querySelector(".fbk-empty").textContent, "暂无已授权账号");
  button(f.w, "全部账号").click(); await tick();
  assert.equal(f.w.document.querySelector(".fbk-empty").textContent, "暂无账号");
});

test("原反馈标记已处理及角标继续工作", async (t) => {
  const f = await fixture(t, { open: 1, feedback: [{ id: 7, text: "演示反馈", email: "demo@example.test", done: false }], fetch: (path, init) => path === "/api/feedback/7" && init.method === "PATCH" ? json({ done: true, doneBy: "管理员", doneAt: "2026-10-16T08:00:00Z" }) : null });
  f.w.document.querySelector(".fbk-btn").click(); await waitFor(() => button(f.w, "标记已处理"));
  button(f.w, "标记已处理").click(); await tick(); await tick();
  assert.equal(f.w.document.querySelector(".fbk-badge").hidden, true);
  assert.match(f.w.document.querySelector(".fbk-state").textContent, /已处理/);
  assert.equal(f.calls.filter((c) => c.init.method === "PATCH").length, 1);
});
