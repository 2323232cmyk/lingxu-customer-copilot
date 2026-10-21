export interface OfflineVoiceStatus {
  engine: 'SenseVoice';
  state: 'missing' | 'checking' | 'downloading' | 'ready' | 'error' | 'unsupported';
  detail: string;
  downloadedBytes: number;
  totalBytes: number;
  queued: number;
  active: boolean;
}

export type VoiceModelActionResult =
  | { ok: true; status: OfflineVoiceStatus }
  | { ok: false; status: OfflineVoiceStatus; error: string; cancelled?: boolean };

export type VoiceTranscriptionResult =
  | { ok: true; text: string; engine: 'SenseVoice'; sourceKey?: string }
  | { ok: false; reason: 'missing-model' | 'unavailable' | 'unsupported' | 'cancelled' | 'queue-full' | 'timeout'; error: string };

/** Paths are chosen in a main-process dialog, never accepted as chat-message input. */
export interface OfflineVoiceBridge {
  getVoiceStatus(): Promise<OfflineVoiceStatus>;
  downloadVoiceModel(): Promise<VoiceModelActionResult>;
  cancelVoiceModelDownload(): Promise<void>;
  importVoiceModel(): Promise<VoiceModelActionResult>;
  transcribeWechatVoice(voiceMediaKey: string): Promise<VoiceTranscriptionResult>;
  transcribeAudioFile(): Promise<VoiceTranscriptionResult>;
}
