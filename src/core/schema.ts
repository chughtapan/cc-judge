// TypeBox schemas at every data boundary.
// Principle 2: schemas where data enters; types inside.

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type {
  Issue,
  IssueSeverity,
  RunNumber,
  RunSource,
  ScenarioId,
} from "./types.js";

export const ProjectIdSchema = Type.String({ minLength: 1, maxLength: 256 });
export const RunIdSchema = Type.String({ minLength: 1, maxLength: 256 });
export const AgentIdSchema = Type.String({ minLength: 1, maxLength: 256 });
export const ScenarioIdSchema = Type.String({ minLength: 1, maxLength: 256 });

export const IssueSeveritySchema = Type.Union([
  Type.Literal("minor"),
  Type.Literal("significant"),
  Type.Literal("critical"),
]);

export const RunSourceSchema = Type.Literal("bundle");

// Workspace file path: scenario-relative only. Rejects:
//   - absolute paths (leading `/` or Windows drive `C:\...`)
//   - any `..` path segment (traversal out of workspace root)
//   - backslashes (disambiguates from Windows-style separators; POSIX only)
// Enforced at the P2 decode boundary so untrusted YAML cannot produce a
// host-FS write primitive via the Docker bind-mount source.
export const WORKSPACE_PATH_PATTERN = "^(?![/\\\\])(?![a-zA-Z]:)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\]+$";

export const WorkspaceFileSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1024, pattern: WORKSPACE_PATH_PATTERN }),
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

export const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());

export const ExecutionArtifactSchema = Type.Union([
  Type.Object({
    _tag: Type.Literal("DockerBuildArtifact"),
    contextPath: Type.String({ minLength: 1 }),
    dockerfilePath: Type.Optional(Type.String({ minLength: 1 })),
    target: Type.Optional(Type.String({ minLength: 1 })),
    buildArgs: Type.Optional(Type.Record(Type.String(), Type.String())),
    imageTag: Type.Optional(Type.String({ minLength: 1 })),
  }),
  Type.Object({
    _tag: Type.Literal("DockerImageArtifact"),
    image: Type.String({ minLength: 1 }),
    pullPolicy: Type.Optional(
      Type.Union([
        Type.Literal("always"),
        Type.Literal("if-missing"),
        Type.Literal("never"),
      ]),
    ),
  }),
]);

export const AgentDeclarationSchema = Type.Object({
  id: AgentIdSchema,
  name: Type.String({ minLength: 1 }),
  role: Type.Optional(Type.String({ minLength: 1 })),
  artifact: ExecutionArtifactSchema,
  promptInputs: UnknownRecordSchema,
  metadata: Type.Optional(UnknownRecordSchema),
});

export const RunRequirementsSchema = Type.Object({
  expectedBehavior: Type.String(),
  validationChecks: Type.Array(Type.String({ minLength: 1 })),
  judgeRubric: Type.Optional(Type.String()),
});

export const RunPlanSchema = Type.Object({
  project: ProjectIdSchema,
  scenarioId: ScenarioIdSchema,
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  agents: Type.Array(AgentDeclarationSchema, { minItems: 1 }),
  requirements: RunRequirementsSchema,
  metadata: Type.Optional(UnknownRecordSchema),
});

export const TraceEventSchema = Type.Union([
  Type.Object({
    type: Type.Literal("message"),
    from: Type.String(),
    to: Type.Optional(Type.String()),
    channel: Type.String(),
    text: Type.String(),
    ts: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal("phase"),
    phase: Type.String(),
    round: Type.Optional(Type.Number()),
    ts: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal("action"),
    agent: Type.String(),
    action: Type.String(),
    channel: Type.String(),
    ts: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal("state"),
    snapshot: Type.Record(Type.String(), Type.Unknown()),
    ts: Type.Number(),
  }),
]);

export const PhaseSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String(),
  tsStart: Type.Number(),
  tsEnd: Type.Optional(Type.Number()),
});

export const AgentRefSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String(),
  role: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const AgentTurnSchema = Type.Object({
  turn: TurnSchema,
  agentId: Type.Optional(AgentIdSchema),
});

export const AgentLifecycleStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("timed_out"),
  Type.Literal("failed_to_start"),
  Type.Literal("runtime_error"),
  Type.Literal("cancelled"),
]);

export const AgentOutcomeSchema = Type.Object({
  agentId: AgentIdSchema,
  status: AgentLifecycleStatusSchema,
  startedAt: Type.Optional(Type.String()),
  endedAt: Type.String(),
  exitCode: Type.Optional(Type.Integer()),
  reason: Type.Optional(Type.String()),
});

export const JudgmentBundleSchema = Type.Object({
  runId: RunIdSchema,
  project: ProjectIdSchema,
  scenarioId: ScenarioIdSchema,
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  requirements: RunRequirementsSchema,
  agents: Type.Array(AgentRefSchema, { minItems: 1 }),
  turns: Type.Optional(Type.Array(AgentTurnSchema)),
  events: Type.Optional(Type.Array(TraceEventSchema)),
  phases: Type.Optional(Type.Array(PhaseSchema)),
  context: Type.Optional(UnknownRecordSchema),
  workspaceDiff: Type.Optional(WorkspaceDiffSchema),
  outcomes: Type.Array(AgentOutcomeSchema, { minItems: 1 }),
  metadata: Type.Optional(UnknownRecordSchema),
});

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
export type RunPlanStatic = Static<typeof RunPlanSchema>;
export type JudgmentBundleStatic = Static<typeof JudgmentBundleSchema>;

// Helper: format TypeBox error list into short messages for the SchemaInvalid error cause.
export function formatSchemaErrors(errors: Iterable<{ path: string; message: string }>): ReadonlyArray<string> {
  const out: string[] = [];
  for (const e of errors) out.push(`${e.path} ${e.message}`);
  return out;
}

// Re-export TSchema so consumers can annotate without pulling typebox directly.
export type { TSchema };
