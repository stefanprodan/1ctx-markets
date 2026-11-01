// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The release build's own options, bundled once without compiling.

import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { RELEASE } from "../scripts/build.ts";

const built = Bun.build(RELEASE).then(async (out) => {
  if (!out.success) throw new AggregateError(out.logs, "the build failed");
  const page = out.outputs.find(
    (o) => o.kind === "entry-point" && o.path.endsWith("index.html"),
  );
  if (page === undefined) throw new Error("no page in the build");
  const html = await page.text();
  const named = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) =>
    basename(m[1]!),
  );
  const file = (ext: string) => {
    const name = named.find((n) => n.endsWith(ext));
    const o = out.outputs.find((o) => basename(o.path) === name);
    if (o === undefined) throw new Error(`the page names no ${ext}`);
    return o;
  };
  const server = out.outputs.find(
    (o) => o.kind === "entry-point" && basename(o.path) === "main.js",
  );
  if (server === undefined) throw new Error("no server in the build");
  return {
    html,
    named,
    server,
    script: file(".js"),
    styles: file(".css"),
  };
});

describe("the release build", () => {
  test("keeps the fonts as files it preloads, out of the stylesheet", async () => {
    const { html, named, styles } = await built;
    expect(await styles.text()).not.toContain("data:font");
    const fonts = named.filter((n) => n.endsWith(".woff2"));
    expect(fonts).toHaveLength(2);
    for (const font of fonts) {
      expect(html).toMatch(
        new RegExp(`rel="preload" href="[^"]*${font}" as="font"`),
      );
    }
  });

  test("minifies the page's script", async () => {
    const { script } = await built;
    const js = await script.text();
    expect(js).toContain("TradingView");
    expect(js.split("\n").length).toBeLessThan(100);
  });

  test("keeps the server's class names, which the log names errors by", async () => {
    const { server } = await built;
    expect(await server.text()).toContain("class KeyConflict ");
  });
});
