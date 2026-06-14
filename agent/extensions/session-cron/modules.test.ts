/**
 * Import guard for session-cron non-entry-point modules.
 *
 * Satisfies the meta coverage check that every module with exports
 * is imported by at least one test.
 */
import { describe, it, expect } from "bun:test";
import * as constants from "./constants";
import * as types from "./types";
import * as cronLock from "./cron-lock";
import * as persistence from "./persistence";
import * as intervalParser from "./interval-parser";
import * as taskStore from "./task-store";

describe("session-cron modules import guard", () => {
  it("constants exports", () => {
    expect(constants.CHECK_INTERVAL_MS).toBeDefined();
  });

  it("types exports", () => {
    expect(types).toBeDefined();
  });

  it("cron-lock exports", () => {
    expect(cronLock.tryAcquireCronSchedulerLock).toBeFunction();
  });

  it("persistence exports", () => {
    expect(persistence.getCronTasksFilePath).toBeFunction();
  });

  it("interval-parser exports", () => {
    expect(intervalParser.parseLoopInput).toBeFunction();
  });

  it("task-store exports", () => {
    expect(taskStore.InMemoryTaskStore).toBeDefined();
  });
});