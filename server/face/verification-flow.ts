import type Database from 'better-sqlite3';
import { recordFaceEvent } from '../db.ts';
import type { IdentitySessionStore } from '../identity-session-store.ts';
import { advanceChallenge, chooseChallenge, isChallengeComplete, type ChallengeKind } from './challenge.ts';
import { ConsecutiveFaceVote, findFaceMatch, type FaceRoster } from './matcher.ts';
import { decodeFaceEmbedding, type FaceSidecar } from './sidecar-client.ts';

export interface FaceFrameResult { state: 'scanning' | 'challenging' | 'issued' | 'fallback'; hint: string | null; challenge: { kind: ChallengeKind; deadline: number } | null; result: { subjectHint: string; assurance: 'high' | 'medium' } | null; subjectUserId?: string; }
interface FlowState { vote: ConsecutiveFaceVote; spoof: number; ambiguous: number; challenge?: { kind: ChallengeKind; deadline: number; moved: boolean; userId: string }; }
export class FaceVerificationFlow {
  private readonly flows = new Map<string, FlowState>();
  constructor(private readonly deps: { db: Database.Database; sessions: IdentitySessionStore; sidecar: FaceSidecar; roster: () => FaceRoster; threshold: number; margin: number; livenessThreshold: number; challengeRequired: boolean; subjectHint: (id: string) => string; random?: () => number }) {}
  async process(sessionId: string, frame: Uint8Array): Promise<FaceFrameResult | null> {
    const session = this.deps.sessions.get(sessionId);
    if (!session || session.state === 'issued' || session.state === 'fallback') return null;
    this.deps.sessions.touch(sessionId);
    const flow = this.flows.get(sessionId) ?? { vote: new ConsecutiveFaceVote(), spoof: 0, ambiguous: 0 };
    this.flows.set(sessionId, flow);
    const faces = await this.deps.sidecar.analyze(frame, flow.challenge ? ['embedding', 'liveness', 'blendshapes'] : ['embedding', 'liveness']);
    const face = faces[0];
    if (!face) return this.scanning(sessionId, 'no_face');
    if (!face.quality.pass) return this.scanning(sessionId, face.quality.fail[0] ?? 'hold_still');
    if ((face.liveness ?? 0) < this.deps.livenessThreshold) { flow.spoof += 1; if (flow.spoof >= 3) return this.fallback(sessionId, 'spoof_retry'); return this.scanning(sessionId, 'spoof_retry'); }
    const embedding = decodeFaceEmbedding(face.embedding); if (!embedding) return this.scanning(sessionId, 'hold_still');
    const match = findFaceMatch(embedding, this.deps.roster());
    if (flow.challenge) return this.challenge(sessionId, flow, match?.userId, face);
    if (!match || match.score < this.deps.threshold) return this.scanning(sessionId, 'no_match');
    if (match.score - match.runnerUp < this.deps.margin) { flow.ambiguous += 1; return flow.ambiguous >= 10 ? this.fallback(sessionId, 'ambiguous') : this.scanning(sessionId, 'ambiguous'); }
    const userId = flow.vote.add(match, this.deps.threshold, this.deps.margin);
    if (!userId) return this.scanning(sessionId, null);
    if (!this.deps.challengeRequired) return this.issued(sessionId, userId, 'face_passive');
    const kind = chooseChallenge(this.deps.random); flow.challenge = { kind, deadline: Date.now() + 8_000, moved: false, userId }; this.deps.sessions.transition(sessionId, 'challenging');
    return { state: 'challenging', hint: null, challenge: { kind, deadline: flow.challenge.deadline }, result: null };
  }
  private challenge(sessionId: string, flow: FlowState, userId: string | undefined, face: { blendshapes?: Record<string, number>; pose?: { yaw: number; pitch: number } }): FaceFrameResult {
    const challenge = flow.challenge!;
    if (Date.now() > challenge.deadline || userId !== challenge.userId) return this.fallback(sessionId, 'challenge_failed');
    const progress = advanceChallenge(challenge, face); flow.challenge = { ...challenge, moved: progress.moved };
    return isChallengeComplete(progress, face) ? this.issued(sessionId, challenge.userId, 'face') : { state: 'challenging', hint: null, challenge: { kind: challenge.kind, deadline: challenge.deadline }, result: null };
  }
  private scanning(sessionId: string, hint: string | null): FaceFrameResult { this.deps.sessions.transition(sessionId, 'scanning'); return { state: 'scanning', hint, challenge: null, result: null }; }
  private fallback(sessionId: string, reason: string): FaceFrameResult { this.deps.sessions.transition(sessionId, 'fallback'); recordFaceEvent(this.deps.db, { outcome: reason, sessionId }); return { state: 'fallback', hint: reason, challenge: null, result: null }; }
  private issued(sessionId: string, userId: string, method: 'face' | 'face_passive'): FaceFrameResult { this.deps.sessions.transition(sessionId, 'issued', method); recordFaceEvent(this.deps.db, { outcome: 'issued', method, subjectUser: userId, sessionId }); return { state: 'issued', hint: null, challenge: null, result: { subjectHint: this.deps.subjectHint(userId), assurance: method === 'face' ? 'high' : 'medium' }, subjectUserId: userId }; }
}
