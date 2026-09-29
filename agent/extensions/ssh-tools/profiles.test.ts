import { describe, expect, it } from "bun:test";
import {
    type SshProfile,
    normalizeTargetArg,
    resolveRemoteCwd,
} from "./profiles.ts";

const profiles: SshProfile[] = [
    { name: "devlab", remote: "devlab" },
    { name: "clawd", remote: "clawd" },
];

describe("normalizeTargetArg", () => {
    it("uses a known profile as given", () => {
        expect(normalizeTargetArg("devlab", profiles)).toEqual({
            name: "devlab",
            remote: "devlab",
        });
    });

    it("trims surrounding whitespace before matching", () => {
        expect(normalizeTargetArg("  devlab  ", profiles).remote).toBe("devlab");
    });

    it("splits an explicit remote working directory", () => {
        expect(normalizeTargetArg("devlab:/home/dev", profiles)).toEqual({
            name: "devlab:/home/dev",
            remote: "devlab",
            cwd: "/home/dev",
        });
    });

    it("accepts a user@host target with no profile", () => {
        expect(normalizeTargetArg("deploy@10.0.0.5", profiles)).toEqual({
            name: "deploy@10.0.0.5",
            remote: "deploy@10.0.0.5",
        });
    });

    it("prefers a known profile over colon splitting for a bare alias", () => {
        expect(normalizeTargetArg("devlab", profiles).cwd).toBeUndefined();
    });
});

describe("resolveRemoteCwd", () => {
    it("returns an explicit working directory without contacting the host", async () => {
        await expect(
            resolveRemoteCwd({
                name: "fixture",
                remote: "unreachable-host",
                cwd: "/repo",
            }),
        ).resolves.toBe("/repo");
    });

    it("trims an explicit working directory", async () => {
        await expect(
            resolveRemoteCwd({
                name: "fixture",
                remote: "unreachable-host",
                cwd: "  /repo  ",
            }),
        ).resolves.toBe("/repo");
    });

    it("strips a trailing separator from an explicit working directory", async () => {
        await expect(
            resolveRemoteCwd({
                name: "fixture",
                remote: "unreachable-host",
                cwd: "/repo/",
            }),
        ).resolves.toBe("/repo");
    });

    it("rejects a relative explicit working directory", async () => {
        // A relative remote cwd would make every relative path resolve against
        // the local session directory, which is the bug this extension exists to
        // prevent. Fail loudly at activation instead.
        await expect(
            resolveRemoteCwd({
                name: "devlab",
                remote: "devlab",
                cwd: "repo",
            }),
        ).rejects.toThrow("absolute path");
    });

    it("rejects a dot working directory with a readable message", async () => {
        await expect(
            resolveRemoteCwd({
                name: "devlab",
                remote: "devlab",
                cwd: ".",
            }),
        ).rejects.toThrow("/ssh devlab:/absolute/path");
    });
});
