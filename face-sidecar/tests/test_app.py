import base64

import cv2
import numpy as np
from fastapi.testclient import TestClient

from face_sidecar.app import InferenceFace, create_app


class FakeAnalyzer:
    def analyze(self, image: np.ndarray) -> list[InferenceFace]:
        return [InferenceFace(
            bbox=(4.0, 4.0, 160.0, 160.0), score=0.99,
            landmarks5=[(20, 20)] * 5, liveness=0.98,
            embedding=np.ones(512, dtype=np.float32),
        )]


def image_bytes() -> bytes:
    image = np.zeros((200, 200, 3), dtype=np.uint8)
    cv2.rectangle(image, (20, 20), (180, 180), (255, 255, 255), 3)
    ok, encoded = cv2.imencode('.jpg', image)
    assert ok
    return encoded.tobytes()


def test_health_and_analyze_shape() -> None:
    client = TestClient(create_app(FakeAnalyzer()))
    assert client.get('/v1/health').json()['ok'] is True
    response = client.post('/v1/analyze', files={'image': ('frame.jpg', image_bytes(), 'image/jpeg')}, data={'want': 'embedding,liveness,blendshapes'})
    assert response.status_code == 200
    face = response.json()['faces'][0]
    assert face['quality']['pass'] is True
    assert len(base64.b64decode(face['embedding'])) == 512 * 4
    assert 'blendshapes' in face and 'pose' in face


def test_embed_batch_limits_input() -> None:
    client = TestClient(create_app(FakeAnalyzer()))
    image = base64.b64encode(image_bytes()).decode('ascii')
    assert client.post('/v1/embed-batch', json={'images': [image]}).json()['embeddings'][0]
    assert client.post('/v1/embed-batch', json={'images': [image] * 9}).status_code == 400
    assert client.post('/v1/embed-batch', json={'images': ['not base64!']}).status_code == 400


def test_quality_gate_omits_embedding_for_small_face() -> None:
    class SmallFaceAnalyzer:
        def analyze(self, image: np.ndarray) -> list[InferenceFace]:
            return [InferenceFace((1, 1, 100, 100), .99, [(1, 1)] * 5, .98, np.ones(512, dtype=np.float32))]

    client = TestClient(create_app(SmallFaceAnalyzer()))
    response = client.post('/v1/analyze', files={'image': ('frame.jpg', image_bytes(), 'image/jpeg')})
    face = response.json()['faces'][0]
    assert face['quality']['pass'] is False
    assert 'embedding' not in face


def test_load_default_analyzer_falls_back_when_models_missing(tmp_path, monkeypatch):
    from face_sidecar.app import UnavailableAnalyzer, load_default_analyzer

    monkeypatch.setenv("FACE_SIDECAR_MODELS_DIR", str(tmp_path))
    analyzer = load_default_analyzer()
    assert isinstance(analyzer, UnavailableAnalyzer)
    client = TestClient(create_app(analyzer))
    assert client.get("/v1/health").json()["ok"] is False
    response = client.post("/v1/analyze", files={"image": ("f.jpg", image_bytes(), "image/jpeg")})
    assert response.status_code == 503
