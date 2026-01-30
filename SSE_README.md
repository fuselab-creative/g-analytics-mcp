# Google Analytics MCP Server - SSE Transport

This document describes how to use the Google Analytics MCP server with SSE (Server-Sent Events) transport.

## Overview

The SSE transport provides an alternative way to serve the MCP server over HTTP with Server-Sent Events, which is useful for legacy clients or environments that require SSE-based communication.

## Installation

First, install the package with all dependencies:

```bash
pip install -e .
```

## Configuration

1. Copy the `.env.example` file to `.env`:

```bash
cp .env.example .env
```

2. Configure your Google Cloud credentials and SSE server settings in `.env`:

```env
# Google Cloud Configuration
GOOGLE_CLOUD_PROJECT=your-project-id-here
GOOGLE_APPLICATION_CREDENTIALS=${HOME}/.config/gcloud/application_default_credentials.json

# SSE Server Configuration
MCP_SSE_HOST=0.0.0.0
MCP_SSE_PORT=8000
```

## Running the SSE Server

### Method 1: Using the installed script

After installation, you can run the SSE server using the command:

```bash
analytics-mcp-sse
```

### Method 2: Running directly with Python

```bash
python -m analytics_mcp.sse_server
```

### Method 3: Programmatically

```python
from analytics_mcp.sse_server import run_sse_server

# Run with default settings (0.0.0.0:8000)
run_sse_server()

# Or with custom host and port
run_sse_server(host="localhost", port=3000)
```

## Available Tools

The SSE server exposes all the same tools as the standard MCP server:

### Admin Tools
- `get_account_summaries`: Retrieve Google Analytics accounts and properties
- `list_google_ads_links`: List links to Google Ads accounts
- `get_property_details`: Get details about a property
- `list_property_annotations`: Get property annotations

### Reporting Tools
- `run_report`: Run Google Analytics Data API reports
- `run_realtime_report`: Run realtime reports

## Client Configuration

Configure your MCP client to connect to the SSE server:

```json
{
  "mcpServers": {
    "google-analytics": {
      "transport": "sse",
      "url": "http://localhost:8000"
    }
  }
}
```

## Docker Support

You can also run the SSE server in Docker. Create a Dockerfile or use docker-compose:

```yaml
version: '3.8'
services:
  analytics-mcp-sse:
    build: .
    ports:
      - "8000:8000"
    environment:
      - MCP_SSE_HOST=0.0.0.0
      - MCP_SSE_PORT=8000
      - GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/application_default_credentials.json
    volumes:
      - ./credentials:/app/credentials:ro
    command: analytics-mcp-sse
```

## Differences from STDIO Transport

- **SSE Transport**: Uses HTTP with Server-Sent Events, suitable for web clients and legacy systems
- **STDIO Transport**: Uses standard input/output, typically for direct process communication

Both transports expose the same tools and functionality.

## Troubleshooting

1. **Port already in use**: Change the port in your `.env` file or use a different port when calling `run_sse_server()`

2. **Authentication errors**: Ensure your Google Cloud credentials are properly configured and have the necessary permissions

3. **Connection refused**: Check that the host and port are correctly configured and that no firewall is blocking the connection

## Security Considerations

- The SSE server binds to `0.0.0.0` by default, making it accessible from any network interface
- For production use, consider:
  - Binding to `127.0.0.1` for local-only access
  - Using a reverse proxy with authentication
  - Implementing proper CORS headers if accessed from web browsers

## Example Usage

Here's a simple example of how a client might interact with the SSE server:

```python
import httpx
import json

# Example request to get account summaries
response = httpx.post(
    "http://localhost:8000/tools/call",
    json={
        "tool": "get_account_summaries",
        "arguments": {}
    }
)
result = response.json()
print(json.dumps(result, indent=2))
```

Note: The actual SSE protocol implementation details depend on the MCP client library you're using.
