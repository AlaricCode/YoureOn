#!/usr/bin/env python3
"""Downloads the weights in weights.lock.json into $VERDICT_WEIGHTS_DIR and checks
each sha256 against the lock.

  fetch_weights.py                 download missing files, verify pinned digests
  fetch_weights.py --require-pinned  fail if any entry has no digest (Docker build)
  fetch_weights.py --pin           write the digests of what was downloaded into the lock

Free: Hugging Face / GitHub downloads (SAM 3 is gated: set HF_TOKEN after accepting the license).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
LOCK = HERE / "weights.lock.json"


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def download(url: str, dest: Path, token: str | None = None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    headers = {"user-agent": "verdict-fetch-weights/1"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=600) as r, open(tmp, "wb") as f:  # noqa: S310
        shutil.copyfileobj(r, f)
    tmp.rename(dest)


def url_of(w: dict) -> str:
    if w["source"] == "huggingface":
        return f"https://huggingface.co/{w['repo']}/resolve/{w['revision']}/{w['path']}"
    return w["url"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pin", action="store_true")
    ap.add_argument("--require-pinned", action="store_true")
    ap.add_argument("--dir", default=os.environ.get("VERDICT_WEIGHTS_DIR", "/opt/verdict/weights"))
    a = ap.parse_args()
    lock = json.loads(LOCK.read_text("utf-8"))
    root = Path(a.dir)
    unpinned = [w["name"] for w in lock["weights"] if not w.get("sha256")]
    if a.require_pinned and unpinned:
        print(f"unpinned weights in {LOCK.name}: {', '.join(unpinned)} (run --pin and commit)", file=sys.stderr)
        return 3
    token = os.environ.get("HF_TOKEN")
    for w in lock["weights"]:
        dest = root / w["file"]
        if not dest.exists():
            print(f"downloading {w['name']} …")
            download(url_of(w), dest, token if w["source"] == "huggingface" else None)
        d = sha256(dest)
        if w.get("sha256") and w["sha256"] != d:
            print(f"{w['name']}: sha256 {d} != pinned {w['sha256']}", file=sys.stderr)
            return 4
        if a.pin:
            w["sha256"] = d
        if w.get("unzip_to"):
            out = root / w["unzip_to"]
            if not out.exists():
                with zipfile.ZipFile(dest) as z:
                    z.extractall(out.parent)
        print(f"ok {w['name']} {d}")
    if a.pin:
        LOCK.write_text(json.dumps(lock, indent=2) + "\n", "utf-8")
        print(f"pinned digests written to {LOCK}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
