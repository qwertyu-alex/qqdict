export type Hotkey = 'fn' | 'right-option' | 'ctrl-option';
export type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'error';
export type Permission = 'granted' | 'denied' | 'not-determined' | 'unavailable';
export type TranscriptEntry = {
  id: string;
  text: string;
  timestamp: string;
  pasted: boolean;
  error?: string;
  logError?: string;
};
export type RecordingStatus = 'recording' | 'failed' | 'transcribed' | 'retrying';
export type RecordingEntry = {
  id: string;
  startedAt: string;
  durationSeconds: number;
  status: RecordingStatus;
  error?: string;
  transcriptId?: string;
};
/** A take that could not be transcribed and is waiting on the island for Retry or dismissal. */
export type Attention = {
  recordingId: string;
  title: string;
  detail: string;
  retrying: boolean;
  /** Epoch milliseconds of the next automatic retry, when one is scheduled. */
  retryAt?: number;
};
export type Settings = { hotkey: Hotkey; microphoneId: string; launchAtLogin: boolean };
export type AppState = {
  phase: Phase;
  connected: boolean;
  label: string;
  detail: string;
  hotkey: Hotkey;
  microphoneId: string;
  microphoneName: string;
  launchAtLogin: boolean;
  permissions: { microphone: Permission; accessibility: Permission; inputMonitoring: Permission };
  history: TranscriptEntry[];
  /** Saved audio from the last 24 hours that can be transcribed again. */
  recordings: RecordingEntry[];
  attention: Attention | null;
  logDirectory: string;
  level: number;
  elapsedSeconds: number;
  maxRecordingSeconds: number;
};
export type AppEvent =
  | { type: 'state'; state: AppState }
  | { type: 'navigate'; tab: 'setup' | 'settings' }
  | { type: 'command'; command: 'start' | 'stop' | 'cancel'; takeId: number }
  | { type: 'status' | 'partial' | 'final' | 'error'; text?: string; status?: string; detail?: string; takeId?: number };
export interface DictationAPI {
  getState(): Promise<AppState>;
  refresh(): Promise<AppState>;
  setSettings(settings: Partial<Settings>): Promise<AppState>;
  requestPermission(kind: keyof AppState['permissions']): Promise<AppState>;
  openSettings(kind: keyof AppState['permissions']): Promise<void>;
  begin(): Promise<void>;
  end(): Promise<void>;
  copyTranscript(id: string): Promise<void>;
  /** Transcribe saved audio again and copy the result. */
  retryRecording(id: string): Promise<void>;
  /** Retry the island's failed take and paste at the current cursor. */
  retryAttention(): Promise<void>;
  dismissAttention(): void;
  holdOverlay(held: boolean): void;
  beginOverlayDrag(): void;
  moveOverlayDrag(): void;
  endOverlayDrag(): void;
  openLogs(): Promise<void>;
  showSettings(): Promise<void>;
  quit(): Promise<void>;
  ready(): Promise<void>;
  reportCapturing(takeId: number, microphoneName: string): void;
  reportLevel(level: number): void;
  reportError(message: string, takeId: number): void;
  start(takeId: number): Promise<void>;
  sendAudio(audio: ArrayBuffer, takeId: number): void;
  stop(takeId: number): Promise<void>;
  cancel(takeId: number): Promise<void>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
