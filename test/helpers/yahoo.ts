// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import type { Fetch } from "../../src/source.ts";

const YAHOO = join(import.meta.dir, "..", "fixtures", "yahoo");

export type Recorded = {
  recordedAt: string;
  status: number;
  headers: Record<string, string>;
  body: any;
};

export async function recorded(name: string): Promise<Recorded> {
  return Bun.file(join(YAHOO, `${name}.json`)).json();
}

// answers each call with what route gives for its URL; a route that
// gives nothing fails the test, so no call goes unnoticed
export function fakeFetch(
  route: (url: URL) => Recorded | Promise<Recorded> | undefined,
): { fetch: Fetch; urls: URL[]; headers: Headers[] } {
  const urls: URL[] = [];
  const headers: Headers[] = [];
  const fetch: Fetch = async (raw, init) => {
    const url = new URL(raw);
    urls.push(url);
    headers.push(new Headers(init.headers));
    const answer = await route(url);
    if (answer === undefined) throw new Error(`no fixture for ${raw}`);
    const body =
      typeof answer.body === "string"
        ? answer.body
        : JSON.stringify(answer.body);
    return new Response(body, {
      status: answer.status,
      headers: answer.headers,
    });
  };
  return { fetch, urls, headers };
}

// the symbol a chart URL asks for
export const chartSymbol = (url: URL): string | null =>
  url.pathname.startsWith("/v8/finance/chart/")
    ? decodeURIComponent(url.pathname.slice("/v8/finance/chart/".length))
    : null;

export const clone = <T>(v: T): T => structuredClone(v);
