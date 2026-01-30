# Multi-stage build: Node.js + Python
FROM node:20-slim AS base

# Install Python and dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Python MCP server
COPY analytics_mcp/ ./analytics_mcp/
COPY pyproject.toml ./

# Install Python dependencies
RUN pip3 install --break-system-packages --no-cache-dir -e . && \
    pip3 install --break-system-packages --no-cache-dir google-analytics-admin google-analytics-data

# Copy wrapper code
COPY wrapper/package*.json ./wrapper/
COPY wrapper/tsconfig.json ./wrapper/

# Install Node.js dependencies
WORKDIR /app/wrapper
RUN npm ci

# Copy TypeScript source
COPY wrapper/src/ ./src/

# Build TypeScript
RUN npm run build

# Create non-root user (use UID 1001 to avoid conflicts)
RUN useradd -m -u 1001 mcpuser && \
    chown -R mcpuser:mcpuser /app

USER mcpuser

# Set environment variables
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["node", "dist/index.js"]
