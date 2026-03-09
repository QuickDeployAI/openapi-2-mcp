# openapi-2-mcp

Build an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server from an OpenAPI spec using [FastMCP for TypeScript](https://github.com/punkpeye/fastmcp).

Each operation in the OpenAPI spec is exposed as an MCP tool, allowing AI agents to interact with any REST API through the MCP protocol.

## Installation

```bash
npm install -g openapi-2-mcp
```

Or run directly with `npx`:

```bash
npx openapi-2-mcp <spec>
```

## Usage

```
Usage: openapi-2-mcp [options] <spec>

Build an MCP server from an OpenAPI spec

Arguments:
  spec              Path to the OpenAPI spec file (JSON or YAML)

Options:
  --port <number>   Port for the HTTP server (default: "3000")
  --mcp <path>      HTTP streaming endpoint path (default: "/mcp")
  --sse <path>      SSE endpoint path (used when serving via HTTP) (default: "/sse")
  --stdio           Use stdio transport instead of HTTP (default: false)
  --base-url <url>  Override the base URL from the spec's servers field
  -h, --help        display help for command
```

## Examples

### Start an HTTP server (HTTP Streaming + SSE)

```bash
openapi-2-mcp ./openapi.yaml
```

Starts an HTTP server on port 3000 with:
- HTTP streaming endpoint at `http://localhost:3000/mcp`
- SSE endpoint at `http://localhost:3000/sse`

### Custom endpoint paths

```bash
openapi-2-mcp ./openapi.yaml --mcp /api/mcp --sse /api/sse --port 8080
```

### Stdio transport (for use with Claude Desktop, etc.)

```bash
openapi-2-mcp ./openapi.yaml --stdio
```

### Override base URL

```bash
openapi-2-mcp ./openapi.yaml --base-url https://api.example.com --stdio
```

## Transport Modes

### HTTP Streaming (default)

When started without `--stdio`, the server uses FastMCP's HTTP streaming transport which supports both:
- **HTTP Streaming** (`--mcp` path, default `/mcp`): Modern MCP transport using HTTP streaming
- **SSE** (`--sse` path, default `/sse`): Legacy Server-Sent Events transport for backwards compatibility

### Stdio

Use `--stdio` for integrations with MCP clients that communicate over stdin/stdout, such as Claude Desktop.

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": ["openapi-2-mcp", "/path/to/openapi.yaml", "--stdio"]
    }
  }
}
```

## How It Works

1. Loads the OpenAPI spec (JSON or YAML)
2. Extracts all non-deprecated operations from the spec
3. Creates an MCP tool for each operation with:
   - **Name**: the `operationId` (or auto-generated from method + path)
   - **Description**: the operation's `description` or `summary`
   - **Parameters**: derived from the operation's path/query parameters and request body schema
4. Starts the MCP server with the chosen transport
5. When a tool is called, makes the corresponding HTTP request to the API

## Building from Source

```bash
npm install
npm run build
```

