// v1.15.x · 更新弹窗里有一段字贴在框的左边线上，比其他段落往左凸出 22px。
//
// 病根：弹窗外壳 .modal 本身没有内边距，框里每一段都靠自己加左右 22px（.update-note 等），
// 但 v1.15.x 新加的那句「装完打开，更新日志里会列出这次一起装上的所有版本…」用的是
// .up-skipped，全仓库没有这个类的样式，字就直接贴在框的左边线上。三端共用同一份 CSS，
// 改一处三端一起修好。
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import updateDialogSource from "../src/components/UpdateDialog.tsx?raw";

const read = (p: string) => readFileSync(p, "utf8");
const overlaysCss = read("src/styles/overlays.css");

describe("更新弹窗：说明文字左右对齐，不再贴边", () => {
  it("🔴 那句「装完打开…」不再用没有样式的 .up-skipped，改用带内边距的 .update-note", () => {
    expect(updateDialogSource).not.toContain("up-skipped");
    expect(updateDialogSource).toContain('className="update-hint update-note"');
    // .update-note 本身要带左右内边距，且跟框里其他段落一致（22px）
    expect(overlaysCss).toContain(".update-note { padding: 0 22px 12px;");
  });

  it("🔴 底栏 .update-foot 的左右内边距跟其他段落统一成 22px（原来是 20px，差了 2px）", () => {
    const foot = overlaysCss.slice(overlaysCss.indexOf(".update-foot {"));
    expect(foot.slice(0, foot.indexOf("}"))).toContain("padding: 12px 22px;");
  });
});
