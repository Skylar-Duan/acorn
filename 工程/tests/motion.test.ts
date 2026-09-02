// 动效常量这一套（v1.9.0 · B0）。
//
// 动画本身没法在 jsdom 里「看」，所以这里钉的是**它能不能被一处改掉**：
//   ① base.css 里三个常量都在，而且写的就是 --ease / --dur-1 / --dur-2 这三个名字
//   ② 系统「减少动态效果」的降级还在，而且没把提交回执的「✓」一起降没
//   ③ 全仓 CSS 里不再散着字面时长（改造前是 9 种各写各的）
//   ④ JS 那边的兜底值跟 CSS 里写的对得上——这两处一旦分家，就会出现
//      「动画演完了行还赖着」或者「行已经没了动画还在跑」
//   ⑤ TaskRow 那条「动画播放中重复点击不能把循环任务推进两轮」的保护还在
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串，
// 那样这些断言会变成对着空字符串「全过」。类型见 tests/node-fs.d.ts。
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dur1, dur2, doneRowMs, popMs, cardMs } from "../src/core/motion";
import taskRowSource from "../src/components/TaskRow.tsx?raw";
import rowListSource from "../src/components/RowList.tsx?raw";
import taskCardSource from "../src/components/TaskCard.tsx?raw";

// vitest 的工作目录就是项目根（vite.config.ts 所在处）
const STYLES = "src/styles";
const readCss = (name: string) => readFileSync(`${STYLES}/${name}`, "utf8");

const baseCss = readCss("base.css");

/** 一条声明里有没有写死的时长（.12s / 180ms 这种） */
const TIME_LITERAL = /(?<![\w-])\d*\.?\d+m?s(?![\w-])/;

describe("B0：动效常量立在 base.css，一处能改掉全部", () => {
  it("三个常量都在，值就是方案里定的那套", () => {
    expect(baseCss).toContain("--ease: cubic-bezier(.2, .8, .3, 1);");
    expect(baseCss).toMatch(/--dur-1:\s*120ms;/);
    expect(baseCss).toMatch(/--dur-2:\s*180ms;/);
  });

  it("注释里写清楚了「改这三个值就能整体调轻/调慢/关掉」", () => {
    expect(baseCss).toContain("想整体调轻");
  });

  it("有 prefers-reduced-motion 全局降级（改造前全仓一处都没有）", () => {
    expect(baseCss).toContain("@media (prefers-reduced-motion: reduce)");
    // 降级块里把两个时长也压掉：JS 读的是同一对变量，等待时间跟着变成「立刻」
    expect(baseCss).toMatch(/prefers-reduced-motion[\s\S]{0,200}--dur-1:\s*0\.01ms/);
  });

  it("降级不许把提交回执的「✓」一起关掉——它是靠动画把自己显示 800 毫秒的", () => {
    expect(baseCss).toContain("*:not(.commit-ok)");
  });
});

describe("B0：旧的九种时长已经收编，没有再散在各文件里", () => {
  const names = readdirSync(STYLES).filter((f: string) => f.endsWith(".css"));

  it("样式文件都读到了（免得改了目录这条测试悄悄变成空跑）", () => {
    expect(names.length).toBeGreaterThan(10);
    expect(baseCss.length).toBeGreaterThan(1000);
  });

  for (const name of names) {
    it(`${name}：transition / animation 里不写字面时长`, () => {
      const bad = readCss(name)
        .split(/\r?\n/)
        .filter((line: string) => /\b(transition|animation):/.test(line))
        .filter((line: string) => TIME_LITERAL.test(line))
        // 两条例外，都在源码注释里交代过：
        // · 0.01ms 是 prefers-reduced-motion 的降级值本身
        // · commit-ok-fade 是「停留多久」不是「动多久」，跟 commitFlash 的 FLASH_MS 配对
        .filter((line: string) => !line.includes("0.01ms") && !line.includes("commit-ok-fade"));
      expect(bad).toEqual([]);
    });
  }
});

describe("B2：完成动画的时长 JS 和 CSS 共用一份", () => {
  it("TaskRow 不再写死 950 毫秒，改成读常量", () => {
    expect(taskRowSource).not.toContain("950");
    expect(taskRowSource).toContain("doneRowMs()");
  });

  it("CSS 那条 row-leave 用的就是同一对变量，顺序也对得上（先停 --dur-1 再收 --dur-2）", () => {
    // v1.9.1 起曲线是 --ease-shut（收的方向用加速型，见 base.css）。
    // 时长和延迟这两个数才是跟 JS 的 doneRowMs 配对的那一对，曲线不参与
    expect(readCss("app.css")).toContain(
      "animation: row-leave var(--dur-2) var(--ease-shut) var(--dur-1) forwards;",
    );
  });

  it("JS 兜底值跟 CSS 里写的一致，两边不会各说各话", () => {
    // jsdom 里读不到 CSS 变量，走的就是兜底值——正好用来钉住它没写歪
    expect(dur1()).toBe(120);
    expect(dur2()).toBe(180);
    expect(doneRowMs()).toBe(dur1() + dur2());
    expect(cardMs()).toBe(dur2());
    expect(popMs()).toBe(dur1());
  });

  it("收行改成了可插值的写法：不再动 height:auto", () => {
    const app = readCss("app.css");
    expect(app).toContain("@keyframes row-leave { to { grid-template-rows: 0fr; opacity: 0; } }");
    // ⚠️ 这一句禁的是**旧那套 `height: auto → 0` 的不可插值写法**（它连着 padding-top 一起写，
    //    浏览器只能在中途硬跳一格）。它**不是**在禁「过渡 padding」本身：
    //    v1.9.1 那套是「0fr 驱动高度 + 顺带把 padding 过渡到 0」，padding 是可插值的，
    //    而且不压 padding 的话 0fr 的轨道根本收不到 0（盒子高度不可能小于自己的 padding，
    //    折叠行会永远残留 16px）。两者是相反的两件事，别看到 padding 就照着这条删修复。
    //    下面「v1.9.1」那一组钉的就是那份修复，删了它这里会一起红
    expect(app).not.toContain("height: 0; padding-top: 0");
  });

  it("「动画播放中重复点击不能把循环任务推进两轮」这条保护还在", () => {
    expect(taskRowSource).toContain("if (leaving) return;");
  });
});

describe("B1：行和卡同时挂着，收起也有动画", () => {
  it("RowList 不再是行↔卡三元替换，两个都画出来", () => {
    expect(rowListSource).toContain("<CardSlot");
    expect(rowListSource).toContain("collapsed={expanded || fold.hidden.has(key)}");
  });

  it("卡片仍然按**任务 id** 认 key（在卡里勾子任务时不能把整张卡卸载重建）", () => {
    expect(rowListSource).toContain("key={`card:${r.task.id}`}");
    // 行的 key 加了前缀跟它岔开：母任务行的 rowKey 就等于任务 id，不加会撞
    expect(rowListSource).toContain("key={`row:${key}`}");
  });

  it("TaskRow 外面套了只管高度的那一层，行本身的类名没动", () => {
    expect(taskRowSource).toContain('className={`row-slot${leaving ? " leaving" : ""}');
    expect(taskRowSource).toContain('className={`task-row${willDone ? " done-row" : ""}');
  });

  // B1 的后账：卡片多活的那一拍里，它那条 document mousedown 监听也还活着。
  // 点开任务 A → 点任务 B 的行 → 在这 180ms 内点 B 卡上的「📅 安排日期」，
  // 这一下会先被 A 那条监听接到（目标不在 A 的 cardRef 里），于是 expandTask(null)，
  // B 刚展开就被收掉、弹层没打开——正好落在「点开一件事马上去点它的日期」上
  it("收起中的卡不许再吞点击：onDoc 头一句先认「我还是不是当前那张」", () => {
    const onDoc = taskCardSource.slice(
      taskCardSource.indexOf("function onDoc(e: MouseEvent)"),
      taskCardSource.indexOf("function onKey(e: KeyboardEvent)"),
    );
    expect(onDoc).toContain("appStore.getState().ui.expandedId !== taskIdRef.current");
    // 判据必须在最前面：收起那一拍的收尾在 flushPending 里早就做过了，不能再做第二遍
    expect(onDoc.indexOf("expandedId")).toBeLessThan(onDoc.indexOf("flushRef.current()"));
    expect(onDoc.indexOf("expandedId")).toBeLessThan(onDoc.indexOf("cardRef.current.contains"));
    // 那条监听的闭包停在首帧，任务 id 只能靠每次渲染刷新的 ref 送进去
    expect(taskCardSource).toContain("taskIdRef.current = task.id;");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// v1.9.1：折叠行收不到 0 的那个 bug（一个 CSS 病根解释了三件用户抱怨的事）
//
// 0fr 的轨道**解算不到 0**——.task-row 自己有 padding: 8px 10px，加上全局 border-box，
// 盒子高度永远不可能小于它自己的 padding，于是每条被折叠的行残留 16px（手机 18px）：
//   · 收起 n 条子任务 → 母行下面躺着 (n-1)×16px 死白（用户说的「段后间距长」）
//   · 某个时间段的行全被折叠 → 组标题不画、死行还在（「段前距更夸张」）
//   · .card-slot 同病，残留 42px（.task-card 的 margin+padding+border）→「卡片感不好」
//
// ⚠️ 修法是「0fr 驱动高度 + 把 padding 一起过渡到 0」。它跟上面那条
//    `not.toContain("height: 0; padding-top: 0")` 禁的**不是一回事**：那条禁的是旧的
//    `height: auto → 0`（不可插值，中途硬跳）。别看到 padding 就把这份修复删回去。
describe("v1.9.1：折叠行/收起的卡片必须真收到 0 高", () => {
  const app = readCss("app.css");

  it("行的上下 padding 跟着一起压掉——只压 min-height 管不住 padding", () => {
    expect(app).toContain(".row-slot.shut > .task-row {");
    const shutRow = app.slice(app.indexOf(".row-slot.shut > .task-row {"));
    const body = shutRow.slice(0, shutRow.indexOf("}"));
    expect(body).toContain("padding-top: 0;");
    expect(body).toContain("padding-bottom: 0;");
  });

  it("padding 必须被**过渡**着收，只压不过渡等于把硬跳从尾部搬到第 0 帧", () => {
    const rowInSlot = app.slice(app.indexOf("\n.row-slot > .task-row {"));
    const body = rowInSlot.slice(0, rowInSlot.indexOf("}"));
    expect(body).toContain("padding var(--dur-2)");
    // 这条选择器比 .task-row 更具体，只写 padding 会把 hover 变底色那条过渡顶掉
    expect(body).toContain("background var(--dur-1)");
  });

  it("勾掉一件事那条是 animation，不吃 transition —— padding 必须在关键帧里再写一遍", () => {
    expect(app).toContain(".row-slot.leaving > .task-row { animation: row-leave-pad");
    expect(app).toContain("@keyframes row-leave-pad { to { padding-top: 0; padding-bottom: 0; } }");
  });

  it("opacity:0 照样能点：那条死带补上了 pointer-events", () => {
    expect(app.slice(app.indexOf(".row-slot.shut {"), app.indexOf(".row-slot.shut >")))
      .toContain("pointer-events: none;");
  });

  it("任务卡那 42px 同样收掉，而且**指名 .task-card**（那个槽以后还会塞别的东西）", () => {
    expect(app).toContain(".card-slot.shut > .task-card {");
    expect(app).not.toContain(".card-slot.shut > * {");
    const card = app.slice(app.indexOf(".card-slot.shut > .task-card {"));
    const body = card.slice(0, card.indexOf("}"));
    for (const d of ["margin-top: 0;", "margin-bottom: 0;", "padding-top: 0;", "padding-bottom: 0;", "border-top-width: 0;", "border-bottom-width: 0;"]) {
      expect(body).toContain(d);
    }
    // 展开方向也得对上，否则第一帧凭空冒出 42px 的卡片边框再长大
    expect(app).toMatch(/@keyframes card-in \{[\s\S]*?padding-top: 0;[\s\S]*?\n\}/);
  });

  it("侧栏折叠**不许**被顺手并进来：它的子元素是无 padding 的 ul，本来就是 0", () => {
    expect(app).toContain(".side-fold.shut { grid-template-rows: 0fr; }");
    expect(app).not.toContain(".side-fold.shut > ");
  });

  it("收起方向有自己的加速型曲线，而且只在 base.css 定义一处", () => {
    expect(baseCss).toContain("--ease-shut:");
    // 别处不许再写第二条 cubic-bezier
    expect(readCss("app.css")).not.toContain("cubic-bezier");
    for (const s of [".row-slot.shut", ".row-slot.leaving", ".card-slot.shut"]) {
      expect(app.slice(app.indexOf(`\n${s}`), app.indexOf(`\n${s}`) + 400)).toContain("--ease-shut");
    }
  });

  it("+N 徽标跟行同一拍（原来 --dur-1，徽标先站定、行还在动）", () => {
    expect(app).toContain("animation: badge-in var(--dur-2) var(--ease);");
  });
});

describe("v1.9.1：折叠的点击热区（候选 A）", () => {
  const app = readCss("app.css");

  it("小三角撑到 24×24，用负 margin 吃行首留白——行高和标题左缘一格不动", () => {
    const caret = app.slice(app.indexOf("\n.chain-caret {"));
    const body = caret.slice(0, caret.indexOf("}"));
    expect(body).toContain("width: 24px;");
    expect(body).toContain("height: 24px;");
    expect(body).toContain("margin: -4px -5.5px;"); // 24-11=13 宽、24-8=16 高，跟改前一模一样
    // 不是链头的行照旧占等宽空位，一列不参差
    expect(app).toContain(".chain-caret.ghost { visibility: hidden; }");
  });

  it("手机端跟着改：占位还是 9px，命中区 28×28", () => {
    expect(app).toContain(".chain-caret { width: 28px; height: 28px; margin: -5px -9.5px; }");
  });

  // 顺手修的老 bug：窄屏那句原来写在文件中段那个 @media 大块里，而 .chain-caret 本体在它**后面**，
  // 同一个类名谁在后面谁赢 —— 于是窄屏版一直没生效（实测手机上量到的是桌面那 13px）
  it("窄屏版写在 .chain-caret 本体之后，否则盖不住（老 bug）", () => {
    // 本体（行首那条）必须排在窄屏那条**前面**
    const base = app.search(/(^|\r?\n)\.chain-caret \{/);
    const narrow = app.indexOf(".chain-caret { width: 28px;");
    expect(base).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(base);
    // 全仓只剩这一条窄屏声明：中段那个 @media 大块里再留一份也是死的，
    // 留着下一个人会以为它在生效
    expect(app.split(/\.chain-caret \{ width:/).length - 1).toBe(1);
  });

  it("「母任务 › 」前缀在链头行上是第二个热区，不是链头的行一个像素没变", () => {
    expect(taskRowSource).toContain('className={`chain-parent${chain ? " hit" : ""}`}');
    expect(taskRowSource).toContain("onClick={chain ? onFoldHit : undefined}");
    expect(app).toContain(".task-row .chain-parent.hit:hover");
  });

  it("徽标两个方向都有：收起是 +N，摊开是 −N", () => {
    expect(taskRowSource).toContain("`+${chain.more}`");
    expect(taskRowSource).toContain("`−${chain.total}`");
    expect(rowListSource).toContain("total: fold.total.get(key) ?? 0,");
  });

  it("绝不为了让徽标可点就拆掉 .meta 那句 stopPropagation（点日期会误开卡片）", () => {
    expect(taskRowSource).toContain('<span className="meta" onClick={(e) => e.stopPropagation()}>');
  });

  it("每一块新热区都先放行 Ctrl/Shift 连选——连选是「按件不按行」的设计基石", () => {
    const hit = taskRowSource.slice(
      taskRowSource.indexOf("function onFoldHit"),
      taskRowSource.indexOf("function onCtx"),
    );
    expect(hit).toContain("if (multiSelect(e)) return;");
    // 整行点击仍然是「打开任务卡」，没被改成折叠
    expect(taskRowSource).toContain("onClick={onRowClick}");
    expect(taskRowSource).toMatch(/function onRowClick[\s\S]*?expandTask\(task\.id\);/);
  });
});

describe("v1.9.1：键盘 ←收链 / →摊开", () => {
  it("挂在原本空着的 ←/→ 上，而且排在 mod+→（顺延）后面、自己带 !mod", () => {
    const src = readFileSync("src/App.tsx", "utf8");
    expect(src).toContain('setChainFolded(selectedIds[0], e.key === "ArrowLeft");');
    // 必须在「顺延」之后，否则 Ctrl+→ 会被这条先接走
    expect(src.indexOf('mod && e.key === "ArrowRight"'))
      .toBeLessThan(src.indexOf('e.key === "ArrowLeft" || e.key === "ArrowRight"'));
    expect(src).toContain("hasChain(selectedIds[0])");
  });
});
