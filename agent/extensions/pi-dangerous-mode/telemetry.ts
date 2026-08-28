import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuardCategory } from "./guard-policy.ts";

export const AUTOPILOT_TELEMETRY_ENTRY = "pi:autopilot:telemetry";
export const AUTOPILOT_TELEMETRY_SCHEMA_VERSION = 1;

export type AutopilotTelemetryEvent =
    | {
          event: "mode_change";
          mode: "dangerous" | "autopilot";
          source: "flag" | "command" | "reload";
          enabled: boolean;
      }
    | {
          event: "prompt_blocked";
          kind:
              | "ask_user_question"
              | "select"
              | "confirm"
              | "input"
              | "editor"
              | "custom";
          agentActive: boolean;
      }
    | {
          event: "guard_blocked";
          category: GuardCategory;
          toolName: string;
      }
    | {
          event: "turn_recorded";
          turnsUsed: number;
          retriesUsed: number;
          hadError: boolean;
      }
    | {
          event: "continuation_queued";
          reason: "continue" | "retry" | "prompt_blocked";
      }
    | { event: "completed"; outcome: "completed" | "blocked" }
    | {
          event: "stopped";
          reason:
              | "turn_budget"
              | "retry_budget"
              | "time_budget"
              | "guard"
              | "incompatible";
      };

export function createTelemetryRecorder(
    appendEntry: ExtensionAPI["appendEntry"],
    now: () => number = Date.now,
): (event: AutopilotTelemetryEvent) => void {
    return (event) => {
        try {
            appendEntry(AUTOPILOT_TELEMETRY_ENTRY, {
                schemaVersion: AUTOPILOT_TELEMETRY_SCHEMA_VERSION,
                timestamp: new Date(now()).toISOString(),
                ...event,
            });
        } catch {
            // Session shutdown may make appendEntry unavailable. Telemetry is non-critical.
        }
    };
}
