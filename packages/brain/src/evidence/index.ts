// Evidence corpus (case documents A..N): payload adapter, ACL, passages, duplicate detection, claim extraction.
// Boundary: must not import src/reference/** or src/pipeline/** (eslint + test/boundary.test.ts). Stage files in
// src/pipeline only orchestrate these functions.
export * from './acl';
export * from './adapter';
export * from './duplicates';
export * from './extract';
export * from './passages';
export * from './simhash';
