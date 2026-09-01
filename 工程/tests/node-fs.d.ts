// 这个仓库是纯前端项目，没装 @types/node，tsconfig 的 types 也只开了 vite/client。
// 但有的测试要按文件名把源码当**文本**读出来核对（比如动效常量有没有散回各个 css 里）——
// 样式走不了 Vite 的 ?raw：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
// 所以就地声明用得到的那两个函数，不为此把一整套 node 类型拉进来。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  // 递归收 .tsx 时用来分辨「这一项是目录还是文件」（commit-guards 那条全仓扫描）
  export function statSync(path: string): { isDirectory(): boolean };
}
