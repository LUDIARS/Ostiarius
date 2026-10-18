"""Input/output contract for upstream 2.7_80x80_MiniFASNetV2 logits.

This adapter expects an export preserving the upstream model's class ordering
and raw BGR input. It must not be used with a rescaled/reordered export.
"""
from __future__ import annotations

import cv2
import numpy as np


def liveness_input(image: np.ndarray, bbox: np.ndarray) -> np.ndarray:
    """Keep surrounding context, then produce raw BGR float32 NCHW pixels."""
    if image.ndim != 3 or image.shape[2] != 3 or image.dtype != np.uint8:
        raise RuntimeError("liveness requires a uint8 BGR image")
    height, width = image.shape[:2]
    box = np.asarray(bbox, dtype=np.float64)
    if box.shape != (4,) or not np.isfinite(box).all() or min(height, width) < 2:
        raise RuntimeError("invalid liveness crop")
    x, y, box_width, box_height = box
    if box_width <= 0 or box_height <= 0 or x + box_width <= 0 or y + box_height <= 0 or x >= width or y >= height:
        raise RuntimeError("invalid liveness crop")
    # Match upstream CropImage: cap scale to the image and translate at edges
    # instead of trimming context or warping the face to an aligned embedding.
    scale = min(2.7, (width - 1) / box_width, (height - 1) / box_height)
    crop_width, crop_height = box_width * scale, box_height * scale
    left = min(max(x + (box_width - crop_width) / 2, 0), width - 1 - crop_width)
    top = min(max(y + (box_height - crop_height) / 2, 0), height - 1 - crop_height)
    right, bottom = left + crop_width, top + crop_height
    crop = image[int(top):int(bottom) + 1, int(left):int(right) + 1]
    resized = cv2.resize(crop, (80, 80), interpolation=cv2.INTER_LINEAR)
    # Upstream functional.to_tensor explicitly does NOT divide uint8 by 255.
    return np.ascontiguousarray(resized.transpose(2, 0, 1)[None], dtype=np.float32)


def live_probability(logits: np.ndarray) -> float:
    """Upstream class 1 is real; classes 0 and 2 are presentation attacks."""
    values = np.asarray(logits, dtype=np.float64)
    if values.shape not in ((3,), (1, 3)) or not np.isfinite(values).all():
        raise RuntimeError("invalid liveness logits")
    values = values.reshape(3)
    probabilities = np.exp(values - values.max())
    return float(probabilities[1] / probabilities.sum())
