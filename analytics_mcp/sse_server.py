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

"""SSE wrapper for the Google Analytics MCP server."""

import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Import the existing coordinator which has all tools registered
from analytics_mcp.coordinator import mcp

# Import all tools to ensure they're registered with the mcp object
from analytics_mcp.tools.admin import info  # noqa: F401
from analytics_mcp.tools.reporting import realtime  # noqa: F401
from analytics_mcp.tools.reporting import core  # noqa: F401


def run_sse_server() -> None:
    """Runs the Google Analytics MCP server with SSE transport.
    
    The SSE transport will use the host and port configured via environment variables
    or default settings.
    """
    print("Starting Google Analytics MCP server with SSE transport")
    
    # Run the server with SSE transport
    mcp.run(transport='sse')


if __name__ == "__main__":
    run_sse_server()
