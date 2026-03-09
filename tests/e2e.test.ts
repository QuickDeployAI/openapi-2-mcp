import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC    = resolve(__dirname, "fixtures/petstore.yaml");
const SERVER  = resolve(__dirname, "../dist/index.js");
const PORT    = 13100;
const BASE    = `http://localhost:${PORT}`;

const EXPECTED_TOOLS = ["getPetById", "findPetsByStatus", "addPet"];

// ── helpers ─────────────────────────────────────────────────────────────────

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(url); return; }
    catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error(`Server not ready at ${url} after ${timeoutMs}ms`);
}

function mkClient() {
  return new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
}

// ── fixture: HTTP+SSE+stdio server ──────────────────────────────────────────

let httpProc: ReturnType<typeof spawn>;

beforeAll(async () => {
  httpProc = spawn("node", [SERVER, SPEC, "--port", String(PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Surface server stderr in test output for debugging
  httpProc.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  await waitForServer(`${BASE}/ping`);
}, 30_000);

afterAll(() => { httpProc?.kill(); });

// ── tests ────────────────────────────────────────────────────────────────────

describe("all three MCP transports served simultaneously", () => {

  it("HTTP streaming (/mcp) returns the expected tools", async () => {
    const client = mkClient();
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
  });

  it("SSE (/sse) returns the expected tools", async () => {
    const client = mkClient();
    await client.connect(new SSEClientTransport(new URL(`${BASE}/sse`)));
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
  });

  it("stdio returns the expected tools", async () => {
    // StdioClientTransport spawns its own child process, so it runs alongside
    // the HTTP server process above — all three transports in flight at once.
    const client = mkClient();
    const transport = new StdioClientTransport({
      command: "node",
      args: [SERVER, SPEC, "--port", String(PORT + 1)],
      stderr: "pipe",
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
  });

});
