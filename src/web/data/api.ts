// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

// the server's errors are fixed phrases written for an operator to read
export function statusWords(status: number): string {
  if (status === 0) return "the server did not answer";
  if (status === 401) return "signed out";
  if (status === 403) return "forbidden";
  if (status === 404) return "not found";
  if (status >= 500) return "the server failed";
  return "refused";
}

export function failure(status: number, body: unknown): ApiError {
  const message =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string" &&
    status !== 401 &&
    status < 500
      ? body.message
      : statusWords(status);
  return new ApiError(status, message, body);
}

export type Call = <T>(
  path: string,
  method?: string,
  body?: unknown,
) => Promise<T>;

export function client(fetchFn: Fetch, onUnauthorized: () => void): Call {
  return async <T>(path: string, method = "GET", body?: unknown) => {
    let res: Response;
    try {
      res = await fetchFn(path, {
        method,
        credentials: "same-origin",
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw failure(0, null);
    }
    const data: unknown =
      res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 401) onUnauthorized();
    if (!res.ok) throw failure(res.status, data);
    return data as T;
  };
}

// 1ctx's: a capital and a full stop, whatever the server's phrase
export function sentence(text: string): string {
  const t = text.trim();
  if (t === "") return t;
  const upper = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(upper) ? upper : `${upper}.`;
}

export const says = (error: unknown): string =>
  sentence(error instanceof Error ? error.message : statusWords(0));
