/* 橡果介绍页 · 管理员看反馈
 * ============================================================
 * 只有管理员看得到：页面加载后自己问一次服务端 /api/feedback，
 * 200 才在「打开网页版」右边放一个「反馈」按钮；普通访客什么也看不到。
 *
 * 身份两条路，按顺序试：
 *   1. 橡果网页版登录过（同源 localStorage 的 acorn-auth，里面是 {token,...}）→ 带 Bearer；
 *   2. 没有令牌或不认 → 不带 Authorization 再试一次，让浏览器带 cdpandas 登录 cookie。
 * 不依赖 tool-board.js 的任何内部状态（那是 10-Platform 的脚本，随时会改）。
 *
 * 安全：反馈里的每个字段都是用户随手填的，只用 textContent / createElement 渲染，
 * 不拼 innerHTML，不识别链接。令牌只放 Authorization 头，不打印、不进地址。
 * 请求一律相对路径 /api/...（同源）。
 *
 * 挂载点：index.html 里的 <span data-feedback-mount hidden>。
 * 文件必须在 网站/assets/ 下：线上 /intro/ 只把 index.html 和 /intro/assets/* 映射到页面目录。
 *
 * 被套在 iframe 里时整段不启用（防别的页面把介绍页套进框、诱导管理员误点）。
 *
 * 已知现象（不是 bug）：普通访客控制台会有 1 条浏览器自己打的 404；
 * 这台设备登录过网页版但不是管理员（或令牌过期）时是 2 条（先带令牌试、再不带试）。
 * 页面本身不报脚本错误。
 */
(function () {
  "use strict";

  var AUTH_KEY = "acorn-auth";
  var PAGE_SIZE = 50;
  var PLATFORM = { desktop: "电脑版", android: "安卓", web: "网页版" };

  // 被套在框里不探测、不出按钮
  try {
    if (window.top !== window.self) return;
  } catch (e) {
    return;
  }

  var mount = document.querySelector("[data-feedback-mount]");
  if (!mount || !window.fetch) return;

  // ---------- 身份 ----------

  function readToken() {
    try {
      var raw = window.localStorage.getItem(AUTH_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && typeof s.token === "string" && s.token ? s.token : null;
    } catch (e) {
      return null;
    }
  }

  var auth = null; // { bearer: string|null }，探测成功后定下来

  function request(method, path, body, useAuth) {
    var a = useAuth || auth;
    var headers = { Accept: "application/json" };
    if (a && a.bearer) headers.Authorization = "Bearer " + a.bearer;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, {
      method: method,
      headers: headers,
      credentials: "same-origin",
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error("http " + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  function probe() {
    var token = readToken();
    var tries = [];
    if (token) tries.push({ bearer: token });
    tries.push({ bearer: null });
    var i = 0;
    function next() {
      if (i >= tries.length) return Promise.reject(null);
      var a = tries[i++];
      return request("GET", "/api/feedback?status=open&limit=1", undefined, a).then(
        function (data) {
          if (!data || !Array.isArray(data.items)) throw new Error("bad");
          auth = a;
          return data;
        },
        next
      );
    }
    return next();
  }

  // ---------- 小工具 ----------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function when(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "";
    var now = new Date();
    var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    var day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var t = d.getTime();
    if (t >= day0 && t < day0 + 86400000) return "今天 " + hm;
    if (t >= day0 - 86400000 && t < day0) return "昨天 " + hm;
    var md = d.getMonth() + 1 + "月" + d.getDate() + "日 " + hm;
    return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + "年" + md;
  }

  function str(v) {
    return typeof v === "string" ? v : v == null ? "" : String(v);
  }

  // ---------- 样式（只作用于 .fbk-*，配色取 tool-page.css 的 token） ----------

  function injectStyle() {
    var css =
      ".fbk-btn{position:relative}" +
      ".fbk-badge{display:inline-block;min-width:20px;height:20px;padding:0 6px;border-radius:999px;" +
      "background:var(--brand);color:var(--on-brand);font-size:12px;font-weight:700;line-height:20px;text-align:center}" +
      ".fbk-badge[hidden]{display:none}" +
      ".fbk-dialog{margin:auto;border:1px solid var(--line);border-radius:16px;background:var(--panel);color:var(--fg);" +
      "padding:0;width:min(640px,calc(100vw - 32px));max-height:min(760px,calc(100vh - 48px));box-shadow:var(--shadow);overflow:hidden}" +
      ".fbk-dialog[open]{display:flex;flex-direction:column}" +
      ".fbk-dialog::backdrop{background:rgba(0,0,0,.45)}" +
      ".fbk-head{display:flex;align-items:center;gap:12px;padding:18px 20px 12px;border-bottom:1px solid var(--line)}" +
      ".fbk-title{font-size:18px;font-weight:650;flex:1}" +
      ".fbk-x{background:none;border:0;color:var(--fg2);font-size:26px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px}" +
      ".fbk-x:hover{color:var(--fg);background:var(--sunken)}" +
      ".fbk-tabs{display:flex;gap:6px;padding:12px 20px 0}" +
      ".fbk-tab{background:transparent;border:1px solid var(--line);color:var(--fg2);font:inherit;font-size:14px;" +
      "padding:5px 14px;border-radius:999px;cursor:pointer}" +
      ".fbk-tab[aria-pressed=true]{background:var(--brand);border-color:var(--brand);color:var(--on-brand);font-weight:600}" +
      ".fbk-body{overflow-y:auto;padding:12px 20px 20px;flex:1;min-height:120px}" +
      ".fbk-card{border:1px solid var(--line);border-radius:12px;background:var(--bg);padding:14px 16px;margin-top:10px}" +
      ".fbk-card.done{opacity:.72}" +
      ".fbk-card.fbk-leave{opacity:0;transition:opacity .25s}" +
      ".fbk-text{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:15px;line-height:1.7}" +
      ".fbk-meta{margin-top:8px;color:var(--fg2);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 14px}" +
      ".fbk-meta span{overflow-wrap:anywhere}" +
      ".fbk-foot{margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}" +
      ".fbk-state{font-size:13px;font-weight:600;color:var(--brand-ink)}" +
      ".fbk-card.done .fbk-state{color:var(--fg3);font-weight:500}" +
      ".fbk-empty,.fbk-msg{color:var(--fg2);font-size:14px;padding:22px 0;text-align:center}" +
      ".fbk-more{margin-top:14px;text-align:center}" +
      "@media (max-width:640px){" +
      ".fbk-dialog{width:calc(100vw - 16px);max-height:calc(100vh - 16px);border-radius:14px}" +
      ".fbk-head{padding:14px 14px 10px}.fbk-tabs{padding:10px 14px 0}.fbk-body{padding:10px 14px 16px}" +
      ".fbk-card{padding:12px 13px}}";
    var s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ---------- 面板 ----------

  var state = { view: "open", open: 0, next: null, seq: 0 };
  var ui = {};

  function setBadge(n) {
    state.open = typeof n === "number" && n >= 0 ? n : state.open;
    ui.badge.textContent = state.open > 99 ? "99+" : String(state.open);
    ui.badge.hidden = state.open === 0;
    ui.btn.setAttribute("aria-label", state.open ? "反馈，" + state.open + " 条没处理" : "反馈");
    ui.title.textContent = state.open ? "反馈 · " + state.open + " 条没处理" : "反馈";
  }

  function buildButton() {
    var btn = el("button", "btn btn-ghost fbk-btn");
    btn.type = "button";
    btn.appendChild(document.createTextNode("反馈"));
    var badge = el("span", "fbk-badge");
    btn.appendChild(badge);
    ui.btn = btn;
    ui.badge = badge;
    btn.addEventListener("click", openPanel);
    mount.replaceWith(btn);
  }

  function buildDialog() {
    var dlg = el("dialog", "fbk-dialog");
    dlg.setAttribute("aria-label", "反馈");

    var head = el("div", "fbk-head");
    ui.title = el("div", "fbk-title", "反馈");
    var x = el("button", "fbk-x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "关闭");
    x.addEventListener("click", function () {
      dlg.close();
    });
    head.appendChild(ui.title);
    head.appendChild(x);

    var tabs = el("div", "fbk-tabs");
    ui.tabs = {};
    [
      ["open", "未处理"],
      ["all", "全部"],
    ].forEach(function (t) {
      var b = el("button", "fbk-tab", t[1]);
      b.type = "button";
      b.addEventListener("click", function () {
        if (state.view !== t[0]) {
          state.view = t[0];
          load(true);
        }
      });
      ui.tabs[t[0]] = b;
      tabs.appendChild(b);
    });

    ui.body = el("div", "fbk-body");
    dlg.appendChild(head);
    dlg.appendChild(tabs);
    dlg.appendChild(ui.body);

    // 点遮罩关：<dialog> 的遮罩点击落在 dialog 元素本身，且在它的方框之外
    dlg.addEventListener("click", function (e) {
      if (e.target !== dlg) return;
      var r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    document.body.appendChild(dlg);
    ui.dlg = dlg;
  }

  function openPanel() {
    if (typeof ui.dlg.showModal === "function") ui.dlg.showModal();
    else ui.dlg.setAttribute("open", "");
    load(true);
  }

  function renderCard(item) {
    var card = el("div", "fbk-card");
    card.appendChild(el("div", "fbk-text", str(item.text)));

    var meta = el("div", "fbk-meta");
    var who = str(item.email);
    if (who) meta.appendChild(el("span", null, who));
    var where = PLATFORM[str(item.platform)] || str(item.platform);
    var ver = str(item.version);
    if (where || ver) meta.appendChild(el("span", null, (where + (ver ? " " + ver : "")).trim()));
    var dev = str(item.device);
    if (dev) meta.appendChild(el("span", null, dev));
    var t = when(item.createdAt);
    if (t) meta.appendChild(el("span", null, t));
    card.appendChild(meta);

    var foot = el("div", "fbk-foot");
    var st = el("span", "fbk-state");
    var act = el("button", "btn btn-ghost btn-sm");
    act.type = "button";
    foot.appendChild(st);
    foot.appendChild(act);
    card.appendChild(foot);

    function paint() {
      card.classList.toggle("done", !!item.done);
      if (item.done) {
        var by = str(item.doneBy);
        var at = when(item.doneAt);
        st.textContent = "已处理" + (at ? " · " + at : "") + (by ? " · " + by : "");
        act.textContent = "改回未处理";
      } else {
        st.textContent = "未处理";
        act.textContent = "标记已处理";
      }
    }
    paint();

    act.addEventListener("click", function () {
      var want = !item.done;
      act.disabled = true;
      request("PATCH", "/api/feedback/" + encodeURIComponent(String(item.id)), { done: want })
        .then(function (fresh) {
          if (fresh && typeof fresh === "object") {
            item.done = !!fresh.done;
            item.doneAt = fresh.doneAt;
            item.doneBy = fresh.doneBy;
          } else {
            item.done = want;
          }
          setBadge(state.open + (item.done ? -1 : 1));
          paint();
          // 「未处理」里标完就拿掉，列表和角标口径一致
          if (state.view === "open" && item.done) leave(card);
        })
        .catch(function () {
          st.textContent = "没改成，稍后再试";
        })
        .then(function () {
          act.disabled = false;
        });
    });
    return card;
  }

  function leave(card) {
    card.classList.add("fbk-leave");
    setTimeout(function () {
      if (!card.parentNode) return;
      card.remove();
      if (state.view === "open" && !ui.body.querySelector(".fbk-card") && !ui.body.querySelector(".fbk-more")) {
        ui.body.replaceChildren(el("div", "fbk-empty", "没有要处理的反馈"));
      }
    }, 260);
  }

  function load(reset) {
    var my = ++state.seq;
    Object.keys(ui.tabs).forEach(function (k) {
      ui.tabs[k].setAttribute("aria-pressed", k === state.view ? "true" : "false");
    });
    var moreWrap = ui.body.querySelector(".fbk-more");
    if (reset) {
      state.next = null;
      ui.body.replaceChildren(el("div", "fbk-msg", "正在读取…"));
    } else if (moreWrap) {
      moreWrap.firstChild.disabled = true;
      moreWrap.firstChild.textContent = "正在读取…";
    }
    var view = state.view;
    var q = "/api/feedback?status=" + view + "&limit=" + PAGE_SIZE;
    if (!reset && state.next != null) q += "&before=" + encodeURIComponent(String(state.next));

    request("GET", q)
      .then(function (data) {
        if (my !== state.seq) return;
        var items = data && Array.isArray(data.items) ? data.items : [];
        if (reset) ui.body.replaceChildren();
        else if (moreWrap) moreWrap.remove();
        setBadge(data && data.open);
        if (reset && !items.length) {
          ui.body.appendChild(el("div", "fbk-empty", view === "open" ? "没有要处理的反馈" : "还没有人发过反馈"));
        }
        items.forEach(function (it) {
          if (it && typeof it === "object") ui.body.appendChild(renderCard(it));
        });
        state.next = data && data.next != null ? data.next : null;
        if (state.next != null) {
          var w = el("div", "fbk-more");
          var b = el("button", "btn btn-ghost btn-sm", "再看更早的");
          b.type = "button";
          b.addEventListener("click", function () {
            load(false);
          });
          w.appendChild(b);
          ui.body.appendChild(w);
        }
      })
      .catch(function () {
        if (my !== state.seq) return;
        if (reset) ui.body.replaceChildren(el("div", "fbk-msg", "没读到，关掉再开一次试试"));
        else if (moreWrap) {
          moreWrap.firstChild.disabled = false;
          moreWrap.firstChild.textContent = "没读到，再点一次";
        }
      });
  }

  // ---------- 启动 ----------

  probe().then(
    function (data) {
      injectStyle();
      buildButton();
      buildDialog();
      setBadge(typeof data.open === "number" ? data.open : 0);
    },
    function () {
      /* 不是管理员 / 没登录 / 连不上：什么也不显示 */
    }
  );
})();
