"""§6.0 job API end to end on CPU (ColorSegmenter stands in for SAM 3)."""
import json
import os
import time
from pathlib import Path

from fastapi.testclient import TestClient

from perception.app import create_app
from perception.settings import model_hash
from tests.fixtures import fake_models, frame, mjpeg, mp4, sha

GOLDEN = Path(__file__).parent / "golden" / "detections.jsonl"
BET = "7dEr7cjNoH37VgRJoXHHeJHNvZmZh45xHCAZMZp3UYa3"


def chunks(pan_px=0):
    a = mjpeg([frame(i, pan_px) for i in range(10)], t0_local=2000)
    b = mp4([frame(10 + i, pan_px) for i in range(10)])
    files = {"https://backend.test/v1/media/chunks/a": a, "https://backend.test/v1/media/chunks/b": b}
    urls = [
        {"index": 0, "url": "https://backend.test/v1/media/chunks/a", "sha256": sha(a), "start_ms": 2000, "duration_ms": 1000, "body_format": "mjpeg"},
        {"index": 1, "url": "https://backend.test/v1/media/chunks/b", "sha256": sha(b), "start_ms": 3000, "duration_ms": 1000, "body_format": "mp4"},
    ]
    return files, urls


def job_body(urls, **kw):
    return {
        "bet": BET,
        "job_nonce": "ab" * 16,
        "fps": 10,
        "offset_ms": 2000,
        "video_urls": urls,
        "prompts": [{"entity": "ball", "phrase": "paper ball"}, {"entity": "shooter", "phrase": "person"}],
        "entity_refs": [{"entity": "ball", "label": "Ball", "bbox": [0, 4000, 2000, 6000]}],
        "need_pose": True,
        "need_reid": False,
        "need_faces": True,
        **kw,
    }


def run(client, body):
    r = client.post("/jobs", json=body)
    assert r.status_code == 200, r.text
    jid = r.json()["job_id"]
    for _ in range(200):
        s = client.get(f"/jobs/{jid}").json()
        if s["status"] in ("done", "failed"):
            return jid, s
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def make_client(tmp_path, files, mh="ab" * 32):
    app = create_app(lambda req: fake_models(req.need_pose, req.need_faces, req.need_reid), lambda: mh, fetch=lambda u: files[u], jobs_dir=tmp_path)
    return TestClient(app)


def test_job_api_contract_and_detections(tmp_path):
    files, urls = chunks()
    c = make_client(tmp_path, files)
    jid, s = run(c, job_body(urls))
    assert s["status"] == "done", s
    assert set(s) >= {"status", "model_hash", "flags", "detections_url", "host"}
    assert s["model_hash"] == "ab" * 32 and s["flags"] == 0
    assert set(s["host"]) == {"provider", "job_id", "url", "market"} and s["host"]["job_id"] == jid
    assert s["frame"] == {"width_px": 320, "height_px": 240}
    # Same (bet, job_nonce) → same job.
    assert c.post("/jobs", json=job_body(urls)).json()["job_id"] == jid
    text = c.get(s["detections_url"].replace("http://testserver", "")).text
    lines = [json.loads(l) for l in text.splitlines()]
    assert lines, "no detections"
    for l in lines:
        assert set(l) >= {"t_ms", "entity", "track_id", "bbox_px", "mask_area_px", "confidence"}
        assert isinstance(l["t_ms"], int) and l["t_ms"] >= 0
        assert 1 <= l["track_id"] <= 0xFFFF and 0 <= l["confidence"] <= 1 and len(l["bbox_px"]) == 4
        assert l["entity"] in ("ball", "person")  # person prompts are anonymous person tracks
    ts = sorted({l["t_ms"] for l in lines})
    assert ts[0] == 0 and ts[-1] >= 1800  # both chunks placed on the session timeline at 10 fps
    persons = [l for l in lines if l["entity"] == "person"]
    assert all(l["pose"] == {"standing": True, "elbow_deg": 170.0} for l in persons)
    faced = [l for l in persons if "face" in l]
    assert faced and all((l["t_ms"] // 100) % 3 == 0 for l in faced)
    assert all(len(l["face"]["emb"]) == 128 for l in faced)
    assert all("face" not in l and "pose" not in l for l in lines if l["entity"] == "ball")
    # Golden file consumed by the backend test (parseDetectionsJsonl + engine quantizeSession).
    if os.environ.get("UPDATE_GOLDEN"):
        GOLDEN.parent.mkdir(exist_ok=True)
        GOLDEN.write_text(text)
    assert text == GOLDEN.read_text(), "pipeline output changed; rerun with UPDATE_GOLDEN=1 if intended"


def test_panning_camera_sets_flag_bit0(tmp_path):
    files, urls = chunks(pan_px=12)
    _, s = run(make_client(tmp_path, files), job_body(urls))
    assert s["status"] == "done" and s["flags"] & 1 == 1


def test_sha_mismatch_fails_and_urls_are_restricted(tmp_path):
    files, urls = chunks()
    urls[1]["sha256"] = "00" * 32
    c = make_client(tmp_path, files)
    _, s = run(c, job_body(urls))
    assert s["status"] == "failed" and "sha256" in s.get("error", "")
    bad = [dict(urls[0], url="http://169.254.169.254/latest/meta-data")]
    assert c.post("/jobs", json=job_body(bad, job_nonce="cd" * 16)).status_code == 400
    assert c.get("/jobs/nope").status_code == 404


def test_model_hash_covers_weights_and_settings():
    from perception.settings import SETTINGS

    d = [["sam3", "11" * 32], ["face_projection", "22" * 32]]
    h = model_hash(d)
    assert h == model_hash(list(reversed(d)))
    assert h != model_hash([["sam3", "33" * 32], ["face_projection", "22" * 32]])
    changed = json.loads(json.dumps(SETTINGS))
    changed["motion"]["threshold_frac_width"] = 0.02
    assert h != model_hash(d, changed)
