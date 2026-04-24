import { afterEach, beforeEach } from "vitest";

export function restoreEnvVar(name: string, savedValue: string | undefined): void {
  if (savedValue === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = savedValue;
}

export function installDefaultEnvVar(name: string, value: string): void {
  const savedValue = process.env[name];
  beforeEach(() => {
    process.env[name] = value;
  });
  afterEach(() => {
    restoreEnvVar(name, savedValue);
  });
}

export function captureEnvVar(name: string): string | undefined {
  return process.env[name];
}
