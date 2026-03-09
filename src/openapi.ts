import type { OpenAPIV3 } from "openapi-types";
import { z } from "zod";

export type { OpenAPIV3 };

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

export interface Tool {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  method: string;
  path: string;
  pathParams: string[];
  bodyKeys: string[];
}

function toZod(schema: OpenAPIV3.SchemaObject, required = false): z.ZodTypeAny {
  let type: z.ZodTypeAny;

  if (schema.enum) {
    const vals = schema.enum as string[];
    type =
      vals.length >= 2 && vals.every((v) => typeof v === "string")
        ? z.enum(vals as [string, ...string[]])
        : z.unknown();
  } else {
    switch (schema.type) {
      case "string":   type = z.string();  break;
      case "number":
      case "integer":  type = z.number();  break;
      case "boolean":  type = z.boolean(); break;
      case "array":    type = z.array(toZod((schema as OpenAPIV3.ArraySchemaObject).items as OpenAPIV3.SchemaObject, true)); break;
      case "object":   type = z.object(
        Object.fromEntries(
          Object.entries(schema.properties ?? {}).map(([k, v]) => [
            k,
            toZod(v as OpenAPIV3.SchemaObject, (schema.required ?? []).includes(k)),
          ])
        )
      ); break;
      default: type = z.unknown(); break;
    }
  }

  if (schema.description) type = type.describe(schema.description);
  return required ? type : type.optional();
}

export function extractTools(doc: OpenAPIV3.Document): Tool[] {
  return Object.entries(doc.paths ?? {}).flatMap(([path, item]) => {
    const pathItem = item as OpenAPIV3.PathItemObject;
    const sharedParams = (pathItem.parameters ?? []) as OpenAPIV3.ParameterObject[];

    return METHODS.flatMap((method) => {
      const op = pathItem[method as OpenAPIV3.HttpMethods];
      if (!op || op.deprecated) return [];

      const params = [...sharedParams, ...(op.parameters ?? []) as OpenAPIV3.ParameterObject[]]
        .reduce<OpenAPIV3.ParameterObject[]>((acc, p) => {
          const i = acc.findIndex((x) => x.name === p.name && x.in === p.in);
          if (i >= 0) acc[i] = p; else acc.push(p);
          return acc;
        }, []);

      const shape = Object.fromEntries(
        params.map((p) => [
          p.name,
          toZod((p.schema ?? {}) as OpenAPIV3.SchemaObject, p.required ?? false).describe(p.description ?? ""),
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
        method,
        path,
        pathParams: params.filter((p) => p.in === "path").map((p) => p.name),
        bodyKeys,
      }];
    });
  });
}

export function getBaseUrl(doc: OpenAPIV3.Document, override?: string): string {
  return override ?? doc.servers?.[0]?.url ?? "";
}
