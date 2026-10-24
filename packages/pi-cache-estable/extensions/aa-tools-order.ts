// Canonical order, not a new authorization boundary. Without tools-order.json
// the scoped adapter is transparent. It never activates a tool by itself.
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installToolsOrderAdapter } from "../lib/tools-order-runtime.ts";

export default function (pi: ExtensionAPI) {
  const release = installToolsOrderAdapter(AgentSession);
  // No handlers or writes during a human turn; shutdown unwinds before /reload
  // installs the next generation. Other owners' wrappers are not overwritten.
  pi.on("session_shutdown", () => release());
}
