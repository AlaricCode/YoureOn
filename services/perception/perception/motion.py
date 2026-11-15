"""Camera-motion flag (§6.2): bit0 when the median optical-flow magnitude of
the *background* exceeds 1% of the frame width for more than 5 consecutive
frames (frame-to-frame at 10 fps)."""
from __future__ import annotations

import numpy as np

from .settings import SETTINGS


def background_motion(prev: np.ndarray, cur: np.ndarray, boxes: list[tuple[float, float, float, float]]) -> float:
    """Median flow magnitude (in source pixels) outside the detection boxes."""
    import cv2

    cfg = SETTINGS["motion"]
    h, w = cur.shape[:2]
    scale = cfg["flow_width_px"] / float(w)
    size = (cfg["flow_width_px"], max(1, int(round(h * scale))))
    a = cv2.cvtColor(cv2.resize(prev, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    b = cv2.cvtColor(cv2.resize(cur, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    flow = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 3, 15, 3, 5, 1.2, 0)
    mag = np.hypot(flow[..., 0], flow[..., 1])
    mask = np.ones(mag.shape, dtype=bool)
    for x0, y0, x1, y1 in boxes:
        xa, ya = max(0, int(x0 * scale)), max(0, int(y0 * scale))
        xb, yb = min(mag.shape[1], int(np.ceil(x1 * scale))), min(mag.shape[0], int(np.ceil(y1 * scale)))
        if xb > xa and yb > ya:
            mask[ya:yb, xa:xb] = False
    vals = mag[mask] if mask.any() else mag.reshape(-1)
    return float(np.median(vals)) / scale


def camera_motion_flag(magnitudes_px: list[float], width_px: int) -> bool:
    """True when > min_consecutive-1 (i.e. more than 5) consecutive magnitudes exceed 1% of width."""
    cfg = SETTINGS["motion"]
    thr = cfg["threshold_frac_width"] * width_px
    run = 0
    for m in magnitudes_px:
        run = run + 1 if m > thr else 0
        if run >= cfg["min_consecutive_frames"]:
            return True
    return False
