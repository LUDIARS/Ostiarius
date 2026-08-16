# interface: face-sidecar (Python / ONNX Runtime、localhost 専用)

Ostiarius 本体 (Node) から HTTP で呼ぶ推論サイドカー。**127.0.0.1 のみ listen** (既定 17591)。
モデルはコンテナ/ホストに置き、SHA-256 を検証してからロード (Vultus analyzer と同じ運用、コードは共有しない)。

- 配置: `face-sidecar/` (pyproject、`vultus` 依存なし)、起動は Excubitor catalog に別サービスとして登録
- モデル: [../plan/face-model-selection.md](../plan/face-model-selection.md)

## `GET /v1/health`
- res: `{ ok, modelId: 'insightface/glintr100@1', detector: 'scrfd_10g', liveness: 'minifasnet_v2', landmarker: 'mediapipe_face_landmarker@1', device: 'cpu' }`

## `POST /v1/analyze`
- req: `multipart/form-data` `image` (JPEG/PNG)、`want` (CSV: `embedding,liveness,blendshapes`、既定 `embedding,liveness`)
- res 200:
  ```jsonc
  { "faces": [ {                          // 面積降順、最大 5
      "bbox": [x, y, w, h], "score": 0.99,
      "landmarks5": [[x,y],...],
      "quality": { "width": 148, "blur": 213.4, "yaw": 3.1, "pitch": -2.0, "pass": true, "fail": [] },
      "liveness": 0.97,                    // want に liveness
      "embedding": "base64(float32[512] LE)", // want に embedding かつ quality.pass
      "blendshapes": { "eyeBlinkLeft": 0.05, "eyeBlinkRight": 0.04, "jawOpen": 0.0 }, // want に blendshapes
      "pose": { "yaw": 3.1, "pitch": -2.0, "roll": 0.5 } } ],
    "ms": 180 }
  ```
- `quality.pass=false` の顔は `embedding` を返さない (`fail` に理由: `too_small|blur|yaw|pitch|occlusion`)。
- 画像はメモリ上でのみ処理し、ディスク・ログに書かない。

## `POST /v1/embed-batch` (enroll 用)
- req: JSON `{ images: [base64 JPEG...] }` (≤ 8)
- res: `{ embeddings: [base64 | null], qualities: [...] }`

## 実行制御
- 同時 1 リクエスト、キュー長 1 (古いフレームは 429 `{ error: 'busy' }`)。Ostiarius 側は最新フレームだけ送る。
- モデルロード失敗は起動失敗 (Ostiarius は `/api/health` の `sidecar.ok=false` で顔経路を `fallback` 表示)。
