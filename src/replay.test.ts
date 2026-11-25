import assert from 'node:assert/strict';
import test from 'node:test';
import type { DictationEvent } from './transport';
import { replayRecording, type ReplayTransport } from './replay';

function fakeTransport(options: { failAfter?: number; text?: string } = {}) {
  const log: string[] = [];
  let emit: (event: DictationEvent) => void = () => {};
  let appended = 0;
  const transport: ReplayTransport = {
    async start() { log.push('start'); },
    append(audio) {
      appended += audio.length;
      log.push(`append:${audio.length}`);
      if (options.failAfter !== undefined && appended >= options.failAfter) emit({ type: 'error', text: 'The dictation connection closed before completion (code 1006).' });
    },
    async stop() { log.push('stop'); return options.text ?? 'Recovered words'; },
    cancel() { log.push('cancel'); },
  };
  return { log, create: (next: (event: DictationEvent) => void) => { emit = next; return transport; } };
}

test('streams saved audio in microphone-sized frames, then stops', async () => {
  const { log, create } = fakeTransport();
  const sleeps: number[] = [];
  const text = await replayRecording(create, new Uint8Array(10_000), { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(text, 'Recovered words');
  assert.deepEqual(log, ['start', 'append:4800', 'append:4800', 'append:400', 'stop', 'cancel']);
  assert.deepEqual(sleeps, [25, 25]);
});

test('reports the session error instead of a generic stop failure', async () => {
  const { log, create } = fakeTransport({ failAfter: 4_800 });
  await assert.rejects(replayRecording(create, new Uint8Array(20_000), { sleep: async () => {} }), /code 1006/);
  assert.equal(log.includes('stop'), false);
  assert.equal(log.at(-1), 'cancel');
});

test('aborting cancels the replay session', async () => {
  const { log, create } = fakeTransport();
  const abort = new AbortController();
  const replay = replayRecording(create, new Uint8Array(20_000), {
    signal: abort.signal, sleep: async () => { abort.abort(); },
  });
  await assert.rejects(replay, /Retry cancelled/);
  assert.equal(log.includes('stop'), false);
});

test('refuses empty audio', async () => {
  const { log, create } = fakeTransport();
  await assert.rejects(replayRecording(create, new Uint8Array(0)), /no audio/);
  assert.deepEqual(log, []);
});
