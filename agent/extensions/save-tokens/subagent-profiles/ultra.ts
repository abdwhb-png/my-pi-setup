import { applyUltraSubagentProfile } from "../subagent-profile.ts";

/**
 * Attach this extension through subagentOnlyExtensions to give a child
 * Caveman and Ponytail ultra defaults without changing the parent session.
 */
export default function ultraSubagentProfile(): void {
    applyUltraSubagentProfile();
}
