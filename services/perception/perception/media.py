"""Chunk download (sha256-checked), decoding (mp4 | mjpeg) and 10 fps sampling.

Timebases: `start_ms` and MJPEG record times are device-local ms; the job's
`offset_ms` is the device-local ms of t0, so session time = local − offset_ms.
Frames before t0 are dropped. Sampling keeps, per session frame
f = floor(t/100), the source frame with the smallest t (§6.2 dedup rule).
"""
from __future__ import annotations

import hashlib
import struct
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Iterator

import numpy as np

from .schema import VideoUrl
from .settings import FRAME_MS

MAX_CHUNK_BYTES = 64 * 1024 * 1024


class ChunkIntegrityError(Exception):
    """A downloaded chunk does not match its §6.0 sha256: the job must fail."""


@dataclass
class Frame:
    t_ms: int  # session ms since t0
    image: np.ndarray  # BGR uint8


Fetcher = Callable[[str], bytes]


def http_fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"user-agent": "verdict-perception/1"})
    with urllib.request.urlopen(req, timeout=120) as r:  # noqa: S310 (signed https URLs from the backend)
        data = r.read(MAX_CHUNK_BYTES + 1)
    if len(data) > MAX_CHUNK_BYTES:
        raise ChunkIntegrityError(f"chunk larger than {MAX_CHUNK_BYTES} bytes: {url}")
    return data


def download_verified(v: VideoUrl, fetch: Fetcher = http_fetch) -> bytes:
    body = fetch(v.url)
    digest = hashlib.sha256(body).hexdigest()
    if digest != v.sha256:
        raise ChunkIntegrityError(f"chunk {v.index}: sha256 {digest} != {v.sha256}")
    return body


def parse_mjpeg(body: bytes) -> list[tuple[int, bytes]]:
    """`u32 len ‖ u32 t_ms_local ‖ jpeg[len]` (LE), repeated."""
    out = []
    o = 0
    n = len(body)
    while o < n:
        if o + 8 > n:
            raise ValueError("mjpeg: truncated record header")
        length, t = struct.unpack_from("<II", body, o)
        if o + 8 + length > n:
            raise ValueError("mjpeg: truncated frame")
        out.append((t, body[o + 8 : o + 8 + length]))
        o += 8 + length
    return out


def decode_mjpeg(body: bytes, offset_ms: int) -> Iterator[Frame]:
    import cv2

    for t_local, jpeg in parse_mjpeg(body):
        img = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            continue
        yield Frame(t_ms=int(t_local) - offset_ms, image=img)


def decode_mp4(body: bytes, start_ms: int, offset_ms: int) -> Iterator[Frame]:
    import cv2

    with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
        f.write(body)
        f.flush()
        cap = cv2.VideoCapture(f.name)
        try:
            while True:
                ok, img = cap.read()
                if not ok:
                    break
                pos = cap.get(cv2.CAP_PROP_POS_MSEC)  # presentation time of the frame just read
                yield Frame(t_ms=int(round(start_ms + pos)) - offset_ms, image=img)
        finally:
            cap.release()


def sample_10fps(frames: Iterable[Frame]) -> list[Frame]:
    """One frame per 100 ms bucket (smallest t wins), t ≥ 0, ascending."""
    best: dict[int, Frame] = {}
    for fr in frames:
        if fr.t_ms < 0:
            continue
        b = fr.t_ms // FRAME_MS
        cur = best.get(b)
        if cur is None or fr.t_ms < cur.t_ms:
            best[b] = fr
    return [best[k] for k in sorted(best)]


def load_session_frames(videos: list[VideoUrl], offset_ms: int, fetch: Fetcher = http_fetch) -> list[Frame]:
    """Downloads + verifies every chunk (any mismatch fails the job), decodes, places, samples at 10 fps."""
    bodies = [(v, download_verified(v, fetch)) for v in videos]

    def all_frames() -> Iterator[Frame]:
        for v, body in sorted(bodies, key=lambda x: x[0].start_ms):
            if v.body_format == "mjpeg":
                yield from decode_mjpeg(body, offset_ms)
            else:
                yield from decode_mp4(body, v.start_ms, offset_ms)

    return sample_10fps(all_frames())


def write_frames_dir(frames: list[Frame], directory: Path) -> list[Path]:
    """JPEG frame folder for video predictors that take an image sequence (00000.jpg, ...)."""
    import cv2

    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    for i, fr in enumerate(frames):
        p = directory / f"{i:05d}.jpg"
        cv2.imwrite(str(p), fr.image, [cv2.IMWRITE_JPEG_QUALITY, 95])
        paths.append(p)
    return paths
