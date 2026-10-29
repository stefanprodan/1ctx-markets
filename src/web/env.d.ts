// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Bun bundles a stylesheet a component imports; it exports nothing.

declare module "*.css" {}

// an image the server serves as a file: the import is its path
declare module "*.png" {
  const path: string;
  export default path;
}
