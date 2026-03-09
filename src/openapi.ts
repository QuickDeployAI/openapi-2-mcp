import { readFile } from "fs/promises";
import yaml from "js-yaml";
import { z } from "zod";

export interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenAPIServer {
  url: string;
  description?: string;
}

export interface OpenAPIParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: OpenAPISchema;
}

export interface OpenAPISchema {
  type?: string;
  format?: string;
  description?: string;
  enum?: unknown[];
  items?: OpenAPISchema;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  nullable?: boolean;
  $ref?: string;
}

export interface OpenAPIRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: OpenAPISchema }>;
}

export interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses?: Record<string, unknown>;
  tags?: string[];
  deprecated?: boolean;
}

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

export interface OpenAPIPathItem {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  head?: OpenAPIOperation;
  options?: OpenAPIOperation;
  parameters?: OpenAPIParameter[];
}

export interface OpenAPISpec {
  openapi: string;
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  paths?: Record<string, OpenAPIPathItem>;
  components?: {
    schemas?: Record<string, OpenAPISchema>;
    parameters?: Record<string, OpenAPIParameter>;
  };
}

export interface ParsedOperation {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  parameters: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
}

/**
 * Loads and parses an OpenAPI spec from a file path (JSON or YAML).
 */
export async function loadSpec(filePath: string): Promise<OpenAPISpec> {
  const content = await readFile(filePath, "utf-8");
  const ext = filePath.toLowerCase();
  let parsed: unknown;
  if (ext.endsWith(".yaml") || ext.endsWith(".yml")) {
    parsed = yaml.load(content);
  } else {
    parsed = JSON.parse(content);
  }
  return parsed as OpenAPISpec;
}

/**
 * Builds a z.union type from an array of enum values.
 * Uses z.enum for string-only enums (more efficient), z.union otherwise.
 */
function buildEnumZodType(enumValues: unknown[]): z.ZodTypeAny {
  const stringValues = enumValues.filter((v) => typeof v === "string") as string[];
  if (stringValues.length === enumValues.length && stringValues.length >= 2) {
    return z.enum(stringValues as [string, ...string[]]);
  }
  if (stringValues.length === enumValues.length && stringValues.length === 1) {
    return z.literal(stringValues[0] as string);
  }
  const literals = enumValues.map((v) => z.literal(v as string | number | boolean));
  if (literals.length === 1) {
    return literals[0] as z.ZodTypeAny;
  }
  const zodLiterals = literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
  const [first, second, ...rest] = zodLiterals;
  return z.union([first, second, ...rest]);
}

/**
 * Checks if a parameter-like value has a $ref property.
 */
function hasRef(value: unknown): value is { $ref: string } {
  return typeof value === "object" && value !== null && "$ref" in value && typeof (value as { $ref: unknown }).$ref === "string";
}

/**
 * Resolves a $ref against the spec's components.
 * Only allows refs in the format #/... to prevent prototype pollution.
 */
function resolveRef(ref: string, spec: OpenAPISpec): OpenAPISchema | OpenAPIParameter | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.replace(/^#\//, "").split("/");

  // Validate ref path to prevent prototype pollution attacks
  for (const part of parts) {
    if (part === "__proto__" || part === "constructor" || part === "prototype") {
      return undefined;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = spec;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current as OpenAPISchema | OpenAPIParameter | undefined;
}

/**
 * Resolves a schema, following $ref if present.
 */
function resolveSchema(schema: OpenAPISchema | undefined, spec: OpenAPISpec): OpenAPISchema | undefined {
  if (!schema) return undefined;
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, spec);
    return resolved as OpenAPISchema | undefined;
  }
  return schema;
}

/**
 * Converts an OpenAPI schema to a Zod schema.
 */
export function schemaToZod(schema: OpenAPISchema | undefined, spec: OpenAPISpec, required = false): z.ZodTypeAny {
  const resolved = resolveSchema(schema, spec);

  if (!resolved) {
    return required ? z.unknown() : z.unknown().optional();
  }

  let zodType: z.ZodTypeAny;

  if (resolved.enum) {
    zodType = buildEnumZodType(resolved.enum);
  } else {
    switch (resolved.type) {
      case "string":
        zodType = z.string();
        if (resolved.description) {
          zodType = (zodType as z.ZodString).describe(resolved.description);
        }
        break;
      case "number":
      case "integer":
        zodType = z.number();
        if (resolved.description) {
          zodType = (zodType as z.ZodNumber).describe(resolved.description);
        }
        break;
      case "boolean":
        zodType = z.boolean();
        if (resolved.description) {
          zodType = (zodType as z.ZodBoolean).describe(resolved.description);
        }
        break;
      case "array":
        zodType = z.array(schemaToZod(resolved.items, spec, true));
        if (resolved.description) {
          zodType = (zodType as z.ZodArray<z.ZodTypeAny>).describe(resolved.description);
        }
        break;
      case "object": {
        const shape: Record<string, z.ZodTypeAny> = {};
        const requiredFields = resolved.required ?? [];
        if (resolved.properties) {
          for (const [key, propSchema] of Object.entries(resolved.properties)) {
            const isRequired = requiredFields.includes(key);
            shape[key] = schemaToZod(propSchema, spec, isRequired);
          }
        }
        zodType = z.object(shape);
        if (resolved.description) {
          zodType = (zodType as z.ZodObject<z.ZodRawShape>).describe(resolved.description);
        }
        break;
      }
      default:
        zodType = z.unknown();
    }
  }

  if (!required && resolved.type !== "object") {
    zodType = zodType.optional();
  }

  return zodType;
}

/**
 * Extracts all operations from an OpenAPI spec.
 */
export function extractOperations(spec: OpenAPISpec): ParsedOperation[] {
  const operations: ParsedOperation[] = [];
  const paths = spec.paths ?? {};

  const httpMethods: HttpMethod[] = ["get", "post", "put", "patch", "delete", "head", "options"];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;

    // Path-level parameters apply to all operations in the path
    const pathLevelParams = pathItem.parameters ?? [];

    for (const method of httpMethods) {
      const operation = pathItem[method];
      if (!operation) continue;
      if (operation.deprecated) continue;

      // Merge path-level params with operation-level params (operation-level takes precedence)
      const mergedParams = mergeParameters(pathLevelParams, operation.parameters ?? []);

      // Resolve any $ref parameters
      const resolvedParams = mergedParams.map((p) => {
        if (hasRef(p)) {
          const resolved = resolveRef(p.$ref, spec) as OpenAPIParameter | undefined;
          return resolved ?? p;
        }
        return p;
      });

      const operationId = operation.operationId ?? generateOperationId(method, path);

      operations.push({
        method,
        path,
        operationId,
        summary: operation.summary ?? operation.operationId ?? `${method.toUpperCase()} ${path}`,
        description: operation.description ?? operation.summary ?? `${method.toUpperCase()} ${path}`,
        parameters: resolvedParams,
        requestBody: operation.requestBody,
      });
    }
  }

  return operations;
}

/**
 * Merges path-level and operation-level parameters, giving precedence to operation-level.
 */
function mergeParameters(pathParams: OpenAPIParameter[], opParams: OpenAPIParameter[]): OpenAPIParameter[] {
  const merged = [...pathParams];
  for (const opParam of opParams) {
    const existingIdx = merged.findIndex((p) => p.name === opParam.name && p.in === opParam.in);
    if (existingIdx >= 0) {
      merged[existingIdx] = opParam;
    } else {
      merged.push(opParam);
    }
  }
  return merged;
}

/**
 * Generates an operation ID from method and path when none is provided.
 */
function generateOperationId(method: string, path: string): string {
  const sanitized = path
    .replace(/^\//, "")
    .replace(/\//g, "_")
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9_]/g, "_");
  return `${method}_${sanitized}`;
}

/**
 * Builds a Zod parameter schema for an operation's parameters.
 */
export function buildParameterSchema(
  operation: ParsedOperation,
  spec: OpenAPISpec
): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const param of operation.parameters) {
    const zodType = schemaToZod(param.schema, spec, param.required ?? false);
    const withDescription = param.description
      ? zodType.describe(param.description)
      : zodType;
    shape[param.name] = withDescription;
  }

  // Add request body parameters if present
  if (operation.requestBody) {
    const content = operation.requestBody.content;
    if (content) {
      const jsonContent = content["application/json"];
      if (jsonContent?.schema) {
        const bodySchema = resolveSchema(jsonContent.schema, spec);
        if (bodySchema?.type === "object" && bodySchema.properties) {
          const requiredFields = bodySchema.required ?? [];
          for (const [key, propSchema] of Object.entries(bodySchema.properties)) {
            const isRequired = operation.requestBody.required === true && requiredFields.includes(key);
            const zodPropType = schemaToZod(propSchema, spec, isRequired);
            const withDescription = propSchema.description
              ? zodPropType.describe(propSchema.description)
              : zodPropType;
            shape[key] = withDescription;
          }
        } else {
          // Treat the whole body as a single "body" parameter
          const bodyRequired = operation.requestBody.required ?? false;
          const zodBodyType = schemaToZod(jsonContent.schema, spec, bodyRequired);
          const description = operation.requestBody.description ?? "Request body";
          shape["body"] = zodBodyType.describe(description);
        }
      }
    }
  }

  return z.object(shape);
}

/**
 * Returns the base URL from the spec's servers array.
 */
export function getBaseUrl(spec: OpenAPISpec, overrideBaseUrl?: string): string {
  if (overrideBaseUrl) return overrideBaseUrl;
  const firstServer = spec.servers?.[0];
  return firstServer?.url ?? "";
}
