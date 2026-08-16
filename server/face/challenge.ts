export type ChallengeKind = 'blink' | 'turn_left' | 'turn_right' | 'nod';
export interface FaceSignals { blendshapes?: Record<string, number>; pose?: { yaw: number; pitch: number }; }
export interface ChallengeProgress { kind: ChallengeKind; moved: boolean; }
export function chooseChallenge(random: () => number = Math.random): ChallengeKind { return (['blink', 'turn_left', 'turn_right', 'nod'] as const)[Math.min(3, Math.floor(random() * 4))] ?? 'blink'; }
export function advanceChallenge(progress: ChallengeProgress, signals: FaceSignals): ChallengeProgress {
  const yaw = signals.pose?.yaw ?? 0; const pitch = signals.pose?.pitch ?? 0; const blink = Math.min(signals.blendshapes?.eyeBlinkLeft ?? 0, signals.blendshapes?.eyeBlinkRight ?? 0);
  const moved = progress.moved || (progress.kind === 'blink' ? blink > .5 : progress.kind === 'turn_left' ? yaw < -15 : progress.kind === 'turn_right' ? yaw > 15 : pitch < -12);
  return { ...progress, moved };
}
export function isChallengeComplete(progress: ChallengeProgress, signals: FaceSignals): boolean {
  const yaw = Math.abs(signals.pose?.yaw ?? 0); const pitch = Math.abs(signals.pose?.pitch ?? 0); const blink = Math.min(signals.blendshapes?.eyeBlinkLeft ?? 0, signals.blendshapes?.eyeBlinkRight ?? 0);
  return progress.moved && (progress.kind === 'blink' ? blink < .2 : progress.kind === 'nod' ? pitch < 5 : yaw < 5);
}
