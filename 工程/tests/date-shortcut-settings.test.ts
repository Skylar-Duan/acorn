import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, update: vi.fn() }));
vi.mock("../src/core/store", () => ({ useApp: (select: (s: unknown) => unknown) => select({ data: { settings: state.settings } }), updateSettings: state.update }));
import DateShortcutSettings from "../src/components/DateShortcutSettings";
import { defaultDateShortcuts } from "../src/core/dateShortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
  if (!button) throw new Error(`找不到按钮 ${label}`);
  await act(async () => button.click());
}
beforeEach(async () => {
  state.settings = { weekendDay: "sun" }; state.update.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(DateShortcutSettings)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("快捷日期编辑", () => {
  it("增删与排序只改草稿，保存提交最终顺序和数量", async () => {
    await click("编辑快捷日期");
    await click("删除第1项"); await click("下移第1项"); await click("＋ 添加快捷日期");
    expect(state.update).not.toHaveBeenCalled();
    await click("保存");
    const saved = state.update.mock.calls[0][0].dateShortcuts;
    expect(saved.map((r: { id: string }) => r.id).slice(0, 4)).toEqual(["weekend", "tomorrow", "nextWeekend", "monthEnd"]);
    expect(saved).toHaveLength(5); expect(saved[4].days).toBe(3);
    expect(host.querySelector(".date-shortcut-editor")).toBeNull();
  });
  it("取消丢弃增删；重置后仍需保存才生效", async () => {
    await click("编辑快捷日期"); await click("删除第1项"); await click("取消");
    expect(state.update).not.toHaveBeenCalled();
    await click("编辑快捷日期"); expect(host.querySelectorAll(".date-shortcut-rule")).toHaveLength(5);
    await click("删除第1项"); await click("恢复默认"); expect(state.update).not.toHaveBeenCalled();
    await click("保存"); expect(state.update).toHaveBeenCalledWith({ dateShortcuts: defaultDateShortcuts() });
  });
  it("输入名称时隔离应用导航快捷键，保留输入自身的原生行为", async () => {
    await click("编辑快捷日期");
    const navigation = vi.fn(); document.addEventListener("keydown", navigation);
    try {
      const input = host.querySelector<HTMLInputElement>('.date-shortcut-name input')!;
      for (const key of ["1", "2", "k", "f"]) {
        const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
        await act(async () => input.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(false);
      }
      expect(navigation).not.toHaveBeenCalled();
    } finally { document.removeEventListener("keydown", navigation); }
  });
});
