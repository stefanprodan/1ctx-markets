// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// CLI only: installs the binary with the service manager; opens no database.

export {
  runService,
  type ServiceDeps,
  ServiceError,
  serviceConfig,
  urlOf,
} from "./service.ts";
