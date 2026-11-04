// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A symbol's shared analysis: its calls and signals, one store per page.

import type { Call } from "./api.ts";
import { documentStore } from "./document.ts";

export const analysisPath = (id: string) =>
  `/api/v1/instruments/${encodeURIComponent(id)}/analysis`;

export type SinceWritten = {
  change_percent: number | null;
  earnings: { date: string; status: string }[];
} | null;

export type AnalysisAnswer = {
  text: string | null;
  html: string | null;
  revision: number | null;
  author: string | null;
  written_at: string | null;
  bytes: number | null;
  since_written: SinceWritten;
};

export type AnalysisStore = ReturnType<typeof analysisStore>;

export const analysisStore = (call: Call, session: () => number, id: string) =>
  documentStore<AnalysisAnswer>(call, session, analysisPath(id));
