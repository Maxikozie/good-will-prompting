// Reference corpus (wiki pages): ingestion, sections, reference-fact extraction, gap-targeted queries and retrieval.
// Boundary: must not import src/evidence/** or src/pipeline/** (eslint + test/boundary.test.ts). Bridge edges to the case
// documents (FILLS_GAP, CORROBORATES, CONTRADICTS, ADDS_CONTEXT, DERIVED_FROM) are created only in src/pipeline/50-enrich.ts.
export * from './sections';
export * from './ingest';
export * from './extract';
export * from './queries';
export * from './retrieval';
