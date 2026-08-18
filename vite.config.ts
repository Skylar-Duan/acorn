/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// 版本号只有 package.json 一个真源；关于页与导出文件的版本都从这儿来，不会写歪
const pkgVersion = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  base: "./",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    target: "chrome110",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        quickadd: resolve(__dirname, "quickadd.html"),
        focus: resolve(__dirname, "focus.html"),
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
