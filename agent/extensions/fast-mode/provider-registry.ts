import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openaiFastMode } from "./providers/openai.ts";

const providers = [openaiFastMode];

export function getFastModeProvider(model: ExtensionContext["model"]) {
    return model
        ? providers.find((provider) => provider.supports(model))
        : undefined;
}
