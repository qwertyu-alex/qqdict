import { setTimeout as delay } from 'node:timers/promises';
import { safeMessage, type DictationEvent } from './transport';

export type ReplayTransport = {
  start(): Promise<void>;
  append(audio: Uint8Array): void;
  stop(): Promise<string>;
  cancel(): void;
};
type ReplayOptions = {
  signal?: AbortSignal;
  /** 100 ms of 24 kHz PCM16 per frame, the same size the microphone sends. */
  chunkBytes?: number;
  /** Pause between frames. 25 ms replays at four times real time. */
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** Transcribe saved PCM16 audio by streaming it through a fresh dictation session. */
export async function replayRecording(
  createTransport: (emit: (event: DictationEvent) => void) => ReplayTransport,
  pcm: Uint8Array,
  { signal, chunkBytes = 4_800, intervalMs = 25, sleep = (ms) => delay(ms) }: ReplayOptions = {},
): Promise<string> {
  if (!pcm.length) throw new Error('This recording has no audio.');
  let failure: string | undefined;
  const transport = createTransport((event) => { if (event.type === 'error') failure ??= event.text; });
  const abort = () => transport.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  const check = () => {
    if (signal?.aborted) throw new Error('Retry cancelled.');
    if (failure) throw new Error(failure);
  };
  try {
    check();
    await transport.start();
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      check();
      transport.append(pcm.subarray(offset, offset + chunkBytes));
      if (offset + chunkBytes < pcm.length) await sleep(intervalMs);
    }
    check();
    return await transport.stop();
  } catch (error) {
    if (signal?.aborted) throw new Error('Retry cancelled.');
    throw new Error(failure ?? safeMessage(error));
  } finally {
    signal?.removeEventListener('abort', abort);
    transport.cancel();
  }
}
