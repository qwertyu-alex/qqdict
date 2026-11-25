import type { AppState, Hotkey, RecordingEntry, TranscriptEntry } from './contracts';
import { PRODUCT_NAME } from './product';
import { classifyFailure, failureCopy, formatDuration } from './recovery';

const api = window.dictation;
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const copyIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1.5"/><path d="M3.5 11H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v.5"/></svg>';
const retryIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/></svg>';
const checkIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';
const hotkeyLabel = (hotkey: Hotkey): string => hotkey === 'fn' ? 'fn' : hotkey === 'right-option' ? 'Right ⌥' : '⌃ + ⌥';
let historyFingerprint: string | undefined;
let operationError = '';
let lastPhase: AppState['phase'] | undefined;
let latestState: AppState | undefined;

function announce(message: string): void {
  element('announcement').textContent = message;
}

function renderError(): void {
  const error = latestState?.phase === 'error' ? latestState.detail || operationError : operationError;
  element('popover-error').textContent = error;
  element('popover-error').hidden = !error;
}

function showError(error: unknown): void {
  operationError = error instanceof Error ? error.message : String(error);
  renderError();
}

function timeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)} · ${time}`;
}

/** Transcribe saved audio again. The menu takes focus, so the result is copied rather than pasted. */
function retry(recording: RecordingEntry, button: HTMLButtonElement, done: () => void): void {
  button.disabled = true;
  announce('Transcribing saved audio');
  void api.retryRecording(recording.id).then(() => {
    operationError = '';
    renderError();
    done();
    announce('Transcript copied');
  }).catch((error: unknown) => {
    showError(error);
    announce('Couldn’t transcribe saved audio');
  }).finally(() => { button.disabled = false; });
}

function recordingRow(recording: RecordingEntry): HTMLElement {
  const row = document.createElement('article');
  row.className = 'transcript-row recording-row';
  const meta = document.createElement('div');
  meta.className = 'transcript-meta';
  const time = document.createElement('time');
  time.className = 'transcript-time';
  time.dateTime = recording.startedAt;
  time.textContent = `${timeLabel(recording.startedAt)} · ${formatDuration(recording.durationSeconds)}`;
  const retrying = recording.status === 'retrying';
  const button = document.createElement('button');
  button.className = 'retry-button';
  button.type = 'button';
  button.textContent = retrying ? 'Retrying…' : 'Retry';
  button.disabled = retrying;
  button.title = 'Transcribe the saved audio and copy the text';
  button.setAttribute('aria-label', `Transcribe the recording from ${time.textContent} and copy the text`);
  button.addEventListener('click', () => retry(recording, button, () => { button.textContent = 'Copied'; }));
  meta.append(time, button);
  const text = document.createElement('p');
  text.className = 'transcript-text';
  text.textContent = retrying ? 'Transcribing saved audio…' : 'Not transcribed';
  row.append(meta, text);
  if (!retrying && recording.error) {
    const reason = document.createElement('p');
    reason.className = 'recording-reason';
    reason.textContent = `${failureCopy(classifyFailure(recording.error), recording.durationSeconds).title}. Audio is kept for 24 hours.`;
    reason.title = recording.error;
    row.append(reason);
  }
  return row;
}

function transcriptRow(entry: TranscriptEntry, recording?: RecordingEntry): HTMLElement {
  const row = document.createElement('article');
  row.className = 'transcript-row';
  const meta = document.createElement('div');
  meta.className = 'transcript-meta';
  const time = document.createElement('time');
  time.className = 'transcript-time';
  time.dateTime = entry.timestamp;
  time.textContent = timeLabel(entry.timestamp);
  time.title = new Date(entry.timestamp).toLocaleString();
  const button = document.createElement('button');
  button.className = 'icon-button copy-button';
  button.type = 'button';
  button.innerHTML = copyIcon;
  const label = `Copy transcript from ${time.title}`;
  button.setAttribute('aria-label', label);
  button.title = 'Copy transcript';
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    button.disabled = true;
    void api.copyTranscript(entry.id).then(() => {
      operationError = '';
      renderError();
      clearTimeout(feedbackTimer);
      button.innerHTML = checkIcon;
      button.dataset.copied = 'true';
      button.title = 'Copied';
      button.setAttribute('aria-label', 'Transcript copied');
      announce('Transcript copied');
      feedbackTimer = setTimeout(() => {
        button.innerHTML = copyIcon;
        delete button.dataset.copied;
        button.title = 'Copy transcript';
        button.setAttribute('aria-label', label);
      }, 1400);
    }).catch((error: unknown) => {
      showError(error);
      announce('Couldn’t copy transcript');
    }).finally(() => { button.disabled = false; });
  });
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  if (recording) {
    // The audio is kept for 24 hours, so a truncated transcript can be redone.
    const again = document.createElement('button');
    again.className = 'icon-button copy-button redo-button';
    again.type = 'button';
    again.innerHTML = retryIcon;
    const retrying = recording.status === 'retrying';
    again.disabled = retrying;
    again.setAttribute('aria-busy', String(retrying));
    again.title = retrying ? 'Transcribing again…' : 'Transcribe again from saved audio and copy';
    again.setAttribute('aria-label', again.title);
    again.addEventListener('click', () => retry(recording, again, () => {}));
    actions.append(again);
  }
  actions.append(button);
  meta.append(time, actions);
  const text = document.createElement('p');
  text.className = 'transcript-text';
  text.textContent = entry.text;
  row.append(meta, text);
  if (entry.error || entry.logError) {
    const warning = document.createElement('p');
    warning.className = 'transcript-warning';
    warning.textContent = entry.error && entry.logError
      ? 'Couldn’t paste or save the journal. Copy above.'
      : entry.logError ? 'Journal not saved. Copy above.' : 'Couldn’t paste. Copy above.';
    warning.title = [entry.error, entry.logError].filter(Boolean).join('\n');
    row.append(warning);
  }
  return row;
}

function render(state: AppState): void {
  latestState = state;
  const ready = state.connected && Object.values(state.permissions).every((permission) => permission === 'granted');
  document.body.dataset.phase = state.phase;
  element('state-label').textContent = state.phase === 'recording' ? 'Listening'
    : state.phase === 'starting' ? 'Starting'
      : state.phase === 'transcribing' ? 'Transcribing'
        : state.phase === 'error' ? 'Needs attention'
          : ready ? 'Ready' : 'Setup needed';
  element('settings-button').setAttribute('aria-label', ready ? 'Open settings' : `Finish ${PRODUCT_NAME} setup`);
  element('settings-button').title = ready ? 'Settings' : 'Finish setup';
  const shortcut = hotkeyLabel(state.hotkey);
  element('hotkey-label').textContent = shortcut;
  element('shortcut-hint').setAttribute('aria-label', `Hold ${shortcut} to dictate`);
  if (state.phase !== lastPhase) operationError = '';
  lastPhase = state.phase;
  renderError();
  const entries = state.history.slice(0, 10);
  // A take that never got a transcript sits in Recent at the time it was recorded.
  const unfinished = state.recordings.filter(recording => !recording.transcriptId && (recording.status === 'failed' || recording.status === 'retrying'));
  const audio = new Map(state.recordings.filter(recording => recording.transcriptId).map(recording => [recording.transcriptId!, recording]));
  const fingerprint = JSON.stringify([entries, unfinished, [...audio]]);
  if (fingerprint === historyFingerprint) return;
  historyFingerprint = fingerprint;
  const rows = [
    ...entries.map(entry => ({ time: entry.timestamp, row: () => transcriptRow(entry, audio.get(entry.id)) })),
    ...unfinished.map(recording => ({ time: recording.startedAt, row: () => recordingRow(recording) })),
  ].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  if (rows.length) {
    element('history').replaceChildren(...rows.map(item => item.row()));
  } else {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No transcripts yet';
    element('history').replaceChildren(empty);
  }
}

element('settings-button').addEventListener('click', () => { void api.showSettings().catch(showError); });
element('journal-button').addEventListener('click', () => { void api.openLogs().catch(showError); });
element('quit-button').addEventListener('click', () => { void api.quit().catch(showError); });
api.onEvent((event) => { if (event.type === 'state') render(event.state); });
void api.getState().then(render).catch(showError);
window.addEventListener('focus', () => { void api.getState().then(render).catch(showError); });
