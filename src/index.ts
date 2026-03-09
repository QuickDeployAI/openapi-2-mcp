#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { Command } from "commander";
import { dereference } from "@readme/openapi-parser";
import type { OpenAPIV3 } from "openapi-types";
import { openApiToMcpTools, parseVersion } from "./parser.js";

const program = new Command()
  .name("openapi-2-mcp")
  .description("Build an MCP server from an OpenAPI spec")
  .argument("<spec>", "Path or URL to the OpenAPI spec (local file or http(s)://)")
  .option("--port <number>", "HTTP server port", "3000")
  .option("--mcp <path>",    "HTTP streaming endpoint path", "/mcp")
  .option("--sse <path>",    "SSE endpoint path", "/sse")
  .option("--base-url <url>","Override base URL from spec servers")
  .parse();

const [specPath] = program.args as [string];
const { port: portStr, mcp: mcpPath, baseUrl: baseUrlOverride } =
  program.opts<{ port: string; mcp: string; sse: string; baseUrl?: string }>();

const doc    = await dereference<OpenAPIV3.Document>(specPath);
const baseUrl = baseUrlOverride ?? doc.servers?.[0]?.url ?? "";
const tools  = openApiToMcpTools(doc, baseUrl);
const version = parseVersion(doc.info.version);
const port   = Number(portStr);

// All logging → stderr; stdout is reserved for the MCP stdio protocol
const log = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");
const logger = { log, info: log, warn: log, error: log, debug: () => {} };

log(`[openapi-2-mcp] ${tools.length} tools | :${port} stream:${mcpPath} sse:/sse stdio:on`);

function makeServer(): FastMCP {
  const s = new FastMCP({ name: doc.info.title, version, logger });
  for (const tool of tools) s.addTool(tool);
  return s;
}

// HTTP: mcp-proxy's startHTTPServer serves both Streamable HTTP (mcpPath) and legacy SSE (/sse)
await makeServer().start({
  transportType: "httpStream",
  httpStream: { port, endpoint: mcpPath as `/${string}` },
});

// stdio: always active; stdout carries the MCP wire protocol
await makeServer().start({ transportType: "stdio" });
