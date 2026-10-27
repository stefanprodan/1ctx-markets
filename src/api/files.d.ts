// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A file import is the embedded file's path, read with Bun.file().

declare module "swagger-ui-dist/swagger-ui-bundle.js" {
  const path: string;
  export default path;
}

declare module "swagger-ui-dist/swagger-ui.css" {
  const path: string;
  export default path;
}

declare module "*/init.js" {
  const path: string;
  export default path;
}
