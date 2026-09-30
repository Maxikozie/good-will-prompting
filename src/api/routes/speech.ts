import express from 'express';
import { z } from 'zod';
import { readResponseJson } from '../../../packages/brain/src/llm/http';
import { LIMITS } from '../../../packages/brain/src/security/limits';

export function speechRouter(apiKey?: string) {
  const api = express.Router();
  // Voice input: browser audio → ElevenLabs Speech-to-Text (Scribe). The API key stays on the server.
  const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
  const STT_MAX = 20; // transcriptions per client per minute (they cost credits)
  const sttHits = new Map<string, { count: number; reset: number }>();
  api.post('/transcribe', express.raw({ type: (req) => /^audio\//.test(String(req.headers['content-type'] ?? '')), limit: LIMITS.audioBodyBytes }), async (req, res) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    if (!/^audio\/[a-z0-9.+-]{1,40}$/.test(type)) return res.status(415).json({ error: 'Send audio (e.g. audio/webm)' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: 'Recording is empty or too short' });
    const key = apiKey;
    if (!key) return res.status(503).json({ error: 'Voice input is not configured (ELEVENLABS_API_KEY missing). Type your question instead.' });

    const ip = req.ip ?? 'unknown';
    const t = Date.now();
    const h = sttHits.get(ip);
    if (!h || h.reset < t) sttHits.set(ip, { count: 1, reset: t + 60_000 });
    else if (++h.count > STT_MAX) return res.status(429).json({ error: 'Too many voice requests, wait a minute' });

    const form = new FormData();
    form.append('model_id', 'scribe_v2');
    form.append('tag_audio_events', 'false');
    form.append('file', new Blob([new Uint8Array(req.body)], { type }), `question.${type.split('/')[1].replace(/[^a-z0-9]/g, '') || 'webm'}`);
    try {
      const r = await fetch(STT_URL, { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(LIMITS.speechTimeoutMs) });
      if (!r.ok) {
        console.error(`[api] speech-to-text failed with HTTP ${r.status}`);
        return res.status(502).json({ error: 'Speech-to-text failed. Type your question instead.' });
      }
      const data = z.object({
        text: z.string().max(LIMITS.documentChars), language_code: z.string().max(20).optional(), language_probability: z.number().min(0).max(1).optional(), transcription_id: z.string().max(200).optional(),
        words: z.array(z.object({ text: z.string().max(1000), start: z.number(), end: z.number(), type: z.enum(['word', 'spacing', 'audio_event']), speaker_id: z.string().nullable().optional(), logprob: z.number().optional() }).strict()).max(100_000).optional(),
      }).strict().parse(await readResponseJson(r));
      const text = typeof data.text === 'string' ? data.text.trim().slice(0, LIMITS.questionChars) : '';
      if (!text) return res.status(422).json({ error: "Didn't catch that, try again" });
      res.json({ text });
    } catch {
      console.error('[api] speech-to-text request error');
      res.status(502).json({ error: 'Speech-to-text unavailable. Type your question instead.' });
    }
  });

  return api;
}
