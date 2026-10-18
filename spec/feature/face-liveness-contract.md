# Face liveness input/output contract

## Purpose and scope

Part of the requested authentication runtime readiness work. The MiniFASNetV2
adapter previously reused an aligned identity crop, normalized/swapped channels,
and treated the final class as live. For the upstream 2.7_80x80 model those are
incorrect. This change isolates and corrects that contract. It does not enable
face authentication, approve model artifacts, or establish physical accuracy.

## Contract

- Use the original BGR frame and detector bounding box (x, y, width, height).
- Expand by 2.7, cap dimensions to image size minus one, translate at edges,
  and include both boundary pixels, matching upstream CropImage.
- Resize to 80x80, float32 NCHW, preserving BGR values in 0..255. No alignment,
  channel swap, subtraction, or division by 255.
- Expect one three-class logit vector. Stable softmax class index 1 is live;
  0 and 2 are attacks. Reject non-finite/malformed values and invalid crops.
- An exported model must preserve this contract. Documentation claiming live
  index 0 or normalized input is not sufficient evidence of compatibility.

## Evidence inspected 2026-10-18

- [Upstream ndarray conversion](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/blob/master/src/data_io/functional.py): `to_tensor` preserves raw pixel range despite the older ToTensor docstring.
- [Upstream inference](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/blob/master/src/anti_spoof_predict.py): ToTensor then model and softmax.
- [Upstream cropping](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/blob/master/src/generate_patches.py).
- [Upstream decision](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/blob/master/test.py): class 1 is real.

## Acceptance and remaining deployment work

Automated checks cover raw channels/range, context and edge crops, rejection of
both attack classes, overflow-safe probabilities, malformed outputs, and use of
the original frame by the analyzer. They use synthetic pixels, not face data.

Before deployment: verify the exact exported artifact against upstream weights,
pin its provenance/digest, and test real people and print/screen replay with
consent. Model replacement (including the commercial-use identity candidate
AuraFace) and Vultus facial-part integration remain separate unfinished work.
Existing model files must not be assumed compatible from filenames alone.
