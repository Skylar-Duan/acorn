// 安卓图标那组测试要把 PNG 真解开来量橡果落在画布哪里，所以要 node 自带的 zlib，
// 外加一个「不给编码就读回字节」的 readFileSync 重载。仓库没装 @types/node（见 node-fs.d.ts 的说明），
// 同样就地声明用得到的这两个，不为此把整套 node 类型拉进来。
declare module "node:zlib" {
  export function inflateSync(data: Uint8Array): Uint8Array;
}

declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
}
