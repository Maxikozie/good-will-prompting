import { LIMITS } from '../../packages/brain/src/security/limits';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import '../core/util'; // Loads the operator's .env before establishing identity.
import { authenticateStdio } from '../security/stdio-session';
import { createMcpServer } from './server';

const session = authenticateStdio(process.env);
const server = createMcpServer(session);
await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: LIMITS.jsonBodyBytes }));
console.error('[trustlayer-mcp] ready on authenticated local stdio');
