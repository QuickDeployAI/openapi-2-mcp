#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { Command } from "commander";
import { dereference } from "@readme/openapi-parser";
import type { OpenAPIV3 } from "openapi-types";
import { z } from "zod";

// ── OpenAPI → Zod ──────────────────────────────────────────────────────────

function toZod(schema: OpenAPIV3.SchemaObject, required = false): z.ZodTypeAny {
  let t: z.ZodTypeAny;
  if (schema.enum) {
    const vals = schema.enum as string[];
    t = vals.length >= 2 && vals.every((v) => typeof v === "string")
      ? z.enum(vals as [string, ...string[]])
      : z.unknown();
  } else {
    switch (schema.type) {
      case "string":  t = z.string();  break;
      case "integer":
      case "number":  t = z.number();  break;
      case "boolean": t = z.boolean(); break;
      case "array":   t = z.array(toZod((schema as OpenAPIV3.ArraySchemaObject).items as OpenAPIV3.SchemaObject, true)); break;
      case "object":  t = z.object(Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([k, v]) => [
          k, toZod(v as OpenAPIV3.SchemaObject, (schema.required ?? []).includes(k)),
        ])
      )); break;
      default: t = z.unknown(); break;
    }
  }
  if (schema.description) t = t.describe(schema.description);
  return required ? t : t.optional();
}

// ── Operation extraction ───────────────────────────────────────────────────

const HTTP_METHODS = ["get","post","put","patch","delete","head","options"] as const;

interface OpTool {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  method: string;
  path: string;
  pathParams: string[];
  bodyKeys: string[];
}

function extractOps(doc: OpenAPIV3.Document): OpTool[] {
  return Object.entries(doc.paths ?? {}).flatMap(([path, item]) => {
    const pi = item as OpenAPIV3.PathItemObject;
    const shared = (pi.parameters ?? []) as OpenAPIV3.ParameterObject[];
    return HTTP_METHODS.flatMap((method) => {
      const op = pi[method as OpenAPIV3.HttpMethods];
      if (!op || op.deprecated) return [];

      const params = [...shared, ...(op.parameters ?? []) as OpenAPIV3.ParameterObject[]]
        .reduce<OpenAPIV3.ParameterObject[]>((acc, p) => {
          const i = acc.findIndex((x) => x.name === p.name && x.in === p.in);
          i >= 0 ? (acc[i] = p) : acc.push(p);
          return acc;
        }, []);

      const shape: Record<string, z.ZodTypeAny> = Object.fromEntries(
        params.map((p) => [
          p.name,
          toZod((p.schema ?? {}) as OpenAPIV3.SchemaObject, p.required ?? false)
            .describe(p.description ?? ""),
        ])
      );

      const bodyKeys: string[] = [];
      const body = op.requestBody as OpenAPIV3.RequestBodyObject | undefined;
      const bodySchema = body?.content?.["application/json"]?.schema as OpenAPIV3.SchemaObject | undefined;
      if (bodySchema?.type === "object" && bodySchema.properties) {
        const req = bodySchema.required ?? [];
        for (const [k, v] of Object.entries(bodySchema.properties)) {
          shape[k] = toZod(v as OpenAPIV3.SchemaObject, body?.required === true && req.includes(k));
          bodyKeys.push(k);
        }
      } else if (bodySchema) {
        shape.body = toZod(bodySchema, body?.required ?? false).describe(body?.description ?? "Request body");
        bodyKeys.push("body");
      }

      return [{
        name: op.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`,
        description: op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`,
        parameters: z.object(shape),
        method, path,
        pathParams: params.filter((p) => p.in === "path").map((p) => p.name),
        bodyKeys,
      }];
    });
  });
}

// ── CLI ────────────────────────────────────────────────────────────────────

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
const opts = program.opts<{ port: string; mcp: string; sse: string; baseUrl?: string }>();

const doc = await dereference<OpenAPIV3.Document>(specPath);
const baseUrl = opts.baseUrl ?? doc.servers?.[0]?.url ?? "";

const [M = 1, m = 0, p = 0] = (doc.info.version ?? "1.0.0")
  .replace(/[^0-9.]/g, "").split(".").map(Number);
const semver: `${number}.${number}.${number}` = `${M}.${m}.${p}`;

// All logging → stderr; stdout is reserved for the MCP stdio protocol
const log = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");
const logger = { log, info: log, warn: log, error: log, debug: () => {} };

const ops = extractOps(doc);

function makeServer() {
  const s = new FastMCP({ name: doc.info.title, version: semver, logger });
  for (const op of ops) {
    s.addTool({
      name: op.name,
      description: op.description,
      parameters: op.parameters,
      execute: async (rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const url = new URL(
          baseUrl + op.path.replace(/\{([^}]+)\}/g, (_, k) =>
            encodeURIComponent(String(args[k] ?? "")))
        );
        for (const [k, v] of Object.entries(args))
          if (!op.pathParams.includes(k) && !op.bodyKeys.includes(k) && v != null)
            url.searchParams.set(k, String(v));

        const bodyObj =
          op.bodyKeys.length === 1 && op.bodyKeys[0] === "body"
            ? args.body
            : Object.fromEntries(op.bodyKeys.filter((k) => args[k] != null).map((k) => [k, args[k]]));

        const res = await fetch(url, {
          method: op.method.toUpperCase(),
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          ...(op.bodyKeys.length ? { body: JSON.stringify(bodyObj) } : {}),
        });
        const text = await res.text();
        try { return JSON.stringify(JSON.parse(text), null, 2); }
        catch { return text; }
      },
    });
  }
  return s;
}

const port = Number(opts.port);
log(`[openapi-2-mcp] ${ops.length} tools | :${port} stream:${opts.mcp} sse:${opts.sse} stdio:on`);

// HTTP transport — mcp-proxy's startHTTPServer serves BOTH:
//   • Streamable HTTP at opts.mcp  (e.g. /mcp)
//   • Legacy SSE      at opts.sse  (e.g. /sse)   ← mcp-proxy default, not yet overridable via FastMCP
await makeServer().start({
  transportType: "httpStream",
  httpStream: { port, endpoint: opts.mcp as `/${string}` },
});

// Stdio transport — always active; stdout carries the MCP protocol stream
await makeServer().start({ transportType: "stdio" });
