import { describe, expect, it } from "bun:test";
import {
    assertInsideRemoteCwd,
    normalizeRemoteDir,
    resolveRemotePath,
    resolveSandboxedRemotePath,
    shellQuote,
} from "./remote-path.ts";

describe("shellQuote", () => {
    it("wraps a plain value in single quotes", () => {
        expect(shellQuote("/home/dev/ufw.conf")).toBe("'/home/dev/ufw.conf'");
    });

    it("neutralizes an embedded single quote", () => {
        expect(shellQuote("a'b")).toBe(`'a'"'"'b'`);
    });
});

describe("normalizeRemoteDir", () => {
    it("strips trailing separators", () => {
        expect(normalizeRemoteDir("/home/dev/")).toBe("/home/dev");
    });

    it("keeps the filesystem root", () => {
        expect(normalizeRemoteDir("/")).toBe("/");
    });
});

describe("resolveRemotePath", () => {
    it("resolves a relative name under the remote working directory", () => {
        expect(resolveRemotePath("notes.md", "/home/dev")).toBe(
            "/home/dev/notes.md",
        );
    });

    it("resolves a relative path under the remote working directory", () => {
        expect(resolveRemotePath("./a/b.md", "/home/dev")).toBe(
            "/home/dev/a/b.md",
        );
    });

    it("keeps an absolute remote path unchanged", () => {
        expect(resolveRemotePath("/etc/ufw/ufw.conf", "/home/dev")).toBe(
            "/etc/ufw/ufw.conf",
        );
    });

    it("tolerates a trailing separator on the remote working directory", () => {
        expect(resolveRemotePath("notes.md", "/home/dev/")).toBe(
            "/home/dev/notes.md",
        );
    });

    it("normalizes away interior duplicate separators", () => {
        expect(resolveRemotePath("/etc//ufw/ufw.conf", "/home/dev")).toBe(
            "/etc/ufw/ufw.conf",
        );
    });

    it("rejects a relative path that escapes the remote working directory", () => {
        expect(() => resolveRemotePath("../escape", "/home/dev")).toThrow(
            "outside the active SSH working directory /home/dev",
        );
    });

    it("rejects a relative path that escapes through a deeper traversal", () => {
        expect(() => resolveRemotePath("a/../../escape", "/home/dev")).toThrow(
            "outside the active SSH working directory /home/dev",
        );
    });

    it("never emits a local platform separator", () => {
        expect(resolveRemotePath("a/b.md", "/home/dev")).not.toContain("\\");
    });
});

describe("assertInsideRemoteCwd", () => {
    it("accepts a path inside the remote working directory", () => {
        expect(assertInsideRemoteCwd("/home/dev/app.conf", "/home/dev")).toBe(
            "/home/dev/app.conf",
        );
    });

    it("accepts the remote working directory itself", () => {
        expect(assertInsideRemoteCwd("/home/dev", "/home/dev")).toBe(
            "/home/dev",
        );
    });

    it("rejects a sibling path that shares a name prefix", () => {
        expect(() =>
            assertInsideRemoteCwd("/home/developer/notes.md", "/home/dev"),
        ).toThrow("outside the active SSH working directory /home/dev");
    });

    it("rejects an out-of-tree system path", () => {
        expect(() =>
            assertInsideRemoteCwd("/etc/ufw/ufw.conf", "/home/dev"),
        ).toThrow("outside the active SSH working directory /home/dev");
    });
});

describe("resolveSandboxedRemotePath", () => {
    it("resolves a relative path under the remote working directory", () => {
        expect(resolveSandboxedRemotePath("app.conf", "/home/dev")).toBe(
            "/home/dev/app.conf",
        );
    });

    it("accepts an absolute path inside the remote working directory", () => {
        expect(resolveSandboxedRemotePath("/home/dev/app.conf", "/home/dev")).toBe(
            "/home/dev/app.conf",
        );
    });

    it("rejects an absolute path outside the remote working directory", () => {
        expect(() =>
            resolveSandboxedRemotePath("/etc/ufw/ufw.conf", "/home/dev"),
        ).toThrow("outside the active SSH working directory /home/dev");
    });

    it("still rejects a relative path that escapes", () => {
        expect(() => resolveSandboxedRemotePath("../escape", "/home/dev")).toThrow(
            "outside the active SSH working directory /home/dev",
        );
    });

    it("rejects an absolute path that climbs out with ..", () => {
        expect(() =>
            resolveSandboxedRemotePath(
                "/home/dev/../../etc/ufw/ufw.conf",
                "/home/dev",
            ),
        ).toThrow("outside the active SSH working directory /home/dev");
    });

    it("rejects an absolute path that climbs out through a deeper ..", () => {
        expect(() =>
            resolveSandboxedRemotePath(
                "/home/dev/a/../../../etc/passwd",
                "/home/dev",
            ),
        ).toThrow("outside the active SSH working directory /home/dev");
    });

    it("normalizes an in-tree .. before the containment check", () => {
        expect(
            resolveSandboxedRemotePath("/home/dev/a/../b.conf", "/home/dev"),
        ).toBe("/home/dev/b.conf");
    });

    it("rejects a path containing a Unicode space pi would rewrite", () => {
        expect(() =>
            resolveSandboxedRemotePath("/home/dev/a\u00a0b.conf", "/home/dev"),
        ).toThrow("Unicode space");
    });
});

describe("assertInsideRemoteCwd with traversal", () => {
    it("rejects .. that climbs out of the remote working directory", () => {
        expect(() =>
            assertInsideRemoteCwd("/home/dev/../etc/passwd", "/home/dev"),
        ).toThrow("outside the active SSH working directory /home/dev");
    });

    it("rejects repeated .. that climbs above the remote filesystem root", () => {
        expect(() =>
            assertInsideRemoteCwd("/../../etc/passwd", "/home/dev"),
        ).toThrow("outside the active SSH working directory /home/dev");
    });

    it("clamps .. at the filesystem root instead of escaping it", () => {
        expect(assertInsideRemoteCwd("/../../etc/passwd", "/")).toBe(
            "/etc/passwd",
        );
    });
});

describe("resolveRemotePath normalization", () => {
    it("resolves .. inside an absolute path", () => {
        expect(resolveRemotePath("/home/dev/a/../b.conf", "/home/dev")).toBe(
            "/home/dev/b.conf",
        );
    });

    it("rejects a relative remote working directory instead of returning a relative path", () => {
        expect(() => resolveRemotePath("file.txt", "repo")).toThrow(
            "absolute path",
        );
    });

    it("rejects a Unicode space that pi would rewrite to an ASCII space", () => {
        expect(() =>
            resolveRemotePath("/home/dev/a\u00a0b.conf", "/home/dev"),
        ).toThrow("Unicode space");
    });

    it("rejects every Unicode space class pi normalizes", () => {
        for (const character of [
            "\u00a0",
            "\u2000",
            "\u200a",
            "\u202f",
            "\u205f",
            "\u3000",
        ]) {
            expect(() =>
                resolveRemotePath(`/home/dev/a${character}b.conf`, "/home/dev"),
            ).toThrow("Unicode space");
        }
    });

    it("allows an ordinary ASCII space in a remote path", () => {
        expect(resolveRemotePath("/home/dev/my app.conf", "/home/dev")).toBe(
            "/home/dev/my app.conf",
        );
    });
});
