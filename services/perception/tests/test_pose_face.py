import json
from pathlib import Path

from perception.models import pose_from_landmarks
from perception.settings import SETTINGS
import verdict_face as vf


def test_pose_standing_and_elbow():
    # image coords (y down): upright body, straight legs, one arm bent 90°.
    pts = {11: (50, 50), 12: (70, 50), 23: (52, 120), 24: (68, 120), 25: (52, 170), 26: (68, 170), 27: (52, 220), 28: (68, 220),
           13: (50, 90), 15: (90, 90), 14: (70, 90), 16: (70, 130)}
    p = pose_from_landmarks(lambda i: pts.get(i), SETTINGS["pose"])
    assert p.standing is True
    assert abs(p.elbow_deg - 90.0) < 1e-6
    sitting = {**pts, 25: (100, 120), 26: (110, 120)}  # thighs horizontal
    assert pose_from_landmarks(lambda i: sitting.get(i), SETTINGS["pose"]).standing is False


def test_face_projection_is_pinned_and_preserves_identity():
    lock = json.loads((Path(__file__).parent.parent / "weights.lock.json").read_text())
    assert lock["derived"]["face_projection"] == vf.projection_sha256()
    import numpy as np

    rng = np.random.default_rng(1)
    a = rng.standard_normal(512)
    same = a + 0.25 * rng.standard_normal(512)
    other = rng.standard_normal(512)
    qa, qs, qo = (vf.quantize(vf.project_arcface(x)) for x in (a, same, other))
    assert vf.cos_bps(qa, qs) >= vf.TAU_FACE_BPS
    assert vf.cos_bps(qa, qo) < vf.TAU_FACE_BPS
