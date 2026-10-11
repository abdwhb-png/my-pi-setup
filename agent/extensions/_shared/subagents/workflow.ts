import type { DelegationRequest } from "./contracts.ts";
import type { ExtensionBindings } from "./native-api.ts";

export type AgentLaunch = Pick<DelegationRequest, "agent" | "task"> &
    Partial<
        Omit<
            DelegationRequest,
            "agent" | "task" | "requestId" | "ownerRunId" | "nodeId"
        >
    > & {
        extensionBindings?: ExtensionBindings;
        acceptance?: boolean;
    };
export type WorkflowItem = AgentLaunch & { key: string };
export interface DelegationWorkflow {
    stages: readonly (readonly WorkflowItem[])[];
}
export type DetachedRequest =
    | AgentLaunch
    | (DelegationWorkflow & {
          cwd: string;
          context?: "fresh" | "fork";
          artifacts?: boolean;
      });

export function nativeLaunch(request: AgentLaunch): Record<string, unknown> {
    const { result, ...launch } = request;
    return {
        ...launch,
        ...(result?.kind === "structured"
            ? { outputSchema: result.schema }
            : {}),
    };
}

/** Only the package executes stages and owns child runs. This compiles our data contract into its native workflow API. */
export function compileWorkflow(workflow: DelegationWorkflow): string {
    if (!workflow.stages.length) throw new Error("Workflow requires stages.");
    const known = new Set<string>();
    for (const stage of workflow.stages) {
        if (!stage.length) throw new Error("Workflow stages cannot be empty.");
        const keys = new Set<string>();
        for (const item of stage) {
            if (
                !/^[A-Za-z0-9_-]+$/.test(item.key) ||
                known.has(item.key) ||
                keys.has(item.key)
            )
                throw new Error(
                    `Invalid or duplicate workflow key: ${item.key}.`,
                );
            for (const match of item.task.matchAll(/\{outputs\.([^}]+)\}/g)) {
                if (!known.has(match[1]))
                    throw new Error(
                        `Workflow output ${match[1]} is missing from prior stages.`,
                    );
            }
            keys.add(item.key);
        }
        for (const key of keys) known.add(key);
    }
    const stages = workflow.stages.map((stage) =>
        stage.map((item) => ({ ...nativeLaunch(item), key: item.key })),
    );
    return [
        `const stages = ${JSON.stringify(stages)};`,
        "const outputs = Object.create(null);",
        "const results = [];",
        "for (const stage of stages) {",
        "  const items = stage.map(item => ({ ...item, task: item.task.replace(/\\{outputs\\.([^}]+)\\}/g, (_, key) => { if (!Object.hasOwn(outputs, key) || outputs[key] === undefined) throw new Error(`Workflow dependency ${key} has no structured output.`); return JSON.stringify(outputs[key]); }) }));",
        "  const completed = await runs.all(items);",
        "  results.push(...completed);",
        "  if (completed.some(result => !result.ok)) return { results };",
        "  for (let index = 0; index < items.length; index++) outputs[items[index].key] = completed[index].structuredOutput;",
        "}",
        "return { results };",
    ].join("\n");
}
