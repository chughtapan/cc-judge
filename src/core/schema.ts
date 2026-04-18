// TypeBox schemas at every data boundary.
// Principle 2: schemas where data enters, types inside.
// All runtime decoding (YAML -> Scenario, JSON -> JudgeResult, JSONL -> Trace) routes through here.

import type { Static, TSchema } from "@sinclair/typebox";
import type {
  DeterministicCtx,
  Issue,
  IssueSeverity,
  RunNumber,
  RunSource,
  ScenarioId,
  TraceId,
  Turn,
  WorkspaceDiff,
  WorkspaceFile,
} from "./types.js";

// Schemas below are declared but not initialized. Implement-staff wires the
// TypeBox calls after /safer:setup installs @sinclair/typebox.

export declare const ScenarioIdSchema: TSchema;
export declare const TraceIdSchema: TSchema;
export declare const IssueSeveritySchema: TSchema;
export declare const WorkspaceFileSchema: TSchema;
export declare const WorkspaceDiffSchema: TSchema;
export declare const TurnSchema: TSchema;
export declare const IssueSchema: TSchema;

export interface Scenario {
  readonly id: ScenarioId;
  readonly name: string;
  readonly description: string;
  readonly setupPrompt: string;
  readonly followUps?: ReadonlyArray<string>;
  readonly workspace?: ReadonlyArray<WorkspaceFile>;
  readonly timeoutMs?: number;
  readonly expectedBehavior: string;
  readonly validationChecks: ReadonlyArray<string>;
  readonly deterministicPassCheck?: (ctx: DeterministicCtx) => boolean;
  readonly deterministicFailCheck?: (ctx: DeterministicCtx) => boolean;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export declare const ScenarioSchema: TSchema;
export declare const ScenarioYamlSchema: TSchema;

export interface JudgeResult {
  readonly pass: boolean;
  readonly reason: string;
  readonly issues: ReadonlyArray<Issue>;
  readonly overallSeverity: IssueSeverity | null;
  readonly judgeConfidence?: number;
  readonly retryCount: number;
}

export declare const JudgeResultSchema: TSchema;

export interface RunRecord {
  readonly source: RunSource;
  readonly scenarioId: ScenarioId;
  readonly runNumber: RunNumber;
  readonly modelName: string;
  readonly judgeModel: string;
  readonly startedAt: string;
  readonly latencyMs: number;
  readonly pass: boolean;
  readonly reason: string;
  readonly issues: ReadonlyArray<Issue>;
  readonly overallSeverity: IssueSeverity | null;
  readonly judgeConfidence: number | null;
  readonly retryCount: number;
  readonly toolCallCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly transcriptPath: string;
  readonly workspaceDiffSummary: { readonly changed: number; readonly added: number; readonly removed: number };
  readonly traceId?: TraceId;
}

export declare const RunRecordSchema: TSchema;

export interface ReportSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly avgLatencyMs: number;
}

export interface Report {
  readonly runs: ReadonlyArray<RunRecord>;
  readonly summary: ReportSummary;
  readonly artifactsDir?: string;
}

export declare const ReportSchema: TSchema;

export interface Trace {
  readonly traceId: TraceId;
  readonly scenarioId?: ScenarioId;
  readonly name: string;
  readonly turns: ReadonlyArray<Turn>;
  readonly workspaceDiff?: WorkspaceDiff;
  readonly expectedBehavior: string;
  readonly validationChecks: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export declare const TraceSchema: TSchema;

// Promptfoo results shape is external contract; schema'd so adapter emits valid output.
export declare const PromptfooResultsSchema: TSchema;

// Static-type helpers (once schemas are initialized, Static<typeof X> == the interface above).
export type ScenarioStatic = Static<typeof ScenarioSchema>;
export type JudgeResultStatic = Static<typeof JudgeResultSchema>;
export type RunRecordStatic = Static<typeof RunRecordSchema>;
export type TraceStatic = Static<typeof TraceSchema>;
