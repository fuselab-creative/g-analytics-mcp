#!/usr/bin/env python

# Copyright 2025 Google LLC All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""HTTP server entry point for the Google Analytics MCP server with SSE support."""

import os

# Configure MCP to accept requests from any host (for proxies, tunnels, etc.)
# MUST be set before importing MCP modules
if "ALLOWED_HOSTS" not in os.environ:
    # Allow localhost, 0.0.0.0, and any IP addresses (for proxies/tunnels)
    # MCP doesn't support "*" wildcard, so we need to be permissive with validation
    os.environ["ALLOWED_HOSTS"] = "localhost,127.0.0.1,0.0.0.0"
    
# Disable MCP's strict host validation entirely
os.environ["MCP_DISABLE_HOST_VALIDATION"] = "1"

import contextlib
from starlette.applications import Starlette
from starlette.routing import Mount
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.middleware.cors import CORSMiddleware

from analytics_mcp.coordinator import mcp

from analytics_mcp.tools.admin import info  # noqa: F401
from analytics_mcp.tools.reporting import realtime  # noqa: F401
from analytics_mcp.tools.reporting import core  # noqa: F401

@contextlib.asynccontextmanager
async def lifespan(app: Starlette):
    async with mcp.session_manager.run():
        yield

# Create both transport apps
streamable_http = mcp.streamable_http_app()
sse_legacy = mcp.sse_app()

# Create Starlette app with both endpoints
from starlette.routing import Route
from starlette.responses import Response

async def health_check(request):
    return Response("OK", media_type="text/plain")

starlette_app = Starlette(
    routes=[
        # Health check endpoint
        Route("/health", health_check),
        # Modern Streamable HTTP transport
        Mount("/mcp", app=streamable_http, name="streamable_http"),
        # Legacy SSE transport for backward compatibility  
        Mount("/sse", app=sse_legacy, name="sse_legacy"),
    ],
    lifespan=lifespan,
)

# Add CORS middleware for browser and cross-origin requests
starlette_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Mcp-Session-Id"],
)

# Add middleware to accept all hosts (for ngrok and other proxies)
starlette_app.add_middleware(TrustedHostMiddleware, allowed_hosts=["*"])

def run_http_server() -> None:
    """Runs the server with HTTP transport (Streamable HTTP with SSE support).
    
    Configuration via environment variables:
    - MCP_HOST: Host to bind to (default: 0.0.0.0)
    - MCP_PORT: Port to listen on (default: 8000)
    """
    import uvicorn
    
    host = os.getenv("MCP_HOST", "0.0.0.0")
    port = int(os.getenv("MCP_PORT", "8000"))
    
    print(f"Starting Google Analytics MCP server on {host}:{port}")
    print(f"Streamable HTTP endpoint: http://{host}:{port}/mcp (recommended)")
    print(f"Legacy SSE endpoint: http://{host}:{port}/sse (backward compatibility)")
    print(f"Both endpoints support the same MCP tools and capabilities")
    
    uvicorn.run(
        starlette_app, 
        host=host, 
        port=port,
        proxy_headers=True,
        forwarded_allow_ips="*"
    )


if __name__ == "__main__":
    run_http_server()
