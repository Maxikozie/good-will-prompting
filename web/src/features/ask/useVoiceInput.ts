import { useRef, useState } from 'react';
import { api } from '../../api';

type Mic = 'idle' | 'recording' | 'transcribing';
const MAX_RECORDING_MS = 15_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useVoiceInput({ busy, onTranscript, onQuestion, onError }: {
  busy: boolean; onTranscript: (text: string) => void; onQuestion: (text: string) => void; onError: () => void;
}) {
  const [mic, setMic] = useState<Mic>('idle');
  const [micError, setMicError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stopTimer = useRef<number | null>(null);
  async function toggleMic() {
    setMicError(null);
    if (mic === 'recording') {
      recorder.current?.stop();
      return;
    }
    if (mic !== 'idle' || busy) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        if (stopTimer.current) window.clearTimeout(stopTimer.current);
        stream.getTracks().forEach((t) => t.stop());
        setMic('transcribing');
        try {
          const q = await api.transcribe(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
          setMic('idle');
          onTranscript(q);
          await wait(450); // let the transcript land in the box before it is sent
          onQuestion(q);
        } catch (e) {
          setMic('idle');
          setMicError(e instanceof Error ? e.message : 'Voice input failed');
          onError();
        }
      };
      recorder.current = rec;
      rec.start();
      setMic('recording');
      stopTimer.current = window.setTimeout(() => rec.state === 'recording' && rec.stop(), MAX_RECORDING_MS);
    } catch {
      setMicError('No microphone access. Type your question instead.');
      onError();
    }
  }

  return { mic, micError, toggleMic };
}
