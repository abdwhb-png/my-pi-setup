import type { PresentedTool } from "./presentation.ts";
import type { CatalogResult, ToolSelection } from "./provider-catalog.ts";

export type ProviderCatalogObservation =
    | {
          supported: true;
          tools: PresentedTool[];
          callableTools: PresentedTool[] | undefined;
          selection: ToolSelection;
          block: string;
      }
    | Extract<CatalogResult, { supported: false }>;

export interface ProviderCatalogSnapshot {
    api: string;
    requestNumber: number;
    injected: boolean;
    observation: ProviderCatalogObservation;
}

const KEY = Symbol.for("pi.tool-policy.provider-catalog-state.v1");
type State = {
    generation: symbol;
    snapshot?: ProviderCatalogSnapshot;
};
type Root = typeof globalThis & { [KEY]?: State };

export interface ProviderCatalogRecorder {
    reset(): void;
    record(snapshot: ProviderCatalogSnapshot): void;
    dispose(): void;
}

export function claimProviderCatalogRecorder(): ProviderCatalogRecorder {
    const generation = Symbol("provider-catalog-generation");
    const root = globalThis as Root;
    root[KEY] = { generation };
    return {
        reset() {
            if (root[KEY]?.generation === generation)
                root[KEY] = { generation };
        },
        record(snapshot) {
            if (root[KEY]?.generation === generation)
                root[KEY] = { generation, snapshot };
        },
        dispose() {
            if (root[KEY]?.generation === generation) delete root[KEY];
        },
    };
}

export function getProviderCatalogSnapshot():
    | ProviderCatalogSnapshot
    | undefined {
    return (globalThis as Root)[KEY]?.snapshot;
}
