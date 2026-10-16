import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";

const require = createRequire(new URL("../package.json", import.meta.url));
const { JSDOM, VirtualConsole } = require("jsdom");
const html = readFileSync(new URL("../../网站/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../../网站/assets/acorn-download.js", import.meta.url), "utf8");
const bytes = Buffer.from("Synthetic Acorn Ultra installer bytes. Not an executable.");
const digest = createHash("sha256").update(bytes).digest("hex");
const expiry = () => new Date(Date.now() + 3600000).toISOString();
const ready = () => ({ email: "demo@example.test", enabled: false, serverNow: new Date().toISOString(), requestId: null, requestDay: null, expiresAt: null, canRequest: true, nextRequestAt: expiry(), consecutiveFailures: 0, lockedUntil: null, verified: false, downloaded: false, download: null });
const requested = () => ({ ...ready(), canRequest: false, requestId: "demo-request", expiresAt: expiry() });
const manifest = () => ({ available: true, edition: "ultra", version: "1.16.1", schema: 8, url: "/api/ultra/download/demo-ticket", size: bytes.length, sha256: digest, fileName: "Acorn-Ultra-demo.exe", downloadId: "demo-download", requiresAuth: true });
const verified = () => ({ ...requested(), verified: true, download: manifest() });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const rejection = (slug, status, extra = {}) => json({ detail: { error: slug, ...extra } }, status);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  assert.ok(predicate(), "等待界面状态超时");
}
function button(w, text) { return Array.from(w.document.querySelectorAll("button")).find((node) => node.textContent === text); }

async function fixture(t, options = {}) {
  const dom = new JSDOM(html, { url: "https://acorn.cdpandas.com/intro/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  t.after(() => w.close());
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
  Object.defineProperty(w, "crypto", { value: webcrypto });
  w.Blob = Blob;
  const calls = [], events = [], blobs = [];
  w.URL.createObjectURL = (blob) => { blobs.push(blob); events.push("blob"); return "blob:synthetic-download"; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { if (this.download) events.push("save"); };
  let state = options.state || ready();
  w.localStorage.setItem("acorn-auth", JSON.stringify({ token: "DO_NOT_USE_BEARER" }));
  w.fetch = async (path, init = {}) => {
    const url = new URL(path, w.location.href);
    calls.push({ path: url.pathname, init });
    if (url.pathname === "/api/desktop/latest" || url.pathname === "/api/android/latest") return json({ version: "1.16.0", size: 7299065 });
    if (options.fetch) {
      const answer = await options.fetch(url.pathname, init, { state, setState: (next) => { state = next; }, events });
      if (answer) return answer;
    }
    if (url.pathname === "/api/ultra/status") return json(state);
    if (url.pathname === "/api/ultra/request") { state = requested(); return json(state, 202); }
    if (url.pathname === "/api/ultra/verify") {
      state = verified();
      return json({ ok: true, requestId: state.requestId, expiresAt: state.expiresAt, download: state.download });
    }
    if (url.pathname === "/api/ultra/download/demo-ticket") { events.push("receive"); return new Response(bytes); }
    if (url.pathname === "/api/ultra/download/demo-download/complete") { events.push("complete"); state = { ...state, downloaded: true }; return json({ ok: true, enabled: true, downloaded: true, consecutiveFailures: 0 }); }
    throw new Error("Unexpected mock endpoint: " + url.pathname);
  };
  w.eval(script); await tick();
  const open = () => w.document.querySelector("[data-download-open]").click();
  async function ultra() { open(); button(w, "获取 Ultra").click(); await tick(); await tick(); }
  return { w, calls, events, blobs, open, ultra, state: () => state };
}

test("普通下载继续公开，三个本地选项，Ultra点击前不探测身份或发信", async (t) => {
  const f = await fixture(t); f.open();
  assert.equal(f.w.document.querySelectorAll(".acdl-choice").length, 3);
  assert.equal(f.w.document.querySelector('.acdl-choice.ultra .acdl-choice-meta').textContent, "个人测试版 · 支持任务附图");
  assert.match(f.w.document.querySelector('[aria-label="下载Windows普通版"]').href, /Acorn-latest-x64-setup\.exe$/);
  assert.match(f.w.document.querySelector('[aria-label="下载安卓普通版"]').href, /Acorn-latest-arm64\.apk$/);
  assert.equal(f.calls.filter((c) => c.path.startsWith("/api/ultra/")).length, 0);
  assert.ok(!html.includes('src="/utilities/_shared/tool-download.js"'));
});

test("未登录走cdpandas回跳链接，Cookie请求不偷用橡果Bearer", async (t) => {
  const f = await fixture(t, { fetch: (path) => path === "/api/ultra/status" ? rejection("no_token", 401) : null });
  await f.ultra();
  const link = f.w.document.querySelector('.acdl-body a');
  const url = new URL(link.href);
  assert.equal(url.origin, "https://cdpandas.com");
  assert.equal(url.pathname, "/login");
  assert.equal(url.searchParams.get("redirect"), "https://acorn.cdpandas.com/intro/#download-ultra");
  const call = f.calls.find((c) => c.path === "/api/ultra/status");
  assert.equal(call.init.credentials, "same-origin");
  assert.equal(call.init.headers.Authorization, undefined);
});

test("明确点击申请才发起一次，按钮等待时不会重复申请", async (t) => {
  const f = await fixture(t); await f.ultra();
  assert.equal(f.calls.filter((c) => c.path.endsWith("/request")).length, 0);
  const apply = button(f.w, "申请今日验证码"); apply.click(); apply.click();
  await waitFor(() => f.w.document.querySelector("#acdl-code"));
  assert.equal(f.calls.filter((c) => c.path.endsWith("/request")).length, 1);
  assert.match(f.w.document.querySelector(".acdl-status").textContent, /只发送给管理员.*北京时间/);
});

test("错误验证码三次仍可重试，不显示七天锁定或重新申请", async (t) => {
  const f = await fixture(t, { state: requested(), fetch: (path) => path === "/api/ultra/verify" ? rejection("bad_code", 400) : null });
  await f.ultra();
  for (let i = 0; i < 3; i++) {
    const input = f.w.document.querySelector("#acdl-code"); input.value = "000000"; input.dispatchEvent(new f.w.Event("input"));
    f.w.document.querySelector(".acdl-body form").dispatchEvent(new f.w.Event("submit", { cancelable: true }));
    await waitFor(() => f.w.document.querySelector('[role="alert"]'));
  }
  assert.equal(f.calls.filter((c) => c.path.endsWith("/verify")).length, 3);
  assert.ok(f.w.document.querySelector("#acdl-code"));
  assert.equal(button(f.w, "申请今日验证码"), undefined);
  assert.match(f.w.document.querySelector('[role="alert"]').textContent, /输错不会按三次申请失败计算/);
});

test("已获授权仍显示今日申请，不绕过按天验证", async (t) => {
  const f = await fixture(t, { state: { ...ready(), enabled: true } }); await f.ultra();
  assert.ok(button(f.w, "申请今日验证码"));
  assert.equal(button(f.w, "下载安装包"), undefined);
  assert.match(f.w.document.querySelector(".acdl-body").textContent, /此前已获授权/);
});

test("锁定显示北京时间结束时刻，不可申请或输入验证码", async (t) => {
  const state = { ...ready(), canRequest: false, lockedUntil: "2099-01-02T16:00:00Z", consecutiveFailures: 3 };
  const f = await fixture(t, { state }); await f.ultra();
  assert.match(f.w.document.querySelector(".acdl-status").textContent, /1月3日.*00:00.*北京时间/);
  assert.equal(button(f.w, "申请今日验证码"), undefined);
  assert.equal(f.w.document.querySelector("#acdl-code"), null);
});

test("当天已验证可直接下载，完整收取和SHA256后才Blob与complete", async (t) => {
  const f = await fixture(t, { state: verified() }); await f.ultra();
  button(f.w, "下载安装包").click();
  await waitFor(() => f.events.includes("complete"));
  assert.deepEqual(f.events, ["receive", "blob", "save", "complete"]);
  assert.equal(f.calls.filter((c) => /\/(request|verify)$/.test(c.path)).length, 0);
  const complete = f.calls.find((c) => c.path.endsWith("/complete"));
  assert.deepEqual(JSON.parse(complete.init.body), { sha256: digest });
  assert.equal(f.blobs[0].size, bytes.length);
});

test("当天已完成仍可重下，不能因enabled长期免申请", async (t) => {
  const f = await fixture(t, { state: { ...verified(), enabled: true, downloaded: true } }); await f.ultra();
  assert.match(f.w.document.querySelector(".acdl-status").textContent, /今天已完成下载.*午夜前可再次下载/);
  assert.ok(button(f.w, "下载安装包"));
});

test("SHA256不匹配不保存文件，也不报complete成功", async (t) => {
  const state = verified(); state.download.sha256 = "0".repeat(64);
  const f = await fixture(t, { state }); await f.ultra(); button(f.w, "下载安装包").click();
  await waitFor(() => f.w.document.querySelector('[role="alert"]'));
  assert.equal(f.blobs.length, 0); assert.ok(!f.events.includes("complete"));
  assert.match(f.w.document.querySelector('[role="alert"]').textContent, /校验不一致/);
});

test("文件少字节时不保存，不确认完整下载", async (t) => {
  const state = verified(); state.download.size += 5;
  const f = await fixture(t, { state }); await f.ultra(); button(f.w, "下载安装包").click();
  await waitFor(() => f.w.document.querySelector('[role="alert"]'));
  assert.equal(f.blobs.length, 0); assert.ok(!f.events.includes("complete"));
});

test("私有安装包地址必须本站Ultra路径，拒绝跨源清单", async (t) => {
  const state = verified(); state.download.url = "https://other.example.test/installer.exe";
  const f = await fixture(t, { state }); await f.ultra(); button(f.w, "下载安装包").click();
  await waitFor(() => f.w.document.querySelector('[role="alert"]'));
  assert.equal(f.calls.filter((c) => c.path === "/installer.exe").length, 0);
  assert.equal(f.blobs.length, 0);
});

test("完成确认暂失败可幂等重试，不重新申请或重复取文件", async (t) => {
  let completes = 0;
  const f = await fixture(t, { state: verified(), fetch: (path) => {
    if (path.endsWith("/complete") && ++completes === 1) return rejection("download_incomplete", 409);
    return null;
  } });
  await f.ultra(); button(f.w, "下载安装包").click();
  await waitFor(() => button(f.w, "重试下载完成确认")); button(f.w, "重试下载完成确认").click();
  await waitFor(() => f.w.document.querySelector(".acdl-success"));
  assert.equal(completes, 2);
  assert.equal(f.calls.filter((c) => c.path === "/api/ultra/download/demo-ticket").length, 1);
  assert.equal(f.blobs.length, 1);
});

test("收起后重开从服务器恢复今日请求，不发失败回执", async (t) => {
  const f = await fixture(t); await f.ultra(); button(f.w, "申请今日验证码").click();
  await waitFor(() => f.w.document.querySelector("#acdl-code"));
  f.w.document.querySelector(".acdl-close").click(); await f.ultra();
  assert.ok(f.w.document.querySelector("#acdl-code"));
  assert.equal(f.calls.filter((c) => c.path.endsWith("/request")).length, 1);
  assert.ok(!f.calls.some((c) => /fail|cancel/.test(c.path)));
});

test("离线可重试状态，普通下载仍可用", async (t) => {
  let online = false;
  const f = await fixture(t, { fetch: (path) => {
    if (path === "/api/ultra/status" && !online) throw new TypeError("offline");
    return null;
  } });
  await f.ultra(); assert.match(f.w.document.querySelector('[role="alert"]').textContent, /检查网络后重试/);
  online = true; button(f.w, "刷新申请状态").click();
  await waitFor(() => button(f.w, "申请今日验证码"));
});

test("午夜过期后重新读取服务端状态，不复用昨天的下载票据", async (t) => {
  let midnight = false;
  const f = await fixture(t, { state: verified(), fetch: (path) => path === "/api/ultra/status" && midnight ? json(ready()) : null });
  await f.ultra(); assert.ok(button(f.w, "下载安装包"));
  midnight = true; f.w.document.dispatchEvent(new f.w.Event("visibilitychange"));
  await waitFor(() => button(f.w, "申请今日验证码"));
  assert.equal(button(f.w, "下载安装包"), undefined);
});

test("Esc收起并恢复触发按钮焦点，状态字段只作文本", async (t) => {
  const f = await fixture(t, { state: { ...ready(), email: '<img src=x onerror="alert(1)">' } });
  f.w.document.querySelector("[data-download-open]").focus(); await f.ultra();
  assert.equal(f.w.document.querySelector(".acdl-account img"), null);
  const dlg = f.w.document.querySelector(".acdl-dialog");
  dlg.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(dlg.open, false);
  assert.equal(f.w.document.activeElement, f.w.document.querySelector("[data-download-open]"));
});
