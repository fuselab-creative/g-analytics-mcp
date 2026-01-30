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
  client: Client;
  transport: StdioClientTransport;
  lastActivity: number;
}

const sessions = new Map<string, SessionData>();

// Cleanup inactive sessions
setInterval(() => {
  const now = Date.now();
  const SESSION_TIMEOUT = 30 * 60 * 1000;

  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      console.log(`${ts()} [CLEANUP] Inactive session: ${sessionId}`);
      session.client.close().catch(() => {});
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

// SSE endpoint - use MCP SDK to bridge SSE client to stdio Python server
app.get('/sse', async (req: Request, res: Response) => {
  try {
    // Create SSE transport for client
    const sseTransport = new SSEServerTransport('/sse/message', res as any);
    const sessionId = sseTransport.sessionId;

    console.log(`${ts()} [SSE_CONNECT] New session: ${sessionId}`);

    // Create stdio transport to Python MCP server
    const stdioTransport = new StdioClientTransport({
      command: pythonBin,
      args: ['analytics_mcp/server.py'],
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: projectRoot
      }
    });

    // Create MCP client to connect to Python server
    const client = new Client(
      {
        name: 'analytics-mcp-wrapper',
        version: '1.0.0'
      },
      {
        capabilities: {}
      }
    );

    // Store session
    sessions.set(sessionId, {
      client,
      transport: stdioTransport,
      lastActivity: Date.now()
    });

    // Connect client to Python server via stdio
    await client.connect(stdioTransport);

    console.log(`${ts()} [CONNECTED ${sessionId}] Client connected to Python MCP server`);

    // Handle cleanup
    req.on('close', async () => {
      console.log(`${ts()} [SSE_CLOSE] Session disconnected: ${sessionId}`);
      await client.close().catch(() => {});
      sessions.delete(sessionId);
    });

    // Bridge: forward all requests from SSE client to Python server
    // The SSEServerTransport will handle the SSE protocol automatically
    // We just need to forward requests to the Python client
    
  } catch (error) {
    console.error(`${ts()} [SSE_ERROR]:`, error);
    if (!res.headersSent) {
      res.status(500).send('Failed to establish SSE connection');
    }
  }
});

// POST endpoint for SSE messages
app.post('/sse/message', async (req: Request, res: Response) => {
  const sessionId = req.query?.sessionId as string;
  const session = sessions.get(sessionId);

  if (!session) {
    console.warn(`${ts()} [NO_SESSION] ${sessionId}`);
    res.status(404).send('No session found');
    return;
  }

  try {
    session.lastActivity = Date.now();
    const message = req.body;

    // Forward request to Python MCP server via client
    const response = await session.client.request(
      message,
      message.params || {}
    );

    res.json(response);
  } catch (error) {
    console.error(`${ts()} [MESSAGE_ERROR]:`, error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error'
      },
      id: req.body?.id
    });
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
    await session.client.close().catch(() => {});
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log(`${ts()} Shutting down...`);
  for (const [sessionId, session] of sessions.entries()) {
    await session.client.close().catch(() => {});
  }
  process.exit(0);
});
