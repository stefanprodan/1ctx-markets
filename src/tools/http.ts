// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// GET /quotes for scripts: the quote reader's smaller projection as
// JSON, with the same resolution, tracking, deadline and pages.

import { errorFields } from "../log.ts";
import { ArgError, quoted } from "./args.ts";
import { briefItem, parseQuote, quotePage } from "./quote.ts";
import type { Markets } from "./targets.ts";

const ARGS = ["symbols", "next"];

const json = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      // a quote is live: no proxy or client may answer it again
      "cache-control": "no-store",
    },
  });

const failed = (status: number, error: string, message: string) =>
  json(JSON.stringify({ error, message }), status);

// symbols is one comma-separated list, as a shell script builds it
export function quotesHandler(m: Markets): (req: Request) => Promise<Response> {
  return async (req) => {
    const params = new URL(req.url).searchParams;
    try {
      for (const name of params.keys()) {
        if (!ARGS.includes(name))
          throw new ArgError(`unknown argument ${quoted(name)}`);
      }
      if (params.getAll("symbols").length !== 1) {
        throw new ArgError("symbols must be given once, comma-separated");
      }
      const args = parseQuote({
        symbols: params.get("symbols")!.split(","),
        ...(params.has("next") ? { next: params.get("next") } : {}),
      });
      const page = await quotePage(m, args, (item, latest) =>
        briefItem(m.db, item, latest),
      );
      return json(page, 200);
    } catch (error) {
      if (error instanceof ArgError) {
        return failed(400, "bad_arguments", error.message);
      }
      m.log.error("quotes failed", errorFields(error));
      return failed(500, "internal", "internal error");
    }
  };
}
