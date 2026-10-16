import { describe, expect, it } from "vitest";
import { listColor } from "../src/core/colors";
import { LIST_COLORS } from "../src/core/model";

describe("分类记录颜色", () => {
  it("既有主题颜色仍由主题变量决定", () => {
    for (const token of LIST_COLORS) expect(listColor(token)).toBe(`var(--list-${token})`);
  });
  it("合法十六进制颜色保留，支持短色、透明度与大小写", () => {
    for (const color of ["#fa0", "#FA08", "#A1b2C3", "#112233ff"]) expect(listColor(color)).toBe(color);
    expect(listColor(" #7A9B40 ")).toBe("#7A9B40");
  });
  it("未知值和不合法CSS不进入样式", () => {
    for (const value of [null, undefined, {}, 42, "", "unknown", "#ggg", "#12", "#12345", "red", "var(--ink)", "url(https://example.test)"])
      expect(listColor(value)).toBe("var(--list-clay)");
  });
});
