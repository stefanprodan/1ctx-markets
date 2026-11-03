// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The code step's boxes, one per digit, kept apart from the page so they
// can be tried without a browser. The code is held as its digits in
// order, never with gaps.

export const DIGITS = 6;

// the code after digits typed or pasted into box `at`, and the box to
// focus next; null when nothing was a digit
export function put(
  value: string,
  at: number,
  typed: string,
): { value: string; focus: number } | null {
  const digits = typed.replace(/\D/g, "");
  if (digits === "") return null;
  // a whole code, pasted or filled by the system, fills every box;
  // fewer digits go from the box they landed in, never past the first
  // empty one
  const from =
    digits.length >= DIGITS ? 0 : Math.min(at, value.length, DIGITS - 1);
  const next = value.split("");
  for (let k = 0; k < digits.length && from + k < DIGITS; k++) {
    next[from + k] = digits[k]!;
  }
  const joined = next.join("").slice(0, DIGITS);
  return {
    value: joined,
    focus: Math.min(from + digits.length, DIGITS - 1),
  };
}

// what a box's input event typed: one new digit beside the box's old one
// is typing over it, on either side of it as the caret was; more is a
// paste or the system's fill
export function typedIn(old: string | undefined, raw: string): string {
  const typed = raw.replace(/\D/g, "");
  if (typed.length !== 2 || !old) return typed;
  return typed[1] === old ? typed[0]! : typed[1]!;
}

// Backspace in box `i`: its own digit goes, or the one before when it is
// empty; null at the first box with nothing to erase
export function erase(
  value: string,
  i: number,
): { value: string; focus: number } | null {
  const at = value[i] ? i : Math.min(i, value.length) - 1;
  if (at < 0) return null;
  return { value: value.slice(0, at) + value.slice(at + 1), focus: at };
}

// the one line under the boxes, which always holds something so its
// height never changes
export function sayLine(s: {
  checking: boolean;
  error: string | null;
  resent: boolean;
  email: string;
}): string {
  if (s.checking) return "Signing in";
  if (s.error !== null) return s.error;
  return `${s.resent ? "New code sent" : "Sent"} to ${s.email}`;
}

// the code was taken and the login opened, but who it is could not be
// read: the page reads it again, never the code, which is used
export const UNREAD = "Couldn't load.";

export type Outcome =
  | { kind: "in" }
  // the code refused, or the login it opened gone: a new code is asked
  | { kind: "wrong"; error: unknown }
  // the code taken, but who it is not read: Try again reads it again
  | { kind: "unread" };

// a code's way to a sign-in. Once the code is taken a retry reads who is
// signed in and never posts the used code; a new code or another email
// starts over
export function codeFlow(d: {
  // posts the code; landed runs once it is taken
  post: (code: string, landed: () => void) => Promise<void>;
  // reads who is signed in: a person, nobody, or no answer
  read: () => Promise<"in" | "nobody" | "failed">;
}) {
  let accepted = false;
  return {
    accepted: () => accepted,
    reset(): void {
      accepted = false;
    },
    async submit(code: string): Promise<Outcome> {
      if (accepted) return this.retry();
      try {
        await d.post(code, () => {
          accepted = true;
        });
        return { kind: "in" };
      } catch (error) {
        return accepted ? { kind: "unread" } : { kind: "wrong", error };
      }
    },
    async retry(): Promise<Outcome> {
      const r = await d.read();
      if (r === "in") return { kind: "in" };
      if (r === "failed") return { kind: "unread" };
      // the login went meanwhile: the used code is no good, a new one is
      accepted = false;
      return { kind: "wrong", error: null };
    },
  };
}

// the longest the line under the boxes says for an address, held in its
// place whatever it says, so the card never changes height
export const holdLine = (email: string): string => `New code sent to ${email}`;

// a call dropped while one is still running, so the sixth digit typed
// and a fill landing together sign in once
export function oneAtATime<A extends unknown[]>(
  run: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    try {
      await run(...args);
    } finally {
      running = false;
    }
  };
}
