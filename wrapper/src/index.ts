#!/usr/bin/env node

import { spawn, ChildProcess } from 'child_process';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';

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

// Session management for SSE connections
interface SessionData {
  sessionId: string;
  pythonServer: ChildProcess;
  response: Response;
  messageBuffer: string;
  lastActivity: number;
}

const sessions = new Map<string, SessionData>();

// Cleanup inactive sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      console.log(`${ts()} [CLEANUP] Inactive session: ${sessionId}`);
      session.pythonServer.kill();
      sessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

// Helper to create Python MCP server process
function createPythonServer(): ChildProcess {
  return spawn(pythonBin, ['analytics_mcp/server.py'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: projectRoot,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: projectRoot
    }
  });
}

// Helper to send JSON-RPC request to Python server
function sendToPython(pythonServer: ChildProcess, request: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const message = JSON.stringify(request) + '\n';
    
    let responseReceived = false;
    const onData = (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            if (response.id === request.id) {
              responseReceived = true;
              pythonServer.stdout?.removeListener('data', onData);
              resolve(response);
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    };

    pythonServer.stdout?.on('data', onData);

    pythonServer.stdin?.write(message, (error) => {
      if (error) {
        pythonServer.stdout?.removeListener('data', onData);
        reject(error);
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!responseReceived) {
        pythonServer.stdout?.removeListener('data', onData);
        reject(new Error('Request timeout'));
      }
    }, 30000);
  });
}

console.log(`${ts()} Wrapper initialized, ready to accept SSE connections`);

// Health check
app.get('/health', (req, res) => {
  res.send('OK');
});

app.get('/', (req, res) => {
  res.send('Google Analytics MCP Wrapper - Connect via /sse');
});

// SSE endpoint - establishes new session with dedicated Python process
app.get('/sse', async (req: Request, res: Response) => {
  const sessionId = req.query?.sessionId as string | undefined;

  if (sessionId) {
    console.error(`${ts()} [SSE_WARN] Client reconnecting with sessionId=${sessionId}`);
    res.status(400).send('Session already exists');
    return;
  }

  const newSessionId = randomUUID();
  
  // Start dedicated Python MCP server for this session
  const pythonServer = createPythonServer();
  
  pythonServer.stderr?.on('data', (data) => {
    console.error(`${ts()} [Python ${newSessionId}] ${data.toString()}`);
  });

  pythonServer.on('error', (error) => {
    console.error(`${ts()} [ERROR ${newSessionId}] Failed to start Python:`, error);
  });

  pythonServer.on('exit', (code) => {
    console.log(`${ts()} [EXIT ${newSessionId}] Python exited with code ${code}`);
    sessions.delete(newSessionId);
  });

  // Setup SSE response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send endpoint event with sessionId
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ sessionId: newSessionId })}\n\n`);

  console.log(`${ts()} [SSE_CONNECT] New session: ${newSessionId}`);

  // Store session
  sessions.set(newSessionId, {
    sessionId: newSessionId,
    pythonServer,
    response: res,
    messageBuffer: '',
    lastActivity: Date.now()
  });

  // Handle client disconnect
  req.on('close', () => {
    console.log(`${ts()} [SSE_CLOSE] Session disconnected: ${newSessionId}`);
    pythonServer.kill();
    sessions.delete(newSessionId);
  });
});

// POST endpoint for sending messages to Python MCP server
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

    // Send to Python and get response
    const response = await sendToPython(session.pythonServer, message);

    // Send response back via SSE
    session.response.write(`event: message\n`);
    session.response.write(`data: ${JSON.stringify(response)}\n\n`);

    res.status(202).send('Accepted');
  } catch (error) {
    console.error(`${ts()} [MESSAGE_ERROR]:`, error);
    res.status(500).send('Failed to handle message');
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
process.on('SIGINT', () => {
  console.log(`${ts()} Shutting down...`);
  for (const [sessionId, session] of sessions.entries()) {
    session.pythonServer.kill();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`${ts()} Shutting down...`);
  for (const [sessionId, session] of sessions.entries()) {
    session.pythonServer.kill();
  }
  process.exit(0);
});
