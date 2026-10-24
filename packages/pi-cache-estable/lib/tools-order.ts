// Order only: never registers/activates a tool and never expands permissions.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ToolsOrderPolicy {
  version: 1;
  priority: string[];
  unlisted: "alphabetical";
}

export function parseToolsOrder(raw: unknown): ToolsOrderPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (Object.keys(p).some(k => !["version", "priority", "unlisted"].includes(k))) return null;
  if (p.version !== 1 || p.unlisted !== "alphabetical" || !Array.isArray(p.priority) || !p.priority.length) return null;
  if (p.priority.some(x => typeof x !== "string" || !/^[a-z][a-z0-9_]*(\*)?$/.test(x))) return null;
  if (new Set(p.priority).size !== p.priority.length) return null;
  return { version: 1, priority: [...p.priority] as string[], unlisted: "alphabetical" };
}

export function readToolsOrder(cwd: string): ToolsOrderPolicy | null {
  try { return parseToolsOrder(JSON.parse(readFileSync(join(cwd, ".pi", "tools-order.json"), "utf8"))); }
  catch { return null; } // absent/invalid is transparent; it cannot open tools
}

const ascii = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function canonicalToolNames(names: string[], policy: ToolsOrderPolicy): string[] {
  const rank = (name: string): number => {
    const i = policy.priority.findIndex(rule => rule.endsWith("*") ? name.startsWith(rule.slice(0, -1)) : name === rule);
    return i < 0 ? policy.priority.length : i;
  };
  // Rules rank selected names only. Wildcards never invent registered names.
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || ascii(a, b));
}

export function sameToolMembership(a: string[], b: string[]): boolean {
  const aa = new Set(a), bb = new Set(b);
  return aa.size === bb.size && [...aa].every(name => bb.has(name));
}
