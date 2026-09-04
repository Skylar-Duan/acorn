// 安卓桌面图标的两层（2026-09-03 · 手机图标比例）。
//
// 用户 v1.12.0 真机截图：橡果撑满圆角方块、帽子顶到边。根因是 build-android.sh 拿整张
// app-icon.png（自带米色圆角底板的全出血图）当安卓前景。安卓的自适应图标只露出前景
// 中间 72/108 的安全区，再套桌面自己的形状——带底板的整图当前景 = 放大 1.5 倍再裁。
//
// 现在改成图标清单 icon-manifest.json：default 仍是 app-icon.png（Windows 那套图标不动），
// 安卓单独给两层：android-bg.png 纯底色 + android-fg.png 只有橡果本体、四周留白。
// 这里钉的是**几何关系**，因为它没法在 jsdom 里「看」：
//   ① 清单还指着这三张图，打包脚本走的是清单而不是整图
//   ② 两层都是 1024 方图，前景带透明通道，底色是桌面底板那种米色而不是纯白
//   ③ 前景里的橡果落在安全区正中：高约 40% 画布、顶上留够、左右居中——
//      换算成系统裁完安全区后的样子就是「橡果占圆角方块六成出头、帽顶离边 ≥15%」
//   ④ tauri 生成的 mipmap（gen/ 不进仓库，只在本机存在时才查）确实用了 png 底色层
//
// PNG 要真解开才能量，所以带了一个够用的最小解码器（8 位 RGB/RGBA、非隔行、五种滤波）。
import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";

const ICONS = "src-tauri/icons";
const MANIFEST = `${ICONS}/icon-manifest.json`;
const RES = "src-tauri/gen/android/app/src/main/res";

const exists = (p: string): boolean => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

type Png = { w: number; h: number; depth: number; ctype: number; interlace: number; idat: Uint8Array[] };

/** 只拆 chunk，不解像素 */
function parsePng(bytes: Uint8Array): Png {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error("not a png");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Png = { w: 0, h: 0, depth: 0, ctype: 0, interlace: 0, idat: [] };
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      out.w = dv.getUint32(off + 8);
      out.h = dv.getUint32(off + 12);
      out.depth = data[8];
      out.ctype = data[9];
      out.interlace = data[12];
    } else if (type === "IDAT") {
      out.idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** 解到像素：返回 bpp（3=RGB / 4=RGBA）和一条平铺的字节数组 */
function decodePng(path: string) {
  const png = parsePng(readFileSync(path));
  if (png.depth !== 8 || png.interlace !== 0) throw new Error(`${path}: 只支持 8 位非隔行`);
  const bpp = png.ctype === 6 ? 4 : png.ctype === 2 ? 3 : 0;
  if (!bpp) throw new Error(`${path}: 颜色类型 ${png.ctype} 不在支持范围`);
  const total = png.idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let p = 0;
  for (const c of png.idat) {
    joined.set(c, p);
    p += c.length;
  }
  const raw = inflateSync(joined);
  const stride = png.w * bpp;
  const px = new Uint8Array(png.w * png.h * bpp);
  for (let y = 0; y < png.h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y > 0 ? px[dst - stride + i] : 0;
      const c = y > 0 && i >= bpp ? px[dst - stride + i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`${path}: 未知滤波 ${filter}`);
      }
      px[dst + i] = v & 255;
    }
  }
  return { w: png.w, h: png.h, bpp, px, ctype: png.ctype };
}

/** alpha ≥ threshold 的像素包围盒（含端点，右/下为开区间） */
function alphaBox(img: ReturnType<typeof decodePng>, threshold: number) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.px[(y * img.w + x) * 4 + 3] >= threshold) {
        if (x < x0) x0 = x;
        if (x >= x1) x1 = x + 1;
        if (y < y0) y0 = y;
        if (y >= y1) y1 = y + 1;
      }
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>;

describe("安卓图标清单：桌面那张不动，安卓单独两层", () => {
  it("default 仍是 app-icon.png，安卓前景/底色指向拆出来的两张图", () => {
    expect(manifest.default).toBe("app-icon.png");
    expect(manifest.android_fg).toBe("android-fg.png");
    expect(manifest.android_bg).toBe("android-bg.png");
    expect(exists(`${ICONS}/app-icon.png`)).toBe(true);
    expect(exists(`${ICONS}/android-fg.png`)).toBe(true);
    expect(exists(`${ICONS}/android-bg.png`)).toBe(true);
  });

  it("android_fg_scale 是个百分数（它只管旧机型的 ic_launcher.png，别写成 0.x 的小数——那样旧图标会缩成一个点）", () => {
    expect(typeof manifest.android_fg_scale).toBe("number");
    expect(manifest.android_fg_scale as number).toBeGreaterThanOrEqual(50);
    expect(manifest.android_fg_scale as number).toBeLessThanOrEqual(100);
  });

  it("打包脚本走清单，不再拿整张 app-icon.png 当安卓前景", () => {
    const sh = readFileSync("scripts/build-android.sh", "utf8");
    expect(sh).toContain("npx tauri icon src-tauri/icons/icon-manifest.json");
    expect(sh).not.toContain("npx tauri icon src-tauri/icons/app-icon.png");
  });
});

describe("android-bg.png：1024 方图、桌面底板那种米色、完全不透明", () => {
  const bg = decodePng(`${ICONS}/android-bg.png`);

  it("尺寸 1024×1024", () => {
    expect([bg.w, bg.h]).toEqual([1024, 1024]);
  });

  it("四角和正中都是同一个米色（不是纯白，跟桌面图标底板同一色系）", () => {
    const at = (x: number, y: number) => Array.from(bg.px.subarray((y * bg.w + x) * bg.bpp, (y * bg.w + x) * bg.bpp + 3));
    const c = at(512, 512);
    for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023], [300, 700]]) expect(at(x, y)).toEqual(c);
    // 桌面底板渐变 #FFFDF8 → #FCF1E1 之间的暖米色：R 最高、B 最低，且不是 #FFFFFF
    expect(c[0]).toBeGreaterThanOrEqual(0xf8);
    expect(c[2]).toBeLessThanOrEqual(0xf1);
    expect(c[2]).toBeGreaterThanOrEqual(0xe1);
    expect(c).not.toEqual([255, 255, 255]);
    if (bg.bpp === 4) expect(bg.px[3]).toBe(255);
  });
});

describe("android-fg.png：只有橡果本体，落在安全区正中", () => {
  const fg = decodePng(`${ICONS}/android-fg.png`);
  // 安卓只露出中间 72/108；这里按 1024 画布换算
  const SAFE0 = Math.round(1024 * 18 / 108); // 171
  const SAFE1 = 1024 - SAFE0; // 853
  const VISIBLE = SAFE1 - SAFE0; // 682
  const solid = alphaBox(fg, 128); // 橡果本体（柄顶到果底）
  const any = alphaBox(fg, 1); // 连落影一起

  it("1024×1024、带透明通道，四角是透明的（没有那块圆角底板）", () => {
    expect([fg.w, fg.h, fg.ctype]).toEqual([1024, 1024, 6]);
    for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023], [100, 100], [924, 924]]) {
      expect(fg.px[(y * fg.w + x) * 4 + 3]).toBe(0);
    }
  });

  it("连落影在内的所有像素都在安全区里，而且离安全区边缘还有余量（≥ 安全区的 10%）", () => {
    const margin = VISIBLE * 0.1;
    expect(any.x0).toBeGreaterThanOrEqual(SAFE0 + margin);
    expect(any.y0).toBeGreaterThanOrEqual(SAFE0 + margin);
    expect(any.x1).toBeLessThanOrEqual(SAFE1 - margin);
    expect(any.y1).toBeLessThanOrEqual(SAFE1 - margin);
  });

  it("橡果本体高度是画布的 38%–44%——裁完安全区就是圆角方块的 57%–66%", () => {
    const ratio = solid.h / 1024;
    expect(ratio).toBeGreaterThanOrEqual(0.38);
    expect(ratio).toBeLessThanOrEqual(0.44);
    const visibleRatio = solid.h / VISIBLE;
    expect(visibleRatio).toBeGreaterThanOrEqual(0.57);
    expect(visibleRatio).toBeLessThanOrEqual(0.66);
  });

  it("帽顶（柄顶）离裁完后的上边 ≥15%，果底离下边 ≥12%", () => {
    expect((solid.y0 - SAFE0) / VISIBLE).toBeGreaterThanOrEqual(0.15);
    expect((SAFE1 - solid.y1) / VISIBLE).toBeGreaterThanOrEqual(0.12);
  });

  it("左右居中（包围盒中心离画布中线不超过 8px），宽度是画布的 26%–36%", () => {
    expect(Math.abs((solid.x0 + solid.x1) / 2 - 512)).toBeLessThanOrEqual(8);
    expect(solid.w / 1024).toBeGreaterThanOrEqual(0.26);
    expect(solid.w / 1024).toBeLessThanOrEqual(0.36);
  });
});

// gen/android 不进仓库；本机跑过 `tauri icon` 才有这些文件，没有就跳过
const hasMipmap = exists(`${RES}/mipmap-anydpi-v26/ic_launcher.xml`);

describe.runIf(hasMipmap)("本机已生成的安卓 mipmap 确实是两层结构", () => {
  it("自适应图标的底色指向 png 底色层，而不是过去那个 #fff 颜色值", () => {
    const xml = readFileSync(`${RES}/mipmap-anydpi-v26/ic_launcher.xml`, "utf8");
    expect(xml).toContain('android:drawable="@mipmap/ic_launcher_foreground"');
    expect(xml).toContain('android:drawable="@mipmap/ic_launcher_background"');
    expect(xml).not.toContain("@color/ic_launcher_background");
  });

  it("每档密度都有前景 + 底色两张，且 xxxhdpi 前景里的橡果没撑满画布", () => {
    for (const d of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
      expect(exists(`${RES}/mipmap-${d}/ic_launcher_foreground.png`)).toBe(true);
      expect(exists(`${RES}/mipmap-${d}/ic_launcher_background.png`)).toBe(true);
    }
    const fg = decodePng(`${RES}/mipmap-xxxhdpi/ic_launcher_foreground.png`);
    expect([fg.w, fg.h]).toEqual([432, 432]);
    const box = alphaBox(fg, 128);
    // 改前整张底板占了 88%；现在橡果本体只该占四成上下
    expect(box.h / 432).toBeLessThanOrEqual(0.46);
    expect(box.h / 432).toBeGreaterThanOrEqual(0.36);
  });
});
