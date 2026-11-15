"""Real-model smoke test (CPU or GPU) on the generated fixture clip.

Skipped unless SAM 3 + MediaPipe + InsightFace are installed and the pinned
weights are present in $VERDICT_WEIGHTS_DIR (e.g. inside the Docker image:
`docker run --rm verdict-perception python -m pytest -q tests/test_smoke_real.py`).
No keys, no spend: the fixture is generated locally and nothing leaves the box.
"""
import importlib.util
import os

import pytest

from perception.settings import WEIGHTS_DIR

HAVE = all(importlib.util.find_spec(m) for m in ("sam3", "mediapipe", "insightface")) and (WEIGHTS_DIR / "sam3.pt").exists()


@pytest.mark.skipif(not HAVE, reason="real models/weights not installed (run inside the perception image)")
def test_real_pipeline_on_fixture_clip():
    os.environ.setdefault("VERDICT_DEVICE", "cpu")
    from perception.models import load_models
    from perception.pipeline import run_job
    from perception.schema import JobRequest
    from perception.settings import model_hash, weight_digests
    from tests.fixtures import frame, mjpeg, sha

    body = mjpeg([frame(i) for i in range(20)], t0_local=0)
    req = JobRequest.model_validate(
        {
            "bet": "7dEr7cjNoH37VgRJoXHHeJHNvZmZh45xHCAZMZp3UYa3",
            "job_nonce": "ab" * 16,
            "fps": 10,
            "offset_ms": 0,
            "video_urls": [{"index": 0, "url": "https://x/0", "sha256": sha(body), "start_ms": 0, "duration_ms": 2000, "body_format": "mjpeg"}],
            "prompts": [{"entity": "ball", "phrase": "red ball"}],
            "entity_refs": [],
            "need_pose": False,
            "need_reid": False,
        }
    )
    mh = model_hash(weight_digests())
    res = run_job(req, load_models(False, False, False), mh, fetch=lambda _u: body)
    balls = [l for l in res.lines if l["entity"] == "ball"]
    assert len(balls) >= 10, f"SAM 3 found the ball in only {len(balls)} of 20 frames"
    assert res.flags & 1 == 0
    assert len(mh) == 64
