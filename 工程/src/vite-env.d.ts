/// <reference types="vite/client" />

/** 由 vite.config.ts 注入：三端各自公开的版本号，真源是 versions.json 的 public */
declare const __APP_VERSIONS__: Partial<Record<"desktop" | "android" | "web", string>>;
/** 由 vite.config.ts 注入：打包脚本给这一包盖的戳（哪一端、几号），没盖就是两个空串 */
declare const __APP_BUILD__: { platform: string; version: string };
