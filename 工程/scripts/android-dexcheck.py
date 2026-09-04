# 列出 APK 里所有 classes*.dex 的 class_defs（真定义的类，不是被引用到的名字），
# 然后断言 opener 的安卓类和橡果自己的 InstallPlugin 都在。
import struct, sys, zipfile

WANT = ["Lapp/tauri/opener/OpenerPlugin;", "Lcom/cdpandas/acorn/InstallPlugin;"]


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


def main(apk):
    z = zipfile.ZipFile(apk)
    names = sorted(n for n in z.namelist() if n.startswith("classes") and n.endswith(".dex"))
    all_defs = []
    for n in names:
        all_defs += class_defs(z.read(n))
    print(f"{apk}\n  dex: {names}  classes: {len(all_defs)}")
    tauri = sorted(c for c in all_defs if c.startswith("Lapp/tauri/") or c.startswith("Lcom/cdpandas/"))
    for c in tauri:
        if "$" not in c:
            print("   ", c)
    ok = True
    for w in WANT:
        present = w in all_defs
        print(f"  {'OK  ' if present else 'MISS'} {w}")
        ok = ok and present
    so = [n for n in z.namelist() if n.endswith("libacorn_lib.so")]
    for n in so:
        blob = z.read(n)
        print(f"  {n}: " + ", ".join(
            f"{s}={blob.count(s.encode())}" for s in ["acorn-install", "install_apk", "com.cdpandas.acorn", "InstallPlugin", "OpenerPlugin"]))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
