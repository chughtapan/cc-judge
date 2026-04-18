// Report emitter: writes the summary.md + results.jsonl + details/*.yaml triple,
// and optionally posts a GitHub comment.
// Invariant: emission is idempotent (re-runs overwrite); emission never changes verdicts.

import type { Effect } from "effect";
import type { PublishError } from "../core/errors.js";
import type { Report, RunRecord } from "../core/schema.js";

export interface ReportEmitterOpts {
  readonly resultsDir: string;
  readonly githubComment?: number;
  readonly githubCommentArtifactUrl?: string;
}

export interface ReportEmitter {
  // Append one RunRecord line to results.jsonl and write details/<id>.<run>.yaml.
  // Streaming: called after each run completes so scheduled jobs see partial output on timeout.
  emitRun(record: RunRecord): Effect.Effect<void, never, never>;

  // Emit the Report triple at pipeline close: summary.md + finalized results.jsonl + details/.
  emitReport(report: Report): Effect.Effect<void, never, never>;

  // Opt-in GitHub comment. Non-verdict: PublishError surfaces as a warning, never alters exit code.
  // Spec Q5.2-B: if summary exceeds ~65k chars, post overall + count + githubCommentArtifactUrl;
  // fall back to inline-truncation when the URL is absent.
  publishGithubComment(report: Report): Effect.Effect<void, PublishError, never>;
}

export declare function makeReportEmitter(opts: ReportEmitterOpts): ReportEmitter;
