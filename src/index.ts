#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { Command } from "commander";
import { dereference } from "@readme/openapi-parser";
import type { OpenAPIV3 } from "openapi-types";
import { extractTools, getBaseUrl } from "./openapi.js";

const program = new Command()
  .name("openapi-2-mcp")
  .description("Build an MCP server from an OpenAPI spec")
  .argument("<spec>", "Path or URL to the OpenAPI spec (local file or http(s)://)")
  .option("--port <number>", "HTTP server port", "3000")
  .option("--mcp <path>",    "HTTP streaming endpoint", "/mcp")
  .option("--sse <path>",    "SSE endpoint", "/sse")
  .option("--stdio",         "Use stdio transport", false)
  .option("--base-url <url>","Override base URL from spec servers")
  .parse();

const [specPath] = program.args as [string];
const opts = program.opts<{ port: string; mcp: string; sse: string; stdio: boolean; baseUrl?: string }>();

const doc = await dereference<OpenAPIV3.Document>(specPath);
const tools = extractTools(doc);
const baseUrl = getBaseUrl(doc, opts.baseUrl);

const [M = 1, m = 0, p = 0] = (doc.info.version ?? "1.0.0")
  .replace(/[^0-9.]/g, "").split(".").map(Number);

const server = new FastMCP({ name: doc.info.title, version: `${M}.${m}.${p}` });

for (const tool of tools) {
  server.addTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const url = new URL(
        baseUrl + tool.path.replace(/\{([^}]+)\}/g, (_, k) => encodeURIComponent(String(args[k] ?? "")))
      );

      for (const [k, v] of Object.entries(args)) {
        if (!tool.pathParams.includes(k) && !tool.bodyKeys.includes(k) && v != null)
          url.searchParams.set(k, String(v));
      }

      const bodyObj =
        tool.bodyKeys.length === 1 && tool.bodyKeys[0] === "body"
          ? args.body
          : Object.fromEntries(tool.bodyKeys.filter((k) => args[k] != null).map((k) => [k, args[k]]));

      const res = await fetch(url, {
        method: tool.method.toUpperCase(),
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        ...(tool.bodyKeys.length ? { body: JSON.stringify(bodyObj) } : {}),
      });

      const text = await res.text();
      try { return JSON.stringify(JSON.parse(text), null, 2); }
      catch { return text; }
    },
  });
}

if (opts.stdio) {
  await server.start({ transportType: "stdio" });
} else {
  const port = Number(opts.port);
  console.log(`[openapi-2-mcp] ${tools.length} tools | :${port} — MCP: ${opts.mcp}  SSE: ${opts.sse}`);
  await server.start({ transportType: "httpStream", httpStream: { port, endpoint: opts.mcp as `/${string}` } });
}
