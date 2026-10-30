// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Connect agents' words and setup lines, as 1ctx's. No setup line holds a
// key: each reads KEY_ENV, so they stay on the page.

import type { AgentKey, KeyAccess } from "../data/store.ts";
import { ago } from "./Status.model.ts";

// every setup reads the key from this variable
export const KEY_ENV = "MARKETS_ACCESS_KEY";
// the name an agent knows this server by
const SERVER = "markets";

export const SHOWN_ONCE = "Copy it now; it is not shown again.";

export const EXPIRY_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Never" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "365 days" },
];

export const ACCESS_OPTIONS: { value: KeyAccess; label: string }[] = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read" },
  { value: "write", label: "Read and write" },
];

const VERB: Record<KeyAccess, string | null> = {
  none: null,
  read: "Reads",
  write: "Writes",
};

// said only for what it has, as many keys reach neither
export function accessWords(k: AgentKey): string | null {
  const said: string[] = [];
  const portfolio = VERB[k.portfolio ?? "none"];
  if (portfolio !== null) said.push(`${portfolio} portfolios`);
  const rules = VERB[k.rules ?? "none"];
  if (rules !== null) said.push(`${rules} alert rules`);
  return said.length === 0 ? null : said.join(" · ");
}

// as the server's rule, typed: a space becomes a dash, what it refuses goes
export const shapeName = (typed: string): string =>
  typed
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[_-]+/, "")
    .slice(0, 80);

export const nameReady = (name: string): boolean => name.length >= 2;

export const capLine = (limit: number): string =>
  `At most ${limit} keys, expired ones included. Revoke one to make another.`;

export const expired = (k: AgentKey, now: number): boolean =>
  k.expires_at !== null && Date.parse(k.expires_at) <= now;

// the year only when it is not this one
function day(at: string, now: number): string {
  const date = new Date(at);
  const year = date.getFullYear() !== new Date(now).getFullYear();
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
  });
}

export const usedWords = (k: AgentKey, now: number): string =>
  k.last_used_at === null ? "Never used" : `Used ${ago(k.last_used_at, now)}`;

export function expiryWords(k: AgentKey, now: number): string {
  if (k.expires_at === null) return "Never expires";
  return `${expired(k, now) ? "Expired" : "Expires"} ${day(k.expires_at, now)}`;
}

export const exportLine = (token: string): string =>
  `export ${KEY_ENV}="${token}"`;

export type Agent = "claude" | "codex" | "opencode";

export const AGENTS: { agent: Agent; label: string }[] = [
  { agent: "claude", label: "Claude Code" },
  { agent: "codex", label: "Codex" },
  { agent: "opencode", label: "OpenCode" },
];

export const mcpUrl = (origin: string): string => `${origin}/mcp`;

export type SetupLine = { label: string; text: string; hint: string };

// single quotes keep ${...} for Claude Code to read at each connection;
// double quotes would let the shell write the key into its config. The
// URL is quoted so a shell never globs an IPv6 origin's brackets.
const claudeMcp = (origin: string): string =>
  [
    `claude mcp add --transport http --scope user ${SERVER} \\`,
    `  "${mcpUrl(origin)}" \\`,
    `  --header 'Authorization: Bearer \${${KEY_ENV}}'`,
  ].join("\n");

const codexMcp = (origin: string): string =>
  [
    `[mcp_servers.${SERVER}]`,
    `url = "${mcpUrl(origin)}"`,
    `bearer_token_env_var = "${KEY_ENV}"`,
  ].join("\n");

// oauth off: /mcp has none, so a 401 must not offer a sign-in
const opencodeMcp = (origin: string): string =>
  [
    '"mcp": {',
    `  "${SERVER}": {`,
    '    "type": "remote",',
    `    "url": "${mcpUrl(origin)}",`,
    '    "headers": {',
    `      "Authorization": "Bearer {env:${KEY_ENV}}"`,
    "    },",
    '    "oauth": false',
    "  }",
    "}",
  ].join("\n");

export function setupLine(origin: string, agent: Agent): SetupLine {
  const lines: Record<Agent, SetupLine> = {
    claude: {
      label: "MCP server",
      text: claudeMcp(origin),
      hint: "For every project.",
    },
    codex: {
      label: "MCP server",
      text: codexMcp(origin),
      hint: "In ~/.codex/config.toml.",
    },
    opencode: {
      label: "MCP server",
      text: opencodeMcp(origin),
      hint: "In ~/.config/opencode/opencode.json.",
    },
  };
  return lines[agent];
}
