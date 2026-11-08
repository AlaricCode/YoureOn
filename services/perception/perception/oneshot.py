"""One-shot mode (Nosana jobs): run the job in env VERDICT_JOB (base64 JSON
§6.0 request), POST {model_hash, flags, frame, detections_jsonl} to the signed
backend URL in VERDICT_RESULT_URL, exit 0. Any failure exits non-zero so the
job is marked FAILED."""
from __future__ import annotations

import base64
import json
import os
import sys
import urllib.request

from .media import http_fetch
from .pipeline import run_job
from .schema import JobRequest


def main(models_loader=None, model_hash_fn=None, fetch=http_fetch) -> int:
    if models_loader is None:
        from .models import load_models as models_loader
    if model_hash_fn is None:
        from .settings import model_hash, weight_digests

        def model_hash_fn():
            return model_hash(weight_digests())

    req = JobRequest.model_validate(json.loads(base64.b64decode(os.environ["VERDICT_JOB"])))
    url = os.environ["VERDICT_RESULT_URL"]
    mh = model_hash_fn()
    res = run_job(req, models_loader(req.need_pose, req.need_faces, req.need_reid), mh, fetch)
    body = {
        "model_hash": res.model_hash,
        "flags": res.flags,
        "detections_jsonl": res.jsonl(),
        **({"frame": {"width_px": res.width_px, "height_px": res.height_px}} if res.width_px else {}),
    }
    data = json.dumps(body).encode("utf-8")
    r = urllib.request.Request(url, data=data, method="POST", headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=300) as resp:  # noqa: S310 — signed backend URL
        if resp.status != 200:
            print(f"upload failed: HTTP {resp.status}", file=sys.stderr)
            return 2
    print(json.dumps({"ok": True, "lines": len(res.lines), "flags": res.flags, "model_hash": mh}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
