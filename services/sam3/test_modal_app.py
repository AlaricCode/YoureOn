"""Checks for the pure helpers in modal_app.py (no GPU, no Modal call).

    ~/.venvs/modal/bin/python services/sam3/test_modal_app.py   (needs modal, numpy, scipy)
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import modal_app as m  # noqa: E402


def mask(blobs, h=20, w=30):
    a = np.zeros((h, w), bool)
    for y0, y1, x0, x1 in blobs:
        a[y0:y1, x0:x1] = True
    return a


def test_main_blob_box_ignores_stray_pixels():
    m3 = mask([(5, 15, 10, 14), (0, 1, 0, 1), (19, 20, 29, 30)])
    o = m.objects_of({"out_obj_ids": np.array([3]), "out_probs": np.array([0.9]), "out_binary_masks": np.array([m3])}, True)[0]
    assert o["box_xyxy"] == [10, 5, 14, 15]
    assert o["box_all_xyxy"] == [0, 0, 30, 20]
    assert o["components"] == 3 and o["mask_area"] == 42 and o["score"] == 0.9
    # the RLE decodes back to the same mask (column-major, starting with a zeros run)
    r = o["mask_rle"]
    flat = np.concatenate([np.full(c, i % 2, np.uint8) for i, c in enumerate(r["counts"])])
    assert (flat.reshape(r["size"][::-1]).T.astype(bool) == m3).all()


def test_empty_and_missing_outputs():
    empty = m.objects_of({"out_obj_ids": np.array([1]), "out_binary_masks": np.zeros((1, 20, 30), bool)}, False)[0]
    assert empty["mask_area"] == 0 and empty["box_xyxy"] is None and "score" not in empty
    assert m.objects_of({"out_obj_ids": np.zeros(0)}, False) == []


def test_tracks_span_gaps_and_shape():
    a = {"id": 3, "score": 0.9, "box_xyxy": [10, 5, 14, 15], "mask_area": 40}
    frames = [
        {"index": 0, "objects": [a]},
        {"index": 1, "objects": []},
        {"index": 2, "objects": [dict(a, box_xyxy=[10, 10, 20, 15], mask_area=50)]},
        {"index": 3, "objects": [dict(a, box_xyxy=None, mask_area=0)]},
    ]
    (t,) = m.tracks_of(frames)
    assert t["frames"] == [0, 2] and t["missing"] == [1]
    assert t["first"]["aspect_h_over_w"] == 2.5 and t["last"]["aspect_h_over_w"] == 0.5
    assert m.tracks_of([{"index": 0, "objects": []}]) == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok {name}")
