"""FastAPI server for the §6.0 job API (PERCEPTION_PROVIDER=http):

  POST /jobs                         → {job_id}
  GET  /jobs/{id}                    → {status, model_hash, flags, detections_url, host, frame}
  GET  /jobs/{id}/detections.jsonl   → RawDetection JSON Lines (§6.1)
  GET  /health

Jobs run one at a time on a worker thread (one GPU). The same (bet,
job_nonce) returns the same job. Env:
  VERDICT_PUBLIC_URL     base for detections_url (default: request base URL)
  VERDICT_HOST_PROVIDER  host.provider (default "io.net"); VERDICT_HOST_URL / VERDICT_HOST_MARKET
  VERDICT_MEDIA_PREFIXES comma list of allowed video URL prefixes (empty = https:// only)
  VERDICT_JOBS_DIR       where detections are kept (default /tmp/verdict-jobs)
"""
from __future__ import annotations

import os
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse

from .media import Fetcher, http_fetch
from .models import ModelSet
from .pipeline import run_job
from .schema import Frame, Host, JobRequest, JobStatus


class JobStore:
    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.by_nonce: dict[tuple[str, str], str] = {}


def allowed_url(url: str, prefixes: list[str]) -> bool:
    if prefixes:
        return any(url.startswith(p) for p in prefixes)
    return url.startswith("https://")


def create_app(
    models_factory: Callable[[JobRequest], ModelSet],
    model_hash_fn: Callable[[], str],
    fetch: Fetcher = http_fetch,
    jobs_dir: Optional[Path] = None,
) -> FastAPI:
    app = FastAPI(title="verdict-perception", version="1.0.0")
    store = JobStore(jobs_dir or Path(os.environ.get("VERDICT_JOBS_DIR", "/tmp/verdict-jobs")))
    pool = ThreadPoolExecutor(max_workers=1)
    prefixes = [p.strip() for p in os.environ.get("VERDICT_MEDIA_PREFIXES", "").split(",") if p.strip()]
    mh = model_hash_fn()

    def host(job_id: str) -> Host:
        return Host(
            provider=os.environ.get("VERDICT_HOST_PROVIDER", "io.net"),
            job_id=job_id,
            url=os.environ.get("VERDICT_HOST_URL", ""),
            market=os.environ.get("VERDICT_HOST_MARKET", ""),
        )

    def work(job_id: str, req: JobRequest) -> None:
        rec = store.jobs[job_id]
        rec["status"] = "running"
        try:
            res = run_job(req, models_factory(req), mh, fetch)
            (store.dir / f"{job_id}.jsonl").write_text(res.jsonl(), "utf-8")
            rec.update(status="done", flags=res.flags, frame=(res.width_px, res.height_px) if res.width_px else None)
        except Exception as e:  # noqa: BLE001 — any failure fails the job (§6.0 status "failed")
            rec.update(status="failed", error=f"{type(e).__name__}: {e}")
            traceback.print_exc()

    @app.get("/health")
    def health():
        return {"ok": True, "model_hash": mh}

    @app.post("/jobs")
    def post_job(req: JobRequest):
        for v in req.video_urls:
            if not allowed_url(v.url, prefixes):
                raise HTTPException(status_code=400, detail=f"video url not allowed: {v.url[:64]}")
        with store.lock:
            key = (req.bet, req.job_nonce)
            if key in store.by_nonce:
                return {"job_id": store.by_nonce[key]}
            job_id = uuid.uuid4().hex
            store.by_nonce[key] = job_id
            store.jobs[job_id] = {"status": "queued", "flags": 0, "frame": None, "error": None}
        pool.submit(work, job_id, req)
        return {"job_id": job_id}

    @app.get("/jobs/{job_id}", response_model=JobStatus, response_model_exclude_none=True)
    def get_job(job_id: str, request: Request):
        rec = store.jobs.get(job_id)
        if rec is None:
            raise HTTPException(status_code=404, detail="job not found")
        base = os.environ.get("VERDICT_PUBLIC_URL", str(request.base_url)).rstrip("/")
        frame = rec.get("frame")
        return JobStatus(
            status=rec["status"],
            model_hash=mh,
            flags=rec["flags"],
            detections_url=f"{base}/jobs/{job_id}/detections.jsonl",
            host=host(job_id),
            frame=Frame(width_px=frame[0], height_px=frame[1]) if frame else None,
            error=rec.get("error"),
        )

    @app.get("/jobs/{job_id}/detections.jsonl", response_class=PlainTextResponse)
    def detections(job_id: str):
        rec = store.jobs.get(job_id)
        if rec is None or rec["status"] != "done":
            raise HTTPException(status_code=404, detail="no detections")
        return PlainTextResponse((store.dir / f"{job_id}.jsonl").read_text("utf-8"), media_type="application/x-ndjson")

    return app


def real_app() -> FastAPI:
    """Production app: real models (cached), model_hash over the pinned weights."""
    from .models import load_models
    from .settings import model_hash, weight_digests

    cache: dict[tuple, ModelSet] = {}
    lock = threading.Lock()

    def factory(req: JobRequest) -> ModelSet:
        key = (req.need_pose, req.need_faces, req.need_reid)
        with lock:
            if key not in cache:
                cache[key] = load_models(*key)
            return cache[key]

    return create_app(factory, lambda: model_hash(weight_digests()))
