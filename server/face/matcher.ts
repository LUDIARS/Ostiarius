export interface FaceMatch { userId: string; score: number; runnerUp: number; }
export interface FaceRoster { userIds: readonly string[]; embeddings: readonly Float32Array[]; }

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) { const a = left[index] ?? 0; const b = right[index] ?? 0; dot += a * b; leftNorm += a * a; rightNorm += b * b; }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function findFaceMatch(embedding: Float32Array, roster: FaceRoster): FaceMatch | null {
  let best: FaceMatch | null = null;
  for (let index = 0; index < roster.embeddings.length; index += 1) {
    const candidate = roster.embeddings[index]; const userId = roster.userIds[index];
    if (!candidate || !userId) continue;
    const score = cosineSimilarity(embedding, candidate);
    if (!best) best = { userId, score, runnerUp: -1 };
    else if (score > best.score) best = { userId, score, runnerUp: best.score };
    else if (score > best.runnerUp) best.runnerUp = score;
  }
  return best;
}

export class ConsecutiveFaceVote {
  private userId: string | null = null;
  private count = 0;
  add(candidate: FaceMatch | null, threshold: number, margin: number): string | null {
    if (!candidate || candidate.score < threshold || candidate.score - candidate.runnerUp < margin) { this.reset(); return null; }
    this.count = this.userId === candidate.userId ? this.count + 1 : 1; this.userId = candidate.userId;
    return this.count >= 3 ? candidate.userId : null;
  }
  reset(): void { this.userId = null; this.count = 0; }
}
