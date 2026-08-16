from __future__ import annotations

import asyncio
import base64
import binascii
import time
from dataclasses import dataclass
from typing import Protocol

import cv2
import mediapipe as mp
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

MODEL_ID = "insightface/glintr100@1"

@dataclass(frozen=True)
class InferenceFace:
    bbox: tuple[float, float, float, float]
    score: float
    landmarks5: list[tuple[float, float]]
    liveness: float
    embedding: np.ndarray
    yaw: float = 0.0
    pitch: float = 0.0
    blendshapes: dict[str, float] | None = None

class Analyzer(Protocol):
    def analyze(self, image: np.ndarray) -> list[InferenceFace]: ...

class UnavailableAnalyzer:
    def analyze(self, image: np.ndarray) -> list[InferenceFace]:
        raise RuntimeError("face models are unavailable; fetch and verify weights before starting the sidecar")

class OnnxAnalyzer:
    """Injectable ONNX runtime backend; model files are verified by fetch-models.py before use."""
    def __init__(self, model_dir: str) -> None:
        from pathlib import Path
        directory = Path(model_dir)
        self.detector = ort.InferenceSession(str(directory / "scrfd_10g_bnkps.onnx"), providers=["CPUExecutionProvider"])
        self.embedder = ort.InferenceSession(str(directory / "glintr100.onnx"), providers=["CPUExecutionProvider"])
        self.liveness_model = ort.InferenceSession(str(directory / "MiniFASNetV2.onnx"), providers=["CPUExecutionProvider"])
        options = mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(directory / "face_landmarker.task")),
            running_mode=mp.tasks.vision.RunningMode.IMAGE,
            num_faces=5,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
        self.landmarker = mp.tasks.vision.FaceLandmarker.create_from_options(options)

    def analyze(self, image: np.ndarray) -> list[InferenceFace]:
        # SCRFD output layouts differ by exporter; the detector adapter isolates that contract.
        boxes, landmarks = self._detect(image)
        landmarks_result = self._landmark(image)
        faces: list[InferenceFace] = []
        for box, points in zip(boxes, landmarks, strict=True):
            aligned = self._align(image, points)
            embedding = self._embedding(aligned)
            liveness = self._liveness(aligned)
            yaw, pitch = self._pose_for(landmarks_result)
            faces.append(InferenceFace(tuple(float(value) for value in box), 1.0, [tuple(map(float, point)) for point in points], liveness, embedding, yaw, pitch, self._blendshapes(landmarks_result)))
        return faces

    def _detect(self, image: np.ndarray) -> tuple[list[np.ndarray], list[np.ndarray]]:
        blob = cv2.dnn.blobFromImage(image, 1 / 128, (640, 640), (127.5, 127.5, 127.5), swapRB=True)
        outputs = self.detector.run(None, {self.detector.get_inputs()[0].name: blob})
        boxes, points, scores = self._decode_scrfd(outputs)
        kept = self._nms(boxes, scores)
        scale_x, scale_y = image.shape[1] / 640, image.shape[0] / 640
        decoded_boxes = [np.array([boxes[index][0] * scale_x, boxes[index][1] * scale_y, (boxes[index][2] - boxes[index][0]) * scale_x, (boxes[index][3] - boxes[index][1]) * scale_y]) for index in kept]
        decoded_points = [points[index] * np.array([scale_x, scale_y]) for index in kept]
        return decoded_boxes, decoded_points

    def _decode_scrfd(self, outputs: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        groups: dict[int, dict[int, np.ndarray]] = {}
        for output in outputs:
            value = np.squeeze(output)
            if value.ndim != 2: continue
            columns = value.shape[1]
            if columns not in (1, 2, 4, 8, 10, 20): continue
            rows = value.shape[0]
            groups.setdefault(rows, {})[columns] = value
        boxes: list[np.ndarray] = []; points: list[np.ndarray] = []; scores: list[np.ndarray] = []
        for rows, group in groups.items():
            score = group.get(1) if group.get(1) is not None else group.get(2)
            distance = group.get(4) if group.get(4) is not None else group.get(8)
            keypoints = group.get(10) if group.get(10) is not None else group.get(20)
            if score is None or distance is None or keypoints is None: continue
            anchors = distance.shape[1] // 4
            cells = rows // anchors
            side = int(round(cells ** .5))
            if side * side != cells: continue
            stride = 640 / side
            grid = np.stack(np.meshgrid(np.arange(side), np.arange(side)), axis=-1).reshape(-1, 2).astype(np.float32) * stride
            centers = np.repeat(grid, anchors, axis=0)
            distances = distance.reshape(rows, 4) * stride
            box = np.column_stack((centers[:, 0] - distances[:, 0], centers[:, 1] - distances[:, 1], centers[:, 0] + distances[:, 2], centers[:, 1] + distances[:, 3]))
            point = keypoints.reshape(rows, 5, 2) * stride + centers[:, None, :]
            value = score.reshape(rows, -1)[:, -1]
            boxes.append(box); points.append(point); scores.append(value)
        if not boxes: raise RuntimeError("unsupported SCRFD output layout")
        return np.concatenate(boxes), np.concatenate(points), np.concatenate(scores)

    def _nms(self, boxes: np.ndarray, scores: np.ndarray) -> list[int]:
        order = scores.argsort()[::-1]; kept: list[int] = []
        while order.size and len(kept) < 5:
            index = int(order[0]); order = order[1:]
            if scores[index] < .5: break
            kept.append(index)
            if not order.size: break
            left = np.maximum(boxes[index, 0], boxes[order, 0]); top = np.maximum(boxes[index, 1], boxes[order, 1])
            right = np.minimum(boxes[index, 2], boxes[order, 2]); bottom = np.minimum(boxes[index, 3], boxes[order, 3])
            overlap = np.maximum(0, right - left) * np.maximum(0, bottom - top)
            area = (boxes[index, 2] - boxes[index, 0]) * (boxes[index, 3] - boxes[index, 1])
            candidate_area = (boxes[order, 2] - boxes[order, 0]) * (boxes[order, 3] - boxes[order, 1])
            order = order[overlap / np.maximum(area + candidate_area - overlap, 1e-6) < .4]
        return kept

    def _landmark(self, image: np.ndarray) -> object:
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        return self.landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))

    def _pose_for(self, result: object) -> tuple[float, float]:
        matrices = getattr(result, "facial_transformation_matrixes", [])
        if not matrices: return 0.0, 0.0
        matrix = np.asarray(matrices[0])
        yaw = float(np.degrees(np.arctan2(matrix[0, 2], matrix[2, 2])))
        pitch = float(np.degrees(np.arctan2(-matrix[1, 2], np.hypot(matrix[0, 2], matrix[2, 2]))))
        return yaw, pitch

    def _blendshapes(self, result: object) -> dict[str, float]:
        categories = getattr(result, "face_blendshapes", [])
        if not categories: return {}
        return {category.category_name: float(category.score) for category in categories[0]}

    def _align(self, image: np.ndarray, points: np.ndarray) -> np.ndarray:
        target = np.float32([[38.3, 51.7], [73.5, 51.5], [56.0, 71.7], [41.5, 92.4], [70.7, 92.2]])
        matrix, _ = cv2.estimateAffinePartial2D(points.astype(np.float32), target)
        if matrix is None: raise RuntimeError("face alignment failed")
        return cv2.warpAffine(image, matrix, (112, 112), borderValue=0)

    def _embedding(self, aligned: np.ndarray) -> np.ndarray:
        blob = cv2.dnn.blobFromImage(aligned, 1 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        value = self.embedder.run(None, {self.embedder.get_inputs()[0].name: blob})[0].reshape(-1).astype(np.float32)
        return value / np.linalg.norm(value)

    def _liveness(self, aligned: np.ndarray) -> float:
        blob = cv2.dnn.blobFromImage(cv2.resize(aligned, (80, 80)), 1 / 128, (80, 80), (127.5, 127.5, 127.5), swapRB=True)
        value = self.liveness_model.run(None, {self.liveness_model.get_inputs()[0].name: blob})[0].reshape(-1)
        return float(np.exp(value[-1]) / np.exp(value).sum())

def quality(face: InferenceFace, image: np.ndarray) -> dict[str, object]:
    width = face.bbox[2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    failures: list[str] = []
    if width < 112: failures.append("too_small")
    if blur < 40: failures.append("blur")
    if abs(face.yaw) > 25: failures.append("yaw")
    if abs(face.pitch) > 20: failures.append("pitch")
    return {"width": width, "blur": blur, "yaw": face.yaw, "pitch": face.pitch, "pass": not failures, "fail": failures}

def face_response(face: InferenceFace, image: np.ndarray, wants: set[str]) -> dict[str, object]:
    result: dict[str, object] = {"bbox": list(face.bbox), "score": face.score, "landmarks5": [list(point) for point in face.landmarks5]}
    result["quality"] = quality(face, image)
    if "liveness" in wants: result["liveness"] = face.liveness
    if "embedding" in wants and result["quality"]["pass"]:
        normalized = face.embedding.astype("<f4", copy=False); normalized = normalized / np.linalg.norm(normalized)
        result["embedding"] = base64.b64encode(normalized.tobytes()).decode("ascii")
    if "blendshapes" in wants:
        result["blendshapes"] = face.blendshapes or {"eyeBlinkLeft": 0.0, "eyeBlinkRight": 0.0, "jawOpen": 0.0}
        result["pose"] = {"yaw": face.yaw, "pitch": face.pitch, "roll": 0.0}
    return result

class BatchRequest(BaseModel):
    images: list[str]


def decode_batch_image(encoded: str) -> bytes:
    # A decoded frame follows the same limit as /v1/analyze.  Validate before
    # dispatching it to OpenCV so malformed input does not become a 500 response.
    if len(encoded) > 266_668:
        raise HTTPException(413, "image too large")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise HTTPException(400, "invalid base64 image") from error
    if len(raw) > 200_000:
        raise HTTPException(413, "image too large")
    return raw


def create_app(analyzer: Analyzer | None = None) -> FastAPI:
    app = FastAPI(); engine = analyzer or UnavailableAnalyzer(); gate = asyncio.Semaphore(1)
    @app.get("/v1/health")
    async def health() -> dict[str, object]:
        return {"ok": not isinstance(engine, UnavailableAnalyzer), "modelId": MODEL_ID, "detector": "scrfd_10g", "liveness": "minifasnet_v2", "landmarker": "mediapipe_face_landmarker@1", "device": "cpu"}
    async def run(raw: bytes, wants: set[str]) -> list[dict[str, object]]:
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None: raise HTTPException(400, "invalid image")
        if gate.locked(): raise HTTPException(429, "busy")
        async with gate:
            try: faces = engine.analyze(image)
            except RuntimeError as error: raise HTTPException(503, "models unavailable") from error
        return [face_response(face, image, wants) for face in sorted(faces, key=lambda item: item.bbox[2] * item.bbox[3], reverse=True)[:5]]
    @app.post("/v1/analyze")
    async def analyze(image: UploadFile = File(...), want: str = Form("embedding,liveness")) -> dict[str, object]:
        raw = await image.read()
        if len(raw) > 200_000: raise HTTPException(413, "image too large")
        started = time.perf_counter(); faces = await run(raw, set(want.split(",")))
        return {"faces": faces, "ms": round((time.perf_counter() - started) * 1000)}
    @app.post("/v1/embed-batch")
    async def embed_batch(body: BatchRequest) -> dict[str, object]:
        if len(body.images) > 8: raise HTTPException(400, "at most 8 images")
        embeddings: list[str | None] = []; qualities: list[dict[str, object]] = []
        for encoded in body.images:
            faces = await run(decode_batch_image(encoded), {"embedding", "liveness"}); face = faces[0] if faces else None
            embeddings.append(face.get("embedding") if face else None); qualities.append(face.get("quality") if face else {"pass": False, "fail": ["no_face"]})
        return {"embeddings": embeddings, "qualities": qualities}
    return app


REQUIRED_MODEL_FILES = ("scrfd_10g_bnkps.onnx", "glintr100.onnx", "MiniFASNetV2.onnx", "face_landmarker.task")


def default_models_dir() -> str:
    """FACE_SIDECAR_MODELS_DIR (Excubitor catalog) or <package>/../models (fetch-models.py の既定出力先)。"""
    import os
    from pathlib import Path
    return os.environ.get("FACE_SIDECAR_MODELS_DIR") or str(Path(__file__).resolve().parents[1] / "models")


def load_default_analyzer(model_dir: str | None = None) -> Analyzer:
    """モデル一式が揃っていれば OnnxAnalyzer、無ければ UnavailableAnalyzer (health ok=false、/v1/analyze 503)。
    起動を止めないのは Ostiarius が sidecar.ok=false で顔経路を fallback 表示に切り替える設計のため。"""
    import sys
    from pathlib import Path
    directory = Path(model_dir or default_models_dir())
    missing = [name for name in REQUIRED_MODEL_FILES if not (directory / name).is_file()]
    if missing:
        print(f"[face-sidecar] models unavailable in {directory}: missing {', '.join(missing)} (run scripts/fetch-models.py)", file=sys.stderr)
        return UnavailableAnalyzer()
    return OnnxAnalyzer(str(directory))


app = create_app(load_default_analyzer())
