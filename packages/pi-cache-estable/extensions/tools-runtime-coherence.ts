// Adaptada de upstream HEAD:.pi/extensions/tools-runtime-coherence.ts.
// Diagnóstico solamente en before_agent_start: no session_start, no census
// process.exit, no escritura durable, ni cambios en las tools activas.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseEnvFile } from "../lib/config.ts";
import { buildCensus, renderCoherenceDiagnostic } from "../lib/tools-runtime-coherence.ts";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    try {
      // null (instrumento no disponible) es distinto de [] (medición vacía).
      const received = pi.getActiveTools();
      if (!Array.isArray(received)) return undefined;
      const diagnostic = renderCoherenceDiagnostic(buildCensus({
        cwd: ctx.cwd,
        prompt: event.systemPrompt,
        env: parseEnvFile(ctx.cwd),
        penv: process.env,
        received,
      }));
      if (!diagnostic) return undefined;
      try {
        if (ctx.hasUI) ctx.ui.notify(diagnostic, "warning");
      } catch {
        // El aviso sigue en el prompt si la UI no funciona.
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${diagnostic}\n` };
    } catch {
      return undefined; // Diagnóstico best-effort; jamás decide autorización.
    }
  });
}
