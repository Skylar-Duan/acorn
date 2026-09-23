# 把介绍页（../网站/index.html）「更新日志」那一段换成跟应用里电脑版更新日志同一份的内容。
#
#   python scripts/site-changelog.py          # 在 工程/ 下跑；写完打印版本数
#
# 为什么有这个脚本（2026-09-23 桌面 1.16.0 发布时加的）：介绍页原来那段是手写的旧写法
# （「某一步也能自己重复了」「手风琴」这些 09-18 被用户批过的说法都在），应用里的日志 09-18 已经按
# _work/约定.md 第五节全部重写。两边不该各说各的，所以介绍页改成从同一份数据生成：
#   · 1.9.0 起：src/core/changelog-data.json 的 desktop（应用里电脑版点版本号看到的就是它）
#   · 1.0.0 ~ 1.8.0：../_work/验收单工具/早期版本.json 的 desktop（应用里不讲这么早，验收页用的也是它）
# 介绍页的「更新日志」读的是桌面版的更新接口（data-release-api），所以这里也只列电脑版的。
#
# 只动两个标记之间的内容（第一次跑时把原来手写的那一整段换成带标记的），页面别处一个字不碰。
# 写文件先写临时文件再替换（总指引：目标文件不直接开 "w" 覆盖写）。
import html, io, json, os, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent  # 工程/
PAGE = HERE.parent / "网站" / "index.html"
DATA = HERE / "src" / "core" / "changelog-data.json"
EARLY = HERE.parent / "_work" / "验收单工具" / "早期版本.json"
BEGIN, END = "<!-- releases:begin（scripts/site-changelog.py 生成，别手改） -->", "<!-- releases:end -->"
SHOW = 3  # 默认只展开最近三版（Skylar 2026-09-02 定），更早的收进「更早的版本」


def ver_key(v: str):
    return tuple(int(x) for x in v.split("."))


def entry_html(e: dict, first: bool) -> str:
    date_attr = ' data-release="date"' if first else ""
    lis = "\n".join(
        f"            <li><b>{html.escape(h['title'])}</b>：{html.escape(h['body'])}</li>" for h in e["highlights"]
    )
    return (
        '      <div class="rel">\n'
        f'        <div class="meta"><div class="ver">v{e["version"]}</div><div class="date"{date_attr}>{e["date"]}</div></div>\n'
        "        <div>\n"
        f"          <p><b>{html.escape(e['headline'])}</b></p>\n"
        "          <ul>\n"
        f"{lis}\n"
        "          </ul>\n"
        "        </div>\n"
        "      </div>\n"
    )


def build() -> tuple[str, str, int]:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    early = json.loads(EARLY.read_text(encoding="utf-8"))
    entries = sorted(data["desktop"] + early["desktop"], key=lambda e: ver_key(e["version"]), reverse=True)
    top, rest = entries[:SHOW], entries[SHOW:]
    parts = [BEGIN + "\n"]
    parts += [entry_html(e, i == 0) + "\n" for i, e in enumerate(top)]
    if rest:
        parts.append('      <details class="rel-more">\n')
        parts.append(f"      <summary>更早的版本（{len(rest)}）</summary>\n\n")
        parts += [entry_html(e, False) + "\n" for e in rest]
        parts.append("      </details>\n")
    parts.append("      " + END)
    return "".join(parts), entries[0]["version"], len(entries)


def main() -> None:
    page = io.open(PAGE, encoding="utf-8", newline="").read()
    block, newest, n = build()
    if BEGIN in page:
        a = page.index(BEGIN)
        b = page.index(END, a) + len(END)
    else:
        # 第一次：从 .releases 这个 div 的开标签之后，到它自己的收尾 </div> 之前，整段换掉
        m = re.search(r'<div class="releases"[^>]*>\n', page)
        if not m:
            sys.exit("找不到 <div class=\"releases\" …>")
        a = m.end()
        close = re.search(r"\n      </details>\n\n    </div>", page[a:])
        if not close:
            sys.exit("找不到更新日志那段的收尾（</details> 后面紧跟 .releases 的 </div>）")
        b = a + close.start() + len("\n      </details>")
        block = "\n" + block
    out = page[:a] + block + page[b:]
    # 读不到接口时拿来比新旧的那个号 = 页面上手写的最新一条
    out = re.sub(r'data-release-static="[\d.]+"', f'data-release-static="{newest}"', out, count=1)
    tmp = PAGE.with_suffix(".html.tmp")
    io.open(tmp, "w", encoding="utf-8", newline="").write(out)
    os.replace(tmp, PAGE)
    print(f"介绍页更新日志：{n} 个版本，最新 v{newest}")


if __name__ == "__main__":
    main()
