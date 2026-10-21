import { describe, expect, it } from "vitest";
import { recordShortcut, shortcutKey } from "../src/core/shortcutCapture";

function chord(codes: string[], modifiers: Partial<KeyboardEvent> = {}) {
  return recordShortcut({ code: codes[codes.length - 1], ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers }, new Set(codes));
}

describe("快捷键录制组合", () => {
  it("用实体键保存三键组合，并避开 Shift 和输入法改变的字符", () => {
    expect(chord(["ControlLeft", "ShiftLeft", "KeyA"], { ctrlKey: true, shiftKey: true })).toEqual({ value: "Ctrl+Shift+A", error: "" });
    expect(chord(["AltLeft", "Space"], { altKey: true })).toEqual({ value: "Alt+Space", error: "" });
    expect(chord(["ControlLeft", "ShiftLeft", "Equal"], { ctrlKey: true, shiftKey: true })).toEqual({ value: "Ctrl+Shift+Equal", error: "" });
    expect(chord(["MetaLeft", "KeyA"], { metaKey: true }).value).toBe("Super+A");
    expect(shortcutKey("Numpad1")).toBe("Numpad1");
  });
  it("第四个键不进入显示或保存，纯修饰键、多个字母与未知键无效", () => {
    expect(chord(["ControlLeft", "AltLeft", "ShiftLeft", "KeyA"], { ctrlKey: true, altKey: true, shiftKey: true })).toEqual({ value: "Ctrl+Alt+Shift", error: "最多三个键，请松开后重新按。" });
    expect(chord(["ControlLeft"], { ctrlKey: true }).error).toContain("再按");
    expect(chord(["ControlLeft", "KeyA", "KeyB"], { ctrlKey: true }).error).toContain("一个");
    expect(chord(["ControlLeft", "Unidentified"], { ctrlKey: true }).error).toContain("暂不支持");
    expect(chord(["KeyA"]).error).toContain("避免误触");
    expect(chord(["F8"]).error).toBe("");
  });
  it("拦下会抢走橡果导航、搜索和任务动作的组合，以及常用系统保留键", () => {
    for (const code of ["KeyK", "KeyF", "KeyZ", "KeyD", "Digit1", "Digit5", "ArrowRight"]) {
      expect(chord(["ControlLeft", code], { ctrlKey: true }).error).toContain("橡果");
    }
    expect(chord(["ControlLeft", "ShiftLeft", "KeyK"], { ctrlKey: true, shiftKey: true }).error).toContain("橡果");
    expect(chord(["AltLeft", "F4"], { altKey: true }).error).toContain("系统");
    expect(chord(["ControlLeft", "AltLeft", "Delete"], { ctrlKey: true, altKey: true }).error).toContain("系统");
  });
});
