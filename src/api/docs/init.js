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
