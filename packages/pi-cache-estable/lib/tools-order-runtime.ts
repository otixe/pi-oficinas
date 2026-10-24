// Version-scoped Pi adapter. Each extension has a DIFFERENT ExtensionAPI object,
// so wrapping pi.setActiveTools in one extension does not cover other writers.
// All writers delegate to AgentSession.setActiveToolsByName. All host loadouts
// (registry refresh, restore, reload, request preparation) use _applyToolLoadout.
// Decorate those shared methods, NEVER tool registry, execution or auth guards.
import { canonicalToolNames, readToolsOrder, sameToolMembership, type ToolsOrderPolicy } from "./tools-order.ts";

const SLOT = Symbol.for("pi.cache-estable.tools-order.adapter.v1");
interface State {
  references: number;
  policies: Map<string, ToolsOrderPolicy | null>;
  originalSet: (...args: any[]) => any;
  originalApply: (...args: any[]) => any;
  wrappedSet: (...args: any[]) => any;
  wrappedApply: (...args: any[]) => any;
}

export function installToolsOrderAdapter(Session: { prototype: any }): () => void {
  const proto = Session.prototype;
  for (const name of ["setActiveToolsByName", "getActiveToolNames", "_applyToolLoadout", "_getToolExposure", "_isActivatable"]) {
    if (typeof proto[name] !== "function") throw new Error(`TOOLS_ORDER_UNSUPPORTED_HOST: ${name}`);
  }
  let state: State | undefined = Object.prototype.hasOwnProperty.call(proto, SLOT) ? proto[SLOT] : undefined;
  if (!state) {
    const policies = new Map<string, ToolsOrderPolicy | null>();
    const policyFor = (session: any): ToolsOrderPolicy | null => {
      // Public cwd is authoritative even when a transcript is opened elsewhere.
      const cwd = session.sessionManager?.getCwd?.();
      if (typeof cwd !== "string") throw new Error("TOOLS_ORDER_UNSUPPORTED_HOST: SessionManager.getCwd");
      if (!policies.has(cwd)) policies.set(cwd, readToolsOrder(cwd));
      return policies.get(cwd) ?? null;
    };
    const originalSet = proto.setActiveToolsByName;
    const originalApply = proto._applyToolLoadout;
    const wrappedApply = function(this: any, names: string[], ...rest: any[]) {
      const policy = policyFor(this);
      // ALWAYS delegate metadata refresh. It can legitimately replace executors,
      // descriptions or prepareLoadout projections with unchanged membership.
      return originalApply.call(this, policy ? canonicalToolNames(names, policy) : names, ...rest);
    };
    const wrappedSet = function(this: any, names: string[], ...rest: any[]) {
      const policy = policyFor(this);
      if (!policy) return originalSet.call(this, names, ...rest);
      if (!(this._toolRegistry instanceof Map)) throw new Error("TOOLS_ORDER_UNSUPPORTED_HOST: tool registry");
      const ordered = canonicalToolNames(names, policy);
      // Preview using the HOST'S OWN guards, not a second permission model.
      // Unknown, hidden, or nonactivatable names do not make a no-op look new.
      const effective = ordered.filter(name => this._toolRegistry.has(name) && this._getToolExposure(name) !== "hidden" && this._isActivatable(name));
      if (sameToolMembership(this.getActiveToolNames(), effective)) return;
      return originalSet.call(this, ordered, ...rest);
    };
    state = { references: 0, policies, originalSet, originalApply, wrappedSet, wrappedApply };
    proto.setActiveToolsByName = wrappedSet;
    proto._applyToolLoadout = wrappedApply;
    Object.defineProperty(proto, SLOT, { value: state, configurable: true });
  }
  // Installing a new resource generation (/reload) re-reads the versioned file.
  state.policies.clear();
  state.references += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state!.references !== 0) return;
    // Do not overwrite an unrelated adapter layered later by someone else.
    if (proto.setActiveToolsByName === state!.wrappedSet) proto.setActiveToolsByName = state!.originalSet;
    if (proto._applyToolLoadout === state!.wrappedApply) proto._applyToolLoadout = state!.originalApply;
    if (proto[SLOT] === state) delete proto[SLOT];
  };
}
