import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(new URL("../package.json", import.meta.url));
const { JSDOM, VirtualConsole } = require("jsdom");
const html = readFileSync(new URL("../../网站/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../../网站/assets/acorn-download.js", import.meta.url), "utf8");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const latest = (path) => path.includes("desktop") ? { version: "1.17.0", size: 8 * 1048576 } : { version: "1.15.0", size: 13 * 1048576 };
async function waitFor(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await tick(); }
  assert.ok(predicate(), "等待下载界面状态超时");
}
async function fixture(t, options = {}) {
  const dom = new JSDOM(options.html || html, { url: options.url || "https://acorn.cdpandas.com/intro/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window, calls = [], clicks = [];
  t.after(() => w.close());
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
  w.HTMLAnchorElement.prototype.click = function () { clicks.push(this.href); };
  if (options.prepare) options.prepare(w);
  w.fetch = async (value, init = {}) => {
    const url = new URL(value, w.location.href); calls.push({ url, path: url.pathname, init });
    if (options.fetch) return options.fetch(url.pathname, init, url);
    assert.ok(["/api/desktop/latest", "/api/android/latest"].includes(url.pathname), "只能请求公开版本接口");
    return json(latest(url.pathname));
  };
  w.eval(script); await tick();
  const open = () => w.document.querySelector("[data-download-open]").click();
  const dialog = () => w.document.querySelector(".acdl-dialog");
  const row = (platform) => w.document.querySelector(`[data-platform="${platform}"]`);
  const retry = () => w.document.querySelector(".acdl-retry");
  const settle = () => waitFor(() => !retry()?.disabled);
  return { w, calls, clicks, open, dialog, row, retry, settle };
}

test("Windows唯一可下载，安卓及网页版开发中不可跳转", async (t) => {
  const f = await fixture(t); f.open(); await f.settle();
  assert.equal(f.w.document.querySelectorAll(".acdl-choice").length, 2);
  assert.deepEqual(Array.from(f.w.document.querySelectorAll(".acdl-choice-title"), (n) => n.textContent), ["Windows", "安卓"]);
  assert.match(f.row("windows").textContent, /同一安装包，Plus账号登录后自动启用附图功能/);
  assert.doesNotMatch(f.dialog().textContent, /Ultra|验证码|普通版|第二版本/);
  assert.equal(f.row("windows").querySelector("a").href, "https://acorn.cdpandas.com/download/windows/Acorn-latest-x64-setup.exe");
  assert.equal(f.row("android").querySelector("a"), null);
  assert.equal(f.row("android").querySelector("button").disabled, true);
  assert.equal(f.row("android").querySelector("button").getAttribute("aria-disabled"), "true");
  const web = f.w.document.querySelector(".acorn-coming");
  assert.equal(web.disabled, true); assert.equal(web.getAttribute("aria-disabled"), "true"); assert.equal(web.hasAttribute("href"), false);
});

test("未登录可直接下载，不读登录存储、不探测身份或调用旧私有接口", async (t) => {
  const f = await fixture(t, { prepare(w) { w.Storage.prototype.getItem = () => { throw new Error("禁止读取登录存储"); }; } });
  assert.equal(f.calls.length, 0);
  f.open(); await f.settle(); f.row("windows").querySelector("a").click();
  assert.equal(f.clicks.length, 1);
  assert.ok(f.calls.every((c) => c.init.credentials === "omit" && c.init.body === undefined && !c.init.headers?.Authorization && !c.path.includes("ultra")));
});

test("只读取Windows真实版本与大小，不请求或显示旧安卓下载元数据", async (t) => {
  const f = await fixture(t); f.open(); await f.settle();
  assert.equal(f.row("windows").querySelector(".acdl-choice-meta").textContent, "v1.17.0 · 8.0 MB");
  assert.equal(f.row("android").querySelector(".acdl-choice-meta").textContent, "正在开发中");
  assert.ok(f.calls.every((call) => call.path === "/api/desktop/latest"));
  assert.ok(f.retry().hidden);
});

test("接口中的跨源、脚本、旧Ultra下载URL都不能改变固定公共下载目标", async (t) => {
  for (const target of ["https://other.example.test/steal.exe", "javascript:alert(1)", "/api/ultra/download/old-ticket"]) {
    const f = await fixture(t, { fetch: (path) => json({ ...latest(path), url: target }) }); f.open(); await f.settle();
    assert.match(f.row("windows").querySelector("a").href, /^https:\/\/acorn\.cdpandas\.com\/download\/windows\/Acorn-latest-x64-setup\.exe$/);
    assert.ok(f.calls.every((c) => c.url.origin === "https://acorn.cdpandas.com"));
  }
});

test("模板旧缓存或恶意href/api不转成其他源或私有下载请求", async (t) => {
  const f = await fixture(t, { prepare(w) {
    const item = w.document.querySelector('[data-label="Windows"]'); item.dataset.href = "javascript:alert(1)"; item.dataset.api = "https://other.example.test/account";
  } }); f.open(); await f.settle();
  assert.equal(f.row("windows").querySelector("a").href, "https://acorn.cdpandas.com/download/windows/Acorn-latest-x64-setup.exe");
  assert.ok(f.calls.every((c) => c.url.origin === "https://acorn.cdpandas.com" && /\/api\/(desktop|android)\/latest$/.test(c.path)));
});

test("离线保留页面版本兜底与可用固定链接，能重试版本读取", async (t) => {
  let online = false;
  const f = await fixture(t, { fetch: (path) => online ? json(latest(path)) : Promise.reject(new Error("offline")) });
  const fallback = f.w.document.querySelector('[data-label="Windows"]').dataset.version;
  f.open(); await f.settle();
  assert.match(f.row("windows").querySelector(".acdl-choice-meta").textContent, new RegExp("^v" + fallback.replaceAll(".", "\\.")));
  assert.match(f.dialog().querySelector('[role="status"]').textContent, /下载入口仍可使用/);
  assert.ok(!f.retry().hidden); online = true; f.retry().click(); await f.settle();
  assert.ok(f.retry().hidden);
});

test("HTTP失败与非JSON响应保留Windows下载且不解开安卓入口", async (t) => {
  for (const response of [() => json({}, 503), () => new Response("not-json")]) {
    const f = await fixture(t, { fetch: response }); f.open(); await f.settle();
    assert.equal(f.w.document.querySelectorAll(".acdl-choice a[href]").length, 1);
    assert.equal(f.row("android").querySelector("button").disabled, true);
    assert.ok(!f.retry().hidden);
  }
});

test("非法大小或版本仅回落，不渲染HTML或异常数字", async (t) => {
  for (const data of [{ version: '<img src=x onerror="alert(1)">', size: 20 }, { version: "1.17.0", size: -1 }, { version: "1.17.0", size: 2.5 }, { version: "9".repeat(60)+".0.0", size: 100 }]) {
    const f = await fixture(t, { fetch: () => json(data) }); f.open(); await f.settle();
    assert.equal(f.dialog().querySelector("img"), null);
    assert.doesNotMatch(f.dialog().textContent, /NaN|Infinity|onerror|9999999999/);
    assert.ok(!f.retry().hidden);
  }
});

test("旧缓存标为安卓已开放也不会绕过当前桌面优先入口", async (t) => {
  const f = await fixture(t, { prepare(w) { const item = w.document.querySelector('[data-label="安卓"]'); item.dataset.disabled = "false"; item.dataset.href = "https://acorn.cdpandas.com/download/android/Acorn-latest-arm64.apk"; }, fetch: () => json({ version: "1.17.1", size: 9 * 1048576 }) });
  f.open(); await f.settle();
  assert.equal(f.row("windows").querySelector(".acdl-choice-meta").textContent, "v1.17.1 · 9.0 MB");
  assert.equal(f.row("android").querySelector("a"), null);
  assert.equal(f.row("android").querySelector("button").disabled, true);
  assert.ok(f.retry().hidden);
});

test("刷新等待时重复点击不会并发重复请求", async (t) => {
  let requests = null;
  const f = await fixture(t, { fetch: (path) => requests ? new Promise((resolve) => requests.push(() => resolve(json(latest(path))))) : json({}, 503) });
  f.open(); await f.settle(); requests = []; f.retry().click(); f.retry().click();
  assert.equal(requests.length, 1); assert.ok(f.retry().disabled);
  requests.forEach((resolve) => resolve()); await f.settle();
  assert.equal(f.calls.length, 2);
});

test("收起取消待完成请求，旧响应不改新一轮内容或重开弹窗", async (t) => {
  let releases = [], delayed = true;
  const f = await fixture(t, { fetch: (path) => delayed ? new Promise((resolve) => releases.push(() => resolve(json({ version: "9.9.9", size: 999 })) )) : json(latest(path)) });
  f.open(); assert.equal(releases.length, 1); f.dialog().close();
  assert.ok(f.calls.every((c) => c.init.signal.aborted));
  delayed = false; f.open(); await f.settle(); releases.forEach((run) => run()); await tick(); await tick();
  assert.doesNotMatch(f.dialog().textContent, /9\.9\.9/); f.dialog().close(); await tick(); assert.equal(f.dialog().open, false);
});

test("Esc收起并将焦点还给触发按钮", async (t) => {
  const f = await fixture(t); const opener = f.w.document.querySelector("[data-download-open]"); opener.focus(); f.open(); await f.settle();
  f.dialog().dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(f.dialog().open, false); assert.equal(f.w.document.activeElement, opener);
});

test("Tab在弹窗两端循环，隐藏的刷新按钮不接焦点", async (t) => {
  const f = await fixture(t); f.open(); await f.settle();
  const close = f.dialog().querySelector(".acdl-close"), last = f.row("windows").querySelector("a");
  last.focus(); last.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); assert.equal(f.w.document.activeElement, close);
  close.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); assert.equal(f.w.document.activeElement, last);
});

test("点击行内空白不关闭，遮罩与原生取消可关闭", async (t) => {
  const f = await fixture(t); f.open(); await f.settle(); f.row("windows").click(); assert.equal(f.dialog().open, true);
  f.dialog().click(); assert.equal(f.dialog().open, false); f.open();
  f.dialog().dispatchEvent(new f.w.Event("cancel", { cancelable: true })); assert.equal(f.dialog().open, false);
});

test("旧download-ultra入口转单包选择，保留query且不出现验证码页", async (t) => {
  const f = await fixture(t, { url: "https://acorn.cdpandas.com/intro/?from=old#download-ultra" }); await f.settle();
  assert.equal(f.dialog().open, true); assert.equal(f.w.location.hash, ""); assert.equal(f.w.location.search, "?from=old");
  assert.equal(f.w.document.querySelectorAll(".acdl-choice").length, 2); assert.doesNotMatch(f.dialog().textContent, /Ultra|验证码|登录后下载/);
  assert.ok(f.calls.every((c) => !c.path.includes("ultra")));
});

test("旧模板遗留Ultra行不会恢复第二安装包，noscript只有Windows可下载", async (t) => {
  const f = await fixture(t, { prepare(w) { const item = w.document.createElement("div"); item.dataset.downloadItem = ""; item.dataset.label = "Windows Ultra"; item.dataset.api = "/api/ultra/status"; w.document.querySelector("[data-download-dialog]").append(item); } }); f.open(); await f.settle();
  assert.equal(f.w.document.querySelectorAll(".acdl-choice").length, 2);
  assert.ok(f.calls.every((c) => !c.path.includes("ultra")));
  const noscript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)[1];
  assert.doesNotMatch(noscript, /Ultra|验证码|普通版/); assert.match(noscript, /Plus账号登录后自动启用/);
  assert.equal((noscript.match(/<a /g) || []).length, 1); assert.doesNotMatch(noscript, /download\/android/);
  assert.ok(!html.includes('src="/utilities/_shared/tool-download.js"'));
});

test("版本信息到达时保留用户当前焦点与下载行节点", async (t) => {
  const releases = [];
  const f = await fixture(t, { fetch: (path) => new Promise((resolve) => releases.push(() => resolve(json(latest(path))))) }); f.open();
  const anchor = f.row("windows").querySelector("a"); anchor.focus(); releases.forEach((run) => run()); await f.settle();
  assert.equal(f.row("windows").querySelector("a"), anchor); assert.equal(f.w.document.activeElement, anchor);
});
