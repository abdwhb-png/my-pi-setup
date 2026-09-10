declare module "pi-agent-browser-native/dist/extensions/agent-browser/index.js" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

  const agentBrowserExtension: (pi: ExtensionAPI) => void;
  export default agentBrowserExtension;
}
