// Shared stdout/stderr capture for tests that need to assert on
// structured log output (WAL warnings, CLI status lines, etc.).
//
// Replaces the inline copies that grew up in plans.test.ts and
// inspect.test.ts. The handle's `restore` MUST be called in a
// finally block so a failing assertion doesn't leak the spy into
// other tests.

type WriteFn = typeof process.stdout.write;

export interface CaptureHandle {
  readonly chunks: string[];
  readonly restore: () => void;
}

export function captureStream(stream: NodeJS.WriteStream): CaptureHandle {
  const chunks: string[] = [];
  const original = stream.write.bind(stream);
  const spy: WriteFn = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }) as WriteFn;
  Object.defineProperty(stream, "write", { configurable: true, value: spy });
  const restore = (): void => {
    Object.defineProperty(stream, "write", { configurable: true, value: original });
  };
  return { chunks, restore };
}
