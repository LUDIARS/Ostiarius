import cv2
import numpy as np
import pytest

from face_sidecar.liveness import live_probability, liveness_input


def test_preserves_bgr_channels_and_raw_pixel_range():
    image = np.full((100, 100, 3), [12, 128, 255], dtype=np.uint8)
    blob = liveness_input(image, np.array([40, 40, 20, 20]))
    assert blob.shape == (1, 3, 80, 80)
    assert blob.dtype == np.float32
    assert blob.flags.c_contiguous
    np.testing.assert_array_equal(blob[0, :, 0, 0], [12, 128, 255])


@pytest.mark.parametrize("box,expected_bounds", [
    ([40, 40, 20, 20], (23, 23, 77, 77)),
    ([0, 0, 20, 20], (0, 0, 54, 54)),
    ([80, 80, 20, 20], (45, 45, 99, 99)),
    ([0, 0, 100, 100], (0, 0, 99, 99)),
])
def test_crop_keeps_context_and_translates_at_image_edges(box, expected_bounds):
    # Fixed bounds independently derived from upstream CropImage's 2.7 scale.
    image = np.arange(100 * 100 * 3, dtype=np.uint8).reshape(100, 100, 3)
    left, top, right, bottom = expected_bounds
    expected = cv2.resize(image[top:bottom + 1, left:right + 1], (80, 80))
    actual = liveness_input(image, np.array(box))[0].transpose(1, 2, 0)
    np.testing.assert_array_equal(actual, expected)


@pytest.mark.parametrize("index", [0, 2])
def test_attack_classes_do_not_become_live(index):
    logits = np.zeros((1, 3))
    logits[0, index] = 1000
    assert live_probability(logits) == 0.0


def test_real_class_is_stable_for_large_logits():
    assert live_probability(np.array([[0, 1000, 0]])) == 1.0
    assert live_probability(np.array([1000, 1000, 1000])) == pytest.approx(1 / 3)


@pytest.mark.parametrize("logits", [[], [1, 2], [0, np.nan, 0], [0, np.inf, 0], [[1, 2, 3], [1, 2, 3]]])
def test_malformed_outputs_fail_closed(logits):
    with pytest.raises(RuntimeError, match="invalid liveness logits"):
        live_probability(np.array(logits))


@pytest.mark.parametrize("box", [[0, 0, 0, 5], [0, 0, -1, 5], [np.nan, 0, 5, 5], [200, 0, 5, 5], [0, 0, 5]])
def test_invalid_boxes_fail_closed(box):
    with pytest.raises(RuntimeError, match="invalid liveness crop"):
        liveness_input(np.zeros((100, 100, 3), dtype=np.uint8), np.array(box))


def test_analyzer_supplies_original_frame_and_box_to_liveness():
    from face_sidecar.app import OnnxAnalyzer

    analyzer = OnnxAnalyzer.__new__(OnnxAnalyzer)
    frame = np.zeros((200, 200, 3), dtype=np.uint8)
    box = np.array([40, 40, 120, 120])
    analyzer._detect = lambda image: ([box], [np.ones((5, 2))])
    analyzer._landmark = lambda image: object()
    analyzer._align = lambda image, points: np.ones((112, 112, 3), dtype=np.uint8)
    analyzer._embedding = lambda aligned: np.ones(512)
    def check_liveness(image, supplied_box):
        assert image is frame
        assert supplied_box is box
        return 0.99
    analyzer._liveness = check_liveness
    assert analyzer.analyze(frame)[0].liveness == 0.99
