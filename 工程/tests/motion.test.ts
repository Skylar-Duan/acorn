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
    expect(readCss("app.css")).toContain(
      "animation: row-leave var(--dur-2) var(--ease) var(--dur-1) forwards;",
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
