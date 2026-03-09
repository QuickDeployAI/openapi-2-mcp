import type { OpenAPIV3 } from "openapi-types";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────────────

export type McpTool = {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  execute(args: unknown): Promise<string>;
};

// ── Schema conversion ─────────────────────────────────────────────────────────

export function schemaToZod(schema: OpenAPIV3.SchemaObject, required = false): z.ZodTypeAny {
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
      case "array":   t = z.array(
        schemaToZod((schema as OpenAPIV3.ArraySchemaObject).items as OpenAPIV3.SchemaObject, true)
      ); break;
      case "object":  t = z.object(Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([k, v]) => [
          k, schemaToZod(v as OpenAPIV3.SchemaObject, (schema.required ?? []).includes(k)),
        ])
      )); break;
      default:        t = z.unknown(); break;
    }
  }

  if (schema.description) t = t.describe(schema.description);
  return required ? t : t.optional();
}

// ── Request building ──────────────────────────────────────────────────────────

export function buildUrl(
  baseUrl: string,
  path: string,
  args: Record<string, unknown>,
  pathParams: readonly string[],
  bodyKeys: readonly string[],
): URL {
  const resolved = path.replace(
    /\{([^}]+)\}/g,
    (_, k) => encodeURIComponent(String(args[k] ?? "")),
  );
  const url = new URL(baseUrl + resolved);
  for (const [k, v] of Object.entries(args)) {
    if (!pathParams.includes(k) && !bodyKeys.includes(k) && v != null) {
      url.searchParams.set(k, String(v));
    }
  }
  return url;
}

export function buildBody(bodyKeys: readonly string[], args: Record<string, unknown>): unknown {
  if (bodyKeys.length === 0) return undefined;
  if (bodyKeys.length === 1 && bodyKeys[0] === "body") return args.body;
  return Object.fromEntries(bodyKeys.filter((k) => args[k] != null).map((k) => [k, args[k]]));
}

// ── Operation extraction ──────────────────────────────────────────────────────

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

function mergeParams(
  shared: OpenAPIV3.ParameterObject[],
  local: OpenAPIV3.ParameterObject[],
): OpenAPIV3.ParameterObject[] {
  return [...shared, ...local].reduce<OpenAPIV3.ParameterObject[]>((acc, p) => {
    const i = acc.findIndex((x) => x.name === p.name && x.in === p.in);
    i >= 0 ? (acc[i] = p) : acc.push(p);
    return acc;
  }, []);
}

async function fetchOperation(
  baseUrl: string,
  method: string,
  path: string,
  pathParams: readonly string[],
  bodyKeys: readonly string[],
  args: Record<string, unknown>,
): Promise<string> {
  const url = buildUrl(baseUrl, path, args, pathParams, bodyKeys);
  const body = buildBody(bodyKeys, args);
  const res = await fetch(url, {
    method: method.toUpperCase(),
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}

function operationToTool(
  method: string,
  path: string,
  op: OpenAPIV3.OperationObject,
  shared: OpenAPIV3.ParameterObject[],
  baseUrl: string,
): McpTool {
  const params = mergeParams(shared, (op.parameters ?? []) as OpenAPIV3.ParameterObject[]);
  const pathParams = params.filter((p) => p.in === "path").map((p) => p.name);

  const shape: Record<string, z.ZodTypeAny> = Object.fromEntries(
    params.map((p) => [
      p.name,
      schemaToZod((p.schema ?? {}) as OpenAPIV3.SchemaObject, p.required ?? false)
        .describe(p.description ?? ""),
    ]),
  );

  const body = op.requestBody as OpenAPIV3.RequestBodyObject | undefined;
  const bodySchema = body?.content?.["application/json"]?.schema as OpenAPIV3.SchemaObject | undefined;
  const bodyKeys: string[] = [];

  if (bodySchema?.type === "object" && bodySchema.properties) {
    const required = bodySchema.required ?? [];
    for (const [k, v] of Object.entries(bodySchema.properties)) {
      shape[k] = schemaToZod(v as OpenAPIV3.SchemaObject, body?.required === true && required.includes(k));
      bodyKeys.push(k);
    }
  } else if (bodySchema) {
    shape.body = schemaToZod(bodySchema, body?.required ?? false)
      .describe(body?.description ?? "Request body");
    bodyKeys.push("body");
  }

  return {
    name: op.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`,
    description: op.description ?? op.summary ?? `${method.toUpperCase()} ${path}`,
    parameters: z.object(shape),
    execute: (args) =>
      fetchOperation(baseUrl, method, path, pathParams, bodyKeys, args as Record<string, unknown>),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function openApiToMcpTools(doc: OpenAPIV3.Document, baseUrl: string): McpTool[] {
  return Object.entries(doc.paths ?? {}).flatMap(([path, item]) => {
    const pi = item as OpenAPIV3.PathItemObject;
    const shared = (pi.parameters ?? []) as OpenAPIV3.ParameterObject[];
    return HTTP_METHODS.flatMap((method) => {
      const op = pi[method as OpenAPIV3.HttpMethods];
      return op && !op.deprecated
        ? [operationToTool(method, path, op, shared, baseUrl)]
        : [];
    });
  });
}

export function parseVersion(version = "1.0.0"): `${number}.${number}.${number}` {
  const [M = 1, m = 0, p = 0] = (version.match(/\d+/g) ?? []).map(Number);
  return `${M}.${m}.${p}`;
}
