---
description: Hand off the current task to a dedicated Herdr tab
argument-hint: '<destination goal or next phase>'
role: pi-agent
---

Hand off the current conversation to a Pi session in a dedicated Herdr tab.

Destination task: ${@:-deduct task from discussion}

Use Herdr only.

1. Inspect existing Herdr tabs, panes, and agents.
2. Reuse a suitable agent already running in a dedicated tab. Ask the user if several destinations fit or reuse is ambiguous.
3. Otherwise create a new tab in the current workspace. Never use a split pane. Start one Pi agent there with a short, unique, task-specific name. Choose the final layout before starting the agent; never close and relaunch it merely to move it.
4. Build a concise handoff from the current conversation. Include:
   - goal and requested starting phase;
   - verified findings, assumptions, and unresolved questions;
   - decisions, rejected options, and reasons;
   - constraints and approval gates;
   - relevant repositories, files, commands, documentation, and skills;
   - local Git state and user changes to preserve;
   - completed validation and missing checks;
   - exact first action expected from the destination.
5. Redact secrets, credentials, sensitive request bodies, and unnecessary raw logs.
6. Submit one complete prompt to the destination agent. Preserve the requested phase:
   - planning: prepare a plan and wait for approval before implementation;
   - implementation: include the approved plan and acceptance criteria;
   - diagnosis: reproduce or verify the failure before proposing a fix.
7. Focus the destination tab.
8. Report the tab label, agent name, whether it was reused or created, starting phase, and any delivery problem.

Do not use a split pane, intercom, subagents, or another delegation mechanism. Do not duplicate the handed-off work, wait for its completion, close the source session, or perform the destination task in this session.
