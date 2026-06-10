# Plannotator Extension Exports Analysis

This report details the exports of the `@plannotator/pi-extension` and how they can be used to build a bridge extension.

## 1. Core Entry Point

### `index.ts`
- **`default export: plannotator(pi: ExtensionAPI): void`**
  - The main initialization function. It registers all commands (e.g., `/plannotator`, `/plannotator-review`, `/plannotator-annotate`), tools (e.g., `plannotator_submit_plan`), and event listeners that drive the extension's logic.

## 2. Browser-Based UI Interactions

### `plannotator-browser.ts`
This file contains the primary functions for launching and interacting with the visual browser components.

#### **Plan Review**
- **`openPlanReviewBrowser(ctx: ExtensionContext, planContent: string): Promise<PlanReviewDecision>`**
  - High-level function that launches the plan review UI and waits for the user's decision.
- **`startPlanReviewBrowserSession(ctx: ExtensionContext, planContent: string): Promise<PlanReviewBrowserSession>`**
  - Low-level function that starts the session and returns a controller.
- **`PlanReviewBrowserSession` (Type/Interface)**
  - Extends `BrowserDecisionSession<PlanReviewDecision>`.
  - Includes `reviewId: string` and `onDecision: (listener: ...) => () => void`.

#### **Code Review**
- **`openCodeReview(ctx: ExtensionContext, options?: ...): Promise<{ approved: boolean; feedback?: string; annotations?: unknown[]; agentSwitch?: string; exit?: boolean }>`**
  - High-level function to open the code review UI (handles both local diffs and remote PRs).
- **`startCodeReviewBrowserSession(ctx: ExtensionContext, options?: ...): Promise<BrowserDecisionSession<{...}>>`**
  - Low-level function for managing a code review session.

#### **Annotation**
- **`openMarkdownAnnotation(ctx: ExtensionContext, filePath: string, markdown: string, mode: AnnotateMode, ...): Promise<{ feedback: string; exit?: boolean; approved?: boolean; selectedMessageId?: string; feedbackScope?: "message" | "messages" }>`**
  - Opens the annotation UI for a specific file or folder.
- **`openLastMessageAnnotation(ctx: ExtensionContext, lastText: string, gate?: boolean, ...): Promise<{ feedback: string; ... }>`**
  - Opens the annotation UI specifically targeting the last assistant message.
- **`startMarkdownAnnotationSession(...)`** and **`startLastMessageAnnotationSession(...)`**
  - Low-level session starters returning `BrowserDecisionSession`.

#### **Utility & Archive**
- **`hasPlanBrowserHtml(): boolean`**: Checks if the required HTML assets are loaded.
- **`hasReviewBrowserHtml(): boolean`**: Checks if the code review HTML assets are loaded.
- **`openArchiveBrowserAction(ctx: ExtensionContext, customPlanPath?: string): Promise<{ opened: boolean }>`**: Opens the visual plan archive.

## 3. Event-Driven Communication

### `plannotator-events.ts`
- **`registerPlannotatorEventListeners(pi: ExtensionAPI): void`**
  - This is the "glue" that allows the browser-side UI to communicate back to the Pi extension. 
  - It listens for requests on the `PLANNOTATOR_REQUEST_CHANNEL` (e.g., `plan-review`, `code-review`, `annotate`).
  - It emits results on the `PLANNOTATOR_REVIEW_RESULT_CHANNEL` once a user makes a decision in the browser.

## 4. Constants and Scopes

### `tool-scope.ts`
- **`PLAN_SUBMIT_TOOL`**: The string `"plannotator_submit_plan"`. This is the tool the agent calls to trigger a plan review.

## 5. Key Types

| Type | Description |
| :--- | :--- |
| `PlanReviewDecision` | `{ approved: boolean; feedback?: string; savedPath?: string; agentSwitch?: string; permissionMode?: string; }` |
| `BrowserDecisionSession<T>` | `{ url: string; waitForDecision: () => Promise<T>; stop: () => void; }` |
| `AnnotateMode` | `"annotate" \| "annotate-folder" \| "annotate-last"` |

## How They Work Together (The Workflow)

1.  **Trigger**: An agent calls a tool (e.g., `plannotator_submit_plan`) or a user runs a command (e.g., `/plannotator-review`).
2.  **Session Start**: The extension calls a `start...BrowserSession` function. This:
    - Starts a local HTTP server.
    - Opens the system browser to the server's URL.
    - Returns a `BrowserDecisionSession` object.
3.  **Interaction**: The user interacts with the web UI in the browser.
4.  **Request (Browser $\to$ Extension)**: The browser UI sends a request via a WebSocket/Event channel using the `PLANNOTATOR_REQUEST_CHANNEL`. The `registerPlannotatorEventListeners` handler in the extension receives this.
5.  **Decision (Browser $\to$ Extension)**: Once the user clicks "Approve" or "Deny", the browser sends a message. The server-side component of the extension catches this and emits it via the `PLANNOTATOR_REVIEW_RESULT_CHANNEL`.
6.  **Resolution (Extension $\to$ Agent)**: The `waitForDecision()` promise in the extension resolves with the `PlanReviewDecision`. The extension then uses `pi.sendUserMessage` to feed the feedback back to the agent, completing the loop.
