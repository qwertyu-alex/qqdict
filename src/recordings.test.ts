import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecordingArchive, wavHeader } from './recordings';

async function fixture(t: test.TestContext, now = () => Date.parse('2026-11-24T12:00:00Z')) {
  const directory = path.join(await mkdtemp(path.join(os.tmpdir(), 'qqdict-recordings-')), 'recordings');
  t.after(() => rm(path.dirname(directory), { recursive: true, force: true }));
  const archive = new RecordingArchive({ directory, now });
  await archive.load();
  return { directory, archive };
}

const pcm = (bytes: number, value = 1) => new Int16Array(bytes / 2).fill(value).buffer;

test('saves a take as a playable 24 kHz mono WAV with exact audio', async t => {
  const { directory, archive } = await fixture(t);
  const id = archive.begin();
  archive.append(id, pcm(4_800, 7));
  archive.append(id, new Uint8Array(pcm(2_400, -3)));
  await archive.finish(id);
  const file = await readFile(path.join(directory, `${id}.wav`));
  assert.deepEqual(file.subarray(0, 44), wavHeader(7_200));
  assert.equal(file.readUInt32LE(24), 24_000);
  assert.equal(file.readUInt16LE(22), 1);
  const audio = await archive.readPcm(id);
  assert.equal(audio.length, 7_200);
  assert.equal(audio.readInt16LE(0), 7);
  assert.equal(audio.readInt16LE(7_198), -3);
  assert.equal(archive.get(id)?.durationSeconds, 0.2);
  assert.equal((await stat(path.join(directory, `${id}.wav`))).mode & 0o777, 0o600);
});

test('ignores audio after finish and caps a take at five minutes', async t => {
  const { archive } = await fixture(t);
  const id = archive.begin();
  for (let i = 0; i < 61; i++) archive.append(id, pcm(240_000));
  await archive.finish(id);
  archive.append(id, pcm(4_800));
  assert.equal((await archive.readPcm(id)).length, 24_000 * 2 * 300);
});

test('recovers a take interrupted by a crash as a failed recording', async t => {
  const { directory, archive } = await fixture(t);
  const id = archive.begin();
  archive.append(id, pcm(9_600));
  await archive.idle();
  // No finish(): the header still claims zero bytes, as after a crash.
  const reloaded = new RecordingArchive({ directory, now: () => Date.parse('2026-11-24T12:00:00Z') });
  await reloaded.load();
  const recovered = reloaded.get(id);
  assert.equal(recovered?.status, 'failed');
  assert.match(recovered?.error ?? '', /closed before/);
  assert.equal((await reloaded.readPcm(id)).length, 9_600);
  assert.deepEqual((await readFile(path.join(directory, `${id}.wav`))).subarray(0, 44), wavHeader(9_600));
});

test('updates persist and reload newest first', async t => {
  let now = Date.parse('2026-11-24T12:00:00Z');
  const { directory, archive } = await fixture(t, () => now);
  const first = archive.begin(); archive.append(first, pcm(480)); await archive.finish(first);
  now += 1_000;
  const second = archive.begin(); archive.append(second, pcm(480)); await archive.finish(second);
  await archive.update(first, { status: 'transcribed', transcriptId: 'entry-1' });
  await archive.update(second, { status: 'failed', error: 'HTTP 429.' });
  const reloaded = new RecordingArchive({ directory, now: () => now });
  await reloaded.load();
  assert.deepEqual(reloaded.recordings.map(item => [item.id, item.status, item.transcriptId ?? item.error]), [
    [second, 'failed', 'HTTP 429.'], [first, 'transcribed', 'entry-1'],
  ]);
});

test('prunes recordings older than 24 hours but keeps an open take', async t => {
  let now = Date.parse('2026-11-24T12:00:00Z');
  const { directory, archive } = await fixture(t, () => now);
  const old = archive.begin(); archive.append(old, pcm(480)); await archive.finish(old);
  await archive.update(old, { status: 'transcribed', transcriptId: 'x' });
  const open = archive.begin(); archive.append(open, pcm(480));
  now += 24 * 60 * 60 * 1000 + 1;
  const fresh = archive.begin(); archive.append(fresh, pcm(480)); await archive.finish(fresh);
  await archive.prune();
  assert.equal(archive.get(old), undefined);
  assert.ok(archive.get(open));
  assert.ok(archive.get(fresh));
  const files = await readdir(directory);
  assert.equal(files.some(name => name.startsWith(old)), false);
  assert.equal(files.filter(name => name.startsWith(fresh)).length, 2);
});

test('discard removes both files', async t => {
  const { directory, archive } = await fixture(t);
  const id = archive.begin();
  archive.append(id, pcm(480));
  await archive.discard(id);
  assert.equal(archive.get(id), undefined);
  assert.deepEqual(await readdir(directory), []);
});

test('a write failure marks the take unhealthy without throwing', async t => {
  const { directory, archive } = await fixture(t);
  const id = archive.begin();
  await archive.idle();
  await rm(directory, { recursive: true });
  await writeFile(directory, 'not a directory');
  const blocked = archive.begin();
  archive.append(blocked, pcm(480));
  await archive.idle();
  assert.equal(archive.healthy(blocked), false);
  assert.equal(archive.healthy(id), true);
});
