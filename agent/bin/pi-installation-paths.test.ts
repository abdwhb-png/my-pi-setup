import { expect, test } from "bun:test";
import { resolvePiInstallationPaths } from "./pi-installation-paths.ts";

test("resolves installation paths independently from HOME", () => {
  expect(resolvePiInstallationPaths("/srv/alice/.pi")).toEqual({
    piRoot: "/srv/alice/.pi",
    agentDir: "/srv/alice/.pi/agent",
    runtimeRoot: "/srv/alice/.pi/runtime/pi-core",
    sourceRoot: "/srv/alice/projects/pi-core",
  });
});
