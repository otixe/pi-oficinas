import {readFileSync} from "node:fs";
import {join} from "node:path";
export function parseEnvFile(cwd: string): Record<string,string> {
  const values: Record<string,string> = {};
  try {
    for (const line of readFileSync(join(cwd,'.env'),'utf8').split(/\r?\n/)) {
      const match=/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      if (Object.hasOwn(values,match[1])) return {};
      let value=match[2];
      if (/^["']/.test(value)) { if(value.at(-1)!==value[0])return {}; value=value.slice(1,-1); }
      else value=value.replace(/\s+#.*$/,'').trim();
      values[match[1]]=value;
    }
  } catch { /* missing configuration is inactive */ }
  return values;
}
