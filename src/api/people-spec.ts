// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The people and email routes' part of the spec, for admins reading the
// docs page.

import { MAX_USER_NAME, ROLES } from "../admin/users.ts";
import { FAILURES, SECURITY } from "../server/email/smtp.ts";
import { ASKS_PER_HOUR, ASKS_PER_USER_DAY } from "../server/links.ts";
import { PROBLEM_TYPE } from "./http.ts";
import {
  bool,
  int,
  list,
  object,
  ref,
  type Schema,
  str,
  values,
} from "./schemas.ts";

const nstr: Schema = { type: ["string", "null"] };
const note = (s: Schema, description: string): Schema => ({
  ...s,
  description,
});

const ADMINS = [{ admin: [] }, { session: [] }];

const r = (name: string) => ({ $ref: `#/components/responses/${name}` });
const content = (schema: Schema) => ({ "application/json": { schema } });
const ok = (description: string, schema: Schema) => ({
  description,
  content: content(schema),
});
const err = (description: string) => ({
  description,
  content: { [PROBLEM_TYPE]: { schema: ref("Problem") } },
});
const lines = (...parts: string[]) => parts.join("\n");
const body = (schema: Schema) => ({ required: true, content: content(schema) });

const base = (extra: object = {}) => ({
  400: r("BadArguments"),
  401: r("Unauthorized"),
  403: r("AdminOnly"),
  429: r("TooMany"),
  500: r("Internal"),
  ...extra,
});

const idParam = {
  name: "id",
  in: "path",
  description: "The person's id.",
  required: true,
  schema: str,
};

const failure = note(
  values(FAILURES),
  "Why the email did not go: the login was refused (`auth`), TLS failed (`tls`), no connection (`connect`), the server refused it (`rejected`), it took too long (`timeout`), or anything else (`other`).",
);

const user = object({
  id: str,
  name: str,
  email: note(nstr, "Null for the operator until they add one."),
  role: values(ROLES),
  operator: note(
    bool,
    "The person the admin key signs in as: always an admin, never removed.",
  ),
  created_at: str,
  last_sign_in_at: nstr,
  keys: note(int, "Their agent keys, expired ones included."),
});

const invited = {
  invite: note(values(["sent", "failed"]), "Whether the invite email went."),
  reason: note(failure, "Present when the invite failed."),
};

const smtpFields = {
  host: note(str, "A host name or an IP address."),
  port: note(int, "1 to 65535."),
  security: note(
    values(SECURITY),
    "`tls`: TLS on connect. `starttls`: upgraded after connecting, refused when the server does not offer it. Certificates are always verified.",
  ),
  username: note(nstr, "Null for none; set together with `key_name`."),
  key_name: note(
    nstr,
    "The name of the password's file on the server, as `key_names` lists it: `email-` and 1 to 48 lowercase letters, digits and dashes. Put there by hand; the server only reads it, at each send. Null for none.",
  ),
  from: note(str, "The address emails come from."),
  public_url: note(
    str,
    "The address links point at: an `https://` origin, or `http://` on a loopback host, with no path.",
  ),
};

export const peopleSchemas: Record<string, Schema> = {
  User: user,
  Users: object({
    users: list(ref("User")),
    email_on: note(
      bool,
      "Email is set up and its key file is there; people can be added only then.",
    ),
  }),
  OneUser: object({ user: ref("User") }),
  UserArgs: object(
    {
      name: note(str, `1 to ${MAX_USER_NAME} characters on one line.`),
      email: note(str, "Their address; the invite goes there."),
      role: note(values(ROLES), "`member` by default."),
    },
    ["name", "email"],
  ),
  UserChange: object(
    {
      name: note(str, `1 to ${MAX_USER_NAME} characters on one line.`),
      role: note(values(ROLES), "The operator stays an admin."),
    },
    [],
  ),
  AddedUser: object({ user: ref("User"), ...invited }, ["user", "invite"]),
  Invited: object(invited, ["invite"]),
  RemovedUser: object({
    dry_run: note(bool, "True: nothing was deleted."),
    deleted: note(
      object({
        trades: int,
        positions: int,
        portfolios: int,
        brokers: int,
        settings: int,
        profile: int,
        dashboard: int,
        dashboard_sections: int,
        dashboards: int,
        rules: int,
        alerts: int,
        keys: int,
        logins: int,
        links: int,
      }),
      "The rows of each kind removing them deletes, or deleted.",
    ),
  }),
  SmtpArgs: object(smtpFields),
  Smtp: object({
    settings: {
      oneOf: [
        object({ ...smtpFields, updated_at: str, updated_by: str }),
        { type: "null" },
      ],
    },
    key_names: note(
      list(str),
      "The `email-` password files on the server, by name alone.",
    ),
    email_on: note(bool, "Saved, and its key file is there."),
    key_missing: note(
      bool,
      "The saved password file is not on the server, or cannot be read: email is off until it is.",
    ),
  }),
  SmtpTestArgs: object(
    {
      to: note(str, "Where the test goes. Default: your own email."),
    },
    [],
  ),
  SmtpTest: object(
    {
      result: values(["sent", "failed"]),
      reason: note(failure, "Present when it failed."),
      reply: note(
        nstr,
        "The SMTP server's own reply, when it gave one. Never logged.",
      ),
    },
    ["result"],
  ),
};

const tags = ["people"];
const noEmail = "Email is not set up (`conflict`).";

export const peoplePaths = {
  "/users": {
    get: {
      tags,
      operationId: "listUsers",
      security: ADMINS,
      summary: "The people",
      description:
        "Every person on the server, with their role, email, last sign-in and key count. Admins only.",
      responses: base({ 200: ok("The people.", ref("Users")) }),
    },
    post: {
      tags,
      operationId: "addUser",
      security: ADMINS,
      summary: "Add a person",
      description: lines(
        "Adds a person and emails them a sign-in link and code, valid 7 days. Only an added address is ever sent a link.",
        "",
        "- The person is added whether or not the invite went; `invite` says which.",
        "- Refused while email is off: nobody could sign in.",
      ),
      requestBody: body(ref("UserArgs")),
      responses: base({
        201: ok("The person and the invite.", ref("AddedUser")),
        409: err(`${noEmail} Or another person has the email.`),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
  "/users/{id}": {
    patch: {
      tags,
      operationId: "changeUser",
      security: ADMINS,
      summary: "Rename a person or change their role",
      parameters: [idParam],
      requestBody: body(ref("UserChange")),
      responses: base({
        200: ok("The person.", ref("OneUser")),
        404: r("NotFound"),
        409: err("The operator stays an admin (`conflict`)."),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
    delete: {
      tags,
      operationId: "removeUser",
      security: ADMINS,
      summary: "Remove a person",
      description: lines(
        "Deletes the person and, in one transaction, their portfolios, trades, positions, brokers, settings, profile, dashboard, rules, alerts, keys, sign-ins and links. Fund prices they entered stay, being shared.",
        "",
        "- `dry_run=true` counts what would go and deletes nothing.",
      ),
      parameters: [
        idParam,
        {
          name: "dry_run",
          in: "query",
          description: "Count only.",
          required: false,
          schema: bool,
        },
      ],
      responses: base({
        200: ok("What it deleted, or would.", ref("RemovedUser")),
        404: r("NotFound"),
        409: err("The operator cannot be removed (`conflict`)."),
      }),
    },
  },
  "/users/{id}/invite": {
    post: {
      tags,
      operationId: "inviteUser",
      security: ADMINS,
      summary: "Email the invite again",
      description:
        "A new 7-day link and code, replacing an unused invite. Takes no body.",
      parameters: [idParam],
      responses: base({
        200: ok("Whether it went.", ref("Invited")),
        404: r("NotFound"),
        409: err(`${noEmail} Or the person has no email.`),
      }),
    },
  },
  "/users/{id}/sign-out": {
    post: {
      tags,
      operationId: "signOutUser",
      security: ADMINS,
      summary: "Sign a person out everywhere",
      description:
        "Ends their sign-ins and live links. Their data and keys stay. Takes no body.",
      parameters: [idParam],
      responses: base({
        204: { description: "Signed out." },
        404: r("NotFound"),
      }),
    },
  },
  "/smtp": {
    get: {
      tags,
      operationId: "getSmtp",
      security: ADMINS,
      summary: "Email settings",
      description:
        "The SMTP server links go through, the `email-` key files to pick the password from, and whether email is on. Never a password.",
      responses: base({ 200: ok("The settings.", ref("Smtp")) }),
    },
    put: {
      tags,
      operationId: "saveSmtp",
      security: ADMINS,
      summary: "Save the email settings",
      description: lines(
        "Saves every field at once; a missing one is refused and named. A save sends nothing; the next email goes through it. The operator's alone: whoever sets the server reads every link it carries, so another admin is refused (`forbidden`).",
        "",
        "- Email is on while the settings are saved and their key file is there, read at each send: a file put there later needs no restart.",
        "- A new host or port with the same password file saves no login: the username and the file are cleared, to be picked again for the new server.",
        `- Sign-in links asked for at the sign-in page are capped at ${ASKS_PER_USER_DAY} a person a day from one browser and ${ASKS_PER_HOUR} an hour.`,
      ),
      requestBody: body(ref("SmtpArgs")),
      responses: base({
        200: ok("The settings.", ref("Smtp")),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
    delete: {
      tags,
      operationId: "removeSmtp",
      security: ADMINS,
      summary: "Remove the email settings",
      description:
        "Email goes off and no new link is sent. The key file, people and their sign-ins stay. The operator's alone.",
      responses: base({
        204: { description: "Removed." },
        404: err("Email is not set up (`not_found`)."),
      }),
    },
  },
  "/smtp/test": {
    post: {
      tags,
      operationId: "testSmtp",
      security: ADMINS,
      summary: "Send a test email",
      description:
        "Sends one email at once through the saved settings and answers whether it went, with the server's reply when it failed; past 25 seconds it answers `timeout` while the send goes on. The operator's alone.",
      requestBody: body(ref("SmtpTestArgs")),
      responses: base({
        200: ok("Whether it went.", ref("SmtpTest")),
        409: err(noEmail),
        413: r("TooLarge"),
        415: r("UnsupportedType"),
      }),
    },
  },
};
