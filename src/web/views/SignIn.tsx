// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Sign in by emailed code, passkey or admin key; the way picked is kept.
// Every emailed sign-in ends on a step that adds a passkey or skips.

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import {
  type AssertionJSON,
  cancelled,
  passkeyWords,
  UNKNOWN_PASSKEY,
} from "../app/Passkeys.model.ts";
import { dropSignedIn } from "../app/Passkeys.tsx";
import { navigate } from "../app/router.ts";
import { ApiError, says } from "../data/api.ts";
import type { Store } from "../data/store.ts";
import { Icon, type IconName, Mark, Wordmark } from "../lib/icons.tsx";
import { Card } from "../ui/Card.tsx";
import { MenuButton, type MenuItem } from "../ui/Menu.tsx";
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

type Step = "email" | "code" | "key" | "passkey";
type Way = "email" | "passkey" | "key";

const KEPT_WAY = "markets-sign-in";

function keptWay(): Way | null {
  try {
    const v = localStorage.getItem(KEPT_WAY);
    return v === "email" || v === "passkey" || v === "key" ? v : null;
  } catch {
    return null;
  }
}

function keepWay(way: Way) {
  try {
    localStorage.setItem(KEPT_WAY, way);
  } catch {}
}

// the way a sign-in goes, from what the server and browser offer
export function wayOf(picked: Step, emailOn: boolean, passkeys: boolean): Step {
  if (picked === "passkey" && !passkeys) return emailOn ? "email" : "key";
  if (!emailOn && (picked === "email" || picked === "code")) return "key";
  return picked;
}

const WAYS: { way: Way; label: string; icon: IconName }[] = [
  { way: "email", label: "Email code", icon: "mail" },
  { way: "passkey", label: "Passkey", icon: "key" },
  { way: "key", label: "Admin key", icon: "shield" },
];

// the one button a step has, and beside it the menu of its other actions
function Action({
  children,
  disabled,
  onClick,
  items,
  label = "Ways to sign in",
  menuDisabled = disabled,
  working = false,
  goRef,
}: {
  children: ComponentChildren;
  disabled: boolean;
  // none: the form's submit
  onClick?: () => void;
  // none: no menu
  items: MenuItem[];
  label?: string;
  menuDisabled?: boolean;
  // something on its way: the arrow turns to a spinner
  working?: boolean;
  goRef?: { current: HTMLButtonElement | null };
}) {
  return (
    <div class="signin-action">
      <button
        ref={goRef}
        type={onClick === undefined ? "submit" : "button"}
        class="btn btn-primary signin-go"
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
      {items.length > 0 && (
        <MenuButton
          label={label}
          icon="chevron"
          head
          buttonClass="btn-primary signin-pick"
          menuClass="menu-pop-field"
          disabled={menuDisabled}
          items={items}
          face={
            working ? (
              <span class="spinner signin-spin" aria-hidden="true" />
            ) : undefined
          }
        />
      )}
    </div>
  );
}

// keeps its height, so nothing moves when it shows
function Said({ error }: { error: string | null }) {
  return (
    <p class="signin-say error" role="alert">
      {error ?? ""}
    </p>
  );
}

function Frame({ children }: { children: ComponentChildren }) {
  return (
    <main class="signin">
      <div class="signin-brand">
        <Mark size={64} />
        <div class="signin-name">
          <Wordmark height={26} />
          <p class="signin-line">Markets</p>
        </div>
      </div>
      {children}
    </main>
  );
}

// signed in already: the landing waits behind it until added or skipped
export function PasskeyStep({ store }: { store: Store }) {
  const p = store.passkeys;
  useEffect(() => p.prime("add"), [p]);
  return (
    <Frame>
      <Card class="signin-card">
        <div class="signin-form">
          <div class="signin-step">
            <span class="signin-step-title">
              <Icon name="key" size={16} />
              Sign in faster next time
            </span>
            <p class="signin-hint faint">
              Use Face ID, Touch ID or your password manager instead of a code.
            </p>
          </div>
          <Said error={p.error.value} />
          <button
            type="button"
            class="btn btn-primary"
            disabled={p.busy.value || p.waiting("add")}
            onClick={() => void p.add()}
          >
            {p.busy.value ? "Adding" : "Add a passkey"}
          </button>
          <button
            type="button"
            class="btn-text signin-skip"
            disabled={p.busy.value}
            onClick={() => {
              p.error.value = null;
              p.step.value = false;
            }}
          >
            Skip
          </button>
        </div>
      </Card>
    </Frame>
  );
}

// opening: the step to start on, as a render of a later step needs
export function SignIn({ store, opening }: { store: Store; opening?: Step }) {
  const emailOn = store.emailOn.value;
  const chosen = useSignal<Step>(opening ?? keptWay() ?? "email");
  const support = store.passkeys.support.value;
  const step = wayOf(chosen.value, emailOn, support);
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
  // a refused passkey is not offered again this visit
  const refused = useSignal(false);
  // the email and key fields' autofill; not mid-code, where the boxes
  // hold the person's attention
  const fill =
    support &&
    store.passkeys.autofill.value &&
    !refused.value &&
    (step === "email" || step === "key");
  useEffect(
    // options in hand before any tap, the menu's Passkey included; the
    // autofill primes its own
    () =>
      support && step !== "code" && !fill
        ? store.passkeys.prime("sign_in")
        : undefined,
    [support, step, fill, store],
  );
  useEffect(
    () =>
      fill
        ? store.passkeys.listen((answer) => {
            // its challenge is spent: a busy card holds it again on new options
            if (busy.peek() || sending.peek()) store.passkeys.signInFailed();
            else void signInByPasskey(answer);
          })
        : undefined,
    [fill, store],
  );

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

  // answer: the autofill's; else the browser is asked before any await,
  // inside the tap
  async function signInByPasskey(answer?: AssertionJSON) {
    if (busy.value || sending.value) return;
    const signing = store.signInByPasskey((to) => navigate(to, true), answer);
    dropSignedIn();
    busy.value = true;
    error.value = null;
    try {
      await signing;
    } catch (err) {
      const words = passkeyWords(err, false);
      if (!cancelled(err)) refused.value = true;
      // gone from the account: the way it was kept on goes with it
      if (
        err instanceof ApiError &&
        err.code === UNKNOWN_PASSKEY &&
        chosen.peek() === "passkey"
      ) {
        const back: Way = emailOn ? "email" : "key";
        keepWay(back);
        go(back);
      }
      error.value = words;
    } finally {
      busy.value = false;
    }
  }

  const submitKey = async (event: Event) => {
    event.preventDefault();
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    dropSignedIn();
    try {
      await store.signIn(key.value);
      key.value = "";
    } catch (err) {
      error.value = says(err);
    } finally {
      busy.value = false;
    }
  };

  const offered: MenuItem[] = WAYS.filter(
    (w) => (w.way !== "email" || emailOn) && (w.way !== "passkey" || support),
  ).map((w) => ({
    label: w.label,
    icon: w.icon,
    checked: step === w.way,
    run: () => {
      keepWay(w.way);
      go(w.way);
      // picking Passkey asks for it in the same tap, as iOS needs
      if (w.way === "passkey") void signInByPasskey();
    },
  }));
  // one way alone needs no menu
  const ways = offered.length > 1 ? offered : [];
  const codeActions: MenuItem[] = [
    {
      label: "Send a new code",
      icon: "retry",
      run: async () => {
        go("code");
        resent.value = false;
        if (!(await send())) return;
        resent.value = true;
        codeInput.current?.focus();
      },
    },
    {
      label: "Use another email",
      icon: "pencil",
      run: () => {
        resent.value = false;
        go("email");
      },
    },
  ];

  return (
    <Frame>
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
                autocomplete={fill ? "email webauthn" : "email"}
                inputmode="email"
                disabled={sending.value}
                value={email.value}
                onInput={(e) => {
                  email.value = (e.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>
            <Said error={error.value} />
            <Action
              disabled={sending.value || busy.value}
              working={sending.value || busy.value}
              items={ways}
            >
              {sending.value ? "Sending" : "Sign in"}
            </Action>
          </form>
        )}
        {step === "passkey" && (
          <div class="signin-form">
            <p class="signin-hint faint">
              Use Face ID, Touch ID or your password manager.
            </p>
            <Said error={error.value} />
            <Action
              disabled={
                busy.value || sending.value || store.passkeys.waiting("sign_in")
              }
              onClick={() => void signInByPasskey()}
              working={busy.value || store.passkeys.waiting("sign_in")}
              items={ways}
            >
              {busy.value ? "Signing in" : "Sign in"}
            </Action>
          </div>
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
            <Action
              goRef={again}
              disabled={
                busy.value ||
                sending.value ||
                (!unread.value && code.value.length < DIGITS)
              }
              menuDisabled={busy.value || sending.value}
              working={busy.value || sending.value}
              onClick={unread.value ? () => void retry() : undefined}
              items={codeActions}
              label="More"
            >
              {unread.value
                ? "Try again"
                : busy.value
                  ? "Signing in"
                  : sending.value
                    ? "Sending"
                    : "Sign in"}
            </Action>
          </form>
        )}
        {step === "key" && (
          <form class="signin-form" onSubmit={submitKey}>
            <label class="field">
              <span class="label">Admin key</span>
              <input
                name="key"
                type="password"
                autocomplete={
                  fill ? "current-password webauthn" : "current-password"
                }
                value={key.value}
                onInput={(e) => {
                  key.value = (e.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>
            <Said error={error.value} />
            <Action disabled={busy.value} working={busy.value} items={ways}>
              Sign in
            </Action>
          </form>
        )}
      </Card>
    </Frame>
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
