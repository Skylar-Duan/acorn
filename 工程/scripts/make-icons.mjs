// icon.svg → 1024px PNG → 交给 `tauri icon` 生成全套平台图标
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(root, "src-tauri/icons/icon.svg"), "utf8");
const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
const out = resolve(root, "src-tauri/icons/app-icon.png");
writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
