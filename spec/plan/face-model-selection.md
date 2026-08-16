# plan: 顔認証 OSS の選定 (2026-08 調査)

neco 指示: Vultus とロジックを揃える必要はなく、**最も精度が高くなるであろう OSS** を選ぶ。
用途は roster 数十〜数百人に対する認証用 1:N (falseAccept 重視) + 提示攻撃検知。

## 1. 認識モデル (embedding)

| 候補 | 学習データ / 構造 | 強み | 弱み | 判定 |
|---|---|---|---|---|
| **InsightFace glintr100 (antelopev2)** | Glint360K, ResNet100, ArcFace loss, 512d, ONNX | 公開重みで最上位級 (IJB-C 高)、ONNX Runtime CPU で動く、SCRFD と組合せ実績 | buffalo_l (r50) より 2〜3 倍重い | **主候補 (採用)** |
| AdaFace IR-101 (WebFace12M) | 画質適応マージン | 低画質・ぼけ・遠距離で最も堅牢 (OODFace 等) | 公式は PyTorch、ONNX 化が必要。5 点アライン前提は同じ | **比較候補** (P4 実機で誤拒否率が高ければ切替) |
| TransFace / ViT 系 | ViT | 高精度 | 重い、エッジ CPU で遅い | 不採用 |
| InsightFace buffalo_l (w600k_r50) | WebFace600K r50 | 軽い、Vultus 採用 | glintr100 より精度下 | 不採用 (Vultus と揃えない方針とも整合) |
| SFace (OpenCV Zoo, 128d) | 軽量 | Ludellus-Native 採用、極軽 | 精度は上記より明確に下 | 不採用 |
| face-api.js / ブラウザ内推論 | JS | サーバ不要 | 精度低・改ざん容易 | 不採用 |

- 前処理: SCRFD 5 点 → 112x112 similarity transform (ArcFace 標準アライン)。AdaFace も同じアラインで比較可能。
- 閾値初期値 (cos): glintr100 0.62 (roster 内 1:N、margin 0.08)。P4 で施設データを使い FAR 目標 ≤ 0.1% で調整。

## 2. 検出

| 候補 | 判定 |
|---|---|
| **SCRFD-10G (InsightFace, ONNX)** | **採用**。5 点ランドマーク同時出力、精度・速度のバランス |
| YuNet (OpenCV) | Vultus / Ludellus-Native 採用。軽いが小顔・横顔で SCRFD に劣る。差し替え候補として保持 |
| RetinaFace-R50 | 高精度だが重い |

## 3. 生体性 (presentation attack detection)

| 層 | 候補 | 判定 |
|---|---|---|
| パッシブ | **MiniFASNetV2 / V1SE (Silent-Face-Anti-Spoofing, ONNX ~600KB)** | **採用**。写真・画面再生を弾く。Ludellus-Native の調査と同結論 |
| アクティブ | **MediaPipe Face Landmarker blendshapes** (瞬き) + 頭部姿勢 (首振り/頷き) | **採用**。ランダム 1 種チャレンジ |
| 深度/IR | RealSense 等 | 将来 (ハード要件)。現段階は不採用 |

## 4. 配布・検証
- 重みは `face-sidecar/models/`、`fetch-models.py` で配布元 URL + SHA-256 を検証 (Vultus と同じ運用、コードは別)。
- `modelId` を `insightface/glintr100@1` のように固定し、テンプレートに刻む (モデル更新 = 再登録)。

## 5. 実機評価計画 (P4)
- 施設で同意済み職員 10 名程度で enroll → 1 週間の kiosk 実測: 誤拒否率、平均フレーム数、チャレンジ失敗率、処理時間。
- 写真提示 (スマホ画面 / 印刷) を各 20 回試して spoof 検出率を記録。
- AdaFace 比較は同じショットからオフラインで embedding を出し、同一 roster での margin 分布を比較。

Sources: InsightFace model zoo (SCRFD / antelopev2 / buffalo_l), Silent-Face-Anti-Spoofing (MiniFASNet),
AdaFace (CVPR 2022), OODFace (arXiv 2412.02479), TransFace++ (arXiv 2308.10133),
facecheck.id / mixpeek 2026 比較記事。
