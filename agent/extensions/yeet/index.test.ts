import { describe, it, expect, mock } from "bun:test";
import { executeCommit } from "./index";

describe("executeCommit", () => {
  it("should stage files, commit, and return SHA on success", async () => {
    let addArgs: string[][] = [];
    let commitArgs: string[][] = [];

    const mockExec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "add") {
        addArgs.push(args);
        return { stdout: "" };
      }
      if (cmd === "git" && args[0] === "commit") {
        commitArgs.push(args);
        return { stdout: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "abc1234\n" };
      }
      throw new Error("unexpected call: " + cmd + " " + args.join(" "));
    });

    const result = await executeCommit(mockExec, ["src/foo.ts", "src/bar.ts"], "feat: add foo");

    expect(result).toEqual({ success: true, sha: "abc1234" });
    expect(addArgs).toEqual([["add", "--", "src/foo.ts", "src/bar.ts"]]);
    expect(commitArgs).toEqual([["commit", "-m", "feat: add foo"]]);
    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it("should return error when git add fails", async () => {
    const mockExec = mock(async (_cmd: string, _args: string[]) => {
      throw new Error("fatal: pathspec 'nonexistent.ts' did not match any files");
    });

    const result = await executeCommit(mockExec, ["nonexistent.ts"], "msg");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("nonexistent.ts");
    }
  });

  it("should return error when git commit fails", async () => {
    const mockExec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "add") {
        return { stdout: "" };
      }
      throw new Error("nothing to commit");
    });

    const result = await executeCommit(mockExec, ["a.ts"], "msg");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("nothing to commit");
    }
  });

  it("should handle empty files array", async () => {
    const mockExec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "add") {
        return { stdout: "" };
      }
      if (cmd === "git" && args[0] === "commit") {
        return { stdout: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "def5678\n" };
      }
      throw new Error("unexpected: " + cmd + " " + args.join(" "));
    });

    const result = await executeCommit(mockExec, [], "chore: empty");

    expect(result).toEqual({ success: true, sha: "def5678" });
  });
});