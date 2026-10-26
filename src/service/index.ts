// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The CLI-only service area: `1ctx-markets service` installs the binary
// with the platform's service manager. It opens no database.

export { runService, type ServiceDeps, ServiceError } from "./service.ts";
