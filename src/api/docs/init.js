// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file of its own, never inline, so the page's policy allows scripts
// from this server only. The validator would send the spec to another
// host; the key typed into Authorize is kept for this page only.

window.ui = window.SwaggerUIBundle({
  url: "/api/v1/openapi.json",
  dom_id: "#swagger-ui",
  validatorUrl: null,
  persistAuthorization: false,
  presets: [window.SwaggerUIBundle.presets.apis],
  layout: "BaseLayout",
});

// Swagger UI's CSS carries a dark theme under html.dark-mode but its
// bundle never sets it, so the page follows the system's scheme here.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const scheme = () =>
  document.documentElement.classList.toggle("dark-mode", dark.matches);
scheme();
dark.addEventListener("change", scheme);
