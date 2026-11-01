// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  fromJsonSchema,
  type JsonSchemaType,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import type { ToolResult } from "../operations/answer.ts";
import { MAX_SYMBOL } from "../operations/args.ts";
import type { Who } from "../operations/who.ts";

// the tools check their own arguments, with errors in their own words
const permissive = {
  getValidator: () => (input: unknown) => ({
    valid: true as const,
    data: input,
    errorMessage: undefined,
  }),
} as unknown as jsonSchemaValidator;

export const schema = (
  properties: Record<string, JsonSchemaType>,
  required: string[],
) =>
  fromJsonSchema<Record<string, unknown>>(
    {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    permissive,
  );

export const symbol: JsonSchemaType = {
  type: "string",
  minLength: 1,
  maxLength: MAX_SYMBOL,
};
export const next: JsonSchemaType = {
  type: "string",
  description: "the next of an earlier answer, with the same arguments",
};
export const day: JsonSchemaType = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
};

export type Tool = {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof schema>;
  run: (input: unknown, who?: Who) => Promise<ToolResult>;
  // read-only unless said otherwise
  writes?: true;
};
