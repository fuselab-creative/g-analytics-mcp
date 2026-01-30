#!/usr/bin/env node

import { spawn, ChildProcess } from 'child_process';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';

const app = express();
const PORT = parseInt(process.env.MCP_PORT || '8000');
const HOST = process.env.MCP_HOST || '0.0.0.0';

// Enable CORS for all origins
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['*'],
  exposedHeaders: ['Mcp-Session-Id']
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.send('OK');
});

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');
const wrapperRoot = join(__dirname, '..');
const pythonBin = join(wrapperRoot, 'venv', 'bin', 'python');

// Simple JSON-RPC proxy to Python MCP server
class MCPProxy extends EventEmitter {
  private pythonServer: ChildProcess;
  private messageBuffer: string = '';
  private pendingRequests: Map<number | string, (response: any) => void> = new Map();

  constructor() {
    super();
    
    // Start Python MCP server
    this.pythonServer = spawn(pythonBin, ['analytics_mcp/server.py'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: projectRoot
      }
    });

    // Handle stdout (JSON-RPC responses from Python)
    this.pythonServer.stdout?.on('data', (data) => {
      this.messageBuffer += data.toString();
      this.processMessages();
    });

    // Log stderr
    this.pythonServer.stderr?.on('data', (data) => {
      console.error(`[Python MCP] ${data.toString()}`);
    });

    this.pythonServer.on('error', (error) => {
      console.error('Failed to start Python MCP server:', error);
      process.exit(1);
    });

    this.pythonServer.on('exit', (code) => {
      console.error(`Python MCP server exited with code ${code}`);
      process.exit(code || 1);
    });
  }

  private processMessages() {
    const lines = this.messageBuffer.split('\n');
    this.messageBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse message:', line, error);
        }
      }
    }
  }

  private handleMessage(message: any) {
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const resolve = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      resolve(message);
    } else {
      // Notification or unsolicited message
      this.emit('notification', message);
    }
  }

  async sendRequest(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (request.id !== undefined) {
        this.pendingRequests.set(request.id, resolve);
      }

      const message = JSON.stringify(request) + '\n';
      this.pythonServer.stdin?.write(message, (error) => {
        if (error) {
          if (request.id !== undefined) {
            this.pendingRequests.delete(request.id);
          }
          reject(error);
        } else if (request.id === undefined) {
          // Notification - no response expected
          resolve(null);
        }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (request.id !== undefined && this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  close() {
    this.pythonServer.kill();
  }
}

const mcpProxy = new MCPProxy();

console.log('Connected to Python MCP server via stdio');

// SSE endpoint for MCP protocol
app.get('/sse', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send initial connection event
  res.write('event: open\n');
  res.write('data: {}\n\n');
  
  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);
  
  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

// POST endpoint for MCP messages (both /mcp and /sse endpoints)
const handleMCPRequest = async (req: express.Request, res: express.Response) => {
  try {
    const message = req.body;
    
    // Forward message to Python MCP server and get response
    const response = await mcpProxy.sendRequest(message);
    
    // Check if client accepts SSE
    const acceptHeader = req.headers.accept || '';
    const supportsSSE = acceptHeader.includes('text/event-stream');
    
    if (supportsSSE && message.method) {
      // Return as SSE stream
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`data: ${JSON.stringify(response)}\n\n`);
      res.end();
    } else {
      // Return as JSON
      res.json(response);
    }
  } catch (error) {
    console.error('Error handling MCP request:', error);
    const errorResponse = {
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error'
      },
      id: req.body.id
    };
    
    res.status(500).json(errorResponse);
  }
};

app.post('/mcp', handleMCPRequest);
app.post('/sse', handleMCPRequest);

// Start server
app.listen(PORT, HOST, () => {
  console.log(`Google Analytics MCP HTTP Wrapper running on http://${HOST}:${PORT}`);
  console.log(`Streamable HTTP endpoint: http://${HOST}:${PORT}/mcp`);
  console.log(`Legacy SSE endpoint: http://${HOST}:${PORT}/sse`);
  console.log(`Proxying to Python MCP server via stdio`);
});

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('Shutting down...');
  mcpProxy.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  mcpProxy.close();
  process.exit(0);
});
