import { EdgeSchema, type Edge, type EdgeType } from '../domain';
import type { Db } from './db';
import { json, parseRow, upsert } from './rows';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const edgeFromRow = (r: Row): Edge =>
  parseRow(EdgeSchema, { id: r.id, type: r.type, fromId: r.from_id, fromKind: r.from_kind, toId: r.to_id, toKind: r.to_kind, props: r.props, ...(r.run_id ? { runId: r.run_id } : {}) });

/** Validates against the edge schema first, so illegal from/to kinds or props never reach the table. */
export async function insertEdge(db: Db, edge: Edge): Promise<void> {
  const e = EdgeSchema.parse(edge);
  await upsert(db, 'brain.edge', { id: e.id, type: e.type, from_id: e.fromId, from_kind: e.fromKind, to_id: e.toId, to_kind: e.toKind, props: json(e.props), run_id: e.runId }, ['id']);
}

export async function insertEdges(db: Db, edges: readonly Edge[]): Promise<void> {
  for (const e of edges) await insertEdge(db, e);
}

export async function edgesFrom(db: Db, fromId: string, type?: EdgeType): Promise<Edge[]> {
  const r = await db.query('SELECT * FROM brain.edge WHERE from_id = $1 AND ($2::brain.edge_type IS NULL OR type = $2::brain.edge_type) ORDER BY id', [fromId, type ?? null]);
  return r.rows.map(edgeFromRow);
}

export async function edgesTo(db: Db, toId: string, type?: EdgeType): Promise<Edge[]> {
  const r = await db.query('SELECT * FROM brain.edge WHERE to_id = $1 AND ($2::brain.edge_type IS NULL OR type = $2::brain.edge_type) ORDER BY id', [toId, type ?? null]);
  return r.rows.map(edgeFromRow);
}

export async function edgesByRun(db: Db, runId: string): Promise<Edge[]> {
  const r = await db.query('SELECT * FROM brain.edge WHERE run_id = $1 ORDER BY id', [runId]);
  return r.rows.map(edgeFromRow);
}

/** Delete a run's edges, optionally only some types (a stage replaces just the edges it wrote). */
export async function deleteEdgesByRun(db: Db, runId: string, types?: readonly EdgeType[]): Promise<void> {
  await db.query('DELETE FROM brain.edge WHERE run_id = $1 AND ($2::text[] IS NULL OR type::text = ANY($2::text[]))', [runId, types ? [...types] : null]);
}
