# 列出 APK 里所有 classes*.dex 的 class_defs（真定义的类，不是被引用到的名字），
# 然后断言 opener 的安卓类和橡果自己的 InstallPlugin 都在。
#
# v1.14.2 加了第二道：光有 InstallPlugin 这个类名不够——类还在、里面却是上一版那个只会
# ACTION_VIEW 的实现，包照样装不上而我们查不出来。所以再去 dex 的字符串表里点名几串
# 只有新实现才会有的东西（PackageInstaller 的类型描述符、结果广播的 action、状态码名字表）。
import struct, sys, zipfile

WANT = ["Lapp/tauri/opener/OpenerPlugin;", "Lcom/cdpandas/acorn/InstallPlugin;"]

WANT_STRINGS = [
    # 主路真的编进去了：会话 API 被引用到，类型描述符就一定在字符串表里
    "Landroid/content/pm/PackageInstaller;",
    # 结果广播的 action（本包唯一）：终态那条回路在
    "com.cdpandas.acorn.INSTALL_SESSION_RESULT",
    # 回执按会话号认领（EXTRA_SESSION_ID 的常量值，编译期就内联进字符串表）：
    # 连点两次更新时，上一轮被丢掉的会话不会冒充这一轮的失败原因
    "android.content.pm.extra.SESSION_ID",
    # 状态码名字表：界面那行小字要靠它写出「为什么没装上」
    "STATUS_FAILURE_BLOCKED",
    # 前端问终态的那条命令（Kotlin 侧的方法名，R8 按 @Command 保留）
    "lastResult",
]


def uleb128(b, off):
    result, shift = 0, 0
    while True:
        byte = b[off]
        off += 1
        result |= (byte & 0x7F) << shift
        if byte & 0x80 == 0:
            return result, off
        shift += 7


def class_defs(dex):
    string_ids_size, string_ids_off = struct.unpack_from("<II", dex, 0x38)
    type_ids_size, type_ids_off = struct.unpack_from("<II", dex, 0x40)
    class_defs_size, class_defs_off = struct.unpack_from("<II", dex, 0x60)

    def string_at(idx):
        (data_off,) = struct.unpack_from("<I", dex, string_ids_off + idx * 4)
        n, p = uleb128(dex, data_off)
        end = dex.index(b"\x00", p)
        return dex[p:end].decode("utf-8", "replace")

    out = []
    for i in range(class_defs_size):
        (class_idx,) = struct.unpack_from("<I", dex, class_defs_off + i * 32)
        (desc_idx,) = struct.unpack_from("<I", dex, type_ids_off + class_idx * 4)
        out.append(string_at(desc_idx))
    return out


def all_strings(dex):
    """整张字符串表：类型描述符、方法名、字面量常量都在里面。"""
    string_ids_size, string_ids_off = struct.unpack_from("<II", dex, 0x38)
    out = []
    for i in range(string_ids_size):
        (data_off,) = struct.unpack_from("<I", dex, string_ids_off + i * 4)
        n, p = uleb128(dex, data_off)
        end = dex.index(b"\x00", p)
        out.append(dex[p:end].decode("utf-8", "replace"))
    return out


def main(apk):
    z = zipfile.ZipFile(apk)
    names = sorted(n for n in z.namelist() if n.startswith("classes") and n.endswith(".dex"))
    all_defs = []
    pool = set()
    for n in names:
        blob = z.read(n)
        all_defs += class_defs(blob)
        pool |= set(all_strings(blob))
    print(f"{apk}\n  dex: {names}  classes: {len(all_defs)}  strings: {len(pool)}")
    tauri = sorted(c for c in all_defs if c.startswith("Lapp/tauri/") or c.startswith("Lcom/cdpandas/"))
    for c in tauri:
        if "$" not in c:
            print("   ", c)
    ok = True
    for w in WANT:
        present = w in all_defs
        print(f"  {'OK  ' if present else 'MISS'} {w}")
        ok = ok and present
    for w in WANT_STRINGS:
        present = w in pool
        # 标签用 ASCII：这行会打进 Windows 控制台，中文在 cp936 下是一串乱码
        print(f"  {'OK  ' if present else 'MISS'} str {w}")
        ok = ok and present
    so = [n for n in z.namelist() if n.endswith("libacorn_lib.so")]
    for n in so:
        blob = z.read(n)
        print(f"  {n}: " + ", ".join(
            f"{s}={blob.count(s.encode())}" for s in [
                "acorn-install", "install_apk", "install_status", "lastResult",
                "com.cdpandas.acorn", "InstallPlugin", "OpenerPlugin"]))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
