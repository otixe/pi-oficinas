// ÚLTIMO-BUENO del registro de líderes (tarea c4f438d6, mitigación cliente de c5aa6829).
//
// POR QUÉ EXISTE: /agents/registry tarda 16-17 s en frío (medido, c5aa6829) y el
// barrido F4 lo pide con AbortSignal.timeout(15_000) cada 2 min — eso produce
// TimeoutError sostenido (18 fallos consecutivos del barrido en una líder; ~30% de
// los barridos en otra desde que se midió). El arreglo de fondo (servidor) es tarea
// aparte; esto es SÓLO la mitigación del lado del cliente: cuando el GET corta, usar
// el último conjunto de líderes válido conocido, con una ventana de confianza acotada.
//
// RIESGO ACEPTADO Y POR QUÉ SE ACEPTA: un líder dado de baja en el registro
// real puede seguir siendo aceptado por este cliente hasta TTL_MS (15 min)
// después de la última lectura fresca que lo vio. Se acepta ese riesgo porque
// (a) la ventana es corta y declarada, (b) el fail-closed de HOY (no timbrar
// si el registro no se puede leer) seguía disponible pero por culpa del
// timeout corto nunca se amortizaba con una caché — con una caché de 15 min
// la mayoría de los barridos deja de fallar sin abrir una ventana de
// confianza larga, y (c) la propia Correspondencia exige que el REMITENTE sea
// un líder registrado antes de timbrar: aceptar un nombre que dejó de ser
// líder sólo manda un timbre informativo al líder local, no concede ninguna
// escritura ni autoridad nueva.
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from './secretaria-state.ts';
import { leaderNamesFromRegistry } from './secretaria-correspondence.ts';

export const LEADER_REGISTRY_TTL_MS = 15 * 60_000;
/** 30 s: más que los 15-17 s medidos en frío (Rias, c5aa6829), para que la caché
 *  del servidor alcance a llenarse antes de cortar. */
export const LEADER_REGISTRY_TIMEOUT_MS = 30_000;

export interface LastGoodLeaderRegistry {
  /** ISO de cuándo se confirmó este conjunto como válido contra /agents/registry. */
  at: string;
  /** Nombres de líder en minúsculas, tal como los devuelve leaderNamesFromRegistry. */
  leaders: string[];
}

function registryStatePath(stateDirectory: string): string {
  return join(stateDirectory, 'secretaria-registro-lideres.json');
}

/** Guarda SIEMPRE el conjunto fresco y válido más reciente (0600, vía writePrivateJson). */
export function persistLastGoodLeaders(stateDirectory: string, leaders: ReadonlySet<string>, now = Date.now()): void {
  const value: LastGoodLeaderRegistry = { at: new Date(now).toISOString(), leaders: [...leaders].sort() };
  writePrivateJson(registryStatePath(stateDirectory), value);
}

function wellFormed(raw: unknown): raw is LastGoodLeaderRegistry {
  return !!raw && typeof raw === 'object' && typeof (raw as any).at === 'string' &&
    Number.isFinite(Date.parse((raw as any).at)) && Array.isArray((raw as any).leaders) &&
    (raw as any).leaders.every((x: unknown) => typeof x === 'string' && x.length > 0);
}

/**
 * Lee el último-bueno y lo devuelve SOLO si existe, está bien formado y no superó TTL_MS.
 * Ausente, malformado o vencido -> null: el llamador debe fail-closed, igual que hoy.
 */
export function readLastGoodLeaders(stateDirectory: string, now = Date.now(), ttlMs = LEADER_REGISTRY_TTL_MS): Set<string> | null {
  let raw: unknown;
  try { raw = readPrivateJson<unknown>(registryStatePath(stateDirectory), null); }
  catch { return null; } // estado local inseguro/corrupto: tratar como ausente, nunca lanzar.
  if (!wellFormed(raw)) return null;
  const ageMs = now - Date.parse(raw.at);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttlMs) return null;
  return new Set(raw.leaders);
}

export interface LeaderRegistryResolution {
  /** null sólo cuando no hay fresco Y no hay último-bueno vigente: fail-closed, sin timbrar. */
  leaders: Set<string> | null;
  source: 'fresh' | 'last-good' | 'fail-closed';
  /** Mensaje del intento fresco fallido (ya incluye ruta+ms si viene de fetchCerebro/timedFetch), para loguear SIEMPRE aunque se recupere con el último-bueno. */
  fetchError?: string;
}

/**
 * Resuelve el conjunto de líderes: intenta `fetchRegistry` fresco; si falla o devuelve una
 * forma inválida, cae al último-bueno (si está vigente); si tampoco hay, fail-closed (null).
 * Un éxito fresco SIEMPRE reemplaza el último-bueno persistido — un líder dado de baja del
 * registro real deja de valer en el próximo barrido que logre un fetch fresco.
 */
export async function resolveLeaderNames(stateDirectory: string, fetchRegistry: () => Promise<unknown>, now = Date.now()): Promise<LeaderRegistryResolution> {
  let freshLeaders: Set<string> | null = null, fetchError: string | undefined;
  try {
    const raw = await fetchRegistry();
    freshLeaders = leaderNamesFromRegistry(raw);
    if (!freshLeaders) fetchError = 'Registro de líderes con forma inválida';
  } catch (e) { fetchError = String(e); }
  if (freshLeaders) { persistLastGoodLeaders(stateDirectory, freshLeaders, now); return { leaders: freshLeaders, source: 'fresh' }; }
  const lastGood = readLastGoodLeaders(stateDirectory, now);
  if (lastGood) return { leaders: lastGood, source: 'last-good', fetchError };
  return { leaders: null, source: 'fail-closed', fetchError };
}

