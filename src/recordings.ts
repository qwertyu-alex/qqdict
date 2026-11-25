import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { RecordingEntry, RecordingStatus } from './contracts';

const SAMPLE_RATE = 24_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const HEADER_BYTES = 44;
const MAX_PCM_BYTES = BYTES_PER_SECOND * 300;
export const RECORDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const STATUSES: RecordingStatus[] = ['recording', 'failed', 'transcribed', 'retrying'];
const ID_PATTERN = /^[0-9a-f-]{36}$/;

type Meta = {
  version: 1; id: string; startedAt: string; bytes: number; status: RecordingStatus;
  error?: string; transcriptId?: string;
};
export type RecordingUpdate = { status?: RecordingStatus; error?: string | undefined; transcriptId?: string };
type ArchiveOptions = { directory: string; retentionMs?: number; now?: () => number };

/** A mono 24 kHz PCM16 WAV header, so a saved take also plays in Finder or QuickTime. */
export function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function isMeta(value: unknown): value is Meta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Record<string, unknown>;
  return meta.version === 1 && typeof meta.id === 'string' && ID_PATTERN.test(meta.id)
    && typeof meta.startedAt === 'string' && Number.isFinite(Date.parse(meta.startedAt))
    && Number.isSafeInteger(meta.bytes) && (meta.bytes as number) >= 0
    && STATUSES.includes(meta.status as RecordingStatus)
    && (meta.error === undefined || typeof meta.error === 'string')
    && (meta.transcriptId === undefined || typeof meta.transcriptId === 'string');
}

function summary(meta: Meta): RecordingEntry {
  return {
    id: meta.id, startedAt: meta.startedAt, status: meta.status,
    durationSeconds: Math.round(meta.bytes / BYTES_PER_SECOND * 10) / 10,
    ...(meta.error === undefined ? {} : { error: meta.error }),
    ...(meta.transcriptId === undefined ? {} : { transcriptId: meta.transcriptId }),
  };
}

/**
 * Keeps each take's microphone audio on disk while it is being recorded, so a
 * failed transcription can be replayed. Writes are serialized and never throw
 * into the recording path; a take whose audio could not be written is reported
 * through `healthy()` so callers fall back to the previous behavior.
 */
export class RecordingArchive {
  private readonly directory: string;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Meta>();
  private readonly handles = new Map<string, Promise<FileHandle | undefined>>();
  private readonly broken = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor({ directory, retentionMs = RECORDING_RETENTION_MS, now = Date.now }: ArchiveOptions) {
    this.directory = directory;
    this.retentionMs = retentionMs;
    this.now = now;
  }

  /** Newest first. */
  get recordings(): RecordingEntry[] {
    return [...this.entries.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(summary);
  }

  get(id: string): RecordingEntry | undefined {
    const meta = this.entries.get(id);
    return meta && summary(meta);
  }

  /** True while the take's audio is fully on disk (or queued to be). */
  healthy(id: string): boolean { return this.entries.has(id) && !this.broken.has(id); }
  hasAudio(id: string): boolean { return (this.entries.get(id)?.bytes ?? 0) > 0; }
  /** Resolves after every queued write has settled. */
  idle(): Promise<void> { return this.queue; }

  load(): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const names = new Set(await readdir(this.directory));
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!ID_PATTERN.test(id) || this.entries.has(id)) continue;
        let meta: unknown;
        try { meta = JSON.parse(await readFile(this.file(id, 'json'), 'utf8')); } catch { continue; }
        if (!isMeta(meta) || meta.id !== id) continue;
        if (!names.has(`${id}.wav`)) { await unlink(this.file(id, 'json')).catch(() => undefined); continue; }
        if (meta.status === 'recording' || meta.status === 'retrying') {
          // The app quit or crashed mid-take. Recover what reached the disk.
          const size = (await stat(this.file(id, 'wav'))).size;
          meta.bytes = Math.max(0, Math.min(MAX_PCM_BYTES, size - HEADER_BYTES)) & ~1;
          meta.error = meta.status === 'recording' ? 'qqdict closed before this recording finished.' : 'qqdict closed before this retry finished.';
          meta.status = 'failed';
          await this.repairHeader(id, meta.bytes).catch(() => undefined);
          await this.writeMeta(meta).catch(() => undefined);
        }
        this.entries.set(id, meta);
      }
      for (const name of names) {
        // Audio whose metadata was never written (a crash at the first write).
        const id = name.endsWith('.wav') ? name.slice(0, -4) : '';
        if (!ID_PATTERN.test(id) || this.entries.has(id)) continue;
        const file = this.file(id, 'wav');
        const info = await stat(file).catch(() => undefined);
        if (info && this.now() - info.mtimeMs > this.retentionMs) await rm(file, { force: true });
      }
      await this.pruneNow();
    });
  }

  /** Register a take synchronously so audio can be appended immediately. */
  begin(now = new Date(this.now())): string {
    const id = randomUUID();
    const meta: Meta = { version: 1, id, startedAt: now.toISOString(), bytes: 0, status: 'recording' };
    this.entries.set(id, meta);
    const opened = this.enqueue(async () => {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.writeMeta(meta);
        const handle = await open(this.file(id, 'wav'), 'wx', 0o600);
        await handle.write(wavHeader(0), 0, HEADER_BYTES, 0);
        return handle;
      } catch (error) {
        this.markBroken(id, error);
        return undefined;
      }
    });
    this.handles.set(id, opened);
    return id;
  }

  append(id: string, audio: ArrayBuffer | Uint8Array): void {
    const meta = this.entries.get(id);
    const opened = this.handles.get(id);
    if (!meta || !opened || this.broken.has(id)) return;
    let chunk = Buffer.from(audio instanceof ArrayBuffer ? new Uint8Array(audio) : audio);
    chunk = chunk.subarray(0, Math.max(0, MAX_PCM_BYTES - meta.bytes));
    if (!chunk.length || chunk.length % 2) return;
    const position = HEADER_BYTES + meta.bytes;
    meta.bytes += chunk.length;
    void this.enqueue(async () => {
      const handle = await opened;
      if (!handle || this.broken.has(id)) return;
      try { await handle.write(chunk, 0, chunk.length, position); }
      catch (error) { this.markBroken(id, error); }
    });
  }

  /** Close the take's audio file. Later appends are ignored. Safe to call twice. */
  finish(id: string): Promise<void> {
    const opened = this.handles.get(id);
    if (!opened) return this.queue;
    this.handles.delete(id);
    return this.enqueue(async () => {
      const handle = await opened;
      if (!handle) return;
      try {
        await handle.write(wavHeader(this.entries.get(id)?.bytes ?? 0), 0, HEADER_BYTES, 0);
        await handle.sync();
      } catch (error) { this.markBroken(id, error); }
      finally { await handle.close().catch(() => undefined); }
    });
  }

  update(id: string, patch: RecordingUpdate): Promise<void> {
    return this.enqueue(async () => {
      const meta = this.entries.get(id);
      if (!meta) return;
      if (patch.status) meta.status = patch.status;
      if ('error' in patch) { if (patch.error === undefined) delete meta.error; else meta.error = patch.error.slice(0, 500); }
      if (patch.transcriptId !== undefined) meta.transcriptId = patch.transcriptId;
      try { await this.writeMeta(meta); } catch (error) { console.error('Could not update a saved recording:', error instanceof Error ? error.message : error); }
    });
  }

  discard(id: string): Promise<void> {
    const finished = this.finish(id);
    return finished.then(() => this.enqueue(async () => {
      this.entries.delete(id);
      this.broken.delete(id);
      await Promise.all([rm(this.file(id, 'wav'), { force: true }), rm(this.file(id, 'json'), { force: true })]).catch(() => undefined);
    }));
  }

  /** The raw PCM16 audio of a finished take. */
  async readPcm(id: string): Promise<Buffer> {
    await this.finish(id);
    const meta = this.entries.get(id);
    if (!meta) throw new Error('This recording is no longer available.');
    const data = await readFile(this.file(id, 'wav'));
    return data.subarray(HEADER_BYTES, HEADER_BYTES + meta.bytes);
  }

  /** Delete takes older than the retention window, except open or retrying ones. */
  prune(): Promise<void> { return this.enqueue(() => this.pruneNow()); }

  private async pruneNow(): Promise<void> {
    const cutoff = this.now() - this.retentionMs;
    for (const meta of [...this.entries.values()]) {
      if (Date.parse(meta.startedAt) > cutoff || this.handles.has(meta.id) || meta.status === 'retrying' || meta.status === 'recording') continue;
      this.entries.delete(meta.id);
      this.broken.delete(meta.id);
      await Promise.all([rm(this.file(meta.id, 'wav'), { force: true }), rm(this.file(meta.id, 'json'), { force: true })]).catch(() => undefined);
    }
  }

  private markBroken(id: string, error: unknown): void {
    if (this.broken.has(id)) return;
    this.broken.add(id);
    console.error('Could not save recording audio:', error instanceof Error ? error.message : error);
  }

  private async repairHeader(id: string, bytes: number): Promise<void> {
    const handle = await open(this.file(id, 'wav'), 'r+');
    try { await handle.write(wavHeader(bytes), 0, HEADER_BYTES, 0); }
    finally { await handle.close(); }
  }

  private async writeMeta(meta: Meta): Promise<void> {
    const target = this.file(meta.id, 'json');
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(meta)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private file(id: string, extension: 'wav' | 'json'): string { return path.join(this.directory, `${id}.${extension}`); }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}
