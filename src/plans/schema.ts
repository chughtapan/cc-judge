import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Data, Effect } from "effect";
import {
  ProjectIdSchema,
  RunRequirementsSchema,
  ScenarioIdSchema,
  UnknownRecordSchema,
  formatSchemaErrors,
} from "../core/schema.js";
import { ProjectId, ScenarioId } from "../core/types.js";
import type {
  HarnessModuleSpec,
  PlanFilePath,
  SharedHarnessPlanDocument,
  SharedHarnessPlanIdentity,
} from "./types.js";

export class PlannedHarnessIngressError extends Data.TaggedError(
  "PlannedHarnessIngressError",
)<{
  readonly cause: PlannedHarnessIngressErrorCause;
}> {}

export type PlannedHarnessIngressErrorCause =
  | {
      readonly _tag: "TopLevelNotDocument";
      readonly path: PlanFilePath;
    }
  | {
      readonly _tag: "SchemaInvalid";
      readonly path: PlanFilePath;
      readonly errors: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "FileNotFound";
      readonly path: string;
    }
  | {
      readonly _tag: "GlobNoMatches";
      readonly pattern: string;
    }
  | {
      readonly _tag: "ParseFailure";
      readonly path: PlanFilePath;
      readonly message: string;
    }
  | {
      readonly _tag: "DuplicateScenarioId";
      readonly scenarioId: SharedHarnessPlanIdentity["scenarioId"];
      readonly paths: readonly [PlanFilePath, PlanFilePath];
    }
  | {
      readonly _tag: "ModuleResolveFailed";
      readonly path: PlanFilePath;
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly _tag: "ModuleImportFailed";
      readonly path: PlanFilePath;
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly _tag: "ModuleExportMissing";
      readonly path: PlanFilePath;
      readonly module: string;
      readonly exportName: string;
    }
  | {
      readonly _tag: "InvalidHarnessModule";
      readonly path: PlanFilePath;
      readonly module: string;
      readonly exportName: string;
    }
  | {
      readonly _tag: "HarnessPlanLoadFailed";
      readonly path: PlanFilePath;
      readonly module: string;
      readonly message: string;
    };

export const PlannedHarnessIngressErrorCause =
  Data.taggedEnum<PlannedHarnessIngressErrorCause>();

export const PLANNED_HARNESS_INGRESS_CAUSE = {
  TopLevelNotDocument: "TopLevelNotDocument",
  SchemaInvalid: "SchemaInvalid",
  FileNotFound: "FileNotFound",
  GlobNoMatches: "GlobNoMatches",
  ParseFailure: "ParseFailure",
  DuplicateScenarioId: "DuplicateScenarioId",
  ModuleResolveFailed: "ModuleResolveFailed",
  ModuleImportFailed: "ModuleImportFailed",
  ModuleExportMissing: "ModuleExportMissing",
  InvalidHarnessModule: "InvalidHarnessModule",
  HarnessPlanLoadFailed: "HarnessPlanLoadFailed",
} as const satisfies { readonly [K in PlannedHarnessIngressErrorCause["_tag"]]: K };

const HarnessModuleSpecSchema = Type.Object({
  module: Type.String({ minLength: 1 }),
  export: Type.Optional(Type.String({ minLength: 1 })),
  payload: Type.Optional(Type.Unknown()),
});

const SharedHarnessPlanDocumentSchema = Type.Object({
  project: ProjectIdSchema,
  scenarioId: ScenarioIdSchema,
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  requirements: RunRequirementsSchema,
  metadata: Type.Optional(UnknownRecordSchema),
  harness: HarnessModuleSpecSchema,
});

type SharedHarnessPlanDocumentStatic = Static<typeof SharedHarnessPlanDocumentSchema>;

function schemaInvalid(
  path: PlanFilePath,
  errors: ReadonlyArray<string>,
): PlannedHarnessIngressError {
  return new PlannedHarnessIngressError({
    cause: PlannedHarnessIngressErrorCause.SchemaInvalid({
      path,
      errors,
    }),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeWithSchema<T>(
  schema: Parameters<typeof Value.Errors>[0],
  source: unknown,
  originPath: PlanFilePath,
): Effect.Effect<T, PlannedHarnessIngressError, never> {
  const errors = formatSchemaErrors(Value.Errors(schema, source));
  if (errors.length > 0) {
    return Effect.fail(schemaInvalid(originPath, errors));
  }
  return Effect.succeed(Value.Decode(schema, source) as T);
}

function toHarnessModuleSpec(
  decoded: SharedHarnessPlanDocumentStatic["harness"],
): HarnessModuleSpec {
  return {
    module: decoded.module,
    ...(decoded.export !== undefined ? { export: decoded.export } : {}),
    ...("payload" in decoded ? { payload: decoded.payload } : {}),
  };
}

function toSharedHarnessPlanDocument(
  decoded: SharedHarnessPlanDocumentStatic,
): SharedHarnessPlanDocument {
  return {
    project: ProjectId(decoded.project),
    scenarioId: ScenarioId(decoded.scenarioId),
    name: decoded.name,
    description: decoded.description,
    requirements: decoded.requirements,
    ...(decoded.metadata !== undefined ? { metadata: decoded.metadata } : {}),
    harness: toHarnessModuleSpec(decoded.harness),
  };
}

export function decodePlannedHarnessDocument(
  source: unknown,
  originPath: PlanFilePath,
): Effect.Effect<SharedHarnessPlanDocument, PlannedHarnessIngressError, never> {
  if (!isRecord(source) || !("harness" in source)) {
    return Effect.fail(
      new PlannedHarnessIngressError({
        cause: PlannedHarnessIngressErrorCause.TopLevelNotDocument({
          path: originPath,
        }),
      }),
    );
  }

  return decodeWithSchema<SharedHarnessPlanDocumentStatic>(
    SharedHarnessPlanDocumentSchema,
    source,
    originPath,
  ).pipe(Effect.map((decoded) => toSharedHarnessPlanDocument(decoded)));
}
