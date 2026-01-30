#!/usr/bin/env node

import { spawn, ChildProcess } from 'child_process';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const app = express();
const PORT = parseInt(process.env.MCP_PORT || '8000');
const HOST = process.env.MCP_HOST || '0.0.0.0';

// Enable CORS for all origins
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['*'],
  exposedHeaders: ['*']
}));

app.use(express.json());

// Timestamp helper
const ts = () => new Date().toISOString();

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');
const wrapperRoot = join(__dirname, '..');

// Use venv Python if available (local dev), otherwise use system python3 (Docker)
const venvPython = join(wrapperRoot, 'venv', 'bin', 'python');
const pythonBin = existsSync(venvPython) ? venvPython : 'python3';

// Session management
interface SessionData {
  transport: SSEServerTransport;
  server: McpServer;
  pythonClient: Client;
  lastActivity: number;
}

const sessions = new Map<string, SessionData>();

// Cleanup inactive sessions
setInterval(async () => {
  const now = Date.now();
  const SESSION_TIMEOUT = 30 * 60 * 1000;

  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      console.log(`${ts()} [CLEANUP] Inactive session: ${sessionId}`);
      try {
        await session.server.close();
      } catch (e) {}
      try {
        await session.pythonClient.close();
      } catch (e) {}
      sessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

console.log(`${ts()} Wrapper initialized, ready to accept SSE connections`);

// Health check
app.get('/health', (req, res) => {
  res.send('OK');
});

app.get('/', (req, res) => {
  res.send('Google Analytics MCP Wrapper - Connect via /sse');
});

// SSE endpoint - create MCP Server that proxies to Python MCP server
app.get('/sse', async (req: Request, res: Response) => {
  const sessionId = req.query?.sessionId as string | undefined;

  if (sessionId) {
    console.error(`${ts()} [SSE_WARN] Client reconnecting with sessionId=${sessionId}`);
    res.status(400).send('Session already exists');
    return;
  }

  const transport = new SSEServerTransport('/sse/message', res as any);
  const sid = transport.sessionId;

  console.log(`${ts()} [SSE_CONNECT] New session: ${sid}`);

  // Create MCP Server
  const sessionServer = new McpServer({ name: 'Google Analytics MCP Wrapper', version: '1.0.0' });

  // Create Python client
  const pythonTransport = new StdioClientTransport({
    command: pythonBin,
    args: ['analytics_mcp/server.py'],
    cwd: projectRoot,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: projectRoot
    }
  });

  const pythonClient = new Client(
    { name: 'wrapper-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await pythonClient.connect(pythonTransport);
  console.log(`${ts()} [CONNECTED ${sid}] Connected to Python MCP server`);

  // Get tools list for logging
  const toolsList = await pythonClient.listTools();
  console.log(`${ts()} [TOOLS ${sid}] Python has ${toolsList.tools?.length || 0} tools`);

  await sessionServer.connect(transport);
  console.log(`${ts()} [SSE_READY ${sid}] SSE server ready`);

  sessions.set(sid, {
    transport,
    server: sessionServer,
    pythonClient,
    lastActivity: Date.now()
  });

  let isClosing = false;
  transport.onclose = async () => {
    if (isClosing) return;
    isClosing = true;

    const session = sessions.get(sid);
    if (!session) return;

    console.log(`${ts()} [SSE_CLOSE] Session disconnected: ${sid}`);

    try {
      await session.server.close();
    } catch (e) {}

    try {
      await session.pythonClient.close();
    } catch (e) {}

    sessions.delete(sid);
  };
});

// POST endpoint for SSE messages
app.post('/sse/message', async (req: Request, res: Response) => {
  const sessionId = req.query?.sessionId as string;
  const session = sessions.get(sessionId);
  
  if (session) {
    try {
      session.lastActivity = Date.now();
      await session.transport.handlePostMessage(req as any, res as any);
    } catch (err) {
      console.error(`${ts()} [MESSAGE_ERROR]:`, err);
      if (!res.headersSent) res.status(500).send('Failed to handle message');
    }
  } else {
    console.warn(`${ts()} [NO_SESSION] ${sessionId}`);
    if (!res.headersSent) res.status(404).send('No session found');
  }
});

// Start server
app.listen(PORT, HOST, () => {
  console.log(`Google Analytics MCP HTTP Wrapper running on http://${HOST}:${PORT}`);
  console.log(`Streamable HTTP endpoint: http://${HOST}:${PORT}/mcp`);
  console.log(`Legacy SSE endpoint: http://${HOST}:${PORT}/sse`);
  console.log(`Proxying to Python MCP server via stdio`);
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log(`${ts()} Shutting down...`);
  for (const [sessionId, session] of sessions.entries()) {
    try { await session.server.close(); } catch (e) {}
    try { await session.pythonClient.close(); } catch (e) {}
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log(`${ts()} Shutting down...`);
  for (const [sessionId, session] of sessions.entries()) {
    try { await session.server.close(); } catch (e) {}
    try { await session.pythonClient.close(); } catch (e) {}
  }
  process.exit(0);
});
