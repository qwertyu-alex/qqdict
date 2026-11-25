import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';
import type { AppEvent } from './contracts';
import type { FocusTarget } from './native';
import { AppUpdater } from './updates';
import * as recovery from './recovery';

const menuCode = readFile('src/menu-app.ts', 'utf8').then((source) => transform(source, { loader: 'ts', format: 'cjs' }));
const nodeRequire = createRequire(`${process.cwd()}/package.json`);

type FixtureOptions = {
  pasteCleanup?: Promise<void>; settingsCleanup?: Promise<void>;
  transport?: Record<string, unknown>; replay?: (pcm: Uint8Array) => Promise<string>; archive?: FakeArchive;
  focusNow?: () => Promise<FocusTarget>;
};
type FakeArchive = ReturnType<typeof fakeArchive>;

function fakeArchive() {
  const updates: Record<string, unknown>[] = [];
  let bytes = 0;
  return {
    updates, discarded: 0,
    get bytes() { return bytes; },
    recordings: [] as unknown[],
    begin: () => 'recording-1',
    append: (_id: string, audio: ArrayBuffer) => { bytes += audio.byteLength; },
    healthy: () => true,
    hasAudio: () => bytes > 0,
    get: (id: string) => ({ id, durationSeconds: bytes / 48_000 }),
    finish: async () => {},
    idle: async () => {},
    update: async (_id: string, patch: Record<string, unknown>) => { updates.push({ ...patch }); },
    async discard() { this.discarded++; },
    readPcm: async () => new Uint8Array(bytes),
  };
}

async function menuFixture(options: FixtureOptions = {}) {
  let resolveFocus!: (target: FocusTarget) => void;
  const focus = new Promise<FocusTarget>((resolve) => { resolveFocus = resolve; });
  const events: AppEvent[] = [];
  const copied: string[] = [];
  const discarded: string[] = [];
  const pasted: FocusTarget[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const nativeUpdates = Object.assign(new EventEmitter(), {
    installs: 0,
    setFeedURL() {}, checkForUpdates() {},
    quitAndInstall() { this.installs++; nativeUpdates.emit('before-quit-for-update'); },
  });
  const contents = { send: (_channel: string, event: AppEvent) => events.push(event) };
  const dependencies: Record<string, unknown> = {
    electron: {
      app: { setName() {}, setPath() {}, getPath: () => '/tmp/qqdict-test', requestSingleInstanceLock: () => false, quit() {}, on() {} },
      autoUpdater: nativeUpdates,
      clipboard: { writeText: (text: string) => copied.push(text) },
      ipcMain: { handle: (name: string, callback: (...args: any[]) => void) => listeners.set(name, callback),
        on: (name: string, callback: (...args: any[]) => void) => listeners.set(name, callback) },
    },
    './harness': { CodexHarness: class {} },
    './transport': { DictationTransport: class { constructor() { Object.assign(this, { cancel() {} }, options.transport); } }, safeMessage: (error: unknown) => error instanceof Error ? error.message : String(error) },
    './native': {}, './store': {}, './island-position': {}, './storage': {},
    './updates': {}, './recordings': {}, './recovery': recovery,
    // Release-time replays wait two seconds between attempts; tests skip the wait.
    'node:timers/promises': { setTimeout: async () => {} },
    './replay': { replayRecording: (_create: unknown, pcm: Uint8Array) => options.replay?.(pcm) ?? Promise.reject(new Error('No replay.')) },
    './product': { PRODUCT_NAME: 'qqdict-test', BUILD_IDENTITY: { journalDirectory: 'Dictation Test' } },
    './paste': { pasteTranscript: async (_bridge: unknown, _text: string, target: FocusTarget) => { pasted.push(target); await options.pasteCleanup; } },
  };
  const context = vm.createContext({
    require: (id: string) => dependencies[id] ?? nodeRequire(id),
    module: { exports: {} }, exports: {}, AbortController, ArrayBuffer, Buffer, setTimeout, clearTimeout,
    fixture: {
      archive: options.archive,
      contents,
      bridge: {
        captureFocus: () => options.focusNow && vm.runInContext('!!take', context) === false ? options.focusNow() : focus,
        setHotkey: () => options.settingsCleanup ?? Promise.resolve(),
        request: async (command: string, fields: { focusId: string }) => { if (command === 'discardFocus') discarded.push(fields.focusId); },
      },
      store: {
        settings: { hotkey: 'fn', microphoneId: '', launchAtLogin: false },
        history: [] as { id: string; text: string }[],
        async updateSettings(settings: object) { Object.assign(this.settings, settings); },
        async addTranscript(text: string) { const entry = { id: 'entry', text }; this.history.unshift(entry); return entry; },
        async updateTranscript() {},
        async flush() {},
      },
    },
  });
  vm.runInContext((await menuCode).code, context);
  vm.runInContext(`
    recorderReady = true;
    state.connected = true;
    state.permissions.microphone = 'granted';
    recorder = { webContents: fixture.contents, isDestroyed: () => false };
    bridge = fixture.bridge;
    store = fixture.store;
    recordings = fixture.archive;
    bindIPC();
  `, context);
  let updater: AppUpdater | undefined;
  return {
    events, discarded, pasted, resolveFocus, copied,
    run: (code: string) => vm.runInContext(code, context),
    get attention() { return JSON.parse(JSON.stringify(vm.runInContext('attentionSnapshot()', context))) as Record<string, unknown> | null; },
    begin: () => vm.runInContext('begin(false)', context) as Promise<void>,
    end: () => vm.runInContext('end()', context),
    cancel: () => vm.runInContext('cancel()', context),
    finalize: () => vm.runInContext("finalize('First words', take)", context) as Promise<void>,
    get phase() { return vm.runInContext('state.phase', context) as string; },
    get detail() { return vm.runInContext('state.detail', context) as string; },
    invoke: (name: string, ...args: unknown[]) => listeners.get(`dictation:${name}`)!({ sender: contents }, ...args) as unknown as Promise<void>,
    sendAudio: (bytes: number, id = 1) => listeners.get('dictation:audio')!({ sender: contents }, new ArrayBuffer(bytes), id),
    get microphoneName() { return vm.runInContext('state.microphoneName', context) as string; },
    get quitting() { return vm.runInContext('quitting', context) as boolean; },
    nativeUpdates,
    enableUpdates() {
      updater = new AppUpdater({
        availability: { feedURL: 'https://example.com/feed' }, updater: nativeUpdates,
        isBusy: () => vm.runInContext('updateBusy()', context) as boolean,
        prepareInstall: async () => {}, showMessage: async () => 1, onChange() {},
      });
      context.fixture.updates = updater;
      vm.runInContext('updates = fixture.updates', context);
      updater.start();
      return updater;
    },
    changeSettings: () => listeners.get('dictation:settings')!({ sender: contents }, { hotkey: 'right-option' }),
    capture: (id: number, sender: unknown = contents, microphone: unknown = 'MacBook Pro Microphone') => listeners.get('dictation:capturing')!({ sender }, id, microphone),
    serverReady: () => vm.runInContext("handleTransport({ type: 'status', status: 'recording' })", context),
    cleanup: () => { updater?.dispose(); vm.runInContext('dismissAttention(false); if (fadeTimer) clearTimeout(fadeTimer)', context); },
  };
}

test('starts and stops capture while the original focus check is still pending', async (t) => {
  const fixture = await menuFixture();
  t.after(fixture.cleanup);
  await fixture.begin();
  assert.equal(fixture.events.filter(event => event.type === 'command' && event.command === 'start').length, 1);
  fixture.end();
  assert.equal(fixture.events.filter(event => event.type === 'command' && event.command === 'stop').length, 1);
  const finishing = fixture.finalize();
  await setImmediate();
  assert.equal(fixture.pasted.length, 0, 'pasting still waits for the original field');
  fixture.resolveFocus({ focusId: 'original-field', targetPid: 123 });
  await finishing;
  assert.equal(fixture.pasted[0]?.focusId, 'original-field');
});

test('discards a late focus snapshot after cancellation', async (t) => {
  const fixture = await menuFixture();
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.cancel();
  fixture.resolveFocus({ focusId: 'cancelled-field', targetPid: 123 });
  await setImmediate();
  assert.deepEqual(fixture.discarded, ['cancelled-field']);
  assert.deepEqual(fixture.pasted, []);
});

test('Listening follows local capture, with stale and post-release notifications ignored', async (t) => {
  const fixture = await menuFixture();
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.serverReady();
  assert.equal(fixture.phase, 'starting');
  fixture.capture(1, {}, 'Foreign Microphone');
  fixture.capture(2, undefined, 'Stale Microphone');
  assert.equal(fixture.phase, 'starting');
  assert.equal(fixture.microphoneName, '');
  fixture.capture(1);
  assert.equal(fixture.phase, 'recording');
  assert.equal(fixture.microphoneName, 'MacBook Pro Microphone');
  fixture.end();
  fixture.capture(1, undefined, 'Late Microphone');
  assert.equal(fixture.phase, 'transcribing');
  assert.equal(fixture.microphoneName, 'MacBook Pro Microphone');
});

test('the next take forgets the previous microphone and ignores a non-string name', async (t) => {
  const fixture = await menuFixture();
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.capture(1);
  fixture.cancel();
  await fixture.begin();
  assert.equal(fixture.microphoneName, '');
  fixture.capture(2, undefined, { name: 'Not a string' });
  assert.equal(fixture.phase, 'recording');
  assert.equal(fixture.microphoneName, '');
});

test('an update waits for cancelled paste cleanup and prevents a new take while restart is pending', async (t) => {
  let finishClipboardRestore!: () => void;
  const pasteCleanup = new Promise<void>((resolve) => { finishClipboardRestore = resolve; });
  const fixture = await menuFixture({ pasteCleanup });
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.resolveFocus({ focusId: 'original-field', targetPid: 123 });
  const finishing = fixture.finalize();
  await setImmediate();
  assert.equal(fixture.pasted.length, 1);
  const updater = fixture.enableUpdates();
  fixture.nativeUpdates.emit('update-downloaded', {}, '', 'qqdict v0.5.6');
  updater.requestInstall();
  fixture.cancel();
  await fixture.begin();
  await setImmediate();
  assert.equal(fixture.nativeUpdates.installs, 0);
  assert.equal(fixture.events.filter(event => event.type === 'command' && event.command === 'start').length, 1);
  finishClipboardRestore();
  await finishing;
  await setImmediate();
  assert.equal(fixture.nativeUpdates.installs, 1);
  assert.equal(fixture.quitting, true, 'updater allows Settings to close before app.before-quit');
});

test('an update waits for a settings change already being applied to macOS', async (t) => {
  let finishSettings!: () => void;
  const settingsCleanup = new Promise<void>((resolve) => { finishSettings = resolve; });
  const fixture = await menuFixture({ settingsCleanup });
  t.after(fixture.cleanup);
  const updater = fixture.enableUpdates();
  const changing = fixture.changeSettings();
  await setImmediate();
  fixture.nativeUpdates.emit('update-downloaded', {}, '', 'qqdict v0.5.6');
  updater.requestInstall();
  await setImmediate();
  assert.equal(fixture.nativeUpdates.installs, 0);
  finishSettings();
  await changing;
  await setImmediate();
  assert.equal(fixture.nativeUpdates.installs, 1);
});

test('a session that fails mid-take keeps recording and is transcribed from saved audio', async (t) => {
  const archive = fakeArchive();
  const appended: number[] = [];
  const replayed: number[] = [];
  const fixture = await menuFixture({
    archive,
    transport: {
      start: async () => { throw new Error('HTTP 503. The internal dictation route did not accept the connection.'); },
      append: (audio: ArrayBuffer) => appended.push(audio.byteLength),
      stop: async () => { throw new Error('stop must not be called after the session failed'); },
    },
    replay: async (pcm) => { replayed.push(pcm.length); return 'Every word I said'; },
  });
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.resolveFocus({ focusId: 'original-field', targetPid: 123 });
  fixture.sendAudio(4_800);
  await fixture.invoke('start', 1);
  assert.equal(fixture.events.some(event => event.type === 'error' || (event.type === 'command' && event.command === 'cancel')), false,
    'the recorder is not told to stop');
  fixture.capture(1);
  assert.equal(fixture.phase, 'recording');
  assert.match(fixture.detail, /Connection lost/);
  fixture.sendAudio(9_600);
  fixture.end();
  await fixture.invoke('stop', 1);
  assert.equal(archive.bytes, 14_400, 'audio before and after the failure is saved');
  assert.deepEqual(appended, [], 'nothing is sent to the failed session');
  assert.deepEqual(replayed, [14_400]);
  assert.equal(fixture.pasted[0]?.focusId, 'original-field');
  assert.deepEqual(archive.updates.at(-1), { status: 'transcribed', transcriptId: 'entry', error: undefined });
});

test('a failed recovery holds the take on the island with Retry', async (t) => {
  const archive = fakeArchive();
  let replays = 0;
  const fixture = await menuFixture({
    archive,
    transport: { start: async () => {}, append() {}, stop: async () => { throw new Error('No final transcript arrived within 30 seconds.'); } },
    replay: async () => { replays++; throw new Error('HTTP 429. The subscription dictation service has reached a usage limit.'); },
  });
  t.after(fixture.cleanup);
  await fixture.begin();
  await fixture.invoke('start', 1);
  fixture.sendAudio(4_800);
  fixture.end();
  await assert.rejects(fixture.invoke('stop', 1), /HTTP 429/);
  assert.equal(replays, 1);
  assert.equal(fixture.phase, 'error');
  assert.match(fixture.detail, /HTTP 429.*Your audio is saved/);
  assert.equal(fixture.pasted.length, 0);
  // A usage limit will not clear in seconds: no automatic retry, just the button.
  assert.deepEqual(fixture.attention, { recordingId: 'recording-1', title: 'Usage limit reached', detail: '0:01 saved · retry later', retrying: false });
  await setImmediate();
  assert.deepEqual(archive.updates.at(-1), { status: 'failed', error: 'HTTP 429. The subscription dictation service has reached a usage limit.' });
});

test('a successful take marks its saved audio as transcribed', async (t) => {
  const archive = fakeArchive();
  const fixture = await menuFixture({ archive, transport: { start: async () => {}, append() {}, stop: async () => 'First words' } });
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.resolveFocus({});
  await fixture.invoke('start', 1);
  fixture.sendAudio(4_800);
  fixture.end();
  await fixture.invoke('stop', 1);
  await setImmediate();
  assert.deepEqual(archive.updates.at(-1), { status: 'transcribed', transcriptId: 'entry', error: undefined });
});

test('an empty tap is discarded rather than kept as unfinished', async (t) => {
  const archive = fakeArchive();
  const fixture = await menuFixture({ archive, transport: { start: async () => {}, append() {}, stop: async () => '' } });
  t.after(fixture.cleanup);
  await fixture.begin();
  await fixture.invoke('start', 1);
  fixture.sendAudio(4_800);
  fixture.end();
  await fixture.invoke('stop', 1);
  await setImmediate();
  assert.equal(archive.discarded, 1);
  assert.deepEqual(archive.updates, []);
});

async function failedTake(t: test.TestContext, replay: (pcm: Uint8Array) => Promise<string>, focusNow?: () => Promise<FocusTarget>) {
  const archive = fakeArchive();
  const fixture = await menuFixture({
    archive, replay, focusNow,
    transport: { start: async () => {}, append() {}, stop: async () => { throw new Error('No final transcript arrived within 30 seconds.'); } },
  });
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.resolveFocus({ focusId: 'original-field', targetPid: 123 });
  await fixture.invoke('start', 1);
  fixture.sendAudio(96_000);
  fixture.end();
  await fixture.invoke('stop', 1).catch(() => {});
  return { archive, fixture };
}

test('a dropped connection retries on release, then keeps retrying from the island and pastes', async (t) => {
  let replays = 0;
  let online = false;
  const { archive, fixture } = await failedTake(t, async () => {
    replays++;
    if (!online) throw new Error('The dictation connection closed before completion (code 1006).');
    return 'Every word I said';
  });
  assert.equal(replays, 2, 'two replays on release');
  const held = fixture.attention!;
  assert.equal(held.title, 'Connection failed');
  assert.equal(held.detail, '0:02 saved');
  assert.equal(typeof held.retryAt, 'number', 'an automatic retry is scheduled');
  online = true;
  await fixture.run('retryAttention(false)');
  assert.equal(replays, 3);
  assert.equal(fixture.attention, null);
  assert.equal(fixture.pasted.at(-1)?.focusId, 'original-field', 'an automatic retry pastes only into the original field');
  assert.equal(fixture.phase, 'idle');
  assert.equal(fixture.detail, 'Pasted');
  assert.deepEqual(archive.updates.at(-1), { status: 'transcribed', transcriptId: 'entry', error: undefined });
});

test('Retry on the island pastes at the current cursor', async (t) => {
  let online = false;
  const { fixture } = await failedTake(t, async () => {
    if (!online) throw new Error('HTTP 429. The subscription dictation service has reached a usage limit.');
    return 'Every word I said';
  }, async () => ({ focusId: 'field-now', targetPid: 456 }));
  online = true;
  await fixture.run('retryAttention(true)');
  assert.equal(fixture.pasted.at(-1)?.focusId, 'field-now');
  assert.ok(fixture.discarded.includes('original-field'));
  assert.equal(fixture.detail, 'Pasted');
});

test('a failed retry returns to Retry and schedules the next automatic attempt', async (t) => {
  const { fixture } = await failedTake(t, async () => { throw new Error('The dictation connection closed before completion (code 1006).'); });
  const first = fixture.attention!.retryAt as number;
  await fixture.run('retryAttention(false)');
  const held = fixture.attention!;
  assert.equal(held.retrying, false);
  assert.ok((held.retryAt as number) > first, 'the next attempt waits longer');
});

test('starting a new take moves a held take to the menu bar', async (t) => {
  const { fixture } = await failedTake(t, async () => { throw new Error('HTTP 429. The subscription dictation service has reached a usage limit.'); });
  assert.ok(fixture.attention);
  fixture.run('take = null; nextTakeId = 2');
  await fixture.begin();
  assert.equal(fixture.attention, null);
  assert.ok(fixture.discarded.includes('original-field'));
});

test('Retry in the menu copies the transcript and clears the island', async (t) => {
  let online = false;
  const { fixture } = await failedTake(t, async () => {
    if (!online) throw new Error('HTTP 429. The subscription dictation service has reached a usage limit.');
    return 'Every word I said';
  });
  online = true;
  await fixture.invoke('retry-recording', 'recording-1');
  assert.deepEqual(fixture.copied, ['Every word I said']);
  assert.equal(fixture.attention, null);
  assert.equal(fixture.pasted.length, 0, 'the menu has focus, so nothing is pasted');
});

test('an interrupted take is held on the island', async (t) => {
  const archive = fakeArchive();
  const fixture = await menuFixture({ archive, transport: { start: async () => {}, append() {} } });
  t.after(fixture.cleanup);
  await fixture.begin();
  await fixture.invoke('start', 1);
  fixture.sendAudio(48_000);
  fixture.cancel();
  assert.deepEqual(fixture.attention, { recordingId: 'recording-1', title: 'Recording interrupted', detail: '0:01 saved', retrying: false });
});
