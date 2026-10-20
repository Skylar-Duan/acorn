"""把已发布的统一安装包原样提供给旧 Ultra 更新器；不构建第二份产品。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile


VERSION = re.compile(r"\d+\.\d+\.\d+(?:-beta\.\d+)?")


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def mirror(source: Path, private: Path, *, beta: bool = False, owner: str | None = None) -> dict:
    source, private = source.resolve(), private.resolve()
    if source == private or source.is_relative_to(private) or private.is_relative_to(source):
        raise ValueError("公共目录和兼容私有目录必须独立")
    raw = json.loads((source / "latest.json").read_text(encoding="utf-8"))
    version = raw.get("version", "")
    if not isinstance(version, str) or not VERSION.fullmatch(version) or ("-beta." in version) != beta:
        raise ValueError("版本与通道不符")
    name = f"Acorn_{version}_x64-setup.exe"
    package = source / name
    if raw.get("file") != name or not package.is_file() or package.is_symlink():
        raise ValueError("必须使用公共通道中确定的统一安装包")
    if package.stat().st_size <= 0 or package.stat().st_size != raw.get("size") or digest(package) != raw.get("sha256"):
        raise ValueError("公共安装包与清单不符")
    target = private / "windows" / "ultra"
    if beta:
        target /= "beta"
    if not target.resolve().is_relative_to(private):
        raise ValueError("私有目标越界")
    target.mkdir(parents=True, exist_ok=True)
    os.chmod(target, 0o750)
    alias = f"AcornUltra_{version}_x64-setup.exe"
    output = target / alias
    if output.exists() and (output.is_symlink() or digest(output) != raw["sha256"]):
        raise ValueError("同版本兼容包已存在且内容不同")
    payload = {**raw, "file": alias, "edition": "ultra"}

    def stage(suffix: str) -> Path:
        fd, path = tempfile.mkstemp(prefix=".legacy-", suffix=suffix, dir=target)
        os.close(fd)
        return Path(path)

    staged_package, staged_manifest = stage(".exe"), stage(".json")
    try:
        # 独立拷贝，不能 hardlink：私有权限不得改到公共下载文件。
        shutil.copyfile(package, staged_package)
        if digest(staged_package) != raw["sha256"]:
            raise ValueError("兼容副本校验失败")
        staged_manifest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        for path in (staged_package, staged_manifest):
            os.chmod(path, 0o640)
            if owner:
                shutil.chown(path, user=owner, group=owner)
        if owner:
            shutil.chown(target, user=owner, group=owner)
        os.replace(staged_package, output)
        os.replace(staged_manifest, target / "latest.json")
    finally:
        staged_package.unlink(missing_ok=True)
        staged_manifest.unlink(missing_ok=True)
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("private", type=Path)
    parser.add_argument("--beta", action="store_true")
    parser.add_argument("--owner")
    args = parser.parse_args()
    result = mirror(args.source, args.private, beta=args.beta, owner=args.owner)
    print(json.dumps({key: result[key] for key in ("version", "size", "sha256")}, ensure_ascii=False))
