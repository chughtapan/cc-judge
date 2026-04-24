import { afterEach, beforeEach } from "vitest";

function nodeEnv(): NodeJS.ProcessEnv {
  return Reflect.get(process, "env") as NodeJS.ProcessEnv;
}

export function restoreEnvVar(name: string, savedValue: string | undefined): void {
  if (savedValue === undefined) {
    delete nodeEnv()[name];
    return;
  }
  nodeEnv()[name] = savedValue;
}

export function setEnvVar(name: string, value: string): void {
  nodeEnv()[name] = value;
}

export function deleteEnvVar(name: string): void {
  delete nodeEnv()[name];
}

export function installDefaultEnvVar(name: string, value: string): void {
  const savedValue = nodeEnv()[name];
  beforeEach(() => {
    setEnvVar(name, value);
  });
  afterEach(() => {
    restoreEnvVar(name, savedValue);
  });
}

export function captureEnvVar(name: string): string | undefined {
  return nodeEnv()[name];
}
