import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real stdio startup binds configured identity and serves the legacy tools', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'trustlayer-stdio-'));
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', 'src/mcp/stdio.ts'],
    env: { ...process.env as Record<string, string>, TRUSTLAYER_VAULT_DIR: vault,
      TRUSTLAYER_MCP_SESSION: JSON.stringify({ id: 'user:lotte.peeters', personId: 'lotte.peeters', groups: ['group:demo'], roles: ['reader'] }),
      TRUSTLAYER_MCP_VAULT_READERS: '["group:demo"]' }, stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-regression', version: '1' });
  try {
    await client.connect(transport);
    const listed = (await client.listTools()).tools;
    assert.equal(listed.length, 6);
    for (const name of ['verify_sources', 'trusted_answer', 'knowledge_health']) {
      assert.equal(listed.find((tool) => tool.name === name)?.annotations?.readOnlyHint, false);
    }
    const result = await client.callTool({ name: 'trusted_answer', arguments: { question: 'Hoe vraag ik verlof aan?' } });
    assert.notEqual(result.isError, true);
    const denied = await client.callTool({ name: 'flag_for_owner', arguments: { topic: 'sunday-overtime-premium', issue: 'conflict', note: 'Check owner' } });
    assert.equal(denied.isError, true);
    assert.deepEqual(denied.content, [{ type: 'text', text: '403 Forbidden' }]);
  } finally { await client.close(); await rm(vault, { recursive: true, force: true }); }
});
