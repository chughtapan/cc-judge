// Shared tmpdir factory for tests that need an isolated working
// directory. Replaces the inline `mkdtempSync(path.join(os.tmpdir(),
// "cc-judge-...-"))` boilerplate that grew across 10+ test files.
//
// The `cc-judge-` prefix is shared so the OS's tmp-cleanup heuristics
// (and the Docker integration suite's stragglers cleanup) can identify
// our directories.

import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function makeTempDir(tag: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `cc-judge-${tag}-`));
}
