import { type Static, Type } from "@sinclair/typebox";
import { PROFILES, type ParsedTask } from "./types.ts";

export const CRITICAL_SIGNALS = [
    "migration_or_data_transform",
    "authentication_or_authorization",
    "secrets",
    "financial_logic",
    "concurrency_or_processes",
    "resource_lifecycle",
    "shared_infrastructure",
    "pi_core_behavior",
    "inter_extension_protocol",
    "irreversible_operation",
    "architecture_uncertainty",
] as const;

export const STANDARD_SIGNALS = [
    "multi_module",
    "public_contract",
    "external_integration",
    "weak_test_coverage",
    "requirements_uncertainty",
] as const;

export const LOW_RISK_SIGNALS = [
    "isolated_scope",
    "clear_requirements",
    "existing_test_pattern",
] as const;

const SIGNALS = [
    ...CRITICAL_SIGNALS,
    ...STANDARD_SIGNALS,
    ...LOW_RISK_SIGNALS,
] as const;
const SignalSchema = Type.Union(SIGNALS.map((signal) => Type.Literal(signal)));
const ProfileSchema = Type.Union(
    PROFILES.map((profile) => Type.Literal(profile)),
);

export const TaskAssessmentSchema = Type.Object(
    {
        taskId: Type.String({ minLength: 1 }),
        signals: Type.Array(SignalSchema),
        evidence: Type.Array(
            Type.Object(
                {
                    signal: SignalSchema,
                    source: Type.String({ minLength: 1 }),
                },
                { additionalProperties: false },
            ),
        ),
        confidence: Type.Union([
            Type.Literal("high"),
            Type.Literal("medium"),
            Type.Literal("low"),
        ]),
        uncertainties: Type.Array(Type.String({ minLength: 1 })),
        advisoryMinimum: ProfileSchema,
    },
    { additionalProperties: false },
);

export const AssessmentSchema = Type.Object(
    {
        version: Type.Literal(1),
        assessorModel: Type.String({ minLength: 1 }),
        tasks: Type.Array(TaskAssessmentSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
);

type SchemaTaskAssessment = Static<typeof TaskAssessmentSchema>;

export type TaskAssessment = Omit<SchemaTaskAssessment, "taskId"> & {
    taskId: ParsedTask["id"];
};

export type Assessment = Omit<Static<typeof AssessmentSchema>, "tasks"> & {
    tasks: TaskAssessment[];
};
