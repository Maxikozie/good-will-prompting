import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
const sql = /\b(?:SELECT\b[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\b[\s\S]*\bSET|DELETE\s+FROM|ON\s+CONFLICT|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i;
function unsafe(source: string, file = 'test.ts') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  function walk(n: ts.Node) {
    // Grep every template, including SQL constructed before the call site.
    if (ts.isTemplateExpression(n) && sql.test(n.getText(ast))) problems.push('interpolated SQL');
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && sql.test(n.getText(ast))) problems.push('concatenated SQL');
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['query', 'exec'].includes(n.expression.name.text)) {
      const arg = n.arguments[0];
      if (arg && (ts.isTemplateExpression(arg) || ts.isBinaryExpression(arg) || ts.isCallExpression(arg))) problems.push('constructed SQL argument');
      // Only the audited adapter, static registry and migration loader may forward SQL variables.
      const forwarding: Record<string, readonly string[]> = {
        'packages/brain/src/store/db.ts': ['sql'],
        'packages/brain/src/store/migrate.ts': ['sql'],
        'packages/brain/src/store/rows.ts': ['statement.sql', 'COUNTS[table as keyof typeof COUNTS]'],
      };
      if (arg && !ts.isStringLiteralLike(arg) && !forwarding[file]?.includes(arg.getText(ast))) problems.push('nonliteral SQL outside audited forwarding boundary');
    }
    ts.forEachChild(n, walk);
  }
  walk(ast); return problems;
}
test('grep src: no SQL with ${…}, concatenation or unreviewed indirect query construction', () => {
  for (const file of [...files('src'), ...files('packages/brain/src')]) assert.deepEqual(unsafe(readFileSync(file, 'utf8'), file), [], file);
});
test('SQL source guard catches templates, concatenation and indirect constructions', () => {
  for (const sample of ['db.query(`SELECT * FROM ${table}`)', 'const q = `UPDATE users SET role=${role}`;', 'db.query("SELECT * FROM " + table)', 'db.query(fragment + suffix)', 'db.query(sqlText)']) assert.ok(unsafe(sample).length, sample);
  assert.deepEqual(unsafe('db.query("SELECT * FROM users WHERE id = $1", [id])'), []);
});
