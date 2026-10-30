"""Private setup archives: validate every member before extracting any bytes."""
import gzip
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile


def validate(members):
    seen = {}
    total = 0
    for member in members:
        parts = member.name.split("/")
        if not member.name or member.name.startswith("/") or any(p in ("", ".", "..") for p in parts) or "\\" in member.name:
            raise ValueError("Unsafe archive member path")
        if member.name in seen or not (member.isfile() or member.isdir() or member.issym()):
            raise ValueError("Duplicate or unsupported archive member")
        if member.issym():
            target = os.path.normpath(str(PurePosixPath(member.name).parent / member.linkname))
            if not member.linkname or member.linkname.startswith("/") or target == ".." or target.startswith("../") or "\\" in member.linkname:
                raise ValueError("Archive link escapes its root")
        total += member.size
        if total > 4 * 1024**3 or len(seen) >= 200000:
            raise ValueError("Archive exceeds setup limits")
        seen[member.name] = member
    for name in seen:
        for parent in PurePosixPath(name).parents:
            if str(parent) in seen and not seen[str(parent)].isdir():
                raise ValueError("Archive member has a non-directory parent")
    return list(seen.values())


def normalized(info):
    info.uid = info.gid = info.mtime = 0
    info.uname = info.gname = ""
    info.mode &= 0o755
    return info


def main():
    mode, source, destination = sys.argv[1:]
    if mode == "pack":
        with open(destination, "xb") as output:
            with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as archive:
                    for entry in sorted(Path(source).iterdir()):
                        archive.add(entry, arcname=entry.name, filter=normalized)
        os.chmod(destination, 0o600)
        with tarfile.open(destination) as archive:
            validate(archive)
    elif mode == "extract":
        with tarfile.open(source) as archive:
            members = validate(archive)
            root = Path(destination)
            root.mkdir(mode=0o700)
            try:
                for member in members:
                    path = root / member.name
                    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    if member.isdir():
                        path.mkdir(exist_ok=True, mode=0o700)
                    elif member.issym():
                        path.symlink_to(member.linkname)
                    else:
                        with archive.extractfile(member) as src, open(path, "xb") as dst:
                            shutil.copyfileobj(src, dst)
                        path.chmod(member.mode & 0o755)
            except BaseException:
                shutil.rmtree(root)
                raise
    else:
        raise ValueError("Expected pack or extract")


if __name__ == "__main__":
    main()
