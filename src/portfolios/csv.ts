// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// RFC 4180 as spreadsheets write it: quotes, doubled quotes, CRLF, a BOM.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.startsWith("﻿") ? text.slice(1) : text;
  for (let k = 0; k < s.length; k++) {
    const c = s[k]!;
    if (quoted) {
      if (c === '"') {
        if (s[k + 1] === '"') {
          cell += '"';
          k++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[k + 1] === "\n") k++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // a blank line is no row
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const field = (v: string): string =>
  /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

export const formatCsv = (rows: readonly (readonly string[])[]): string =>
  `${rows.map((r) => r.map(field).join(",")).join("\r\n")}\r\n`;

// a plain number, thousands commas allowed only with a dot decimal form
export function parseNumber(raw: string): number | null | "bad" {
  const t = raw.trim().replace(/\s+/g, "");
  if (t === "") return null;
  const plain = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)
    ? t.replace(/,/g, "")
    : t;
  if (!/^-?\d+(\.\d+)?$/.test(plain) && !/^-?\.\d+$/.test(plain)) return "bad";
  const n = Number(plain);
  return Number.isFinite(n) ? n : "bad";
}

const valid = (y: number, m: number, d: number): string | null => {
  const at = new Date(Date.UTC(y, m - 1, d));
  if (
    at.getUTCFullYear() !== y ||
    at.getUTCMonth() !== m - 1 ||
    at.getUTCDate() !== d
  ) {
    return null;
  }
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(y, 4)}-${p(m)}-${p(d)}`;
};

// YYYY-MM-DD, Yahoo's YYYYMMDD, or a day-first D.M.YYYY; a slash is
// refused, since day and month first both write it
// month: a bare YYYY-MM reads as that month's last day, as a fund's price
// from a month-end bulletin is stated
export function parseDay(raw: string, month = false): string | null | "bad" {
  const t = raw.trim();
  if (t === "") return null;
  const ym = month ? /^(\d{4})-(\d{2})$/.exec(t) : null;
  if (ym) {
    const y = Number(ym[1]);
    const mo = Number(ym[2]);
    if (mo < 1 || mo > 12) return "bad";
    return valid(y, mo, new Date(Date.UTC(y, mo, 0)).getUTCDate()) ?? "bad";
  }
  let m =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(t) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3])) ?? "bad";
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (m) return valid(Number(m[3]), Number(m[2]), Number(m[1])) ?? "bad";
  return "bad";
}
