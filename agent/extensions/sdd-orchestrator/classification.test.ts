import { expect, it } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  AssessmentSchema,
  CRITICAL_SIGNALS,
  LOW_RISK_SIGNALS,
  STANDARD_SIGNALS,
  type TaskAssessment,
} from "./assessment.ts";
import { classifyTask, effectiveProfile } from "./classification.ts";

function assessment(
  signals: TaskAssessment["signals"],
  confidence: TaskAssessment["confidence"] = "high",
  advisoryMinimum: TaskAssessment["advisoryMinimum"] = "direct",
): TaskAssessment {
  return {
    taskId: "task-1",
    signals,
    evidence: [],
    confidence,
    uncertainties: [],
    advisoryMinimum,
  };
}

it("classifies one critical signal as critical", () => {
  expect(
    classifyTask({
      taskId: "task-1",
      signals: ["financial_logic"],
      evidence: [
        {
          signal: "financial_logic",
          source: "Task 1 handles settlement amounts.",
        },
      ],
      confidence: "high",
      uncertainties: [],
      advisoryMinimum: "direct",
    }),
  ).toEqual({ minimum: "critical", rules: ["critical-signal"] });
});

it("classifies every critical signal as critical", () => {
  for (const signal of CRITICAL_SIGNALS) {
    expect(
      classifyTask({
        taskId: "task-1",
        signals: [signal],
        evidence: [{ signal, source: `Task 1 has ${signal}.` }],
        confidence: "high",
        uncertainties: [],
        advisoryMinimum: "direct",
      }),
    ).toEqual({ minimum: "critical", rules: ["critical-signal"] });
  }
});

it("classifies every direct Standard boundary as standard", () => {
  for (const signal of STANDARD_SIGNALS.slice(0, 3)) {
    expect(
      classifyTask({
        taskId: "task-1",
        signals: [signal],
        evidence: [{ signal, source: `Task 1 has ${signal}.` }],
        confidence: "high",
        uncertainties: [],
        advisoryMinimum: "direct",
      }),
    ).toEqual({ minimum: "standard", rules: ["standard-boundary"] });
  }
});

it("classifies uncertain requirements with weak tests as standard", () => {
  expect(
    classifyTask({
      taskId: "task-1",
      signals: ["weak_test_coverage", "requirements_uncertainty"],
      evidence: [],
      confidence: "high",
      uncertainties: ["The acceptance criteria are incomplete."],
      advisoryMinimum: "direct",
    }),
  ).toEqual({
    minimum: "standard",
    rules: ["standard-uncertainty-plus-weak-tests"],
  });
});

it("classifies a clear isolated task as light", () => {
  expect(
    classifyTask({
      taskId: "task-1",
      signals: ["isolated_scope", "clear_requirements"],
      evidence: [],
      confidence: "high",
      uncertainties: [],
      advisoryMinimum: "direct",
    }),
  ).toEqual({ minimum: "light", rules: ["light-positive-scope"] });
});

it("escalates low-confidence non-critical results by one profile", () => {
  expect(classifyTask(assessment([], "low"))).toEqual({
    minimum: "light",
    rules: ["low-confidence-escalation"],
  });
  expect(
    classifyTask(assessment(["isolated_scope", "clear_requirements"], "low")),
  ).toEqual({
    minimum: "standard",
    rules: ["light-positive-scope", "low-confidence-escalation"],
  });
  expect(classifyTask(assessment(["multi_module"], "low"))).toEqual({
    minimum: "critical",
    rules: ["standard-boundary", "low-confidence-escalation"],
  });
  expect(classifyTask(assessment(["financial_logic"], "low"))).toEqual({
    minimum: "critical",
    rules: ["critical-signal"],
  });
});

it("keeps medium-confidence classification stable", () => {
  expect(
    classifyTask(
      assessment(["isolated_scope", "clear_requirements"], "medium"),
    ),
  ).toEqual({ minimum: "light", rules: ["light-positive-scope"] });
});

it("ignores the assessor advisory minimum", () => {
  expect(classifyTask(assessment([], "high", "critical"))).toEqual({
    minimum: "direct",
    rules: [],
  });
});

it("keeps the global profile without complete low-risk proof", () => {
  const input = assessment(["isolated_scope", "clear_requirements"]);
  expect(effectiveProfile("standard", classifyTask(input), input)).toBe(
    "standard",
  );
});

it("allows Light below global Standard with complete high-confidence proof", () => {
  const input = assessment([
    "isolated_scope",
    "clear_requirements",
    "existing_test_pattern",
  ]);
  expect(effectiveProfile("standard", classifyTask(input), input)).toBe(
    "light",
  );
});

it("raises any global profile to Critical for a critical signal", () => {
  const input = assessment(["financial_logic"]);
  expect(effectiveProfile("standard", classifyTask(input), input)).toBe(
    "critical",
  );
});

it("exports the exact assessment signal vocabulary", () => {
  expect(CRITICAL_SIGNALS).toEqual([
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
  ]);
  expect(STANDARD_SIGNALS).toEqual([
    "multi_module",
    "public_contract",
    "external_integration",
    "weak_test_coverage",
    "requirements_uncertainty",
  ]);
  expect(LOW_RISK_SIGNALS).toEqual([
    "isolated_scope",
    "clear_requirements",
    "existing_test_pattern",
  ]);
});

it("validates versioned assessments with exact signal values", () => {
  const valid = {
    version: 1,
    assessorModel: "assessor-model",
    tasks: [assessment(["isolated_scope"])],
  };
  expect(Value.Check(AssessmentSchema, valid)).toBe(true);
  expect(Value.Check(AssessmentSchema, { ...valid, assessorModel: "" })).toBe(
    false,
  );
  expect(Value.Check(AssessmentSchema, { ...valid, tasks: [] })).toBe(false);
  expect(
    Value.Check(AssessmentSchema, {
      ...valid,
      tasks: [{ ...valid.tasks[0], signals: ["unknown_signal"] }],
    }),
  ).toBe(false);
  expect(Value.Check(AssessmentSchema, { ...valid, extra: true })).toBe(false);
});
