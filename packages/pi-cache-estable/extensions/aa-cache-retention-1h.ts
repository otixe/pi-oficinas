import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** Installing this package opts into extended provider caching unless explicitly configured otherwise.
 * Provider support/pricing vary; this is not a promise of a hit or a fixed TTL. */
export default function (_pi: ExtensionAPI) {
  if (!process.env.PI_CACHE_RETENTION) process.env.PI_CACHE_RETENTION = process.env.PI_CACHE_ESTABLE_RETENTION || "long";
}
