import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "node:url";
import { teamConfig, officeKeyEnv } from './team-config.ts';
export { teamConfig } from './team-config.ts';

/**
 * cerebro-identity.ts — resolvedor de identidad ÚNICO para las extensiones del
 * Cerebro (tarea bdf1381d, hallazgo H3-bis de auditor, gate 7f581065).
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 * ---------------------------------------------------------------------------
 * Hasta 2026-08-03 la lógica de "¿quién soy y con qué key le hablo al
 * Cerebro?" estaba DUPLICADA en dos archivos: `.pi/extensions/cerebro-mcp.ts`
 * (que registra las tools `cb_*`) y `.pi/extensions/cerebro-rest.ts` (que
 * registra `cerebro_fetch`). El fail-closed de H3 (tag `<active_agent>`
 * ilegible ⇒ error explícito, jamás la key del líder) se aplicó a
 * cerebro-mcp.ts y NO a cerebro-rest.ts, porque eran dos copias del mismo
 * algoritmo — el fix llegó a una y no a la otra. auditor lo encontró
 * (H3-bis): 9 de 12 variantes de formato del tag terminaban escribiendo con
 * la key del LÍDER vía `cerebro_fetch` (que es write-capable: POST + path
 * arbitrario ⇒ /memory/add, /vault/write, /task/*), exactamente lo que el
 * mensaje de error de `cb_*` promete evitar. Con dos tags anidados
 * (subagente lanzado por subagente) `cerebro_fetch` tomaba encima la
 * identidad del ANCESTRO, no la del hijo (bug de `.match()` sin `/g`).
 *
 * Este módulo es el ÚNICO resolvedor: las dos extensiones lo IMPORTAN y
 * ninguna vuelve a definir su propio regex de `<active_agent`. Si hace falta
 * tocar la resolución de identidad, se toca ACÁ — parchear el regex en cada
 * extensión por separado es exactamente la causa raíz que esto cierra.
 *
 * POR QUÉ VIVE EN `.pi/lib/` Y NO EN `.pi/extensions/`
 * ---------------------------------------------------------------------------
 * pi auto-descubre como extensión los archivos `.ts` sueltos que viven bajo
 * `.pi/extensions/` y los `index.ts` dentro de sus subcarpetas (docs/
 * extensions.md, tabla "Extension Locations"). Si este módulo viviera DENTRO
 * de `.pi/extensions/`, pi intentaría cargarlo como una extensión más — buscaría un `export default`
 * de tipo `(pi: ExtensionAPI) => void` que este archivo no tiene, o en el
 * mejor de los casos registraría tools espurias. Por eso vive un nivel más
 * arriba, en `.pi/lib/`, que pi no escanea.
 *
 * DECISIONES DE DISEÑO (heredadas de cerebro-mcp.ts, ahora centralizadas)
 * ---------------------------------------------------------------------------
 * 1. FAIL-CLOSED: si hay tag de subagente y NO existe su key propia, la
 *    identidad resuelve a key vacía + owner=AMBIGUOUS_OWNER o el nombre del
 *    subagente sin key. El LLAMADOR (cada extensión) debe erroriza explícito
 *    y JAMÁS caer a la key del líder — un fallback silencioso reintroduce el
 *    agujero de la tarea 4475d244, y lo vuelve invisible.
 * 2. CAMBIO 2026-09-25 (tarea 3dabc111): nombres DISTINTOS en el prompt
 *    implican ambigüedad y key vacía, no "elegir el último". En nuestro
 *    modelo no hay delegación anidada entre tipos distintos (las fichas del
 *    cuerpo no tienen la tool subagent y en oficinas las practicantes llevan
 *    el MISMO nombre que la dueña). La regla anterior de elegir el último
 *    sólo cubría un caso que no usamos y permitía que una cita de una sesión
 *    anterior, inyectada por continuidad tras el tag real, suplantara la key.
 *    Múltiples apariciones del MISMO nombre siguen siendo válidas.
 * 3. DETECCIÓN (`hasAgentTag`) y EXTRACCIÓN (`resolveAgentNameFromPrompt`) son
 *    dos preguntas separadas, deliberadamente, con regexes distintos: si
 *    comparten uno solo estricto, una deriva de formato del tag (comillas
 *    simples, atributo extra, mayúsculas, sin barra de cierre) hace que la
 *    extracción devuelva null, indistinguible de "no soy subagente" ⇒
 *    fail-OPEN. Medido por auditor sobre la versión pre-H3: de 8 variantes
 *    de formato, 6 terminaban con key de líder.
 * 4. SEGUNDA SEÑAL ante un RENAME upstream del tag (tarea 6c47914c, deriva de
 *    479992d4): si @gotgenes/pi-subagents renombrara `<active_agent>`,
 *    `hasAgentTag` da false y (sin este punto) `resolveIdentityFrom` caería a
 *    la rama LÍDER — el rename reintroduce H3 un nivel más arriba, ahora en
 *    la auth PRIMARIA de `cb_*` y `cerebro_fetch`. Medido ejecutando
 *    `buildAgentPrompt` del paquete VIVO v19.2.1
 *    (`.pi/npm/node_modules/@gotgenes/pi-subagents/src/session/prompts.ts`) y
 *    simulando el rename sobre su salida real: en modo "append" (el que usan
 *    los 8 agentes de `.pi/agents/*.md`, porque `config/custom-agents.ts`
 *    sólo da "replace" si el frontmatter lo declara explícito, y ninguno lo
 *    hace) el prompt del hijo agrega, ADEMÁS de `<active_agent>`,
 *    `<sub_agent_context>` y (si el agente tiene systemPrompt no vacío)
 *    `<agent_instructions>` — ninguno de los dos depende del literal
 *    `active_agent`, así que sobreviven al rename. `hasSubagentShape` es el OR
 *    de los tres: agrega detección, nunca la quita — si esos dos marcadores
 *    no existieran en la práctica, esta función se comporta IDÉNTICO a
 *    `hasAgentTag` y la regla queda INERTE (no regresiva). El LÍDER real no
 *    emite ninguno de los tres ⇒ su camino no se toca.
 *    LÍMITE ESTRUCTURAL, no de alcance: en modo "replace" (hoy sólo los
 *    builtins `Explore`/`Plan` de pi, ninguno propio) el emisor NO agrega ni
 *    `<sub_agent_context>` ni `<agent_instructions>` — tras un rename no queda
 *    NINGÚN marcador, indistinguible byte a byte de un prompt de líder.
 *    Ningún fix local puede cerrar eso; lo cubre sólo el canario
 *    (`tests/cerebro-mcp.test.ts` sección 8/11 + `scripts/canary/run.ts` vía
 *    timer systemd). No sobrevender esa cobertura como si fuera equivalente.
 *
 * 5. FALLO DE LECTURA DEL PROMPT = INCERTIDUMBRE, NUNCA LÍDER (tarea 6c47914c,
 *    remediación tras needs_changes de auditor, hallazgo H1, 2026-08-04):
 *    hasta esta remediación, cada extensión envolvía su llamada a
 *    `ctx.getSystemPrompt()` en un `try { ... } catch { return false; }`
 *    PROPIO (duplicado en cerebro-mcp.ts, cerebro-rest.ts y, con el predicado
 *    viejo, ops-brief.ts — ver punto 6). Si esa llamada LANZABA o
 *    devolvía `""`, la señal quedaba en `false` — exactamente la firma del
 *    LÍDER — y `resolveIdentityFrom` entregaba la key del líder EN SILENCIO.
 *    Mismo daño que el rename que motivó la tarea 6c47914c, por un evento MÁS
 *    probable (una API de pi, no un literal de un paquete de terceros) y sin
 *    un solo test que lo cubriera (0 de 166 checks).
 *    MEDIDO, no asumido, si existe un caso donde `getSystemPrompt()` devuelve
 *    `""` y el llamador ES el líder real DENTRO de un `execute()` de tool (la
 *    pregunta que dejó pendiente el gate): en `@earendil-works/pi-coding-agent`
 *    0.83+ instalado, `ExtensionContext.getSystemPrompt` (dist/core/
 *    extensions/runner.js) llama a `runner.getSystemPromptFn()`, cuyo default
 *    (`() => ""`) SOLO está activo ANTES de `ExtensionRunner.bindCore()` — una
 *    ventana anterior a que exista una sesión bindeada, y por lo tanto
 *    anterior a que CUALQUIER tool pueda estar corriendo `execute()` (las
 *    tools se registran en el factory de la extensión, pero se INVOCAN recién
 *    dentro del loop del agente, ya con `bindCore()` corrido). La única forma
 *    real, confirmada leyendo el código, en que la llamada FALLA (lanza) es
 *    `runner.assertActive()` tirando `this.staleMessage` tras un reload/fork —
 *    y eso le pasa IGUAL al líder que a un subagente: es una señal de
 *    LIFECYCLE (sesión stale), no de identidad. Ninguna de las dos ramas mide
 *    nada sobre quién está preguntando. Por eso ambas (throw y ""/falsy) se
 *    tratan IGUAL en `safeSubagentShapeSignal`: la incertidumbre resuelve
 *    AMBIGUOUS (vía `hasSubagentShapeSignal=true`), nunca LEADER. El costo
 *    del falso positivo está acotado (ver gate: el líder conserva las tools
 *    nativas `cerebro_*` porque el guard de `tool_call` bloquea por NOMBRE y
 *    ahí el nombre es `null`) — el mismo tradeoff ya aceptado para 13b.
 * 6. NO RE-IMPLEMENTAR LA DECISIÓN EN NINGÚN CONSUMIDOR (tarea 6c47914c,
 *    hallazgo H3 de auditor, gate 6c47914c-segunda-senal, 2026-08-04):
 *    `ops-brief.ts` importaba `hasAgentTag` (el predicado VIEJO, sin la
 *    segunda señal) y armaba su propio wrapper `tagPresent` con el mismo
 *    `catch { return false; }` de arriba — divergiendo de `cerebro-mcp.ts` y
 *    `cerebro-rest.ts`, que ya usaban `hasSubagentShape`. Es el patrón LITERAL
 *    de H3-bis (bdf1381d): el fix llegó a dos archivos y no al tercero,
 *    porque cada uno decidía por su cuenta QUÉ predicado pasarle a
 *    `resolveIdentityFrom`. Por eso `safeSubagentShapeSignal` existe ACÁ, no
 *    en cada extensión: cualquier consumidor que necesite la señal aditiva
 *    (para pasarla como 4º argumento de `resolveIdentityFrom`) la importa de
 *    este módulo, punto — nunca vuelve a escribir su propio `try/catch`
 *    alrededor de `ctx.getSystemPrompt()` ni elige a mano cuál de los
 *    predicados usar. La sección 7b de `tests/cerebro-mcp.test.ts` vigila
 *    esto estructuralmente (por PREDICADO, no por literal).
 *
 * Historia: 2026-08-03, extraído de `cerebro-mcp.ts` (que hasta ahora era la
 * única copia "arreglada") hacia este módulo, para que `cerebro-rest.ts` deje
 * de tener la suya propia, vieja y sin fail-closed. Ver tarea bdf1381d.
 * 2026-08-04 (tarea 6c47914c): agregada la segunda señal (punto 4) — ver
 * IDENTITY_BUILD para el marcador de build correspondiente.
 * 2026-08-04 (tarea 6c47914c, remediación post needs_changes): agregado
 * `safeSubagentShapeSignal` (puntos 5 y 6) y centralizado su consumo en las
 * tres extensiones — antes cada una tenía su propio wrapper.
 *
 * 7. EL INVARIANTE ES SOBRE EL RECURSO, NO SOBRE LA FORMA DEL CODIGO NI SOBRE
 *    EL GRAFO DE LLAMADAS (tarea 6c47914c, hallazgo R1 de auditor, gate
 *    "el-detector-por-llamada-tiene-su-cuarto-consumidor", 3ra vuelta,
 *    2026-08-04): `bootstrap-identity.ts` (antes de esta remediacion) NUNCA
 *    llamaba a `resolveIdentityFrom` -- tenia su PROPIA copia, literal, de la
 *    rama LEADER de este archivo (mismo orden de credenciales/header
 *    AUTH_HEADER) y decidia "soy lider o inyecto el bootstrap del subagente"
 *    con `hasAgentTag` (el predicado debil, sin la segunda senal). Dos
 *    preguntas ya se probaron insuficientes para encontrar esto: la seccion 7
 *    de tests/cerebro-mcp.test.ts pregunta "quien LEE el literal del tag?"
 *    (un problema distinto -- el tag de identidad, no la credencial) y la 7b
 *    pregunta "quien LLAMA a `resolveIdentityFrom`?" -- por construccion,
 *    ciega a quien NO la llama. La pregunta correcta es "quien ELIGE UNA
 *    CREDENCIAL?": nadie fuera de ESTE archivo puede leer la key de líder
 *    variante), ni el header de auth, ni construir ese header por su cuenta --
 *    `bootstrap-identity.ts` ahora obtiene su identidad EXCLUSIVAMENTE llamando a
 *    `resolveIdentityFrom` (con el MISMO predicado fuerte, via
 *    `safeSubagentShapeSignal`, que usan cb_*, cerebro_fetch y ops_brief -- su
 *    decision de "soy lider o subagente" ES esa decision, no una paralela) y
 *    construye el header con `AUTH_HEADER`, nunca con el nombre tipeado a
 *    mano. La seccion 15 de tests/cerebro-mcp.test.ts vigila esto
 *    estructuralmente, barriendo el repo entero por RECURSO (lectura de
 *    la variable de key (cualquier variante), o construccion del header), no por
 *    literal de tag ni por
 *    llamada a funcion. De paso, se elimino un SEGUNDO decisor menor: el
 *    `discoveryKey` de arranque de `cerebro-mcp.ts` tenia su propio fallback
 *    que releia la key o AUTH_HEADER directo si `bootIdentity.key` venia
 *    vacio -- hoy `bootIdentity.key` (ya resuelto via esta funcion) es la
 *    unica fuente.
 */

// Nombre del header de auth armado en runtime: el guard de security.ts aborta
// la tool si el literal aparece en texto plano en los ARGUMENTOS de la tool
// que lo escribe (no solo en su valor). No lo "simplifiques" a un string
// literal — eso es lo que rompería la próxima edición de este archivo.
const localTeamConfig = join(dirname(fileURLToPath(import.meta.url)), '..', 'equipo.json');
/** No config is a valid stand-alone agent; an explicit but invalid config is NOT. */
function optionalTeam(env: Record<string,string>, penv: Record<string,string|undefined>, legacyAnchorForTest?:string) {
  const explicit = Boolean(env.PI_OFICINAS_EQUIPO || penv.PI_OFICINAS_EQUIPO || process.env.PI_OFICINAS_EQUIPO || parseEnvFile(process.cwd()).PI_OFICINAS_EQUIPO);
  if (!explicit && !existsSync(localTeamConfig)) return null;
  return teamConfig(); // invalid/missing team fails closed, never falls back to agent identity
}
const bootEnv = parseEnvFile(process.cwd());
// Credential names come exclusively from explicit team configuration.
const configuredHeader = process.env.CEREBRO_AUTH_HEADER || bootEnv.CEREBRO_AUTH_HEADER || "X-API-Key";
export const AUTH_HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(configuredHeader) ? configuredHeader : "invalid-auth-header";
let bootTeam: ReturnType<typeof teamConfig> | null = null;
try { bootTeam = optionalTeam(bootEnv, process.env); } catch { /* resolution still rejects invalid config */ }
export const LEADER = bootTeam?.lider || (bootEnv.AGENT_NAME || process.env.AGENT_NAME || "agent").toLowerCase();

/** Owner reportado cuando hay tag de subagente pero no se puede extraer a quién. */
export const AMBIGUOUS_OWNER = "identidad-ambigua";

/**
 * Marcador de build de ESTE módulo, independiente del `EXT_BUILD` de cada
 * extensión. Permite distinguir, desde cualquiera de las dos extensiones,
 * "el resolvedor compartido que está corriendo es la versión post-H3-bis" de
 * "sigue cargado el módulo viejo" — indistinguible desde adentro sin esto
 * (misma razón por la que existe `EXT_BUILD` en cerebro-mcp.ts).
 */
export const IDENTITY_BUILD = "2026-08-04-6c47914c-r1-bootstrap-credencial-unificada";

export interface Identity {
  key: string;
  owner: string;
  isSubagent: boolean;
  varName: string;
}

/**
 * Parsea un archivo .env a un mapa clave/valor. Soporta claves con guiones
 * (p. ej. el nombre del header de auth del líder), que no son variables de
 * shell válidas pero sí entradas .env válidas.
 */
export function parseEnvFile(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(join(cwd, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      let v = trimmed.slice(eq + 1).trim();
      if (!v.startsWith('"') && !v.startsWith("'")) v = v.replace(/\s+#.*$/, "").trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[trimmed.slice(0, eq).trim()] = v;
    }
  } catch {
    /* sin .env → se usa process.env */
  }
  return out;
}

/**
 * DETECCIÓN LAXA: ¿hay un tag de subagente, en CUALQUIER formato?
 * Ver decisión de diseño 3 en la cabecera del archivo.
 */
export function hasAgentTag(prompt: string): boolean {
  return /<active_agent\b/i.test(prompt);
}

/**
 * SEGUNDA SEÑAL, parte 1 (tarea 6c47914c): ¿el prompt tiene el bloque
 * `<sub_agent_context>` que @gotgenes/pi-subagents agrega en modo "append"
 * (ver decisión de diseño 4 en la cabecera)? Sobrevive a un rename de
 * `<active_agent>` porque es un literal DISTINTO, no una variante del mismo.
 */
export function hasSubAgentContextTag(prompt: string): boolean {
  return /<sub_agent_context\b/i.test(prompt);
}

/**
 * SEGUNDA SEÑAL, parte 2 (tarea 6c47914c): ¿el prompt tiene el wrapper
 * `<agent_instructions>` que @gotgenes/pi-subagents agrega en modo "append"
 * cuando el agente tiene `systemPrompt` no vacío (los 8 agentes de
 * `.pi/agents/*.md` lo tienen)? Mismo motivo que hasSubAgentContextTag:
 * literal distinto de `active_agent`, no una variante de su formato.
 */
export function hasAgentInstructionsTag(prompt: string): boolean {
  return /<agent_instructions\b/i.test(prompt);
}

/**
 * SEGUNDA SEÑAL combinada (tarea 6c47914c): ¿el prompt tiene FORMA de
 * subagente, por CUALQUIERA de los tres marcadores? Puramente ADITIVA sobre
 * `hasAgentTag` — nunca la reemplaza, sólo agrega casos en los que también
 * hay que sospechar. Si `<sub_agent_context>`/`<agent_instructions>` no
 * existieran en el emisor real, esta función se comporta IDÉNTICO a
 * `hasAgentTag` y la regla queda inerte (no regresiva; ver tests/
 * cerebro-mcp.test.ts sección 10 para la medición de que SÍ existen hoy).
 *
 * Éste es el valor que hay que pasarle como `hasSubagentShapeSignal` a
 * `resolveIdentityFrom`: si es true y no se pudo extraer nombre, se resuelve
 * AMBIGUOUS_OWNER en vez de LEADER. No cierra el modo "replace" (ver decisión
 * de diseño 4 arriba): ahí, tras un rename, ninguno de los tres marcadores
 * sobrevive — límite estructural, no de esta implementación.
 */
export function hasSubagentShape(prompt: string): boolean {
  return hasAgentTag(prompt) || hasSubAgentContextTag(prompt) || hasAgentInstructionsTag(prompt);
}

/**
 * Wrapper SEGURO y ÚNICO alrededor de `ctx.getSystemPrompt()`, para calcular
 * el 4º argumento (`hasSubagentShapeSignal`) de `resolveIdentityFrom`. Ver
 * decisiones de diseño 5 y 6 en la cabecera del archivo.
 *
 * Recibe un THUNK (`() => string`), no un `ExtensionContext`, a propósito:
 * este módulo se mantiene sin dependencias de tipos de pi (testeable con
 * funciones puras, sin fabricar un `ExtensionContext` falso salvo cuando el
 * test quiere probar el camino end-to-end real).
 *
 * REGLA (tarea 6c47914c, remediación de H1): no poder leer el prompt —lanzó,
 * o devolvió algo que no es un string no vacío— es INCERTIDUMBRE sobre la
 * identidad, no evidencia de que soy el líder. La incertidumbre resuelve
 * "true" (⇒ AMBIGUOUS en `resolveIdentityFrom`), NUNCA "false" (⇒ LEADER).
 * Es aditiva sobre `hasSubagentShape`: sólo AGREGA casos donde hay que
 * sospechar, nunca quita uno — si `getSystemPrompt()` siempre respondiera con
 * un string normal, esta función es idéntica a `hasSubagentShape(prompt)`.
 */
export function safeSubagentShapeSignal(getSystemPrompt: () => string): boolean {
  let prompt: string;
  try {
    prompt = getSystemPrompt();
  } catch {
    // No se pudo LEER el prompt (típicamente: sesión stale tras reload/fork,
    // ver decisión de diseño 5). Le pasa igual al líder que a un subagente:
    // no es una señal de identidad, así que no se trata como "no hay forma
    // de subagente" (que llevaría a LEADER) sino como incertidumbre.
    return true;
  }
  // `!prompt` cubre "" y, defensivamente, cualquier valor falsy que una
  // implementación de ExtensionContext (real o fake, de test) pueda devolver
  // pese al tipo declarado `string` — un `undefined` en runtime no debe
  // colarse a `hasSubagentShape` y evaluar por accidente a "false".
  if (!prompt) return true;
  return hasSubagentShape(prompt);
}

/**
 * EXTRACCIÓN FLEXIBLE: acepta variantes de formato razonables (comillas
 * simples o dobles, atributos en cualquier orden, mayúsculas, con o sin barra
 * de cierre). Devuelve null si no hay tag O si hay tag pero sin nombre
 * utilizable — el llamador distingue los dos casos con hasAgentTag().
 *
 * Un solo nombre (aunque se repita) es válido. Dos nombres distintos son
 * ambiguos: no es seguro distinguir un ancestro legítimo de texto citado.
 * null + forma de subagente en resolveIdentityFrom implica key vacía.
 */
export function resolveAgentNameFromPrompt(prompt: string): string | null {
  const re = /<active_agent\b[^>]*?\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const matches = [...prompt.matchAll(re)];
  if (matches.length === 0) return null;
  const names = matches.map((m) => (m[1] ?? m[2] ?? "").trim().toLowerCase());
  if (new Set(names.filter(Boolean)).size > 1) return null;
  return names[names.length - 1] || null;
}

/**
 * Resuelve la key de auth de la identidad activa. Fail-closed para subagentes.
 *
 * `hasSubagentShapeSignal` cierra el fail-OPEN de detección (H3, y su
 * extensión de la tarea 6c47914c): si el prompt tiene FORMA de subagente
 * (`hasSubagentShape` — CUALQUIERA de `<active_agent>`, `<sub_agent_context>`,
 * `<agent_instructions>`) pero `agent` es null (nombre no extraíble, nombres
 * distintos en conflicto, o el tag con el nombre directamente ya no está
 * por un rename upstream), NO se cae a la key del líder — se devuelve key
 * vacía y el llamador debe errorizar.
 * Preferimos romper ruidosamente antes que escribir en el Cerebro con una
 * identidad equivocada, porque un rastro de auditoría que miente es peor que
 * una tool que falla. (Nombre histórico del parámetro: `hasTag`; se renombró
 * para reflejar que ahora es "forma de subagente", no sólo "tag presente" —
 * el comportamiento con los 4 argumentos posicionales de siempre no cambia.)
 */
export function resolveIdentityFrom(
  agent: string | null,
  env: Record<string, string>,
  penv: Record<string, string | undefined>,
  hasSubagentShapeSignal = false,
  legacyAnchorForTest?: string,
): Identity {
  const config = optionalTeam(env, penv, legacyAnchorForTest);
  const officeBody = env.BODY_ROLE === 'office';
  // A scaffold cannot inherit a valid key from its parent host, even if one
  // happens to be present in process.env. A declared office stays subagent.
  if (env.AGENT_ENABLED === '0' || (!env.AGENT_ENABLED && penv.AGENT_ENABLED === '0')) {
    return {key:'', owner:agent || env.AGENT_NAME || config?.lider || 'agent',
      isSubagent:Boolean(agent || hasSubagentShapeSignal || officeBody), varName:'(scaffold inerte)'};
  }
  if (agent) {
    if (config) {
      // An office body must never use a sibling's credential even if the host
      // accidentally inherited that sibling's process environment.
      const own = env.AGENT_NAME;
      // Explicit local-body opt-in for the owned ephemeral helper, NOT a fallback.
      // `env` is parseEnvFile(ctx.cwd); never consult penv for this flag/name/role.
      // Keep the ambiguous-prompt branch below and all root branches unchanged.
      if (env.MINI_PROPIO_MISMA_KEY === '1' && agent === `mini-${own}`) {
        const parent = officeBody && config.oficinas.includes(own) ? own :
          env.BODY_ROLE === 'leader' && own === config.lider ? config.lider : null;
        const varName = parent === config.lider ? config.lider_key_env :
          parent ? officeKeyEnv(config,parent) : null;
        if (!parent || !varName || (env.AGENT_KEY_ENV && env.AGENT_KEY_ENV !== varName))
          return {key:'',owner:agent,isSubagent:true,varName:'(mini propio inválido)'};
        return {key:penv[varName] || env[varName] || '',owner:parent,isSubagent:true,varName};
      }
      if (officeBody && agent !== own) return {key:'',owner:agent,isSubagent:true,varName:'(oficina ajena)'};
      // Legacy leader-only opt-in kept for existing bodies; new teams use MINI_PROPIO_MISMA_KEY.
      // mini-<líder> no es otra identidad ni es la rama de líder: misma key, isSubagent true.
      // El flag se lee sólo del archivo (env), nunca del proceso heredado. Sin flag, fail-closed.
      if (!officeBody && agent === `mini-${config.lider}` && env.MINI_LIDER_MISMA_KEY === '1') {
        const leaderKey = config.lider_key_env;
        return {key:penv[leaderKey] || env[leaderKey] || '',owner:config.lider,isSubagent:true,varName:leaderKey};
      }
      // PI_AGENT_NAME=<líder> es el cuerpo del líder, no una oficina. Misma precedencia
      // que la rama sin agent. Forma de subagente sigue fail-closed; mini-* no entra acá.
      if (!officeBody && !hasSubagentShapeSignal && agent === config.lider) {
        
        const leaderKey=config.lider_key_env;
        return {key:penv[leaderKey] || env[leaderKey] || '',owner:config.lider,isSubagent:false,varName:leaderKey};
      }
      const varName = config.oficinas.includes(agent) ? officeKeyEnv(config,agent) : '(oficina ajena)';
      return {key:varName==='(oficina ajena)'?'':penv[varName] || env[varName] || '',
        owner:agent,isSubagent:true,varName};
    }
    const configured = `${(env.AGENT_NAME || penv.AGENT_NAME || 'agent').toUpperCase().replace(/-/g, '_')}_KEY_${agent.toUpperCase().replace(/-/g, '_')}`;
    const varName = /^[A-Z][A-Z0-9_]*$/.test(configured) ? configured : '(indeterminada)';
    return {key:penv[varName] || env[varName] || '',owner:agent,isSubagent:true,varName};
  }
  if (hasSubagentShapeSignal) {
    return {key:'',owner:AMBIGUOUS_OWNER,isSubagent:true,varName:'(indeterminada)'};
  }
  if (config) {
    if (officeBody) {
      const owner=env.AGENT_NAME;
      const expected=owner && config.oficinas.includes(owner) ? officeKeyEnv(config,owner) : null;
      if (!expected || (env.AGENT_KEY_ENV && env.AGENT_KEY_ENV !== expected))
        return {key:'',owner:owner || AMBIGUOUS_OWNER,isSubagent:true,varName:'(oficina ajena)'};
      return {key:penv[expected] || env[expected] || '',owner,isSubagent:true,varName:expected};
    }

    const leaderKey=config.lider_key_env;
    return {key:penv[leaderKey] || env[leaderKey] || '',owner:config.lider,isSubagent:false,varName:leaderKey};
  }
  if (officeBody) return {key:'',owner:AMBIGUOUS_OWNER,isSubagent:true,varName:'(sin config de equipo)'};
  const configured=env.AGENT_KEY_ENV || penv.AGENT_KEY_ENV ||
    `${(env.AGENT_NAME || penv.AGENT_NAME || 'agent').toUpperCase().replace(/-/g, '_')}_KEY`;
  return {key:/^[A-Z][A-Z0-9_]*$/.test(configured)?(penv[configured] || env[configured] || ''):'',
    owner:(env.AGENT_NAME || penv.AGENT_NAME || 'agent').toLowerCase(),isSubagent:false,varName:configured};
}

/**
 * Mensaje de error fail-closed, IDÉNTICO para `cb_*` (cerebro-mcp.ts) y
 * `cerebro_fetch` (cerebro-rest.ts). Centralizado a propósito: antes de la
 * tarea bdf1381d cada extensión mantenía este texto por su cuenta, que es
 * exactamente la clase de duplicación que causó H3-bis (el fix de redacción
 * podía llegar a un archivo y no al otro, igual que el fix de regex).
 */
export function explainIdentityFailure(id: Identity): string {
  if (id.owner === AMBIGUOUS_OWNER) {
    return (
      `IDENTIDAD AMBIGUA: el system prompt tiene FORMA de subagente (<active_agent>, ` +
      `<sub_agent_context> y/o <agent_instructions>), o directamente no se pudo LEER el ` +
      `system prompt, o aparecen nombres distintos en conflicto: NO uso la key ` +
      `del líder ni la de una agente citada. Sos un subagente y no sé cuál ` +
      `(o no puedo confirmar que no lo seas), así que no escribiré en el ` +
      `Cerebro con una identidad falsa. Causas probables: (a) cambió el ` +
      `formato del tag <active_agent> en @gotgenes/pi-subagents, o directamente lo ` +
      `renombraron; (b) ctx.getSystemPrompt() lanzó o devolvió vacío (p.ej. sesión stale ` +
      `tras un reload/fork) — ver safeSubagentShapeSignal en .pi/lib/cerebro-identity.ts, ` +
      `tarea 6c47914c hallazgo H1. Revisá resolveAgentNameFromPrompt y hasSubagentShape.`
    );
  }
  if (id.isSubagent) {
    return (
      `No hay key propia para el subagente "${id.owner}" (falta ${id.varName} en .env). ` +
      `NO se usa la key del líder: eso falsearía la atribución en el Cerebro. ` +
      `Provisionala con agent_provision y agregala al .env.`
    );
  }
  return `No hay key de auth para el líder "${id.owner}". Revisá .env.`;
}
