/* 橡果专用：普通版公开下载；Ultra 用本人 cdpandas Cookie 验证。
 * 不读 localStorage 令牌。关窗不申报失败，申请到期与七天锁定由服务器按北京时间结算。
 * Ultra 文件完整收取、长度与 SHA256 校验成功后才交给浏览器，并确认 complete。
 */
(function () {
  "use strict";
  const source = document.querySelector("[data-download-dialog]");
  const openers = document.querySelectorAll("[data-download-open]");
  if (!source || !openers.length) return;

  const items = Array.from(source.querySelectorAll("[data-download-item]"));
  const dialog = document.createElement("dialog");
  dialog.className = "acdl-dialog";
  dialog.setAttribute("aria-labelledby", "acdl-title");
  const head = node("div", "acdl-head");
  const heading = node("div");
  heading.append(node("p", "acdl-eyebrow", "ACORN · DOWNLOAD"));
  const title = node("h2", null, "下载橡果"); title.id = "acdl-title"; heading.append(title);
  const close = button("×", "acdl-close", () => dialog.close());
  close.setAttribute("aria-label", "收起下载弹窗");
  head.append(heading, close);
  const body = node("div", "acdl-body");
  dialog.append(head, body); document.body.append(dialog);
  let opener = null;
  let screen = "choices";
  let status = null;
  let manifest = null;
  let busy = "";
  let error = "";
  let code = "";
  let success = "";
  let sequence = 0;
  let clockOffset = 0;
  let expiryTimer = null;
  let downloadRunning = false;
  let loadedBytes = 0;
  let progressNode = null;
  let progressText = null;
  let completedBuffer = null;
  let completion = null;

  function node(tag, cls, text) {
    const out = document.createElement(tag);
    if (cls) out.className = cls;
    if (text != null) out.textContent = String(text);
    return out;
  }
  function button(text, cls, run) {
    const out = node("button", cls, text); out.type = "button";
    out.addEventListener("click", run); return out;
  }
  function mb(value) {
    const n = Number(value) / 1048576;
    return n > 0 ? (n < 10 ? n.toFixed(1) : Math.round(n)) + " MB" : "";
  }
  function metadata(item) {
    return [item.dataset.version ? "v" + item.dataset.version.replace(/^v/i, "") : "", mb(item.dataset.size)].filter(Boolean).join(" · ");
  }
  function beijing(iso) {
    if (!iso || !Number.isFinite(Date.parse(iso))) return "";
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  }
  function now() { return Date.now() + clockOffset; }
  function activeLock() { return status?.lockedUntil && Date.parse(status.lockedUntil) > now(); }
  function expired() { return status?.expiresAt && Date.parse(status.expiresAt) <= now(); }
  function adopt(next) {
    if (!next || typeof next.email !== "string" || typeof next.canRequest !== "boolean" || !Number.isFinite(Date.parse(next.serverNow))) throw new Error("network");
    const priorRequest = status?.requestId;
    status = next;
    if (next.serverNow && Number.isFinite(Date.parse(next.serverNow))) clockOffset = Date.parse(next.serverNow) - Date.now();
    if ((priorRequest && priorRequest !== next.requestId) || expired()) { completedBuffer = null; completion = null; success = ""; code = ""; }
    manifest = next.download || null;
    scheduleExpiry();
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (!dialog.open || screen !== "ultra") return;
    const deadline = activeLock() ? status.lockedUntil : status?.expiresAt || status?.nextRequestAt;
    const delay = Date.parse(deadline) - now();
    if (Number.isFinite(delay) && delay > 0) expiryTimer = setTimeout(() => {
      code = ""; manifest = null; completedBuffer = null; completion = null;
      if (!downloadRunning && !busy) void loadStatus();
    }, Math.min(delay + 100, 2147483647));
  }
  function safeDownload(value) {
    const url = new URL(value, location.href);
    if (url.origin !== location.origin || url.username || url.password || !/^\/api\/ultra\/download\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash) throw new Error("bad_manifest");
    return url.href;
  }
  function loginHref() {
    const target = location.origin + location.pathname + "#download-ultra";
    return "https://cdpandas.com/login?redirect=" + encodeURIComponent(target);
  }
  function login() {
    busy = ""; error = "";
    title.textContent = "登录后下载 Ultra"; body.replaceChildren();
    body.append(node("p", "acdl-intro", "使用 cdpandas 账号登录，完成后会回到这里。"));
    const link = node("a", "acdl-action primary acdl-wide", "登录 cdpandas 继续"); link.href = loginHref(); body.append(link);
    location.assign(link.href);
  }
  async function api(path, method = "GET", data) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: data === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data) });
      let json = {}; try { json = await response.json(); } catch (_) { if (response.ok) throw new Error("network"); }
      if (!response.ok) {
        const detail = json.detail && typeof json.detail === "object" ? json.detail : json;
        const failure = new Error(detail.error || "network");
        failure.status = response.status; failure.detail = detail; throw failure;
      }
      return json;
    } finally { clearTimeout(timeout); }
  }
  function failureText(failure) {
    const messages = {
      bad_code: "验证码不正确，请向管理员核对后重试。输错不会按三次申请失败计算。",
      code_expired: "今天的验证码已过期，请查看新的北京时间申请状态。",
      download_expired: "这次下载凭证已过期，请刷新状态后重新下载。",
      ultra_locked: "申请暂时锁定，解锁时间见上方。",
      already_requested: "今天已经申请过，无需再申请。可继续输入今天的验证码。",
      no_package: "Ultra 安装包暂未就绪，请稍后重试。",
      mail_unavailable: "管理员邮件服务暂不可用，请稍后重试。",
      mail_failed: "验证码邮件暂未发出，请稍后重试。",
      download_incomplete: "下载完成确认还未就绪，请点击重试确认。无需重新申请验证码。",
      bad_digest: "安装包校验未通过，请重新下载。今天的验证码仍可继续使用。",
      bad_manifest: "下载信息不完整，请刷新状态后重试。",
      size_mismatch: "安装包未完整收到，请重新下载。今天的验证码仍可继续使用。",
      digest_mismatch: "安装包校验不一致，未生成下载文件。请重新下载。",
      unverified: "请先完成 cdpandas 邮箱验证，再回来下载。",
      blocked: "当前账号暂不可申请，请联系管理员。",
      bad_origin: "请从橡果介绍页重新打开下载。",
      crypto_unavailable: "当前浏览器无法校验安装包，请使用新版浏览器打开 HTTPS 介绍页。",
    };
    return messages[failure.message] || "连接未完成，请检查网络后重试。";
  }
  async function failed(failure, refresh = true) {
    if (failure.status === 401) { if (dialog.open && screen === "ultra") login(); else { busy = ""; status = null; } return; }
    busy = ""; error = failureText(failure);
    if (refresh && [410, 423, 429].includes(failure.status)) {
      const message = error;
      try { adopt(await api("/api/ultra/status")); } catch (_) { /* 保留可重试提示 */ }
      error = message;
    }
    if (dialog.open && screen === "ultra") renderGate(failure.message === "bad_code");
  }
  function icon(android) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "acdl-icon"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", android ? "M5 10h14v9H5z M5 10a7 7 0 0 1 14 0 M7 4 5 1M17 4l2-3 M8 8h.01M16 8h.01M8 19v3M16 19v3M2 11v6M22 11v6" : "M3 5l8-1v8H3z M14 3l7-1v10h-7z M3 15h8v7l-8-1z M14 15h7v9l-7-1z");
    svg.append(path); return svg;
  }
  function open() {
    if (!dialog.open) { opener = document.activeElement; dialog.showModal(); }
  }
  function choices() {
    ++sequence; screen = "choices"; clearTimeout(expiryTimer);
    title.textContent = "下载橡果"; body.replaceChildren();
    body.append(node("p", "acdl-intro", "Windows 可选普通版或 Ultra。安卓提供普通版；网页版直接打开即可。"));
    items.forEach((item) => {
      const ultra = item.dataset.edition === "ultra";
      const android = item.dataset.label === "安卓";
      const row = node("div", "acdl-choice" + (ultra ? " ultra" : "")); row.dataset.edition = ultra ? "ultra" : "normal";
      row.append(icon(android));
      const main = node("div", "acdl-choice-main");
      const label = node("div", "acdl-choice-title", android ? "安卓" : "Windows");
      label.append(node("span", "acdl-tag", ultra ? "ULTRA" : "普通版"));
      const meta = node("div", "acdl-choice-meta", ultra ? "个人测试版 · 支持任务附图" : metadata(item));
      main.append(label, meta, node("p", "acdl-choice-desc", ultra ? "需登录并向管理员获取今日验证码" : item.dataset.sub));
      row.append(main);
      if (ultra) row.append(button("获取 Ultra", "acdl-action primary", () => void enterUltra()));
      else { const link = node("a", "acdl-action", "下载"); link.href = item.dataset.href; link.setAttribute("aria-label", `下载${android ? "安卓" : "Windows"}普通版`); row.append(link); }
      body.append(row);
    });
    body.append(node("p", "acdl-choice-foot", "普通版可直接下载。Ultra 每天按北京时间申请一次验证码；已安装的 Ultra 可在应用内继续更新。网页版没有新增 Ultra。"));
    if (downloadRunning) body.append(node("p", "acdl-live", "Ultra 安装包仍在后台下载，请稍后回到 Ultra 查看结果。"));
  }
  function policy() {
    const details = node("details", "acdl-policy");
    details.append(node("summary", null, "验证码有效期与申请规则"));
    details.append(node("p", null, "按北京时间自然日计算，每天只能申请一次，验证码于当天午夜失效，只发给管理员。请向管理员获取后，在到期前正确验证并完整下载安装包。"));
    details.append(node("p", null, "连续三次申请均在到期前未完成验证和完整下载，才暂停申请七天。不是输错三次验证码就锁定。收起弹窗不会立即计作失败，可以在当天回来继续。"));
    details.append(node("p", null, "曾获授权的账号也需要每天申请；当天已完成下载可重新下载。已安装 Ultra 的账号可长期使用应用内更新。"));
    return details;
  }
  function statusCard(lead, text) {
    const box = node("div", "acdl-status"); box.append(node("strong", null, lead));
    if (text) box.append(node("p", null, text)); return box;
  }
  function renderGate(focusCode = false) {
    if (!dialog.open || screen !== "ultra") return;
    title.textContent = "向管理员获取验证码"; body.replaceChildren(); progressNode = null; progressText = null;
    body.append(button("← 选择其他版本", "acdl-back", choices));
    if (status?.email) body.append(node("p", "acdl-account", "当前账号 · " + status.email));
    if (!status) {
      body.append(statusCard(busy ? "正在读取申请状态…" : "暂未读到申请状态", "不会因打开或收起弹窗而消耗今天的申请次数。"));
    } else if (activeLock()) {
      body.append(statusCard("暂时无法申请", "连续三次申请到期前未完成验证和完整下载。可再次申请的时间：" + beijing(status.lockedUntil) + "（北京时间）。"));
    } else if (manifest && !expired()) {
      body.append(statusCard(status.downloaded ? "今天已完成下载" : "验证码已通过", status.downloaded ? "北京时间午夜前可再次下载，无需再申请。" : "请在 " + beijing(status.expiresAt) + "（北京时间）前完整下载。"));
      body.append(node("p", "acdl-intro", "Windows Ultra · v" + manifest.version + " · " + mb(manifest.size)));
      const action = button(downloadRunning ? "正在下载安装包…" : "下载安装包", "acdl-action primary acdl-wide", () => void download());
      action.disabled = !!busy || downloadRunning; body.append(action);
    } else if (status.requestId && !expired()) {
      body.append(statusCard("今天的验证码已申请", "验证码只发送给管理员。请向管理员获取，有效至 " + beijing(status.expiresAt) + "（北京时间）。"));
      const form = node("form");
      const label = node("label", "acdl-code-label", "今日验证码"); label.htmlFor = "acdl-code";
      const input = node("input", "acdl-code"); input.id = "acdl-code"; input.type = "text"; input.inputMode = "numeric"; input.autocomplete = "one-time-code";
      input.maxLength = 12; input.placeholder = "输入管理员提供的验证码"; input.value = code; input.disabled = !!busy;
      input.addEventListener("input", () => { code = input.value; });
      const submit = node("button", "acdl-action primary acdl-wide", busy === "verify" ? "正在验证…" : "验证并继续下载"); submit.type = "submit"; submit.disabled = !!busy;
      form.addEventListener("submit", (event) => { event.preventDefault(); void verify(); });
      form.append(label, input, submit); body.append(form);
      if (focusCode) requestAnimationFrame(() => input.focus());
    } else {
      body.append(statusCard("先申请今天的验证码", "每天仅能申请一次，按北京时间计算；当天午夜失效。验证码只发给管理员，申请后请向管理员获取。"));
      if (status.enabled) body.append(node("p", "acdl-intro", "你此前已获授权。网站下载仍需今天的验证码，已安装的 Ultra 可继续在应用内更新。"));
      const action = button(busy === "request" ? "正在申请…" : "申请今日验证码", "acdl-action primary acdl-wide", () => void requestCode());
      action.disabled = !!busy || status.canRequest !== true; body.append(action);
      if (!status.canRequest) body.append(node("p", "acdl-live", "下一次可申请：" + beijing(status.nextRequestAt) + "（北京时间）。"));
    }
    if (error) { const alert = node("p", "acdl-alert", error); alert.setAttribute("role", "alert"); body.append(alert); }
    if (success) body.append(node("p", "acdl-success", success));
    if (downloadRunning) {
      progressNode = node("progress", "acdl-progress"); progressNode.max = 100; progressNode.value = manifest?.size ? loadedBytes / manifest.size * 100 : 0;
      progressNode.setAttribute("aria-label", "安装包下载进度"); body.append(progressNode);
      progressText = node("p", "acdl-live", "正在下载，收起弹窗后仍会继续。"); progressText.setAttribute("role", "status"); body.append(progressText);
    }
    if (completion && completedBuffer && !downloadRunning) body.append(button("重试下载完成确认", "acdl-action acdl-wide", () => void confirmComplete()));
    const refresh = button("刷新申请状态", "acdl-back acdl-retry", () => void loadStatus()); refresh.disabled = !!busy || downloadRunning; body.append(refresh);
    body.append(policy()); scheduleExpiry();
  }
  async function loadStatus() {
    const run = ++sequence; busy = "status"; error = "";
    if (dialog.open && screen === "ultra") renderGate();
    try { const data = await api("/api/ultra/status"); if (run !== sequence) return; adopt(data); busy = ""; renderGate(); }
    catch (failure) { if (run === sequence) await failed(failure, false); }
  }
  async function enterUltra() {
    open(); screen = "ultra"; error = "";
    if (downloadRunning || ["request", "verify", "complete"].includes(busy)) { renderGate(); return; }
    await loadStatus();
  }
  async function requestCode() {
    if (busy || !status?.canRequest || activeLock()) return;
    busy = "request"; error = ""; success = ""; renderGate();
    try { adopt(await api("/api/ultra/request", "POST")); busy = ""; code = ""; renderGate(true); }
    catch (failure) { await failed(failure); }
  }
  async function verify() {
    if (busy || !status?.requestId || expired()) { if (expired()) void loadStatus(); return; }
    if (!code.trim()) { error = "请先输入管理员提供的验证码。"; renderGate(true); return; }
    busy = "verify"; error = ""; renderGate();
    try {
      const result = await api("/api/ultra/verify", "POST", { requestId: status.requestId, code: code.trim() });
      if (!result.download || !result.expiresAt) throw new Error("bad_manifest");
      manifest = result.download; status = { ...status, verified: true, expiresAt: result.expiresAt, download: result.download };
      code = ""; busy = ""; renderGate();
    } catch (failure) { await failed(failure); }
  }
  async function download() {
    if (downloadRunning || busy || !manifest || expired()) return;
    const selected = manifest;
    const controller = new AbortController();
    let watchdog;
    const bump = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 30000); };
    downloadRunning = true; loadedBytes = 0; error = ""; success = ""; completedBuffer = null; completion = null; renderGate();
    try {
      if (!window.crypto?.subtle) throw new Error("crypto_unavailable");
      if (!/^[a-f0-9]{64}$/i.test(selected.sha256) || !Number.isSafeInteger(selected.size) || selected.size < 1 || !selected.downloadId) throw new Error("bad_manifest");
      bump();
      const response = await fetch(safeDownload(selected.url), { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response.ok) { const fail = new Error(response.status === 410 ? "download_expired" : "network"); fail.status = response.status; throw fail; }
      const chunks = [];
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bump();
          loadedBytes += value.byteLength;
          if (loadedBytes > selected.size) { await reader.cancel(); throw new Error("size_mismatch"); }
          chunks.push(value);
          if (progressNode) progressNode.value = loadedBytes / selected.size * 100;
          if (progressText) progressText.textContent = "已接收 " + mb(loadedBytes) + " / " + mb(selected.size);
        }
      } else { const buffer = await response.arrayBuffer(); chunks.push(buffer); loadedBytes = buffer.byteLength; }
      if (loadedBytes !== selected.size) throw new Error("size_mismatch");
      clearTimeout(watchdog);
      const blob = new Blob(chunks, { type: "application/octet-stream" });
      const hash = Array.from(new Uint8Array(await window.crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), (x) => x.toString(16).padStart(2, "0")).join("");
      if (hash !== selected.sha256.toLowerCase()) throw new Error("digest_mismatch");
      completedBuffer = blob; completion = { id: selected.downloadId, sha256: hash, fileName: String(selected.fileName || "Acorn-Ultra-setup.exe").replace(/[\\/\x00-\x1f]/g, "-") };
      const url = URL.createObjectURL(blob);
      const anchor = node("a"); anchor.href = url; anchor.download = completion.fileName; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      downloadRunning = false;
      await confirmComplete();
    } catch (failure) { downloadRunning = false; await failed(failure); }
    finally { clearTimeout(watchdog); }
  }
  async function confirmComplete() {
    if (!completion || !completedBuffer || busy) return;
    busy = "complete"; error = ""; renderGate();
    try {
      await api("/api/ultra/download/" + encodeURIComponent(completion.id) + "/complete", "POST", { sha256: completion.sha256 });
      status = { ...status, enabled: true, downloaded: true, consecutiveFailures: 0 }; completedBuffer = null; completion = null;
      busy = ""; success = "安装包已完整接收并校验，浏览器已开始保存。今天可继续重新下载。"; renderGate();
    } catch (failure) { await failed(failure); }
  }
  openers.forEach((item) => item.addEventListener("click", () => { choices(); open(); }));
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { clearTimeout(expiryTimer); if (opener?.isConnected) opener.focus(); });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); dialog.close(); return; }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.querySelectorAll("button:not(:disabled),input:not(:disabled),a[href],summary")).filter((n) => !n.hidden);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && dialog.open && screen === "ultra" && !busy && !downloadRunning) void loadStatus(); });

  // 普通版本读取公开接口；Ultra 只在验证通过后显示自己的真实版本和大小。
  items.filter((item) => item.dataset.api).forEach(async (item) => {
    try {
      const response = await fetch(item.dataset.api, { cache: "no-store" });
      if (!response.ok) return;
      const latest = await response.json();
      if (latest.version) item.dataset.version = String(latest.version);
      if (latest.size > 0) item.dataset.size = String(latest.size);
      // 普通版固定地址不跟随任意接口 URL 跳转。
      if (dialog.open && screen === "choices") choices();
    } catch (_) { /* 页面兜底仍能下载普通版 */ }
  });
  if (location.hash === "#download-ultra") {
    history.replaceState(null, "", location.pathname + location.search);
    void enterUltra();
  }
})();
