import { expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagentsAddons from "./index";

it("stays dormant when the package config disables the addon", () => {
    const calls: string[] = [];
    const pi = new Proxy(
        {},
        {
            get: (_target, property) => (..._args: unknown[]) => {
                calls.push(String(property));
            },
        },
    ) as ExtensionAPI;

    registerSubagentsAddons(pi);

    expect(calls).toEqual([]);
});
