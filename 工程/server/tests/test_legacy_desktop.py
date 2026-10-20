"""统一包向旧更新器过渡：本地临时目录，无网络、账号或真实安装包。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location("legacy_mirror", Path(__file__).parents[1] / "deploy/mirror-legacy-desktop.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(root, version="1.17.0"):
    source = root / ("public-beta" if "beta" in version else "public")
    source.mkdir()
    binary = b"same common installer with account-enabled Plus"
    name = f"Acorn_{version}_x64-setup.exe"
    (source / name).write_bytes(binary)
    meta = dict(file=name, version=version, size=len(binary), schema=8,
                sha256=hashlib.sha256(binary).hexdigest(), notes="统一包")
    (source / "latest.json").write_text(json.dumps(meta), encoding="utf-8")
    return source, binary, meta


def test_identical_bytes_without_touching_public_or_other_channel():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        source, binary, meta = fixture(root)
        private = root / "private"
        got = module.mirror(source, private)
        target = private / "windows/ultra"
        assert got["edition"] == "ultra" and got["sha256"] == meta["sha256"]
        assert (target / got["file"]).read_bytes() == (source / meta["file"]).read_bytes() == binary
        assert json.loads((source / "latest.json").read_text(encoding="utf-8")) == meta
        assert json.loads((target / "latest.json").read_text(encoding="utf-8")) == got
        assert not (target / "beta").exists()
        assert module.mirror(source, private) == got
        beta_source, beta_binary, _ = fixture(root, "1.17.1-beta.1")
        beta = module.mirror(beta_source, private, beta=True)
        assert (target / "beta" / beta["file"]).read_bytes() == beta_binary
        assert json.loads((target / "latest.json").read_text(encoding="utf-8")) == got


def test_bad_manifest_or_package_cannot_replace_previous_release():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        source, _, meta = fixture(root)
        private = root / "private"
        module.mirror(source, private)
        previous = (private / "windows/ultra/latest.json").read_bytes()
        for changed in ({**meta, "file": "../escape.exe"}, {**meta, "sha256": "0" * 64}, {**meta, "version": "1.17.1-beta.1"}):
            (source / "latest.json").write_text(json.dumps(changed), encoding="utf-8")
            try:
                module.mirror(source, private)
                raise AssertionError("invalid manifest accepted")
            except ValueError:
                pass
            assert (private / "windows/ultra/latest.json").read_bytes() == previous
        assert not list(private.rglob(".legacy-*"))


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("PASS", name)
