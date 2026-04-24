import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import * as YAML from "yaml";
import { BundleDecodeCause, BundleDecodeError } from "../core/errors.js";
import { JudgmentBundleSchema, formatSchemaErrors, type JudgmentBundleStatic } from "../core/schema.js";
import {
  AgentId,
  ProjectId,
  RunId,
  ScenarioId,
  type AgentOutcome,
  type AgentRef,
  type AgentTurn,
  type JudgmentBundle as JudgmentBundleType,
} from "../core/types.js";

export interface BundleCodec {
  readonly name: string;
  encode(bundle: JudgmentBundleType): Effect.Effect<string, never, never>;
  decode(source: string, originPath: string): Effect.Effect<JudgmentBundleType, BundleDecodeError, never>;
}

function decodeFromParsed(parsed: unknown, originPath: string): Effect.Effect<JudgmentBundleType, BundleDecodeError, never> {
  const errors = formatSchemaErrors(Value.Errors(JudgmentBundleSchema, parsed));
  if (errors.length > 0) {
    return Effect.fail(
      new BundleDecodeError({
        cause: BundleDecodeCause.SchemaInvalid({
          path: originPath,
          errors,
        }),
      }),
    );
  }
  const decoded = Value.Decode(JudgmentBundleSchema, parsed);
  return Effect.succeed(normalizeBundle(decoded));
}

function normalizeBundle(decoded: JudgmentBundleStatic): JudgmentBundleType {
  return {
    runId: RunId(decoded.runId),
    project: ProjectId(decoded.project),
    scenarioId: ScenarioId(decoded.scenarioId),
    name: decoded.name,
    description: decoded.description,
    requirements: decoded.requirements,
    agents: decoded.agents.map(normalizeAgentRef),
    ...(decoded.turns !== undefined ? { turns: decoded.turns.map(normalizeTurn) } : {}),
    ...(decoded.events !== undefined ? { events: decoded.events } : {}),
    ...(decoded.phases !== undefined ? { phases: decoded.phases } : {}),
    ...(decoded.context !== undefined ? { context: decoded.context } : {}),
    ...(decoded.workspaceDiff !== undefined ? { workspaceDiff: decoded.workspaceDiff } : {}),
    outcomes: decoded.outcomes.map(normalizeOutcome),
    ...(decoded.metadata !== undefined ? { metadata: decoded.metadata } : {}),
  };
}

function normalizeAgentRef(agent: AgentRef): AgentRef {
  return { ...agent };
}

function normalizeTurn(turn: NonNullable<JudgmentBundleStatic["turns"]>[number]): AgentTurn {
  return {
    turn: turn.turn,
    ...(turn.agentId !== undefined ? { agentId: AgentId(turn.agentId) } : {}),
  };
}

function normalizeOutcome(outcome: JudgmentBundleStatic["outcomes"][number]): AgentOutcome {
  return {
    ...outcome,
    agentId: AgentId(outcome.agentId),
  };
}

function decodeJson(source: string, originPath: string): Effect.Effect<JudgmentBundleType, BundleDecodeError, never> {
  return Effect.try({
    try: () => JSON.parse(source),
    catch: (error) =>
      new BundleDecodeError({
        cause: BundleDecodeCause.SchemaInvalid({
          path: originPath,
          errors: [error instanceof Error ? error.message : String(error)],
        }),
      }),
  }).pipe(Effect.flatMap((parsed) => decodeFromParsed(parsed, originPath)));
}

function decodeYaml(source: string, originPath: string): Effect.Effect<JudgmentBundleType, BundleDecodeError, never> {
  return Effect.try({
    try: () => YAML.parse(source),
    catch: (error) =>
      new BundleDecodeError({
        cause: BundleDecodeCause.SchemaInvalid({
          path: originPath,
          errors: [error instanceof Error ? error.message : String(error)],
        }),
      }),
  }).pipe(Effect.flatMap((parsed) => decodeFromParsed(parsed, originPath)));
}

function encodeJson(bundle: JudgmentBundleType): Effect.Effect<string, never, never> {
  return Effect.sync(() => JSON.stringify(bundle, null, 2));
}

function encodeYaml(bundle: JudgmentBundleType): Effect.Effect<string, never, never> {
  return Effect.sync(() => YAML.stringify(bundle));
}

export const bundleJsonCodec: BundleCodec = {
  name: "json",
  encode: encodeJson,
  decode: decodeJson,
};

export const bundleYamlCodec: BundleCodec = {
  name: "yaml",
  encode: encodeYaml,
  decode: decodeYaml,
};

export const bundleAutoCodec: BundleCodec = {
  name: "auto",
  encode: encodeJson,
  decode(source, originPath) {
    const trimmed = source.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return decodeJson(source, originPath);
    }
    return decodeYaml(source, originPath);
  },
};
