import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createWidget } from "../_shared/fancy-footer";
import { FILE_RELOAD_DEBOUNCE_MS } from "./constants";
import { registerCronCommand } from "./cron-command";
import { getCronTasksFilePath, loadStoredTasks, saveStoredTasks } from "./persistence";
import { LoopScheduler } from "./scheduler";
import { findMissedTasks, hydrateRuntimeTask, InMemoryTaskStore, RECURRING_EXPIRY_DAYS } from "./task-store";

/**
 * Session Cron Extension — periodic polling and monitoring during a session.
 *
 * Schedules recurring prompts that fire on an interval while the session
 * is active. Tasks fire between turns (when the agent is idle).
 */
export default function sessionCronExtension(pi: ExtensionAPI) {
	const store = new InMemoryTaskStore();
	let persistChain: Promise<void> = Promise.resolve();
	let fileWatcher: FSWatcher | null = null;
	let reloadTimer: ReturnType<typeof setTimeout> | null = null;

	function persistTasks(): void {
		persistChain = persistChain
			.then(() => saveStoredTasks(store.toStoredTasks()))
			.catch(() => undefined);
	}

	function scheduleReloadFromDisk(): void {
		if (reloadTimer) {
			clearTimeout(reloadTimer);
		}
		reloadTimer = setTimeout(() => {
			reloadTimer = null;
			void reloadFromDisk();
		}, FILE_RELOAD_DEBOUNCE_MS);
	}

	async function reloadFromDisk(): Promise<void> {
		const storedTasks = await loadStoredTasks();

		if (scheduler.isSchedulerOwner()) {
			// Owner: in-memory state is authoritative for existing tasks.
			// Only apply additions and deletions made by other sessions.
			// Never overwrite in-memory task state — that would cause double-fires
			// when the file watcher triggers from our own writes.
			const diskIds = new Set(storedTasks.map((t) => t.id));

			// Remove tasks deleted by another session
			for (const task of store.list()) {
				if (!diskIds.has(task.id)) {
					store.delete(task.id);
				}
			}
			// Add tasks created by another session
			for (const task of storedTasks) {
				if (!store.get(task.id)) {
					store.add(hydrateRuntimeTask(task));
				}
			}
			updateStatus();
			return;
		}

		// Passive session: full reload from disk
		store.replaceAll(storedTasks);
		updateStatus();
	}

	async function startFileWatcher(): Promise<void> {
		if (fileWatcher) return;
		const tasksFile = getCronTasksFilePath();
		const tasksDir = dirname(tasksFile);
		const tasksFileName = basename(tasksFile);
		try {
			await mkdir(tasksDir, { recursive: true });
			fileWatcher = watch(tasksDir, (_eventType, changedFile) => {
				if (changedFile !== null && changedFile !== tasksFileName) return;
				scheduleReloadFromDisk();
			});
		} catch {
			fileWatcher = null;
		}
	}

	function stopFileWatcher(): void {
		fileWatcher?.close();
		fileWatcher = null;
		if (reloadTimer) {
			clearTimeout(reloadTimer);
			reloadTimer = null;
		}
	}

	const scheduler = new LoopScheduler(pi, store, {
		onStatusChange: () => {
			updateStatus();
			persistTasks();
		},
		onTaskExpired: (task) => {
			if (!latestCtx?.hasUI) return;
			latestCtx.ui.notify(
				`Cron task ${task.id} expired after its final run (${RECURRING_EXPIRY_DAYS}-day limit)`,
				"info",
			);
		},
		onOwnershipAcquired: async () => {
			if (!latestCtx) return;
			await restoreOwnedTasks(latestCtx);
		},
	});

	const w = createWidget(pi, {
		id: "pi-agent-kit.session-cron",
		label: "Cron",
		description: "Scheduled cron tasks for the current session.",
		row: 1,
		order: 10,
		align: "right",
		grow: false,
		render: () => {
			if (store.size() === 0) return null;
			const isOwner = scheduler.isSchedulerOwner();
			return {
				text: `cron:${store.size()}${isOwner ? "" : " passive"}`,
				textColor: isOwner ? "success" as const : "muted" as const,
			};
		},
	});

	let latestCtx: ExtensionContext | null = null;

	function setContext(ctx: ExtensionContext): void {
		latestCtx = ctx;
		scheduler.setContext(ctx);
	}

	function updateStatus(): void {
		w.update(latestCtx!);
	}

	async function restoreOwnedTasks(ctx: ExtensionContext): Promise<void> {
		const storedTasks = await loadStoredTasks();
		const now = Date.now();
		const missedTasks = findMissedTasks(storedTasks, now);
		const immediateIds = new Set<string>();
		const declinedOneShots = new Set<string>();

		for (const task of missedTasks) {
			if (task.recurring) {
				immediateIds.add(task.id);
				continue;
			}

			if (ctx.hasUI) {
				const shouldRunNow = await ctx.ui.confirm(
					`Run missed loop task ${task.id}?`,
					[
						`This one-shot loop task was missed while the session was offline:`,
						"",
						`Schedule: ${task.humanLabel}`,
						`Prompt: ${task.prompt}`,
						"",
						"Run it now?",
					].join("\n"),
				);
				if (shouldRunNow) {
					immediateIds.add(task.id);
				} else {
					declinedOneShots.add(task.id);
				}
			} else {
				declinedOneShots.add(task.id);
			}
		}

		const restoredTasks = storedTasks.filter((task) => !declinedOneShots.has(task.id));
		store.replaceAll(restoredTasks, immediateIds);
		updateStatus();
		persistTasks();
		if (immediateIds.size > 0) {
			scheduler.fireDueTasks();
		}
		if (ctx.hasUI && missedTasks.length > 0) {
			const recurringCount = missedTasks.filter((task) => task.recurring).length;
			const oneShotCount = missedTasks.length - recurringCount;
			const parts: string[] = [];
			if (recurringCount > 0) {
				parts.push(`${recurringCount} recurring resumed immediately`);
			}
			if (oneShotCount > 0) {
				parts.push(`${oneShotCount} one-shot task${oneShotCount === 1 ? "" : "s"} reviewed`);
			}
			ctx.ui.notify(`Recovered missed loop tasks: ${parts.join(", ")}`, "info");
		}
	}

	pi.on("agent_start", async () => {
		scheduler.setAgentBusy(true);
	});

	pi.on("agent_end", async (_event, ctx) => {
		scheduler.setAgentBusy(false);
		setContext(ctx);
		scheduler.fireDueTasks();
	});

	pi.on("session_start", async (_event, ctx) => {
		setContext(ctx);
		store.replaceAll(await loadStoredTasks());
		updateStatus();
		await persistChain;
		await startFileWatcher();
		await scheduler.start();
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		stopFileWatcher();
		await scheduler.stop();
		persistTasks();
		await persistChain;
	});

	registerCronCommand(pi, {
		store,
		scheduler,
		updateStatus,
		onTasksChanged: persistTasks,
		setContext,
	});
}
