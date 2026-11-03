// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Sign-in by an emailed code (or the link beside it), and the admin key,
// which always works. Without email only the admin key is offered.

import { useSignal } from "@preact/signals";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { navigate } from "../app/router.ts";
import { says } from "../data/api.ts";
import type { Store } from "../data/store.ts";
import { Mark, Wordmark } from "../lib/icons.tsx";
import { Card } from "../ui/Card.tsx";
import { Notice } from "../ui/Notice.tsx";
import {
  codeFlow,
  DIGITS,
  erase,
  holdLine,
  type Outcome,
  oneAtATime,
  put,
  sayLine,
  typedIn,
  UNREAD,
} from "./SignIn.model.ts";
import "./signin.css";

type Step = "email" | "code" | "key";

export function SignIn({ store }: { store: Store }) {
  const emailOn = store.emailOn.value;
  const chosen = useSignal<Step>("email");
  const step: Step = emailOn ? chosen.value : "key";
  const email = useSignal("");
  const code = useSignal("");
  const key = useSignal("");
  const error = useSignal<string | null>(null);
  // a code refused: the boxes turn red until the next digit
  const wrong = useSignal(false);
  const busy = useSignal(false);
  const resent = useSignal(false);
  // an email on its way: the first step's button, or Send a new code
  const sending = useSignal(false);
  // the code was taken but who it is not read: Try again reads it again
  const unread = useSignal(false);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
  }, [step]);

  const flow = useMemo(
    () =>
      codeFlow({
        post: (typed, landed) =>
          store.signInByCode(email.peek(), typed, (to) => {
            landed();
            navigate(to, true);
          }),
        read: () => store.whoIs(),
      }),
    [store],
  );

  // a wrong code empties the boxes for the next try
  const land = (r: Outcome) => {
    unread.value = r.kind === "unread";
    if (r.kind === "in") return;
    busy.value = false;
    if (r.kind === "unread") {
      error.value = UNREAD;
      return;
    }
    error.value = r.error === null ? "Wrong or expired code." : says(r.error);
    wrong.value = true;
    code.value = "";
    // after the render that enables the boxes again
    setTimeout(() => codeInput.current?.focus(), 0);
  };
  const checkCode = useMemo(
    () =>
      oneAtATime(async (typed: string) => {
        busy.value = true;
        error.value = null;
        land(await flow.submit(typed));
      }),
    [flow],
  );
  const retry = useMemo(
    () =>
      oneAtATime(async () => {
        busy.value = true;
        error.value = null;
        land(await flow.retry());
      }),
    [flow],
  );
  // a new code or another email starts over
  const restart = () => {
    flow.reset();
    unread.value = false;
  };
  // the boxes were off during the read, so the focus went with them
  const again = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (unread.value && !busy.value) again.current?.focus();
  }, [unread.value, busy.value]);

  const send = async (): Promise<boolean> => {
    if (sending.value) return false;
    sending.value = true;
    try {
      await store.askLink(email.value);
      return true;
    } catch (err) {
      error.value = says(err);
      return false;
    } finally {
      sending.value = false;
    }
  };

  // any step change starts the code over
  const go = (to: Step) => {
    restart();
    code.value = "";
    error.value = null;
    wrong.value = false;
    chosen.value = to;
  };

  const submitKey = async (event: Event) => {
    event.preventDefault();
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await store.signIn(key.value);
      key.value = "";
    } catch (err) {
      error.value = says(err);
    } finally {
      busy.value = false;
    }
  };

  return (
    <main class="signin">
      <div class="signin-brand">
        <Mark size={64} />
        <div class="signin-name">
          <Wordmark height={26} />
          <p class="signin-line">Markets</p>
        </div>
      </div>
      <Card class="signin-card">
        {step === "email" && (
          <form
            class="signin-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!email.value.includes("@")) return;
              error.value = null;
              if (await send()) go("code");
            }}
          >
            <label class="field">
              <span class="label">Email</span>
              <input
                name="email"
                type="email"
                autocomplete="email"
                inputmode="email"
                disabled={sending.value}
                value={email.value}
                onInput={(e) => {
                  email.value = (e.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>
            {error.value && <Notice error>{error.value}</Notice>}
            <button
              type="submit"
              class="btn btn-primary"
              disabled={sending.value}
            >
              {sending.value ? "Sending" : "Sign in"}
            </button>
          </form>
        )}
        {step === "code" && (
          <form
            class="signin-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.value.length === DIGITS) void checkCode(code.value);
            }}
          >
            <div class="field">
              <span class="label" id="signin-code-label">
                Code
              </span>
              <CodeBoxes
                value={code.value}
                first={codeInput}
                wrong={wrong.value}
                disabled={busy.value}
                onChange={(v) => {
                  code.value = v;
                  error.value = null;
                  wrong.value = false;
                  resent.value = false;
                  // the sixth digit signs in, as code pages do
                  if (v.length === DIGITS) void checkCode(v);
                }}
              />
            </div>
            {/* one line that always keeps its height, so nothing moves */}
            <p
              class={`signin-say${error.value && !busy.value ? " error" : " faint"}`}
              role="status"
            >
              <span class="signin-say-hold" aria-hidden="true">
                {holdLine(email.value)}
              </span>
              <span>
                {sayLine({
                  checking: busy.value,
                  error: error.value,
                  resent: resent.value,
                  email: email.value,
                })}
              </span>
            </p>
            <div class="signin-alts">
              {unread.value && (
                <button
                  ref={again}
                  type="button"
                  class="btn-text"
                  disabled={busy.value}
                  onClick={() => void retry()}
                >
                  Try again
                </button>
              )}
              <button
                type="button"
                class="btn-text"
                disabled={sending.value || busy.value}
                onClick={async () => {
                  restart();
                  code.value = "";
                  error.value = null;
                  wrong.value = false;
                  resent.value = false;
                  if (!(await send())) return;
                  resent.value = true;
                  codeInput.current?.focus();
                }}
              >
                {sending.value ? "Sending" : "Send a new code"}
              </button>
              <button
                type="button"
                class="btn-text"
                disabled={sending.value || busy.value}
                onClick={() => {
                  restart();
                  code.value = "";
                  resent.value = false;
                  go("email");
                }}
              >
                Use another email
              </button>
            </div>
          </form>
        )}
        {step === "key" && (
          <form class="signin-form" onSubmit={submitKey}>
            <label class="field">
              <span class="label">Admin key</span>
              <input
                name="key"
                type="password"
                autocomplete="current-password"
                value={key.value}
                onInput={(e) => {
                  key.value = (e.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>
            {error.value && <Notice error>{error.value}</Notice>}
            <button type="submit" class="btn btn-primary" disabled={busy.value}>
              Sign in
            </button>
          </form>
        )}
      </Card>
      {emailOn && (
        <button
          type="button"
          class="btn-text signin-switch"
          disabled={sending.value || busy.value}
          onClick={() => go(step === "key" ? "email" : "key")}
        >
          {step === "key" ? "Sign in by email" : "Sign in with the admin key"}
        </button>
      )}
    </main>
  );
}

// one box per digit: typing moves on, Backspace and the arrows move, and
// a paste or the code the system offers from Mail fills every box at once
export function CodeBoxes({
  value,
  first,
  wrong,
  disabled,
  onChange,
}: {
  value: string;
  first: { current: HTMLInputElement | null };
  wrong: boolean;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  // selected too, as a box already focused gets no focus event
  const focus = (i: number) => {
    const box = boxes.current[Math.max(0, Math.min(i, DIGITS - 1))];
    box?.focus();
    box?.select();
  };
  const land = (next: { value: string; focus: number } | null) => {
    if (next === null) return;
    // focus first, so a sign-in the last digit starts can move it again
    focus(next.focus);
    onChange(next.value);
  };
  return (
    <fieldset
      class="signin-boxes"
      aria-labelledby="signin-code-label"
      disabled={disabled}
    >
      {Array.from({ length: DIGITS }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
            if (i === 0) first.current = el;
          }}
          class={`signin-box${wrong ? " signin-box-wrong" : ""}`}
          aria-label={`Digit ${i + 1}`}
          autocomplete={i === 0 ? "one-time-code" : "off"}
          inputmode="numeric"
          value={value[i] ?? ""}
          onInput={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            const typed = typedIn(value[i], el.value);
            el.value = value[i] ?? "";
            land(put(value, i, typed));
          }}
          onPaste={(e) => {
            e.preventDefault();
            land(put(value, i, e.clipboardData?.getData("text") ?? ""));
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              e.preventDefault();
              land(erase(value, i));
            } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              // the caret never moves inside a box: the next one's digit
              // is selected, so a digit typed replaces it
              e.preventDefault();
              focus(e.key === "ArrowLeft" ? i - 1 : i + 1);
            }
          }}
          onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
        />
      ))}
    </fieldset>
  );
}
