/* 橡果使用同一Windows安装包；Plus资格由应用登录后的账号决定。
 * 介绍页只读取公开版本信息，不探测账号、不申请验证码、不读取本地登录令牌。
 */
(function () {
  "use strict";
  const source = document.querySelector("[data-download-dialog]");
  const openers = document.querySelectorAll("[data-download-open]");
  if (!source || !openers.length) return;

  const publicOrigin = "https://acorn.cdpandas.com";
  const platforms = [
    { label: "Windows", key: "windows", path: "/download/windows/Acorn-latest-x64-setup.exe", api: "/api/desktop/latest" },
    { label: "安卓", key: "android" },
  ].map((platform) => ({ ...platform, item: Array.from(source.querySelectorAll("[data-download-item]")).find((item) => item.dataset.label === platform.label) }))
    .filter((platform) => platform.item);
  const dialog = document.createElement("dialog");
  dialog.className = "acdl-dialog";
  dialog.setAttribute("aria-labelledby", "acdl-title");
  const head = node("div", "acdl-head");
  const heading = node("div");
  heading.append(node("p", "acdl-eyebrow", "ACORN · DOWNLOAD"));
  const title = node("h2", null, "下载橡果"); title.id = "acdl-title"; heading.append(title);
  const close = button("×", "acdl-close", () => dialog.close()); close.setAttribute("aria-label", "收起下载弹窗");
  head.append(heading, close);
  const body = node("div", "acdl-body");
  const live = node("p", "acdl-live"); live.setAttribute("role", "status");
  const retry = button("刷新版本信息", "acdl-back acdl-retry", () => void refreshMetadata());
  dialog.append(head, body); document.body.append(dialog);
  const metadataNodes = new Map();
  let opener = null;
  let cycle = 0;
  let pending = false;
  let failed = false;
  let controllers = [];

  function node(tag, cls, text) {
    const result = document.createElement(tag);
    if (cls) result.className = cls;
    if (text != null) result.textContent = String(text);
    return result;
  }
  function button(text, cls, run) {
    const result = node("button", cls, text); result.type = "button"; result.addEventListener("click", run); return result;
  }
  function metadata(platform) {
    const size = Number(platform.item.dataset.size);
    const mb = size > 0 && Number.isSafeInteger(size) ? (size < 10485760 ? (size / 1048576).toFixed(1) : Math.round(size / 1048576)) + " MB" : "";
    return [platform.item.dataset.version ? "v" + platform.item.dataset.version.replace(/^v/i, "") : "", mb].filter(Boolean).join(" · ");
  }
  function icon(android) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "acdl-icon"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", android ? "M5 10h14v9H5z M5 10a7 7 0 0 1 14 0 M7 4 5 1M17 4l2-3 M8 8h.01M16 8h.01M8 19v3M16 19v3M2 11v6M22 11v6" : "M3 5l8-1v8H3z M14 3l7-1v10h-7z M3 15h8v7l-8-1z M14 15h7v9l-7-1z");
    svg.append(path); return svg;
  }
  function updateStatus() {
    live.textContent = failed ? "版本信息暂未刷新，下载入口仍可使用。" : "";
    retry.hidden = !failed;
    retry.disabled = pending;
  }
  function choices() {
    body.replaceChildren(); metadataNodes.clear();
    body.append(node("p", "acdl-intro", "目前优先提供Windows桌面版，Plus资格随账号启用。"));
    platforms.forEach((platform) => {
      const unavailable = platform.key !== "windows";
      const row = node("div", "acdl-choice" + (unavailable ? " acdl-unavailable" : "")); row.dataset.platform = platform.key; row.append(icon(platform.key === "android"));
      const main = node("div", "acdl-choice-main");
      const meta = node("div", "acdl-choice-meta", unavailable ? "正在开发中" : metadata(platform)); metadataNodes.set(platform.key, meta);
      main.append(node("div", "acdl-choice-title", platform.label), meta,
        node("p", "acdl-choice-desc", platform.key === "windows" ? "同一安装包，Plus账号登录后自动启用附图功能" : platform.item.dataset.sub));
      const link = unavailable ? button("开发中", "acdl-action", () => {}) : node("a", "acdl-action", "下载");
      // 接口的url或模板中的任意地址不能改变下载目标，也不能回到旧私有安装包通道。
      if (unavailable) { link.disabled = true; link.setAttribute("aria-disabled", "true"); link.setAttribute("aria-label", "安卓版正在开发中"); }
      else { link.href = publicOrigin + platform.path; link.setAttribute("aria-label", "下载" + platform.label + "安装包"); }
      row.append(main, link); body.append(row);
    });
    body.append(node("p", "acdl-choice-foot", "Windows装完可在应用内检查更新。网页版与手机版正在开发中。"), live, retry); updateStatus();
  }
  function open() {
    choices();
    if (!dialog.open) { opener = document.activeElement; dialog.showModal(); close.focus(); }
    if (!pending) void refreshMetadata();
  }
  function cancelMetadata() {
    ++cycle; controllers.forEach((controller) => controller.abort()); controllers = []; pending = false;
  }
  async function refreshMetadata() {
    if (pending) return;
    const run = ++cycle; pending = true; failed = false; controllers = []; updateStatus();
    const results = await Promise.all(platforms.filter((platform) => platform.key === "windows").map(async (platform) => {
      const controller = new AbortController(); controllers.push(controller);
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(publicOrigin + platform.api, { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
        if (!response.ok) return false;
        const latest = await response.json();
        if (run !== cycle) return false;
        if (!latest || typeof latest.version !== "string" || latest.version.length > 40 || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(latest.version) || !Number.isSafeInteger(latest.size) || latest.size < 1) return false;
        platform.item.dataset.version = latest.version; platform.item.dataset.size = String(latest.size);
        const meta = metadataNodes.get(platform.key); if (meta?.isConnected) meta.textContent = metadata(platform);
        return true;
      } catch (_) { return false; }
      finally { clearTimeout(timer); }
    }));
    if (run !== cycle) return;
    pending = false; controllers = []; failed = results.some((ok) => !ok); updateStatus();
  }
  openers.forEach((item) => item.addEventListener("click", open));
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); dialog.close(); });
  dialog.addEventListener("close", () => { cancelMetadata(); if (opener?.isConnected) opener.focus(); });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); dialog.close(); return; }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.querySelectorAll("button:not(:disabled),a[href]")).filter((control) => !control.hidden);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  if (["#download-ultra", "#download-plus", "#download"].includes(location.hash)) {
    history.replaceState(null, "", location.pathname + location.search); open();
  }
})();
