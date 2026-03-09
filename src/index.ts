#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { program } from "commander";
import {
  loadSpec,
  extractOperations,
  buildParameterSchema,
  getBaseUrl,
  type ParsedOperation,
  type OpenAPISpec,
} from "./openapi.js";

interface CliOptions {
  port: string;
  mcp: string;
  sse: string;
  stdio: boolean;
  baseUrl?: string;
}

/**
 * Interpolates path parameters in a URL path template.
 * e.g. "/users/{id}" with args { id: "123" } → "/users/123"
 */
function interpolatePath(path: string, args: Record<string, unknown>): string {
  return path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = args[key];
    return value !== undefined && value !== null ? encodeURIComponent(String(value)) : `{${key}}`;
  });
}

/**
 * Builds a query string from non-path parameters.
 */
function buildQueryString(
  operation: ParsedOperation,
  args: Record<string, unknown>
): string {
  const pathParamNames = new Set(
    operation.parameters.filter((p) => p.in === "path").map((p) => p.name)
  );
  const bodyParamNames = new Set(
    operation.requestBody ? getBodyParamNames(operation) : []
  );

  const queryParts: string[] = [];
  for (const param of operation.parameters) {
    if (param.in !== "query") continue;
    const value = args[param.name];
    if (value !== undefined && value !== null) {
      queryParts.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(String(value))}`);
    }
  }

  // Also include any args that are not path params and not body params as query params
  for (const [key, value] of Object.entries(args)) {
    if (pathParamNames.has(key) || bodyParamNames.has(key)) continue;
    if (operation.parameters.some((p) => p.in === "query" && p.name === key)) continue;
    if (value !== undefined && value !== null) {
      queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }

  return queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
}

/**
 * Returns the names of body parameters for an operation.
 */
function getBodyParamNames(operation: ParsedOperation): string[] {
  const content = operation.requestBody?.content;
  if (!content) return [];
  const jsonContent = content["application/json"];
  if (!jsonContent?.schema) return [];
  // If we inlined the body properties, return those keys; otherwise return "body"
  if (jsonContent.schema.type === "object" && jsonContent.schema.properties) {
    return Object.keys(jsonContent.schema.properties);
  }
  return ["body"];
}

/**
 * Extracts the request body from args.
 */
function extractBody(
  operation: ParsedOperation,
  args: Record<string, unknown>
): unknown | undefined {
  if (!operation.requestBody) return undefined;
  const bodyParamNames = getBodyParamNames(operation);

  if (bodyParamNames.length === 1 && bodyParamNames[0] === "body") {
    return args["body"];
  }

  // Collect all body param values
  const body: Record<string, unknown> = {};
  for (const name of bodyParamNames) {
    if (args[name] !== undefined) {
      body[name] = args[name];
    }
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

/**
 * Creates an MCP tool executor for a given operation.
 */
function createToolExecutor(
  operation: ParsedOperation,
  baseUrl: string
): (args: Record<string, unknown>) => Promise<string> {
  return async (args: Record<string, unknown>): Promise<string> => {
    const interpolatedPath = interpolatePath(operation.path, args);
    const queryString = buildQueryString(operation, args);
    const url = `${baseUrl}${interpolatedPath}${queryString}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const body = extractBody(operation, args);
    const hasBody = body !== undefined && ["post", "put", "patch"].includes(operation.method);

    const response = await fetch(url, {
      method: operation.method.toUpperCase(),
      headers,
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const json = await response.json();
      return JSON.stringify(json, null, 2);
    }

    return await response.text();
  };
}

/**
 * Converts an arbitrary version string to a semver-compatible format (X.Y.Z).
 * Falls back to "1.0.0" if the string cannot be parsed.
 */
function toSemver(version: string | undefined): `${number}.${number}.${number}` {
  if (!version) return "1.0.0";
  const digits = version.replace(/[^0-9.]/g, "").split(".").filter(Boolean);
  const major = parseInt(digits[0] ?? "1", 10) || 0;
  const minor = parseInt(digits[1] ?? "0", 10) || 0;
  const patch = parseInt(digits[2] ?? "0", 10) || 0;
  return `${major}.${minor}.${patch}`;
}

/**
 * Registers all operations from an OpenAPI spec as MCP tools.
 */
function registerTools(server: FastMCP, spec: OpenAPISpec, baseUrl: string): void {
  const operations = extractOperations(spec);

  if (operations.length === 0) {
    console.warn("[openapi-2-mcp] No operations found in the spec.");
    return;
  }

  for (const operation of operations) {
    const parameters = buildParameterSchema(operation, spec);
    const executor = createToolExecutor(operation, baseUrl);

    server.addTool({
      name: operation.operationId,
      description: operation.description ?? operation.summary,
      parameters,
      execute: async (args) => {
        return await executor(args as Record<string, unknown>);
      },
    });
  }

  console.log(`[openapi-2-mcp] Registered ${operations.length} tool(s).`);
}

async function main(): Promise<void> {
  program
    .name("openapi-2-mcp")
    .description("Build an MCP server from an OpenAPI spec")
    .argument("<spec>", "Path to the OpenAPI spec file (JSON or YAML)")
    .option("--port <number>", "Port for the HTTP server", "3000")
    .option("--mcp <path>", "HTTP streaming endpoint path", "/mcp")
    .option("--sse <path>", "SSE endpoint path (used when serving via HTTP)", "/sse")
    .option("--stdio", "Use stdio transport instead of HTTP", false)
    .option("--base-url <url>", "Override the base URL from the spec's servers field")
    .parse();

  const [specPath] = program.args as [string];
  const options = program.opts<CliOptions & { baseUrl?: string }>();

  // Load and parse the OpenAPI spec
  let spec: OpenAPISpec;
  try {
    spec = await loadSpec(specPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[openapi-2-mcp] Failed to load spec from "${specPath}": ${message}`);
    process.exit(1);
  }

  const baseUrl = getBaseUrl(spec, options.baseUrl);
  if (!baseUrl) {
    console.warn(
      "[openapi-2-mcp] No base URL found in spec servers and no --base-url provided. " +
        "HTTP requests will use relative paths."
    );
  }

  const serverName = spec.info.title ?? "openapi-2-mcp";
  const serverVersion = toSemver(spec.info.version);

  const server = new FastMCP({
    name: serverName,
    version: serverVersion as `${number}.${number}.${number}`,
  });

  registerTools(server, spec, baseUrl);

  if (options.stdio) {
    console.error(`[openapi-2-mcp] Starting stdio transport...`);
    await server.start({ transportType: "stdio" });
  } else {
    const port = parseInt(options.port, 10);
    const mcpEndpoint = options.mcp as `/${string}`;
    const sseEndpoint = options.sse;

    console.log(`[openapi-2-mcp] Starting HTTP server on port ${port}`);
    console.log(`[openapi-2-mcp] HTTP streaming endpoint: http://localhost:${port}${mcpEndpoint}`);
    console.log(`[openapi-2-mcp] SSE endpoint:            http://localhost:${port}${sseEndpoint}`);

    await server.start({
      transportType: "httpStream",
      httpStream: {
        port,
        endpoint: mcpEndpoint,
      },
    });
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[openapi-2-mcp] Fatal error: ${message}`);
  process.exit(1);
});
