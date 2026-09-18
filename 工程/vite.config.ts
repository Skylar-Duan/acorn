/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// 版本号的真源是 versions.json（2026-09-18 起三端各排各的号，见 src/core/version.ts）。
// 三端公开的号整张表写进产物，跑起来再按「我是哪一端」挑自己那个；
// 打包脚本给某一端单独打包（尤其测试版）时，再用环境变量盖一个「这一包是谁、几号」的戳
const versionTable = JSON.parse(readFileSync(resolve(__dirname, "versions.json"), "utf8")) as {
  public: Record<string, string>;
};
const buildStamp = {
  platform: process.env.ACORN_BUILD_PLATFORM ?? "",
  version: process.env.ACORN_BUILD_VERSION ?? "",
};

/** 网页版挂在 acorn.cdpandas.com 的这个子路径下。介绍页占着根路径，两边不打架。
 *  manifest.webmanifest 里的 start_url / scope / 图标路径都写死成这个前缀，改这儿要一起改。 */
const WEB_BASE = "/app/";

/**
 * 网页版：把正文字体提前排进下载队列。
 *
 * 字体文件名打包后带指纹（notosanssc-regular-a1b2c3.woff2），没法在 index.html 里写死，
 * 所以等产物出来了再把 preload 塞进 head。桌面包不需要这一步——字体就在本机硬盘上。
 *
 * 配 font-display: swap 一起看：swap 保证首屏立刻用系统字体出字、不白屏，
 * preload 只是让「换成自家字体」这一下早点发生，少闪一次。
 */
function webFontPreload(): Plugin {
  return {
    name: "acorn-web-font-preload",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {}).filter((f) => /notosanssc-[^/]*\.woff2$/.test(f));
        if (fonts.length === 0) return html;
        return {
          html,
          // crossorigin 这个空属性不能省：字体请求天生是匿名跨源模式，
          // preload 不带它会被当成另一个请求，等于白下一遍
          tags: fonts.map((f) => ({
            tag: "link",
            attrs: {
              rel: "preload",
              as: "font",
              type: "font/woff2",
              crossorigin: "",
              href: WEB_BASE + f,
            },
            injectTo: "head-prepend" as const,
          })),
        };
      },
    },
  };
}

// `npx vite build --mode web` 出网页版，不带 --mode 就还是桌面 / 安卓那条。
// 不另开一份配置文件：两端九成是同一套东西，分叉只有下面标着 isWeb 的几处，
// 写在一起才看得见到底差在哪。
export default defineConfig(({ mode }) => {
  const isWeb = mode === "web" || process.env.VITE_ACORN_WEB === "1";

  return {
    plugins: [react(), ...(isWeb ? [webFontPreload()] : [])],
    define: {
      __APP_VERSIONS__: JSON.stringify(versionTable.public),
      __APP_BUILD__: JSON.stringify(buildStamp),
      // 代码里判断「我是不是网页版」认这个。用 define 写死进产物，
      // 不依赖 .env 文件在不在、shell 有没有导出，换台机器打包结果一样
      "import.meta.env.VITE_ACORN_WEB": JSON.stringify(isWeb ? "1" : ""),
    },
    resolve: {
      // 网页版换一份更轻的字体声明（只带正文、不带文楷，省 3.2 MB）。
      // 走别名而不是在 fonts.css 里加条件：CSS 没有「按构建目标分支」这回事，
      // 而 base.css 是别处的地盘，不该为了这件事去动它
      alias: isWeb
        ? [{ find: /^\.\/fonts\.css$/, replacement: resolve(__dirname, "src/styles/fonts-web.css") }]
        : [],
    },
    // 桌面 / 安卓走相对路径（打包后是 file:// 式的本地加载）；
    // 网页版写死成 /app/：加到主屏幕后深链接也能回到同一份 index.html，相对路径那时会算歪
    base: isWeb ? WEB_BASE : "./",
    clearScreen: false,
    server: { port: 5173, strictPort: true },
    build: {
      target: "chrome110",
      outDir: isWeb ? "dist-web" : "dist",
      rollupOptions: {
        input: isWeb
          ? // 网页版只有主窗口。quickadd / focus / guide 是桌面独立窗口的入口，
            // 浏览器里根本没人会去开它们，打进去只是白占体积
            { main: resolve(__dirname, "index.html") }
          : {
              main: resolve(__dirname, "index.html"),
              quickadd: resolve(__dirname, "quickadd.html"),
              focus: resolve(__dirname, "focus.html"),
              // 每个独立窗口的 html 都要在这儿登记。漏了的话 dev 正常（vite 现伺服），
              // 打包后 dist 里没有这个文件，窗口一开就是白的
              guide: resolve(__dirname, "guide.html"),
            },
      },
    },
    test: {
      environment: "jsdom",
      include: ["tests/**/*.test.ts"],
    },
  };
});
