// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export interface PlistSpec {
  label: string;
  programArguments: string[];
  environmentVariables?: Record<string, string>;
  workingDirectory?: string;
  runAtLoad?: boolean;
  keepAlive?: boolean;
  throttleInterval?: number;
  exitTimeOut?: number;
  standardOutPath?: string;
  standardErrorPath?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function key(name: string): string {
  return `  <key>${name}</key>`;
}

function stringValue(value: string): string {
  return `  <string>${escapeXml(value)}</string>`;
}

function booleanValue(value: boolean): string {
  return `  <${value ? "true" : "false"}/>`;
}

export function renderPlist(spec: PlistSpec): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    key("Label"),
    stringValue(spec.label),
    key("ProgramArguments"),
    "  <array>",
    ...spec.programArguments.map(
      (argument) => `    <string>${escapeXml(argument)}</string>`,
    ),
    "  </array>",
  ];

  if (spec.workingDirectory !== undefined) {
    lines.push(key("WorkingDirectory"), stringValue(spec.workingDirectory));
  }
  if (spec.environmentVariables !== undefined) {
    lines.push(key("EnvironmentVariables"), "  <dict>");
    for (const [name, value] of Object.entries(spec.environmentVariables)) {
      lines.push(
        `    <key>${escapeXml(name)}</key>`,
        `    <string>${escapeXml(value)}</string>`,
      );
    }
    lines.push("  </dict>");
  }
  if (spec.runAtLoad !== undefined) {
    lines.push(key("RunAtLoad"), booleanValue(spec.runAtLoad));
  }
  if (spec.keepAlive !== undefined) {
    lines.push(key("KeepAlive"), booleanValue(spec.keepAlive));
  }
  if (spec.throttleInterval !== undefined) {
    lines.push(
      key("ThrottleInterval"),
      `  <integer>${spec.throttleInterval}</integer>`,
    );
  }
  if (spec.exitTimeOut !== undefined) {
    lines.push(key("ExitTimeOut"), `  <integer>${spec.exitTimeOut}</integer>`);
  }
  if (spec.standardOutPath !== undefined) {
    lines.push(key("StandardOutPath"), stringValue(spec.standardOutPath));
  }
  if (spec.standardErrorPath !== undefined) {
    lines.push(key("StandardErrorPath"), stringValue(spec.standardErrorPath));
  }

  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

export function plistPath(label: string, home: string): string {
  return `${home.replace(/\/$/, "")}/Library/LaunchAgents/${label}.plist`;
}

// The <string> children of the ProgramArguments array. The plist is our
// own XML file, so a scan for the array after the key is enough; a binary
// plist yields no arguments.
export function programArguments(xml: string): string[] {
  const key = xml.indexOf("<key>ProgramArguments</key>");
  if (key === -1) return [];
  const start = xml.indexOf("<array>", key);
  const end = xml.indexOf("</array>", start);
  if (start === -1 || end === -1) return [];
  const body = xml.slice(start, end);
  return [...body.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}
