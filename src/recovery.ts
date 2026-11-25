export type FailureKind = 'transient' | 'limit' | 'signin' | 'blocked' | 'silent' | 'interrupted';

/** Waits between automatic retries after a take could not finish: about two minutes in all. */
export const AUTO_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 70_000];
/** Immediate replays tried on release before the take is handed to the pill. */
export const RELEASE_REPLAY_ATTEMPTS = 2;

/** Only transient failures are retried automatically; the rest need the person to act first. */
export function classifyFailure(message: string): FailureKind {
  if (/HTTP 429|usage limit/i.test(message)) return 'limit';
  if (/HTTP 401|Sign in to Codex|sign-in was not accepted/i.test(message)) return 'signin';
  if (/HTTP 403|disabled by your Codex|not allowed|does not support|conflicting workspace/i.test(message)) return 'blocked';
  if (/No speech detected/i.test(message)) return 'silent';
  if (/interrupted/i.test(message)) return 'interrupted';
  return 'transient';
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Short wording for the island: a title and a second line under it. */
export function failureCopy(kind: FailureKind, durationSeconds: number): { title: string; detail: string } {
  const saved = `${formatDuration(durationSeconds)} saved`;
  switch (kind) {
    case 'limit': return { title: 'Usage limit reached', detail: `${saved} · retry later` };
    case 'signin': return { title: 'Sign in to Codex', detail: `${saved} · then retry` };
    case 'blocked': return { title: 'Dictation unavailable', detail: saved };
    case 'silent': return { title: 'No speech detected', detail: saved };
    case 'interrupted': return { title: 'Recording interrupted', detail: saved };
    default: return { title: 'Connection failed', detail: saved };
  }
}
