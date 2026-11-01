// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The release build; test/web-build.test.ts bundles with the same options.

export const RELEASE = {
  entrypoints: ["src/main.ts"],
  target: "bun",
  // identifiers kept: the log names an error by its class
  minify: { whitespace: true, syntax: true },
  define: {
    "process.env.MARKETS_BUILD_VERSION": JSON.stringify(
      process.env.VERSION ?? "",
    ),
  },
  sourcemap: "linked",
} satisfies Bun.BuildConfig;

if (import.meta.main) {
  const target = process.env.TARGET as Bun.Build.CompileTarget | undefined;
  const out = await Bun.build({
    ...RELEASE,
    compile: {
      ...(target ? { target } : {}),
      outfile: "bin/1ctx-markets",
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  for (const log of out.logs) console.error(log);
  if (!out.success) process.exit(1);
}
