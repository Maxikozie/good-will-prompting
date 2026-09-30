# Input validation and resource limits

`packages/brain/src/security/limits.ts` is the single source of resource ceilings. Schemas reject unknown object fields, including nested document metadata, YAML configuration, model responses and MCP arguments. Dynamic dictionaries (claim caches, key IDs) validate their values. Environment validation selects application variables and rejects unknown application-prefixed names; unrelated OS/toolchain variables are intentionally ignored. Empty optional environment values are treated as unset. YAML aliases are rejected; JSON nesting and file reads are bounded before schema validation.

| Resource | Ceiling |
| --- | --- |
| Documents/case; wiki pages/ingest | 10 each |
| Document; question | 200,000; 500 characters |
| JSON transport frame/body | 2 MiB |
| YAML/config file | 1 MiB |
| Model response | 256 KiB |
| Model output | 4,096 tokens/call |
| Model calls/run; principal/hour | 200; 1,000 |
| Model token reservation/run; principal/hour | 2,000,000; 10,000,000 |
| MCP tool token bucket | Burst 60, refill 1/second, per principal and tool |
| LLM; embedding; DB query; transaction deadline | 120; 60; 15; 60 seconds |

Each model attempt, including retries and embeddings, reserves input UTF-8 bytes as a conservative token upper bound plus the maximum output token allowance. Reservations are not refunded after provider failure. Migration `006_resource_usage.sql` stores atomic run/principal-hour counters shared by DB-backed processes. Hour boundaries use real UTC time, independent of the demo clock. Operator-only recording calls outside a pipeline use bounded process-local accounting. Do not wrap model workflows in a rollback-on-error database transaction: reservations must survive failed model work. MCP analysis/ingestion therefore perform authorization first, then use their own short database operations rather than one transaction spanning external calls.

MCP rate buckets are shared between sessions within one process, bounded to 10,000 entries. They reset on process restart; a multi-process transport deployment needs a shared rate-bucket store. The current MCP transport is local stdio and caps the SDK frame buffer. Express caps JSON bodies and audio separately (10 MiB). Resource errors expose clean 400/413/429/504-style messages.

HTTP provider timeouts abort fetch and cover response streaming. PostgreSQL has connection/query/statement timeouts; transactions cannot commit after their deadline. PGlite sets statement_timeout and guards asynchronous transactions against late commits. JavaScript timers cannot preempt synchronous blocking code; bounded input and server-side statement limits remain necessary. Custom providers must implement cancellation for their own work even though callers stop awaiting them at the deadline.

Tests: `npm run test:security`; `npm --prefix packages/brain test`. See [REGEX_AUDIT.md](REGEX_AUDIT.md) for the complete pattern inventory and ReDoS regression cases. No dependencies were added.
