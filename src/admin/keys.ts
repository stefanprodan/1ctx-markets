// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The admin's agent keys: a made key's token is answered once and joins
// the log mask first; a list or a log line names a key, never its token.

import { json, NO_STORE, problem } from "../api/http.ts";
import { iso } from "../market/format.ts";
import { ArgError, fields } from "../operations/args.ts";
import type { Markets } from "../operations/markets.ts";
import {
  createKey,
  isKeyId,
  isKeyName,
  KEY_DAYS,
  KeyConflict,
  type KeyDays,
  type KeyRow,
  listKeys,
  MAX_KEYS,
  MAX_NAME,
  MIN_NAME,
  PORTFOLIO_ACCESS,
  type PortfolioAccess,
  revokeKey,
} from "../server/access.ts";

export type KeysDeps = {
  m: Markets;
  // hides a made token from every later log line
  mask: (token: string) => void;
};

export const keyItem = (k: KeyRow) => ({
  id: k.id,
  name: k.name,
  created_at: iso(k.createdAt),
  last_used_at: k.lastUsedAt === null ? null : iso(k.lastUsedAt),
  expires_at: k.expiresAt === null ? null : iso(k.expiresAt),
  portfolio: k.portfolio,
});

export const listAnswer = (m: Markets) =>
  json({ keys: listKeys(m.db).map(keyItem), limit: MAX_KEYS });

function parseCreate(body: unknown): {
  name: string;
  days: KeyDays | null;
  portfolio: PortfolioAccess;
} {
  const b = fields(body, ["name", "expiresInDays", "portfolio"]);
  if (!isKeyName(b.name)) {
    throw new ArgError(
      `name is ${MIN_NAME} to ${MAX_NAME} lowercase letters, digits, dashes and underscores, starting with a letter or digit`,
    );
  }
  const days = b.expiresInDays ?? null;
  if (days !== null && !(KEY_DAYS as readonly unknown[]).includes(days)) {
    throw new ArgError(`expiresInDays is null, ${KEY_DAYS.join(", ")}`);
  }
  const portfolio = b.portfolio ?? "none";
  if (!(PORTFOLIO_ACCESS as readonly unknown[]).includes(portfolio)) {
    throw new ArgError(`portfolio is ${PORTFOLIO_ACCESS.join(", ")}`);
  }
  return {
    name: b.name,
    days: days as KeyDays | null,
    portfolio: portfolio as PortfolioAccess,
  };
}

export async function createOne(d: KeysDeps, body: unknown) {
  const args = parseCreate(body);
  let made: { key: KeyRow; token: string };
  try {
    made = await d.m.writer.write((db) => createKey(db, args, d.m.clock.now()));
  } catch (error) {
    if (error instanceof KeyConflict) return problem("conflict", error.message);
    throw error;
  }
  d.mask(made.token);
  d.m.log.info("key created", {
    key: made.key.id,
    key_name: made.key.name,
  });
  return json({ key: keyItem(made.key), token: made.token }, 201);
}

export async function revokeOne(d: KeysDeps, id: string) {
  const gone = isKeyId(id)
    ? await d.m.writer.write((db) => revokeKey(db, id))
    : null;
  if (gone === null) return problem("not_found", "no such key");
  d.m.log.info("key revoked", { key: gone.id, key_name: gone.name });
  return new Response(null, { status: 204, headers: NO_STORE });
}
