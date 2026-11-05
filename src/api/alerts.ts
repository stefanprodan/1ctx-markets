// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The alert id is the cursor, and the same alerts must answer the same bytes.

import { storedTrigger, truncatedItem } from "../operations/alerts.ts";
import {
  issuedAlertId,
  prunedAlertId,
  readAlertsAfter,
} from "../rules/store.ts";
import type { Log } from "../runtime/log.ts";
import { errorFields } from "../runtime/log.ts";
import type { Db } from "../storage/db/index.ts";
import { problem } from "./http.ts";

// strictly under: the whole body, in UTF-8 bytes
export const ALERT_PAGE_BYTES = 16 * 1024;
// more rows than any page holds
const READ_ROWS = 200;

const TAG = /^(?:W\/)?"alerts-(0|[1-9]\d{0,14})"$/;

export const etag = (id: number) => `W/"alerts-${id}"`;

const HEADERS = {
  "cache-control": "private, no-store",
};

const json = (body: string, status: number, headers = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json", ...HEADERS, ...headers },
  });

const refused = (detail: string) =>
  problem("bad_arguments", detail, {}, HEADERS);

// the cursor a check sent, null with none, undefined when malformed
function cursorOf(req: Request): number | null | undefined {
  const sent = req.headers.get("if-none-match");
  if (sent === null) return null;
  const m = TAG.exec(sent.trim());
  return m === null ? undefined : Number(m[1]);
}

type Page = {
  body: string;
  last: number;
};

// a trigger too big alone goes out without its values, so the feed never
// stalls; rows are read only as far as the page reaches
export function alertPage(
  rows: readonly {
    id: number;
    ruleId: number;
    firedAt: number;
    snapshot: string;
  }[],
  flags: Record<string, true>,
  log: Log,
): Page {
  const shell = (more: boolean) =>
    JSON.stringify({ ...flags, more, triggers: [] }).slice(0, -2);
  const bytes = (s: string) => Buffer.byteLength(s);
  const items: string[] = [];
  let size = 0;
  for (const row of rows) {
    const item = JSON.stringify(storedTrigger(row, log).item);
    const more = items.length + 1 < rows.length;
    const next = size + (items.length > 0 ? 1 : 0) + bytes(item);
    if (bytes(shell(more)) + next + 2 >= ALERT_PAGE_BYTES) break;
    size = next;
    items.push(item);
  }
  const count = items.length;
  if (count === 0 && rows.length > 0) {
    const r = rows[0]!;
    return {
      body: `${shell(rows.length > 1)}${JSON.stringify(truncatedItem(r))}]}`,
      last: r.id,
    };
  }
  return {
    body: `${shell(count < rows.length)}${items.join(",")}]}`,
    last: count > 0 ? rows[count - 1]!.id : 0,
  };
}

export function alertsHandler(deps: {
  db: Db;
  log: Log;
}): (req: Request, owner: string) => Promise<Response> {
  return async (req, owner) => {
    try {
      if ([...new URL(req.url).searchParams.keys()].length > 0) {
        return refused("the feed takes no query arguments");
      }
      const cursor = cursorOf(req);
      if (cursor === undefined) {
        return refused(
          'If-None-Match must be an ETag this endpoint answered, W/"alerts-<id>"',
        );
      }
      const issued = issuedAlertId(deps.db, owner);
      // a cursor this database never gave the owner, as after a restore:
      // start over
      const reset = cursor !== null && cursor > issued;
      const after = cursor === null || reset ? 0 : cursor;
      const rows = readAlertsAfter(deps.db, owner, after, READ_ROWS);
      // ids are never reused and only retention deletes, which keeps each
      // owner's newest pruned id, so another person's ids between the
      // owner's never read as lost
      const gap =
        cursor !== null && !reset && prunedAlertId(deps.db, owner) > cursor;
      if (rows.length === 0 && !gap) {
        if (cursor === null || reset) {
          return new Response(null, { status: 204, headers: HEADERS });
        }
        return new Response(null, {
          status: 304,
          headers: { ...HEADERS, etag: etag(cursor) },
        });
      }
      const flags: Record<string, true> = {};
      if (gap) flags.retention_gap = true;
      if (reset) flags.cursor_reset = true;
      const page = alertPage(rows, flags, deps.log);
      return json(page.body, 200, {
        etag: etag(rows.length === 0 ? issued : page.last),
      });
    } catch (error) {
      deps.log.error("alerts failed", errorFields(error));
      return problem("internal", "internal error", {}, HEADERS);
    }
  };
}
