// TypeBox schemas at every data boundary.
// Principle 2: schemas where data enters; types inside.

import { Type, type Static, type TSchema } from "@sinclair/typebox";
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

export const ScenarioIdSchema = Type.String({ minLength: 1, maxLength: 256 });
export const TraceIdSchema = Type.String({ minLength: 1, maxLength: 256 });

export const IssueSeveritySchema = Type.Union([
  Type.Literal("minor"),
  Type.Literal("significant"),
  Type.Literal("critical"),
]);

export const RunSourceSchema = Type.Union([
  Type.Literal("scenario"),
  Type.Literal("trace"),
]);

export const WorkspaceFileSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
});

export const WorkspaceFileChangeSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  before: Type.Union([Type.String(), Type.Null()]),
  after: Type.Union([Type.String(), Type.Null()]),
});

export const WorkspaceDiffSchema = Type.Object({
  changed: Type.Array(WorkspaceFileChangeSchema),
});

export const TurnSchema = Type.Object({
  index: Type.Integer({ minimum: 0 }),
  prompt: Type.String(),
  response: Type.String(),
  startedAt: Type.String(),
  latencyMs: Type.Integer({ minimum: 0 }),
  toolCallCount: Type.Integer({ minimum: 0 }),
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0 }),
});

export const IssueSchema = Type.Object({
  issue: Type.String({ minLength: 1 }),
  severity: IssueSeveritySchema,
});

export const MetadataSchema = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
);

// YAML-shaped Scenario. Function-valued deterministic checks cannot round-trip
// through YAML; they are TS-only. ScenarioYamlSchema is the strict decode target.
export const ScenarioYamlSchema = Type.Object({
  id: ScenarioIdSchema,
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  setupPrompt: Type.String({ minLength: 1 }),
  followUps: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  workspace: Type.Optional(Type.Array(WorkspaceFileSchema)),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  expectedBehavior: Type.String(),
  validationChecks: Type.Array(Type.String({ minLength: 1 })),
  metadata: Type.Optional(MetadataSchema),
});

// Full Scenario is the YAML shape plus TS-only function fields. Not a boundary
// decoder (TS scenarios are type-checked by the compiler); exported for Static<>.
export const ScenarioSchema = ScenarioYamlSchema;

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

export const JudgeResultSchema = Type.Object({
  pass: Type.Boolean(),
  reason: Type.String(),
  issues: Type.Array(IssueSchema),
  overallSeverity: Type.Union([IssueSeveritySchema, Type.Null()]),
  judgeConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  retryCount: Type.Integer({ minimum: 0 }),
});

export interface JudgeResult {
  readonly pass: boolean;
  readonly reason: string;
  readonly issues: ReadonlyArray<Issue>;
  readonly overallSeverity: IssueSeverity | null;
  readonly judgeConfidence?: number;
  readonly retryCount: number;
}

export const RunRecordSchema = Type.Object({
  source: RunSourceSchema,
  scenarioId: ScenarioIdSchema,
  runNumber: Type.Integer({ minimum: 1 }),
  modelName: Type.String(),
  judgeModel: Type.String(),
  startedAt: Type.String(),
  latencyMs: Type.Integer({ minimum: 0 }),
  pass: Type.Boolean(),
  reason: Type.String(),
  issues: Type.Array(IssueSchema),
  overallSeverity: Type.Union([IssueSeveritySchema, Type.Null()]),
  judgeConfidence: Type.Union([Type.Number(), Type.Null()]),
  retryCount: Type.Integer({ minimum: 0 }),
  toolCallCount: Type.Integer({ minimum: 0 }),
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0 }),
  transcriptPath: Type.String(),
  workspaceDiffSummary: Type.Object({
    changed: Type.Integer({ minimum: 0 }),
    added: Type.Integer({ minimum: 0 }),
    removed: Type.Integer({ minimum: 0 }),
  }),
  traceId: Type.Optional(TraceIdSchema),
});

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

export const ReportSummarySchema = Type.Object({
  total: Type.Integer({ minimum: 0 }),
  passed: Type.Integer({ minimum: 0 }),
  failed: Type.Integer({ minimum: 0 }),
  avgLatencyMs: Type.Number({ minimum: 0 }),
});

export interface ReportSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly avgLatencyMs: number;
}

export const ReportSchema = Type.Object({
  runs: Type.Array(RunRecordSchema),
  summary: ReportSummarySchema,
  artifactsDir: Type.Optional(Type.String()),
});

export interface Report {
  readonly runs: ReadonlyArray<RunRecord>;
  readonly summary: ReportSummary;
  readonly artifactsDir?: string;
}

export const TraceSchema = Type.Object({
  traceId: TraceIdSchema,
  scenarioId: Type.Optional(ScenarioIdSchema),
  name: Type.String(),
  turns: Type.Array(TurnSchema),
  workspaceDiff: Type.Optional(WorkspaceDiffSchema),
  expectedBehavior: Type.String(),
  validationChecks: Type.Array(Type.String()),
  metadata: Type.Optional(MetadataSchema),
});

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

// Promptfoo results shape (external contract). Minimal: one record per run.
// The adapter writes this to disk; promptfoo's dashboard ingests it.
// Shape anchored to promptfoo's ResultsFile / EvaluateSummary surface in
// promptfoo@0.115+; fields beyond these are preserved via passthrough (false for strictness).
export const PromptfooResultsSchema = Type.Object({
  version: Type.Literal(3),
  createdAt: Type.String(),
  results: Type.Object({
    timestamp: Type.String(),
    results: Type.Array(
      Type.Object({
        promptId: Type.String(),
        testIdx: Type.Integer({ minimum: 0 }),
        success: Type.Boolean(),
        score: Type.Number(),
        latencyMs: Type.Integer({ minimum: 0 }),
        response: Type.Object({
          output: Type.String(),
          tokenUsage: Type.Object({
            prompt: Type.Integer({ minimum: 0 }),
            completion: Type.Integer({ minimum: 0 }),
            cached: Type.Integer({ minimum: 0 }),
          }),
        }),
        gradingResult: Type.Object({
          pass: Type.Boolean(),
          score: Type.Number(),
          reason: Type.String(),
        }),
        vars: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
      }),
    ),
    stats: Type.Object({
      successes: Type.Integer({ minimum: 0 }),
      failures: Type.Integer({ minimum: 0 }),
      tokenUsage: Type.Object({
        total: Type.Integer({ minimum: 0 }),
        prompt: Type.Integer({ minimum: 0 }),
        completion: Type.Integer({ minimum: 0 }),
      }),
    }),
  }),
});

// Type aliases (Static<Schema> mirrors the hand-written interface once schemas are filled).
export type IssueStatic = Static<typeof IssueSchema>;
export type JudgeResultStatic = Static<typeof JudgeResultSchema>;
export type RunRecordStatic = Static<typeof RunRecordSchema>;
export type TraceStatic = Static<typeof TraceSchema>;

// Helper: format TypeBox error list into short messages for the SchemaInvalid error cause.
export function formatSchemaErrors(errors: Iterable<{ path: string; message: string }>): ReadonlyArray<string> {
  const out: string[] = [];
  for (const e of errors) out.push(`${e.path} ${e.message}`);
  return out;
}

// Re-export TSchema so consumers can annotate without pulling typebox directly.
export type { TSchema };
