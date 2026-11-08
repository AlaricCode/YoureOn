"""Nosana one-shot mode: VERDICT_JOB in, signed upload of the result out."""
import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from perception import oneshot
from tests.fixtures import fake_models, frame, mjpeg, sha


def test_oneshot_runs_the_job_and_uploads(monkeypatch):
    got = {}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            got["path"] = self.path
            got["body"] = json.loads(self.rfile.read(int(self.headers["content-length"])))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"stored":true}')

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    body = mjpeg([frame(i) for i in range(6)], t0_local=0)
    job = {
        "bet": "7dEr7cjNoH37VgRJoXHHeJHNvZmZh45xHCAZMZp3UYa3",
        "job_nonce": "ef" * 16,
        "fps": 10,
        "offset_ms": 0,
        "video_urls": [{"index": 0, "url": "https://b/0", "sha256": sha(body), "start_ms": 0, "duration_ms": 600, "body_format": "mjpeg"}],
        "prompts": [{"entity": "ball", "phrase": "ball"}],
        "entity_refs": [],
        "need_pose": False,
        "need_reid": False,
    }
    monkeypatch.setenv("VERDICT_JOB", base64.b64encode(json.dumps(job).encode()).decode())
    monkeypatch.setenv("VERDICT_RESULT_URL", f"http://127.0.0.1:{srv.server_address[1]}/v1/media/perception/x/y?exp=1&sig=s")
    try:
        rc = oneshot.main(models_loader=lambda *a: fake_models(*a), model_hash_fn=lambda: "cd" * 32, fetch=lambda _u: body)
    finally:
        srv.shutdown()
    assert rc == 0
    assert got["path"].startswith("/v1/media/perception/x/y?")
    b = got["body"]
    assert b["model_hash"] == "cd" * 32 and b["flags"] == 0 and b["frame"] == {"width_px": 320, "height_px": 240}
    lines = [json.loads(l) for l in b["detections_jsonl"].splitlines()]
    assert len(lines) == 6 and all(l["entity"] == "ball" for l in lines)
