# LLM fixtures for the demo seed

These files are what the `FakeProvider` replays (keyed by prompt id + hash of the rendered prompt).

**The fixtures in this folder are HAND-AUTHORED** (`"model": "hand-authored"`): they describe what a careful model should extract from the
fictional demo documents, written by the developer because no model was reachable when the pipeline was built. They are **not** model
output. Their purpose is a deterministic, offline test of everything around the model.

- `npm run author-fixtures` regenerates them from `test/helpers/demo-extraction.ts` (a test checks they are up to date with the prompts).
- `npm run brain:record` (real provider) overwrites them with genuine recordings; `author-fixtures` never overwrites a real recording.
- The hand-authored set includes one deliberately gullible extraction: the prompt-injection comment in document B comes back as a
  duration claim with `modality: "unknown"`, to prove such a claim can never win a fact.
