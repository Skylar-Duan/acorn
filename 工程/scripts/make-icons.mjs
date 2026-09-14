// icon.svg → PNG。两批产物，一次跑完：
//   ① src-tauri/icons/app-icon.png（1024）→ 交给 `tauri icon` 生成全套平台图标
//   ② public/icons/*.png → 网页版（PWA）加到主屏幕时用的图标
//
// 为什么网页那批要单独出「满版」的一张：icon.svg 画的是一块**圆角米色底板**，
// 板外是透明的。iOS 的 apple-touch-icon 不认透明，会把透明处填成黑色，
// 主屏上就是一颗黑方块里嵌着橡果；安卓的 maskable 图标则要自己再裁一次形状，
// 圆角外那圈透明会被裁成豁口。所以满版这张把底板拉到画布边缘，圆角交给系统去切。
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(root, "src-tauri/icons/icon.svg"), "utf8");

/** 底板从「居中 896 见方的圆角块」撑成「满画布」。橡果本体（x 286–738 / y 186–846）
 *  仍落在 maskable 要求的中间 80% 安全区里，系统怎么裁都不会切到它。 */
const FULL_BLEED_PLATE = '<rect x="0" y="0" width="1024" height="1024" fill="url(#plate)"/>';
const bleedSvg = svg.replace(
  /<rect x="64" y="64" width="896" height="896" rx="232" fill="url\(#plate\)"\/>/,
  FULL_BLEED_PLATE,
);
if (bleedSvg === svg) {
  // 有人重画了 icon.svg 却没改这儿——与其悄悄出一批带透明角的图标，不如当场停
  throw new Error("icon.svg 里没找到那块圆角底板 rect，满版图标生成不了（改过 icon.svg 就同步改这里）");
}

const png = (source, size) =>
  new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng();

const write = (relPath, buf) => {
  const out = resolve(root, relPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  console.log("wrote", relPath, buf.length, "bytes");
};

// ① 桌面 / 安卓那套的源图，维持原样（带圆角底板的 1024）
write("src-tauri/icons/app-icon.png", png(svg, 1024));

// ② 网页版图标。192 是安卓主屏那档，512 是安装弹窗和启动图那档，
//    180 是 iPhone「添加到主屏幕」认的尺寸（apple-touch-icon）。
write("public/icons/acorn-192.png", png(svg, 192));
write("public/icons/acorn-512.png", png(svg, 512));
write("public/icons/acorn-maskable-512.png", png(bleedSvg, 512));
write("public/icons/apple-touch-icon-180.png", png(bleedSvg, 180));
