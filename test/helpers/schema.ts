// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An unknown keyword is refused, not skipped; description checks nothing.

const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "oneOf",
  "$ref",
  "description",
]);

const TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function schemaErrors(schema: unknown, at = "#"): string[] {
  if (!isObject(schema)) return [`${at}: a schema is an object`];
  const out: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) out.push(`${at}: keyword ${key} is not supported`);
  }
  const t = schema.type;
  if (t !== undefined) {
    const types = Array.isArray(t) ? t : [t];
    if (types.length === 0 || !types.every((x) => TYPES.has(x as string))) {
      out.push(`${at}: type ${JSON.stringify(t)}`);
    }
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) out.push(`${at}: properties`);
    else {
      for (const [k, v] of Object.entries(schema.properties)) {
        out.push(...schemaErrors(v, `${at}/properties/${k}`));
      }
    }
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      !schema.required.every((r) => typeof r === "string"))
  ) {
    out.push(`${at}: required`);
  }
  const extra = schema.additionalProperties;
  if (extra !== undefined && typeof extra !== "boolean") {
    out.push(...schemaErrors(extra, `${at}/additionalProperties`));
  }
  if (schema.items !== undefined) {
    out.push(...schemaErrors(schema.items, `${at}/items`));
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    out.push(`${at}: enum`);
  }
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) {
      out.push(`${at}: oneOf is a list of two or more schemas`);
    } else {
      for (const [k, v] of schema.oneOf.entries()) {
        out.push(...schemaErrors(v, `${at}/oneOf/${k}`));
      }
    }
  }
  if (
    schema.description !== undefined &&
    typeof schema.description !== "string"
  ) {
    out.push(`${at}: description`);
  }
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string" || Object.keys(schema).length > 1) {
      out.push(`${at}: $ref stands alone`);
    }
  }
  return out;
}

function resolve(root: unknown, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`not a local $ref: ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isObject(node) || !(part in node)) {
      throw new Error(`unresolved $ref: ${ref}`);
    }
    node = node[part];
  }
  return node as Schema;
}

const typeOf = (v: unknown): string =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "array"
      : typeof v === "number"
        ? Number.isInteger(v)
          ? "integer"
          : "number"
        : typeof v;

export function validate(
  value: unknown,
  schema: Schema,
  root: unknown,
  at = "$",
): string[] {
  const bad = schemaErrors(schema);
  if (bad.length > 0) return bad;
  if (schema.$ref !== undefined) {
    return validate(value, resolve(root, schema.$ref as string), root, at);
  }
  if (schema.oneOf !== undefined) {
    const branches = (schema.oneOf as Schema[]).map((b) =>
      validate(value, b, root, at),
    );
    const matched = branches.filter((b) => b.length === 0).length;
    if (matched !== 1) {
      return [
        `${at}: matches ${matched} of oneOf's ${branches.length}`,
        ...(matched === 0 ? branches.flat() : []),
      ];
    }
  }
  const out: string[] = [];
  if (schema.type !== undefined) {
    const types = (
      Array.isArray(schema.type) ? schema.type : [schema.type]
    ) as string[];
    const t = typeOf(value);
    const fits =
      types.includes(t) || (t === "integer" && types.includes("number"));
    if (!fits) return [`${at}: ${t}, not ${types.join(" or ")}`];
  }
  if (
    schema.enum !== undefined &&
    !(schema.enum as unknown[]).includes(value as never)
  ) {
    out.push(`${at}: ${JSON.stringify(value)} not in enum`);
  }
  if (isObject(value)) {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) {
      if (!(r in value)) out.push(`${at}: missing ${r}`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (k in props) {
        out.push(...validate(v, props[k]!, root, `${at}.${k}`));
      } else if (schema.additionalProperties === false) {
        out.push(`${at}: unexpected ${k}`);
      } else if (isObject(schema.additionalProperties)) {
        out.push(
          ...validate(v, schema.additionalProperties, root, `${at}.${k}`),
        );
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [k, v] of value.entries()) {
      out.push(...validate(v, schema.items as Schema, root, `${at}[${k}]`));
    }
  }
  return out;
}

export function specSchemas(spec: any): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [name, s] of Object.entries(spec.components?.schemas ?? {})) {
    out.push([`components.schemas.${name}`, s]);
  }
  const media = (where: string, content: any) => {
    for (const [type, m] of Object.entries(content ?? {})) {
      if ((m as any).schema !== undefined) {
        out.push([`${where} ${type}`, (m as any).schema]);
      }
    }
  };
  for (const [name, r] of Object.entries(spec.components?.responses ?? {})) {
    media(`components.responses.${name}`, (r as any).content);
  }
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const ops = Object.entries(item as object);
    for (const p of (item as any).parameters ?? []) {
      out.push([`${path} parameter ${p.name}`, p.schema]);
    }
    for (const [method, op] of ops) {
      if (method === "parameters") continue;
      const where = `${method.toUpperCase()} ${path}`;
      for (const p of op.parameters ?? []) {
        out.push([`${where} parameter ${p.name}`, p.schema]);
      }
      media(`${where} body`, op.requestBody?.content);
      for (const [status, r] of Object.entries(op.responses ?? {})) {
        media(`${where} ${status}`, (r as any).content);
        for (const [h, header] of Object.entries((r as any).headers ?? {})) {
          out.push([`${where} ${status} header ${h}`, (header as any).schema]);
        }
      }
    }
  }
  return out;
}

export function answerSchema(
  spec: any,
  method: string,
  path: string,
  status: number,
): Schema | null {
  const op = spec.paths[path]?.[method.toLowerCase()];
  if (op === undefined) throw new Error(`no operation ${method} ${path}`);
  let r = op.responses[String(status)];
  if (r === undefined) return null;
  if (r.$ref !== undefined) r = resolve(spec, r.$ref);
  return r.content?.["application/json"]?.schema ?? null;
}
