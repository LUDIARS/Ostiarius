"""Downloads model artifacts only when their pinned SHA-256 digest matches."""
from __future__ import annotations
import hashlib, pathlib, urllib.request

MODELS: dict[str, tuple[str, str]] = {
  "scrfd_10g_bnkps.onnx": ("https://github.com/deepinsight/insightface/releases/download/v0.7/scrfd_10g_bnkps.onnx", "d6f9b1d4c9f4ce31d1a0a719bf2d6a53b6b8c71887aee92bc2466eae1d03951f"),
  "glintr100.onnx": ("https://github.com/deepinsight/insightface/releases/download/v0.7/glintr100.onnx", "10a5bb30ba5158de9f1bb714d6b9f0d7f5f0c356ea2d220f5da9ca2bc40eca22"),
  "MiniFASNetV2.onnx": ("https://github.com/kprokofi/light-weight-face-anti-spoofing/raw/master/resources/anti_spoof_models/2.7_80x80_MiniFASNetV2.onnx", "cbbd0e0148643363040ac0ee2044e0e2778cc4cfd3e13e3177135253194ab68d"),
  # The MediaPipe task bundle provides the landmark, blendshape and face-pose heads.
  # Keep its digest in deployment configuration: Google can replace a `latest` asset.
  "face_landmarker.task": ("https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task", "c59c6fdcf9af138c5bad034137cf0fb553dbd363c0a3956b51570425209ad4c4"),
}
def fetch(name: str, url: str, expected: str, target: pathlib.Path) -> None:
    data = urllib.request.urlopen(url).read(); actual = hashlib.sha256(data).hexdigest()
    if actual != expected: raise RuntimeError(f"checksum mismatch for {name}: {actual}")
    target.write_bytes(data)
if __name__ == "__main__":
    directory = pathlib.Path(__file__).parents[1] / "models"; directory.mkdir(exist_ok=True)
    for name, (url, digest) in MODELS.items(): fetch(name, url, digest, directory / name)
