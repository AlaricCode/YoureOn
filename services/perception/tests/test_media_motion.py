import pytest

from perception.media import ChunkIntegrityError, decode_mp4, download_verified, load_session_frames, parse_mjpeg, sample_10fps, Frame
from perception.motion import background_motion, camera_motion_flag
from perception.schema import VideoUrl
from tests.fixtures import W, frame, mjpeg, mp4, sha


def test_mjpeg_roundtrip_and_session_placement():
    body = mjpeg([frame(i) for i in range(5)], t0_local=1000)
    recs = parse_mjpeg(body)
    assert [t for t, _ in recs] == [1000, 1100, 1200, 1300, 1400]
    v = VideoUrl(index=0, url="https://x/0", sha256=sha(body), start_ms=1000, duration_ms=500, body_format="mjpeg")
    # offset_ms = device-local ms of t0: frames before t0 are dropped, the rest are session-relative.
    frames = load_session_frames([v], offset_ms=1150, fetch=lambda _u: body)
    assert [f.t_ms for f in frames] == [50, 150, 250]


def test_sha256_mismatch_fails_the_job():
    body = mjpeg([frame(0)], 0)
    v = VideoUrl(index=0, url="https://x/0", sha256="00" * 32, start_ms=0, duration_ms=100, body_format="mjpeg")
    with pytest.raises(ChunkIntegrityError):
        download_verified(v, fetch=lambda _u: body)


def test_sample_10fps_keeps_smallest_t_per_bucket():
    import numpy as np

    img = np.zeros((2, 2, 3), dtype=np.uint8)
    fr = [Frame(130, img), Frame(110, img), Frame(-5, img), Frame(250, img), Frame(299, img)]
    assert [f.t_ms for f in sample_10fps(fr)] == [110, 250]


def test_mp4_decode_timestamps():
    body = mp4([frame(i) for i in range(10)], fps=10)
    ts = [f.t_ms for f in decode_mp4(body, start_ms=5000, offset_ms=5000)]
    assert len(ts) == 10
    assert ts[0] in (0, 100) and ts[-1] - ts[0] == 900


def test_camera_motion_flag_needs_more_than_five_frames():
    thr = 0.01 * W
    assert not camera_motion_flag([thr + 1] * 5, W)
    assert camera_motion_flag([thr + 1] * 6, W)
    assert not camera_motion_flag([thr + 1] * 5 + [0] + [thr + 1] * 5, W)


def test_background_motion_static_vs_panning():
    static = [background_motion(frame(i), frame(i + 1), []) for i in range(3)]
    pan = [background_motion(frame(i, pan_px=12), frame(i + 1, pan_px=12), [(0, 100, 60, 140)]) for i in range(3)]
    assert max(static) < 0.01 * W
    assert min(pan) > 0.01 * W
