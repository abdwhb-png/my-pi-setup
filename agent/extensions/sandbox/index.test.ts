import { describe, expect, it } from "bun:test";
import { buildSandboxShellEnv } from "./index";

describe("buildSandboxShellEnv", () => {
	it("prepends agent bin dir to PATH when missing", () => {
		const env = buildSandboxShellEnv(
			{ PATH: "/usr/local/bin:/usr/bin" },
			"/home/abdwhb/.pi/agent",
		);
		expect(env.PATH).toBe("/home/abdwhb/.pi/agent/bin:/usr/local/bin:/usr/bin");
	});

	it("does not duplicate agent bin dir when already present", () => {
		const env = buildSandboxShellEnv(
			{ PATH: "/home/abdwhb/.pi/agent/bin:/usr/local/bin:/usr/bin" },
			"/home/abdwhb/.pi/agent",
		);
		expect(env.PATH).toBe("/home/abdwhb/.pi/agent/bin:/usr/local/bin:/usr/bin");
	});

	it("preserves alternate path key casing", () => {
		const env = buildSandboxShellEnv(
			{ Path: "/usr/local/bin:/usr/bin" },
			"/home/abdwhb/.pi/agent",
		);
		expect(env.Path).toBe("/home/abdwhb/.pi/agent/bin:/usr/local/bin:/usr/bin");
	});
});