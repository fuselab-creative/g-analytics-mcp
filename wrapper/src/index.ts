#!/usr/bin/env node

import { spawn } from 'child_process';
import express from 'express';
import cors from 'cors';
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
  exposedHeaders: ['Mcp-Session-Id']
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.send('OK');
});

// Get project root directory (two levels up from dist/index.js -> wrapper -> project root)
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');
const wrapperRoot = join(__dirname, '..');
const pythonBin = join(wrapperRoot, 'venv', 'bin', 'python');

// Create Python MCP server process - run directly without module import
const pythonServer = spawn(pythonBin, ['analytics_mcp/server.py'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: projectRoot,
  env: {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: projectRoot
  }
});

// Log Python stderr
pythonServer.stderr?.on('data', (data) => {
  console.error(`[Python MCP] ${data.toString()}`);
});

pythonServer.on('error', (error) => {
  console.error('Failed to start Python MCP server:', error);
  process.exit(1);
});

pythonServer.on('exit', (code) => {
  console.error(`Python MCP server exited with code ${code}`);
  process.exit(code || 1);
});

// Create MCP client connected to Python server via stdio
const transport = new StdioClientTransport({
  command: pythonBin,
  args: ['analytics_mcp/server.py'],
  cwd: projectRoot,
  env: {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: projectRoot
  }
});

const client = new Client({
  name: 'analytics-mcp-wrapper',
  version: '1.0.0'
}, {
  capabilities: {}
});

// Initialize client connection
await client.connect(transport);

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

// POST endpoint for MCP messages
app.post('/sse/message', async (req, res) => {
  try {
    const message = req.body;
    
    // Forward message to Python MCP server
    const response = await client.request(message, message.params);
    
    res.json(response);
  } catch (error) {
    console.error('Error forwarding message:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error'
      },
      id: req.body.id
    });
  }
});

// Streamable HTTP endpoint (modern MCP transport)
app.post('/mcp', async (req, res) => {
  try {
    const message = req.body;
    
    // Check if client accepts SSE
    const acceptHeader = req.headers.accept || '';
    const supportsSSE = acceptHeader.includes('text/event-stream');
    
    if (supportsSSE && message.method) {
      // Start SSE stream for request
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      try {
        const response = await client.request(message, message.params);
        
        // Send response as SSE event
        res.write(`data: ${JSON.stringify(response)}\n\n`);
        res.end();
      } catch (error) {
        const errorResponse = {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error'
          },
          id: message.id
        };
        res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
        res.end();
      }
    } else {
      // Return JSON response
      const response = await client.request(message, message.params);
      res.json(response);
    }
  } catch (error) {
    console.error('Error handling MCP request:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error'
      },
      id: req.body.id
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
process.on('SIGINT', () => {
  console.log('Shutting down...');
  pythonServer.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  pythonServer.kill();
  process.exit(0);
});
