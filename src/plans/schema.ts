import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Data, Effect } from "effect";
import {
  RunPlanSchema,
  WorkspaceFileSchema,
  formatSchemaErrors,
  type RunPlanStatic,
} from "../core/schema.js";
import {
  AgentId,
  ProjectId,
  ScenarioId,
  type AgentDeclaration,
  type RunPlan,
} from "../core/types.js";
import type {
  PlanFilePath,
  PlannedHarnessDocument,
  PromptWorkspacePlanSpec,
} from "./types.js";

export class PlannedHarnessSchemaError extends Data.TaggedError(
  "PlannedHarnessSchemaError",
)<{
  readonly cause: PlannedHarnessSchemaErrorCause;
}> {}

export type PlannedHarnessSchemaErrorCause =
  | { readonly _tag: "TopLevelNotDocument"; readonly path: PlanFilePath }
  | {
      readonly _tag: "UnsupportedHarnessKind";
      readonly path: PlanFilePath;
      readonly kind: string;
    }
  | {
      readonly _tag: "SchemaInvalid";
      readonly path: PlanFilePath;
      readonly errors: ReadonlyArray<string>;
    };

const PromptWorkspaceHarnessConfigSchema = Type.Object({
  prompts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  workspace: Type.Optional(Type.Array(WorkspaceFileSchema)),
  turnTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

const PromptWorkspacePlanSpecSchema = Type.Object({
  kind: Type.Literal("prompt-workspace"),
  config: PromptWorkspaceHarnessConfigSchema,
});

const PlannedHarnessDocumentSchema = Type.Object({
  plan: RunPlanSchema,
  harness: PromptWorkspacePlanSpecSchema,
});

type PromptWorkspacePlanSpecStatic = Static<typeof PromptWorkspacePlanSpecSchema>;
type PlannedHarnessDocumentStatic = Static<typeof PlannedHarnessDocumentSchema>;

function schemaInvalid(
  path: PlanFilePath,
  errors: ReadonlyArray<string>,
): PlannedHarnessSchemaError {
  return new PlannedHarnessSchemaError({
    cause: {
      _tag: "SchemaInvalid",
      path,
      errors,
    },
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeWithSchema<T>(
  schema: Parameters<typeof Value.Errors>[0],
  source: unknown,
  originPath: PlanFilePath,
): Effect.Effect<T, PlannedHarnessSchemaError, never> {
  const errors = formatSchemaErrors(Value.Errors(schema, source));
  if (errors.length > 0) {
    return Effect.fail(schemaInvalid(originPath, errors));
  }
  return Effect.succeed(Value.Decode(schema, source) as T);
}

function toPromptWorkspacePlanSpec(
  decoded: PromptWorkspacePlanSpecStatic,
  originPath: PlanFilePath,
): Effect.Effect<PromptWorkspacePlanSpec, PlannedHarnessSchemaError, never> {
  const [firstPrompt, ...restPrompts] = decoded.config.prompts;
  if (firstPrompt === undefined) {
    return Effect.fail(schemaInvalid(originPath, ["/config/prompts must contain at least one prompt"]));
  }
  const prompts: readonly [string, ...string[]] = [firstPrompt, ...restPrompts];
  return Effect.succeed({
    kind: "prompt-workspace",
    config: {
      prompts,
      ...(decoded.config.workspace !== undefined ? { workspace: decoded.config.workspace } : {}),
      ...(decoded.config.turnTimeoutMs !== undefined
        ? { turnTimeoutMs: decoded.config.turnTimeoutMs }
        : {}),
    },
  });
}

function toAgentDeclaration(agent: RunPlanStatic["agents"][number]): AgentDeclaration {
  return {
    id: AgentId(agent.id),
    name: agent.name,
    ...(agent.role !== undefined ? { role: agent.role } : {}),
    artifact: agent.artifact,
    promptInputs: agent.promptInputs,
    ...(agent.metadata !== undefined ? { metadata: agent.metadata } : {}),
  };
}

function toRunPlan(
  decoded: RunPlanStatic,
  originPath: PlanFilePath,
): Effect.Effect<RunPlan, PlannedHarnessSchemaError, never> {
  const agents = decoded.agents.map((agent) => toAgentDeclaration(agent));
  const [firstAgent, ...restAgents] = agents;
  if (firstAgent === undefined) {
    return Effect.fail(schemaInvalid(originPath, ["/plan/agents must contain at least one agent"]));
  }
  const typedAgents: readonly [AgentDeclaration, ...AgentDeclaration[]] = [firstAgent, ...restAgents];
  return Effect.succeed({
    project: ProjectId(decoded.project),
    scenarioId: ScenarioId(decoded.scenarioId),
    name: decoded.name,
    description: decoded.description,
    agents: typedAgents,
    requirements: decoded.requirements,
    ...(decoded.metadata !== undefined ? { metadata: decoded.metadata } : {}),
  });
}

export function decodePromptWorkspacePlanSpec(
  source: unknown,
  originPath: PlanFilePath,
): Effect.Effect<PromptWorkspacePlanSpec, PlannedHarnessSchemaError, never> {
  if (isRecord(source)) {
    const kind = source["kind"];
    if (typeof kind === "string" && kind !== "prompt-workspace") {
      return Effect.fail(
        new PlannedHarnessSchemaError({
          cause: {
            _tag: "UnsupportedHarnessKind",
            path: originPath,
            kind,
          },
        }),
      );
    }
  }
  return decodeWithSchema<PromptWorkspacePlanSpecStatic>(
    PromptWorkspacePlanSpecSchema,
    source,
    originPath,
  ).pipe(Effect.flatMap((decoded) => toPromptWorkspacePlanSpec(decoded, originPath)));
}

export function decodePlannedHarnessDocument(
  source: unknown,
  originPath: PlanFilePath,
): Effect.Effect<PlannedHarnessDocument, PlannedHarnessSchemaError, never> {
  if (!isRecord(source) || !("plan" in source) || !("harness" in source)) {
    return Effect.fail(
      new PlannedHarnessSchemaError({
        cause: {
          _tag: "TopLevelNotDocument",
          path: originPath,
        },
      }),
    );
  }

  const harnessSource = source["harness"];
  if (isRecord(harnessSource)) {
    const kind = harnessSource["kind"];
    if (typeof kind === "string" && kind !== "prompt-workspace") {
      return Effect.fail(
        new PlannedHarnessSchemaError({
          cause: {
            _tag: "UnsupportedHarnessKind",
            path: originPath,
            kind,
          },
        }),
      );
    }
  }

  return decodeWithSchema<PlannedHarnessDocumentStatic>(
    PlannedHarnessDocumentSchema,
    source,
    originPath,
  ).pipe(
    Effect.flatMap((decoded) =>
      Effect.all({
        plan: toRunPlan(decoded.plan, originPath),
        harness: toPromptWorkspacePlanSpec(decoded.harness, originPath),
      }),
    ),
  );
}
