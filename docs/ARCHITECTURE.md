# Application modules

The API and dashboard share domain contracts in `src/core/types.ts`. Domain behavior stays in `src/core/`; HTTP handlers and MCP tools adapt their respective transports to that behavior. The separate `packages/brain` package retains its domain, pipeline, provider and repository modules.

## HTTP application

- `src/api/server.ts`: executable entry point; loads runtime configuration, initializes the vault, attaches the dashboard and opens the listener.
- `src/api/app.ts`: `createApp(options)` assembles Express without opening a port or initializing the vault.
- `src/api/middleware.ts`: security headers, a rate limiter owned by each app instance, and the common error response policy.
- `src/api/routes/index.ts`: common input guard, router composition, demo reset and API 404 handling.
- `src/api/routes/knowledge.ts`: assistant, verification, answers, health, experts and source reads.
- `src/api/routes/tasks.ts`: owner tasks and resolution.
- `src/api/routes/speech.ts`: audio input and the ElevenLabs adapter; receives its API key from the composition root.
- `src/api/mock-user.ts`: the explicitly labelled dashboard mock identity adapter.
- `src/api/web.ts`: development Vite middleware or production static assets.

The middleware order is security headers → rate limiter → bounded JSON parser → input guard → routes → common errors. Keep new routes behind these guards. Router modules receive configuration rather than inspecting command-line arguments or environment variables themselves. `npm run dev` and `npm start` remain the entry points.

## Ask feature

`web/src/views/Ask.tsx` owns screen layout, composer text and radar visibility. Its feature modules live in `web/src/features/ask/`:

- `useConversation.ts`: assistant → source verification state transitions, turn IDs and rerunning the last question.
- `useVoiceInput.ts`: microphone recording, transcription and callbacks to the composer/conversation.
- `TurnView.tsx`: tool progress, verdict and source presentation.
- `EmailOwner.tsx`: owner email draft and task creation.
- `types.ts` and `icons.tsx`: feature-local contracts and presentation primitives.

HTTP calls remain centralized in `web/src/api.ts`; the hooks and components use that client. The existing mock pacing, task workflow, markup and styling are preserved. Feature-local components do not need to be promoted to global UI utilities until another feature uses them.
