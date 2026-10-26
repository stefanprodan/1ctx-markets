// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the service commands need from the platform's service manager.
// launchd answers it on macOS; another manager is another backend.

export type ServiceDefinition = {
  // the binary, then the server's arguments
  programArguments: string[];
  home: string;
  workingDirectory: string;
  // the manager sends the server's stdout and stderr here
  logPath: string;
  // seconds from the stop's signal to the manager's kill
  exitTimeout: number;
};

export type ServiceState = {
  state: string | null;
  pid: number | null;
  program: string | null;
};

export interface ServiceBackend {
  readonly name: string;
  // the stored program arguments, null when nothing is installed
  installed(): Promise<string[] | null>;
  loaded(): Promise<boolean>;
  // write or replace the definition and start it; one that runs is
  // stopped first and has exited by the time the new one starts
  install(definition: ServiceDefinition): Promise<void>;
  start(): Promise<void>;
  // returns once the process has exited; a stopped service is no error
  stop(): Promise<void>;
  // stop it and forget the definition
  remove(): Promise<void>;
  state(): Promise<ServiceState | null>;
}
