// 测试使用真实 SHA256；与仓库现有 node-fs 声明相同，仅补用到的 Node 接口。
declare module "node:crypto" {
  export const webcrypto: Crypto;
  export function createHash(algorithm: string): { update(data: Uint8Array | string): { digest(encoding: "hex"): string } };
}
