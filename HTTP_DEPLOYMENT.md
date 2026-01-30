# Google Analytics MCP Server - HTTP/SSE Deployment

This guide explains how to deploy the Google Analytics MCP server with HTTP transport and SSE (Server-Sent Events) support for remote access.

## Overview

The server has been configured to run with **Streamable HTTP transport**, which supports:
- HTTP POST/GET requests
- Server-Sent Events (SSE) for streaming responses
- Multiple concurrent clients
- Remote deployment capabilities

## Quick Start

### 1. Setup Credentials

Create a `credentials` directory in the project root and place your Google Cloud credentials file there:

```bash
mkdir -p credentials
cp /path/to/your/creds.json credentials/creds.json
```

### 2. Configure Environment

The `.env` file is already configured with:
- `GOOGLE_CLOUD_PROJECT=medydive`
- `GOOGLE_PROJECT_ID=medydive`
- `GOOGLE_APPLICATION_CREDENTIALS=credentials/creds.json`
- `MCP_HOST=0.0.0.0` (listen on all interfaces)
- `MCP_PORT=8000` (default port)

### 3. Build and Run

```bash
# Build and start the server
docker-compose up --build

# Or run in background
docker-compose up -d --build
```

### 4. Access the Server

The MCP endpoint will be available at:
```
http://localhost:8000/mcp
```

For remote access (if deployed on a server):
```
http://YOUR_SERVER_IP:8000/mcp
```

## Configuration Options

### Environment Variables

You can customize the server by modifying `.env`:

```bash
# Server binding
MCP_HOST=0.0.0.0          # 0.0.0.0 for all interfaces, 127.0.0.1 for localhost only
MCP_PORT=8000             # Port to listen on

# Google Cloud
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_PROJECT_ID=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=credentials/creds.json
```

### Port Mapping

To change the external port, modify `docker-compose.yml`:

```yaml
ports:
  - "9000:8000"  # External port 9000, internal port 8000
```

Or set in `.env`:
```bash
MCP_PORT=9000
```

## Client Connection

### Using MCP Client

```python
from mcp.client import Client
from mcp.client.transports import StreamableHTTPTransport

transport = StreamableHTTPTransport(url="http://localhost:8000/mcp")
client = Client(transport)
```

### Using FastMCP Client

```python
from fastmcp.client import FastMCPClient
from fastmcp.client.transports import StreamableHTTPTransport

transport = StreamableHTTPTransport(url="http://localhost:8000/mcp")
client = FastMCPClient(transport)
```

### Using curl (for testing)

```bash
# Test the endpoint
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

## Security Considerations

### For Production Deployment

1. **Use HTTPS**: Deploy behind a reverse proxy (nginx, Traefik) with SSL/TLS
2. **Authentication**: Add authentication middleware
3. **Firewall**: Restrict access to trusted IPs
4. **Credentials**: Never commit credentials to git (already in `.gitignore`)

### Example nginx Configuration

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location /mcp {
        proxy_pass http://localhost:8000/mcp;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
    }
}
```

## Monitoring

### View Logs

```bash
# Follow logs
docker-compose logs -f analytics-mcp

# View last 100 lines
docker-compose logs --tail=100 analytics-mcp
```

### Health Check

```bash
# Check if server is running
docker-compose ps

# Test endpoint
curl http://localhost:8000/mcp
```

## Troubleshooting

### Port Already in Use

```bash
# Change the port in .env
MCP_PORT=8001

# Rebuild and restart
docker-compose down
docker-compose up --build
```

### Credentials Not Found

Ensure the credentials file exists:
```bash
ls -la credentials/creds.json
```

### Connection Refused

Check if the server is running:
```bash
docker-compose ps
docker-compose logs analytics-mcp
```

## Stopping the Server

```bash
# Stop the server
docker-compose down

# Stop and remove volumes
docker-compose down -v
```

## Development vs Production

### Development (Local)
- Use `MCP_HOST=127.0.0.1` for localhost only
- No authentication needed
- Direct access via localhost

### Production (Remote)
- Use `MCP_HOST=0.0.0.0` to accept external connections
- Deploy behind HTTPS reverse proxy
- Implement authentication
- Use firewall rules to restrict access

## Additional Resources

- [MCP Specification - Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [FastMCP Documentation](https://gofastmcp.com/)
- [Google Analytics Admin API](https://developers.google.com/analytics/devguides/config/admin/v1)
- [Google Analytics Data API](https://developers.google.com/analytics/devguides/reporting/data/v1)
