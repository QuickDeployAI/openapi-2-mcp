import { describe, it, expect } from "vitest";
import type { OpenAPIV3 } from "openapi-types";
import { z } from "zod";
import {
  schemaToZod,
  buildUrl,
  buildBody,
  parseVersion,
  openApiToMcpTools,
} from "../src/parser.js";

// ── schemaToZod ───────────────────────────────────────────────────────────────

describe("schemaToZod", () => {
  describe("primitive types", () => {
    it("maps string to ZodString", () => {
      expect(schemaToZod({ type: "string" })).toBeInstanceOf(z.ZodOptional);
      expect(schemaToZod({ type: "string" }, true)).toBeInstanceOf(z.ZodString);
    });

    it("maps number to ZodNumber", () => {
      expect(schemaToZod({ type: "number" }, true)).toBeInstanceOf(z.ZodNumber);
    });

    it("maps integer to ZodNumber", () => {
      expect(schemaToZod({ type: "integer" }, true)).toBeInstanceOf(z.ZodNumber);
    });

    it("maps boolean to ZodBoolean", () => {
      expect(schemaToZod({ type: "boolean" }, true)).toBeInstanceOf(z.ZodBoolean);
    });

    it("maps unknown/missing type to ZodUnknown", () => {
      expect(schemaToZod({}, true)).toBeInstanceOf(z.ZodUnknown);
      expect(schemaToZod({ type: "null" as never }, true)).toBeInstanceOf(z.ZodUnknown);
    });
  });

  describe("complex types", () => {
    it("maps array to ZodArray of items type", () => {
      const t = schemaToZod({ type: "array", items: { type: "string" } }, true);
      expect(t).toBeInstanceOf(z.ZodArray);
      expect((t as z.ZodArray<z.ZodTypeAny>).element).toBeInstanceOf(z.ZodString);
    });

    it("maps object to ZodObject with correct property types", () => {
      const t = schemaToZod({
        type: "object",
        properties: {
          name: { type: "string" },
          age:  { type: "integer" },
        },
        required: ["name"],
      }, true) as z.ZodObject<z.ZodRawShape>;

      expect(t).toBeInstanceOf(z.ZodObject);
      expect(t.shape.name).toBeInstanceOf(z.ZodString);  // required
      expect(t.shape.age).toBeInstanceOf(z.ZodOptional);  // not required
    });

    it("maps object with no properties to empty ZodObject", () => {
      const t = schemaToZod({ type: "object" }, true);
      expect(t).toBeInstanceOf(z.ZodObject);
    });
  });

  describe("enum types", () => {
    it("maps string enum with 2+ values to ZodEnum", () => {
      const t = schemaToZod({ enum: ["a", "b", "c"] }, true);
      expect(t).toBeInstanceOf(z.ZodEnum);
    });

    it("maps single-value enum to ZodUnknown (ZodEnum requires 2+ values)", () => {
      expect(schemaToZod({ enum: ["only"] }, true)).toBeInstanceOf(z.ZodUnknown);
    });

    it("maps mixed-type enum to ZodUnknown", () => {
      expect(schemaToZod({ enum: [1, "two"] }, true)).toBeInstanceOf(z.ZodUnknown);
    });
  });

  describe("required / optional wrapping", () => {
    it("wraps in ZodOptional when required=false (default)", () => {
      expect(schemaToZod({ type: "string" })).toBeInstanceOf(z.ZodOptional);
    });

    it("does not wrap when required=true", () => {
      expect(schemaToZod({ type: "string" }, true)).toBeInstanceOf(z.ZodString);
    });
  });

  describe("description", () => {
    it("attaches description when present", () => {
      const t = schemaToZod({ type: "string", description: "a name" }, true);
      expect((t as z.ZodString).description).toBe("a name");
    });

    it("does not set description when absent", () => {
      const t = schemaToZod({ type: "string" }, true);
      expect((t as z.ZodString).description).toBeUndefined();
    });
  });

  describe("validation behaviour", () => {
    it("string schema rejects non-strings", () => {
      const t = schemaToZod({ type: "string" }, true) as z.ZodString;
      expect(t.safeParse("ok").success).toBe(true);
      expect(t.safeParse(42).success).toBe(false);
    });

    it("number schema accepts integers and floats", () => {
      const t = schemaToZod({ type: "number" }, true) as z.ZodNumber;
      expect(t.safeParse(1).success).toBe(true);
      expect(t.safeParse(3.14).success).toBe(true);
      expect(t.safeParse("x").success).toBe(false);
    });

    it("enum schema rejects values outside the set", () => {
      const t = schemaToZod({ enum: ["available", "sold"] }, true);
      expect(t.safeParse("available").success).toBe(true);
      expect(t.safeParse("unknown").success).toBe(false);
    });
  });
});

// ── buildUrl ──────────────────────────────────────────────────────────────────

describe("buildUrl", () => {
  const base = "https://api.example.com";

  it("constructs a simple URL with no params", () => {
    expect(buildUrl(base, "/pets", {}, [], []).toString())
      .toBe("https://api.example.com/pets");
  });

  it("substitutes a single path param", () => {
    expect(buildUrl(base, "/pets/{id}", { id: 42 }, ["id"], []).toString())
      .toBe("https://api.example.com/pets/42");
  });

  it("substitutes multiple path params", () => {
    expect(
      buildUrl(base, "/users/{userId}/pets/{petId}", { userId: 1, petId: 2 }, ["userId", "petId"], []).toString()
    ).toBe("https://api.example.com/users/1/pets/2");
  });

  it("URL-encodes special characters in path params", () => {
    const url = buildUrl(base, "/pets/{name}", { name: "hello world" }, ["name"], []);
    expect(url.pathname).toBe("/pets/hello%20world");
  });

  it("substitutes missing path param with empty string", () => {
    expect(buildUrl(base, "/pets/{id}", {}, ["id"], []).toString())
      .toBe("https://api.example.com/pets/");
  });

  it("adds non-path, non-body args as query params", () => {
    const url = buildUrl(base, "/pets", { status: "active" }, [], []);
    expect(url.searchParams.get("status")).toBe("active");
  });

  it("excludes path params from query string", () => {
    const url = buildUrl(base, "/pets/{id}", { id: 5, status: "active" }, ["id"], []);
    expect(url.searchParams.has("id")).toBe(false);
    expect(url.searchParams.get("status")).toBe("active");
  });

  it("excludes body keys from query string", () => {
    const url = buildUrl(base, "/pets", { name: "fido", tag: "cute" }, [], ["name"]);
    expect(url.searchParams.has("name")).toBe(false);
    expect(url.searchParams.get("tag")).toBe("cute");
  });

  it("skips null and undefined query param values", () => {
    const url = buildUrl(base, "/pets", { name: null, tag: undefined, status: "ok" }, [], []);
    expect(url.searchParams.has("name")).toBe(false);
    expect(url.searchParams.has("tag")).toBe(false);
    expect(url.searchParams.get("status")).toBe("ok");
  });

  it("coerces non-string query values to string", () => {
    const url = buildUrl(base, "/pets", { count: 10, flag: true }, [], []);
    expect(url.searchParams.get("count")).toBe("10");
    expect(url.searchParams.get("flag")).toBe("true");
  });
});

// ── buildBody ─────────────────────────────────────────────────────────────────

describe("buildBody", () => {
  it("returns undefined when there are no body keys", () => {
    expect(buildBody([], { name: "fido" })).toBeUndefined();
  });

  it("returns args.body directly when bodyKeys is ['body']", () => {
    const raw = { foo: "bar" };
    expect(buildBody(["body"], { body: raw })).toBe(raw);
  });

  it("returns args.body even when it is a primitive", () => {
    expect(buildBody(["body"], { body: "plain-text" })).toBe("plain-text");
  });

  it("returns an object with the listed body keys", () => {
    const result = buildBody(["name", "status"], { name: "fido", status: "active", extra: "ignored" });
    expect(result).toEqual({ name: "fido", status: "active" });
  });

  it("filters out null/undefined body values", () => {
    const result = buildBody(["name", "status"], { name: "fido", status: null, extra: "x" });
    expect(result).toEqual({ name: "fido" });
  });

  it("returns empty object when all body values are null", () => {
    expect(buildBody(["name"], { name: null })).toEqual({});
  });
});

// ── parseVersion ──────────────────────────────────────────────────────────────

describe("parseVersion", () => {
  it("passes through a standard semver string", () => {
    expect(parseVersion("1.2.3")).toBe("1.2.3");
  });

  it("strips a leading 'v' prefix", () => {
    expect(parseVersion("v2.0.0")).toBe("2.0.0");
  });

  it("pads missing minor and patch to zero", () => {
    expect(parseVersion("3")).toBe("3.0.0");
    expect(parseVersion("3.1")).toBe("3.1.0");
  });

  it("strips pre-release labels", () => {
    expect(parseVersion("1.0.0-beta.1")).toBe("1.0.0");
  });

  it("falls back to '1.0.0' for undefined input", () => {
    expect(parseVersion()).toBe("1.0.0");
    expect(parseVersion("")).toBe("1.0.0");
  });
});

// ── openApiToMcpTools ─────────────────────────────────────────────────────────

// Minimal inline doc — no filesystem dependency for unit tests
const minimalDoc: OpenAPIV3.Document = {
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0.0" },
  paths: {
    "/pets/{id}": {
      parameters: [
        { name: "x-tenant", in: "header", schema: { type: "string" } },  // shared param defined at path-item level
      ],
      get: {
        operationId: "getPet",
        summary: "Get a pet by ID",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
          { name: "expand", in: "query", schema: { type: "string" } },
          // duplicates x-tenant at op level to verify merge/dedup
          { name: "x-tenant", in: "header", schema: { type: "string" }, description: "overridden" },
        ],
      },
      delete: {
        operationId: "deletePet",
        summary: "Delete a pet",
        deprecated: true,   // should be excluded
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
        ],
      },
    },
    "/pets": {
      post: {
        // no operationId — should fall back to method_path
        summary: "Create a pet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name:   { type: "string", description: "Pet name" },
                  status: { type: "string", enum: ["active", "inactive"] },
                },
              },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        operationId: "healthCheck",
        description: "Liveness probe",
        // no parameters, no body
      },
    },
  },
};

describe("openApiToMcpTools", () => {
  const tools = openApiToMcpTools(minimalDoc, "https://api.example.com");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  it("returns one tool per non-deprecated operation", () => {
    // deletePet is deprecated, so only getPet, post_pets, healthCheck
    expect(tools).toHaveLength(3);
  });

  it("uses operationId as the tool name when present", () => {
    expect(byName["getPet"]).toBeDefined();
    expect(byName["healthCheck"]).toBeDefined();
  });

  it("falls back to method_path slug when operationId is absent", () => {
    expect(byName["post__pets"]).toBeDefined();
  });

  it("excludes deprecated operations", () => {
    expect(byName["deletePet"]).toBeUndefined();
  });

  it("uses operation description, then summary, then method+path", () => {
    expect(byName["getPet"].description).toBe("Get a pet by ID");
    expect(byName["healthCheck"].description).toBe("Liveness probe");
  });

  it("merges path-level shared params with operation-level params", () => {
    // getPet should have: id, expand, x-tenant (deduplicated, op-level wins)
    const shape = byName["getPet"].parameters.shape;
    expect(shape).toHaveProperty("id");
    expect(shape).toHaveProperty("expand");
    expect(shape).toHaveProperty("x-tenant");
    expect(Object.keys(shape)).toHaveLength(3);  // no duplicate x-tenant
  });

  it("op-level param wins over path-level param with same name+in", () => {
    // op-level x-tenant has description: "overridden"
    const xTenant = byName["getPet"].parameters.shape["x-tenant"];
    expect(xTenant?.description).toBe("overridden");
  });

  it("makes required path params non-optional in the schema", () => {
    const id = byName["getPet"].parameters.shape["id"];
    expect(id).toBeInstanceOf(z.ZodNumber);  // required → not wrapped in Optional
  });

  it("makes optional query params optional in the schema", () => {
    const expand = byName["getPet"].parameters.shape["expand"];
    expect(expand).toBeInstanceOf(z.ZodOptional);
  });

  it("flattens object body properties into the parameters shape", () => {
    const shape = byName["post__pets"].parameters.shape;
    expect(shape).toHaveProperty("name");
    expect(shape).toHaveProperty("status");
    // required body field → non-optional
    expect(shape["name"]).toBeInstanceOf(z.ZodString);
    // optional body field → optional
    expect(shape["status"]).toBeInstanceOf(z.ZodOptional);
  });

  it("produces no parameters for an operation with none", () => {
    expect(Object.keys(byName["healthCheck"].parameters.shape)).toHaveLength(0);
  });

  it("each tool has an execute function", () => {
    for (const tool of tools) {
      expect(typeof tool.execute).toBe("function");
    }
  });
});
