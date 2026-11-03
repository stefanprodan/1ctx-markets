// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The one file that imports nodemailer: one message over one connection,
// and its error turned into a closed word. Certificates are always
// verified. Addresses go in as objects, never strings it would parse, and a
// header value with a control character is refused here, so safety does
// not rest on the package.

import { createTransport } from "nodemailer";

export const SECURITY = ["tls", "starttls"] as const;
export type Security = (typeof SECURITY)[number];

// 1ctx's words: the only thing a log line says of a failed send
export const FAILURES = [
  "auth",
  "tls",
  "connect",
  "rejected",
  "timeout",
  "other",
] as const;
export type Failure = (typeof FAILURES)[number];

export type Address = { name: string; address: string };

export type SmtpServer = {
  host: string;
  port: number;
  security: Security;
  username: string | null;
  password: string | null;
};

export type Outgoing = {
  from: Address;
  to: Address;
  subject: string;
  text: string;
};

// reply: the server's own words, for the admin's test email alone, since
// it can carry addresses
export type SendResult =
  | { ok: true }
  | { ok: false; failure: Failure; reply: string | null };

// what actually sends; a test passes a fake that records
export type EmailSender = (
  server: SmtpServer,
  message: Outgoing,
) => Promise<SendResult>;

export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
};

// a C0 or C1 control, DEL or a Unicode line break: a header value holding
// one could start a header of its own
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are what it refuses.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export const hasControl = (value: string): boolean => CONTROL.test(value);

export const headersProblem = (m: Outgoing): boolean =>
  [m.from.name, m.from.address, m.to.name, m.to.address, m.subject].some(
    hasControl,
  );

// nodemailer folds a socket's own error into ESOCKET; a TLS failure keeps
// the library's fields or its words, a connect keeps its syscall
const TLS_WORDS = /certificate|self.signed|ssl|tls|altname|handshake/i;

export function failureOf(error: unknown): Failure {
  const e = (error ?? {}) as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
  };
  switch (e.code) {
    case "EAUTH":
    case "ENOAUTH":
      return "auth";
    case "ETLS":
    case "EREQUIRETLS":
      return "tls";
    case "ETIMEDOUT":
      return "timeout";
    case "EENVELOPE":
    case "EMESSAGE":
      return "rejected";
    case "EDNS":
    case "ECONNECTION":
      return "connect";
    case "ESOCKET":
      if ("syscall" in e) return "connect";
      if ("library" in e || "reason" in e) return "tls";
      return typeof e.message === "string" && TLS_WORDS.test(e.message)
        ? "tls"
        : "connect";
  }
  return typeof e.responseCode === "number" && e.responseCode >= 500
    ? "rejected"
    : "other";
}

const MAX_REPLY = 300;

// one line of the server's reply, for the test email's answer
export function replyOf(error: unknown): string | null {
  const said = (error as { response?: unknown } | null)?.response;
  if (typeof said !== "string") return null;
  const line = said.replace(new RegExp(`${CONTROL.source}+`, "g"), " ");
  return line.trim().slice(0, MAX_REPLY) || null;
}

// options, for a test's server on loopback alone: a CA that replaces the
// default roots, and shorter timeouts
export function smtpSender(
  options: { ca?: string; timeouts?: Partial<typeof SMTP_TIMEOUTS> } = {},
): EmailSender {
  return async (server, message) => {
    if (headersProblem(message)) {
      return { ok: false, failure: "other", reply: null };
    }
    const transport = createTransport({
      host: server.host,
      port: server.port,
      secure: server.security === "tls",
      requireTLS: server.security === "starttls",
      ...(server.username === null || server.password === null
        ? {}
        : { auth: { user: server.username, pass: server.password } }),
      tls: {
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      },
      ...SMTP_TIMEOUTS,
      ...options.timeouts,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
    });
    try {
      await transport.sendMail({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, failure: failureOf(error), reply: replyOf(error) };
    } finally {
      transport.close();
    }
  };
}
