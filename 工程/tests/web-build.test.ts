// 网页版的地基（v1.15.0）：构建配置、PWA 外壳、服务器落位、介绍页入口。
//
// 这些东西没法在 jsdom 里「跑一遍看看」——它们要么是打包器配置，要么是服务器配置，
// 要么是发布脚本。但每一条都有过血泪：写歪一个前缀整页白屏，少一句 types 苹果就不认这份清单，
// 缓存头写反了发了新版用户还看老的。所以这里钉的是**当初为什么这么定**。
//
// 顺带钉住三条不许破的边界：
//   ① 只有一份 index.html（桌面 / 安卓 / 网页共用，不许为网页另开一份）
//   ② 网页版不许把文楷打进去（3.2 MB，每个新访客都要下一遍）
//   ③ 发布网页版不许走 10-Platform 的 publish_utility.py（那条通道校验工具页模板，网页版是 App 不是介绍页）
import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";

const read = (p: string): string => readFileSync(p, "utf8");

const viteConfig = read("vite.config.ts");
const indexHtml = read("index.html");
const manifest = JSON.parse(read("public/manifest.webmanifest")) as Record<string, any>;
const fontsWeb = read("src/styles/fonts-web.css");
const fontsCss = read("src/styles/fonts.css");
const nginx = read("server/deploy/nginx-acorn.conf");
const publishWeb = read("server/deploy/publish-web.sh");
const themes = read("src/styles/themes.css");
const siteHtml = read("../网站/index.html");
const siteCopy = read("网站文案.md");

// 下面好几条钉的是「代码里有没有这个东西」，而这些文件的注释里正好都在解释「为什么没有它」。
// 连注释一起搜就会自己把自己判死，所以先把注释摘掉再断言。
const withoutCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const withoutShellComments = (sh: string): string =>
  sh.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/** PNG 的宽高就写在 IHDR 里（偏移 16 / 20 各四字节大端），不用解码整张图。
 *  按字节读的写法跟 android-icon.test.ts 一致（这个仓库没装 @types/node，走 DataView） */
function pngSize(path: string): { w: number; h: number } {
  const bytes = readFileSync(path);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

describe("网页版构建（vite.config.ts）", () => {
  it("多出来的是一条支线，不是另一份配置文件", () => {
    // 两端九成是同一套东西。拆成两份配置，迟早有人只改了一边
    expect(viteConfig).toMatch(/mode === "web"/);
    expect(viteConfig).toMatch(/outDir: isWeb \? "dist-web" : "dist"/);
  });

  it("网页版挂在 /app/ 下：介绍页占着根路径，两边不打架", () => {
    expect(viteConfig).toMatch(/const WEB_BASE = "\/app\/"/);
    // 桌面 / 安卓仍是相对路径（打包后本地加载），这条不许被网页版顺手改掉
    expect(viteConfig).toMatch(/base: isWeb \? WEB_BASE : "\.\/"/);
  });

  it("代码里判断「我是不是网页版」认 VITE_ACORN_WEB，而且是 define 写死进产物的", () => {
    // 靠 .env 文件或 shell 环境变量的话，换台机器打包结果就不一样了
    expect(viteConfig).toMatch(/"import\.meta\.env\.VITE_ACORN_WEB": JSON\.stringify\(isWeb \? "1" : ""\)/);
  });

  it("桌面 / 安卓那条的四个窗口入口一个都没少", () => {
    // 漏登记的话 dev 正常（vite 现伺服），打包后窗口一开就是白的
    for (const entry of ["index.html", "quickadd.html", "focus.html", "guide.html"]) {
      expect(viteConfig, entry).toContain(`resolve(__dirname, "${entry}")`);
    }
    // 网页版只要主窗口：quickadd / focus / guide 是桌面独立窗口，浏览器里没人开得了
    expect(viteConfig).toMatch(/input: isWeb\s*\?/);
  });

  it("字体预加载插件只在网页版挂，桌面包不掺和", () => {
    expect(viteConfig).toMatch(/plugins: \[react\(\), \.\.\.\(isWeb \? \[webFontPreload\(\)\] : \[\]\)\]/);
    // preload 的 font 请求天生是匿名跨源模式，少了 crossorigin 等于白下一遍
    expect(viteConfig).toMatch(/crossorigin: ""/);
  });
});

describe("PWA 外壳（index.html + manifest）", () => {
  it("只有一份 index.html，三端共用", () => {
    // 另开一份 index-web.html 的话，以后改 viewport / 标题就得记得改两处，必漏
    expect(() => statSync("index-web.html")).toThrow();
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it("href 写 / 开头，交给 vite 按各自的 base 改写", () => {
    // 手改成相对路径的话，网页版加到主屏幕后从子路径打开就全 404
    expect(indexHtml).toMatch(/href="\/icons\/apple-touch-icon-180\.png"/);
    expect(indexHtml).not.toMatch(/href="\.\/(icons|manifest)/);
  });

  it("iPhone 加到主屏幕那几句都在", () => {
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(indexHtml).toContain('<meta name="mobile-web-app-capable" content="yes" />');
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="橡果" />');
  });

  it("状态栏用 default 而不是 black-translucent", () => {
    // black-translucent 会让页面画到状态栏底下，而 iOS 状态栏的字始终是白的，
    // 压在橡果这种浅色纸面上看不清。换回去之前先想清楚这件事
    expect(indexHtml).toMatch(/apple-mobile-web-app-status-bar-style" content="default"/);
  });

  it("安卓那句 viewport-fit=cover 还在（网页版这几句不许把它挤掉）", () => {
    expect(indexHtml).toMatch(/viewport-fit=cover/);
  });

  it("theme-color 取默认主题「森林」的底纸色，深浅两档都给", () => {
    const light = /\[data-theme="forest"\]\[data-mode="light"\][\s\S]*?--bg:\s*(#[0-9A-Fa-f]{6})/.exec(themes);
    const dark = /\[data-theme="forest"\]\[data-mode="dark"\][\s\S]*?--bg:\s*(#[0-9A-Fa-f]{6})/.exec(themes);
    expect(light?.[1]).toBeTruthy();
    expect(dark?.[1]).toBeTruthy();
    expect(indexHtml).toContain(`(prefers-color-scheme: light)" content="${light![1]}"`);
    expect(indexHtml).toContain(`(prefers-color-scheme: dark)" content="${dark![1]}"`);
    // 主屏启动图的底色也得是同一个，否则打开那一下会闪一块别的颜色
    expect(manifest.background_color).toBe(light![1]);
    expect(manifest.theme_color).toBe(light![1]);
  });

  it("manifest 指的是 /app/，display 是 standalone", () => {
    expect(manifest.name).toBe("橡果 Acorn");
    expect(manifest.short_name).toBe("橡果");
    // start_url / scope 跟 vite 的 base 是同一个前缀，对不上的话加到主屏幕点开会跳回浏览器
    expect(manifest.start_url).toBe("/app/");
    expect(manifest.scope).toBe("/app/");
    expect(manifest.display).toBe("standalone");
  });

  it("192 / 512 两档图标真的在，尺寸也真的对得上", () => {
    for (const icon of manifest.icons as Array<{ src: string; sizes: string }>) {
      const file = icon.src.replace(/^\/app\//, "public/");
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(file), icon.src).toEqual({ w, h });
    }
    // iPhone 认的是 apple-touch-icon，而且它不认透明——所以给的是满版那张（见 make-icons.mjs）
    expect(pngSize("public/icons/apple-touch-icon-180.png")).toEqual({ w: 180, h: 180 });
    expect((manifest.icons as Array<{ purpose: string }>).some((i) => i.purpose === "maskable")).toBe(true);
  });
});

describe("字体：网页版这端的取舍", () => {
  it("网页版不带文楷 —— 3.2 MB，每个新访客第一次打开都要下一遍", () => {
    const rules = withoutCssComments(fontsWeb);
    expect(rules).not.toContain("lxgwwenkai");
    expect(rules).not.toContain("LXGW WenKai");
    // 桌面包那份照旧带着，别顺手把两边一起砍了
    expect(fontsCss).toContain("lxgwwenkai-regular.woff2");
    expect(fontsCss).toContain("lxgwwenkai-medium.woff2");
  });

  it("正文两档都留着，而且是 swap（首屏先用系统字出字，不白屏）", () => {
    expect(fontsWeb).toContain("notosanssc-regular.woff2");
    expect(fontsWeb).toContain("notosanssc-bold.woff2");
    expect(withoutCssComments(fontsWeb).match(/font-display:\s*swap/g)?.length).toBe(2);
  });

  it("网页版首屏的字体总量守在 2.5 MB 以内", () => {
    // 超了基本只有一个原因：文楷又被打进来了
    const bytes = ["notosanssc-regular", "notosanssc-bold"]
      .reduce((s, f) => s + statSync(`src/assets/fonts/${f}.woff2`).size, 0);
    expect(bytes).toBeLessThan(2_500_000);
  });

  it("换字体走的是别名，不是去改 base.css（那是别人的地盘）", () => {
    expect(viteConfig).toMatch(/find: \/\^\\\.\\\/fonts\\\.css\$\/[\s\S]*?fonts-web\.css/);
  });
});

describe("服务器落位（nginx-acorn.conf）", () => {
  it("/app/ 这一段在，找不到的路径回 index.html", () => {
    expect(nginx).toMatch(/location \/app\/ \{/);
    expect(nginx).toMatch(/alias \/var\/www\/acorn-web\//);
    // 加到主屏幕后系统可能从某个子路径重新打开它，那时候不能给人一个 404
    expect(nginx).toMatch(/try_files \$uri \$uri\/ \/app\/index\.html;/);
    expect(nginx).toMatch(/location = \/app \{/); // 少一条斜杠也得能进去
  });

  it("webmanifest 的 MIME 自己补上：nginx 自带的 mime.types 里没有", () => {
    // 不补就当 text/plain 发出去，Safari 不认这份清单，加到主屏幕退化成普通书签
    expect(nginx).toMatch(/application\/manifest\+json\s+webmanifest;/);
  });

  it("带指纹的资源永久缓存，index.html 绝不缓存", () => {
    expect(nginx).toMatch(/location \^~ \/app\/assets\/[\s\S]*?max-age=31536000, immutable/);
    expect(nginx).toMatch(/location \/app\/ \{[\s\S]*?Cache-Control "no-cache"/);
  });

  it("每个写了 add_header 的 location 都把两条安全头重新写了一遍", () => {
    // add_header 在 location 里是整组覆盖父级的，不是追加——漏写就等于没有
    const appBlocks = nginx.match(/location (\^~ )?\/app[\/ ][\s\S]*?\n    \}/g) ?? [];
    const withHeaders = appBlocks.filter((b) => b.includes("add_header Cache-Control"));
    expect(withHeaders.length).toBeGreaterThanOrEqual(2);
    for (const b of withHeaders) {
      expect(b).toContain("Strict-Transport-Security");
      expect(b).toContain("X-Content-Type-Options");
    }
  });

  it("介绍页、同步接口、下载目录三段一个字没动", () => {
    expect(nginx).toContain("include /etc/nginx/acorn-site.inc;");
    expect(nginx).toMatch(/location \/api\/auth\/ \{[\s\S]*?zone=acorn_auth/);
    expect(nginx).toMatch(/location \/api\/ \{[\s\S]*?zone=acorn_sync/);
    expect(nginx).toMatch(/location \/download\/ \{[\s\S]*?alias \/var\/www\/acorn-public\//);
  });
});

describe("发布脚本（publish-web.sh）", () => {
  it("不走 10-Platform 那条通道", () => {
    // publish_utility.py 会校验「页面必须挂工具页模板」，网页版是 App 本体不是介绍页。
    // 脚本抬头的注释里写着「不要走它」，所以这里只看真正会执行的那些行
    expect(withoutShellComments(publishWeb)).not.toContain("publish_utility");
  });

  it("传上去之前先自检产物，base 写歪当场停", () => {
    // base 错了所有资源都 404，页面是白的，而且发出去才发现
    expect(publishWeb).toContain('grep -q \'src="/app/assets/\'');
    expect(publishWeb).toMatch(/manifest\.webmanifest.*不在|少了 manifest\.webmanifest/);
    // 字体胀回去（文楷被打进来）也当场停
    expect(publishWeb).toMatch(/FONT_BYTES.*-gt 3000000/);
  });

  it("--dry-run 一个字节都不往服务器传", () => {
    expect(publishWeb).toMatch(/if \[ "\$DRY_RUN" = "1" \]; then[\s\S]*?exit 0/);
  });

  it("version.json 由 python 自己写文件，不走 stdout", () => {
    // Windows 上 stdout 是 GBK，重定向出来的不是合法 UTF-8，服务端 read_text 直接报错
    // （publish-exe.sh 2026-08-24 踩过）
    expect(publishWeb).toContain('io.open(out, "w", encoding="utf-8")');
    expect(publishWeb).toMatch(/valid UTF-8 JSON/);
  });

  it("整目录原子替换，不是逐个文件覆盖", () => {
    // 新 index.html 上去了、新 js 还没上去，这中间谁打开页面就是一片白
    expect(publishWeb).toMatch(/mv "\$REMOTE_DIR\.new" "\$REMOTE_DIR"/);
  });

  it("产物之外还得把 nginx 配置一起装上，否则发完是 404", () => {
    // /app/ 那两段 location 只写在仓库这份 conf 里。线上那份还停在「现在不占」的年代，
    // 只传产物的话浏览器打开 /app/ 会掉进 server 块末尾的 return 404（deploy.sh 推配置那条路
    // 被 --code 的 exit 0 挡死了，指望不上）
    const sh = withoutShellComments(publishWeb);
    expect(sh).toMatch(/\$\{SCP\[@\]\}" "\$NGINX_CONF" "\$HOST:\/tmp\/acorn\.conf"/);
    expect(sh).toContain("CONF=/etc/nginx/conf.d/acorn.conf");
    // 坏配置绝不让 nginx 重载：这台机器上还跑着 finance / sbg / osmoeng / petlink
    expect(sh).toMatch(/if ! nginx -t; then[\s\S]*?cp "\$BAK" "\$CONF"[\s\S]*?exit 1/);
    expect(sh).toMatch(/systemctl reload nginx/);
    // 装配置这一步必须在 --dry-run 那道 exit 0 之后：--dry-run 一个字节都不许往服务器传
    expect(sh.indexOf("NGINX_CONF\" \"$HOST")).toBeGreaterThan(sh.indexOf('DRY_RUN" = "1"'));
    // 本地自检就该发现 conf 丢了，不用等发到一半
    expect(publishWeb).toContain('grep -q \'location /app/ {\' "$NGINX_CONF"');
  });

  it("发完从外网自测一遍，任何一条不是 200 就当场失败", () => {
    // 以前只打印 %{http_code} 不判返回码，HTTP 404 照样打印「发完了」
    const sh = withoutShellComments(publishWeb);
    expect(publishWeb).toMatch(/curl[\s\S]*?\$SITE\/app\//);
    expect(sh).toContain("%{http_code}");
    expect(sh).toMatch(/\[ "\$code" = "200" \] \|\| FAILED=/);
    expect(sh).toMatch(/if \[ -n "\$FAILED" \]; then[\s\S]*?exit 1/);
    // 四条都得查：三条网页版的，加一条介绍页——「我没把别人的站弄坏」的证据
    for (const path of ["check /app/ ", "check /app/manifest.webmanifest ", "check /app/version.json ", "check / "]) {
      expect(sh, path).toContain(path);
    }
    expect(sh).toMatch(/check \/ "介绍页/);
  });

  it("版本清单的字段跟 webUpdate.ts 对得上", () => {
    // 一边写 version、一边读 ver 的话，网页版永远发现不了新版
    expect(publishWeb).toContain('"version": ver');
    expect(read("src/core/webUpdate.ts")).toMatch(/\(raw as Record<string, unknown>\)\.version/);
  });
});

describe("介绍页入口", () => {
  it("文案真源先改了，页面才跟着改", () => {
    // 纪律见 网站文案.md 抬头：页面上每一句中文以它为准，不许在 HTML 里就地改
    expect(siteCopy).toContain("并排按钮：打开网页版");
    expect(siteCopy).toContain("添加到主屏幕");
  });

  it("下载按钮旁边并排一颗「打开网页版」，指向 /app/", () => {
    expect(siteHtml).toContain(">打开网页版</a>");
    expect(siteHtml).toContain('href="https://acorn.cdpandas.com/app/"');
    // 下载仍是主按钮（9-17 起改成「一个按钮 + 平台弹窗」，用户要的：平台只会越来越多），
    // 弹窗里 Windows 和安卓两行都在，各指向固定下载名
    expect(siteHtml).toContain('<button class="btn" type="button" data-download-open>');
    expect(siteHtml).toContain('data-href="https://acorn.cdpandas.com/download/windows/Acorn-latest-x64-setup.exe"');
    expect(siteHtml).toContain('data-href="https://acorn.cdpandas.com/download/android/Acorn-latest-arm64.apk"');
  });

  it("手机那段写清了 iPhone 怎么加到主屏幕", () => {
    expect(siteHtml).toMatch(/Safari[\s\S]{0,80}分享[\s\S]{0,40}添加到主屏幕/);
  });
});
