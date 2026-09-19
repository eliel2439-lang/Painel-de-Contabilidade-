import Redis from "ioredis";
import { gzip, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/*
 * Painel de prospecção — armazenamento v4
 *
 * Objetivos desta versão:
 * - NÃO regravar milhares de contatos a cada clique;
 * - separar os dados por segmento/estado;
 * - permitir 10–15 usuários simultâneos sem conflito de snapshot;
 * - autenticar administrador/estado no SERVIDOR;
 * - registrar envios de WhatsApp de forma idempotente;
 * - manter estatísticas agregadas, em vez de uma lista infinita de eventos;
 * - migrar automaticamente o banco antigo (v3) na primeira execução.
 */

const LEGACY_KEY = "prospeccao-tracking-v3";
const LEGACY_BACKUP_PREFIX = LEGACY_KEY + ":bak:";
const LEGACY_BACKUP_INDEX = LEGACY_KEY + ":bak:indice";

const ROOT = "prospeccao-v4";
const META_KEY = ROOT + ":meta";
const STATS_KEY = ROOT + ":stats"; // legado/materialização para migração
const STATS_SELLER_PREFIX = ROOT + ":stats:seller:";
const STATS_TOTAL_DAYS_KEY = ROOT + ":stats:days";
const STATS_MIGRATION_LOCK_KEY = ROOT + ":lock:stats-migration";
const STATS_LAYOUT = "seller-hash-v1";
const RESULTS_KEY = ROOT + ":results";
const STATE_INDEX_KEY = ROOT + ":states";
const STATE_SUMMARY_PREFIX = ROOT + ":summary:";
const CITY_PREFIX = ROOT + ":city:";
const PHONE_INDEX_KEY = ROOT + ":phones";
const PHONE_INDEX_READY_KEY = ROOT + ":phones:ready";
const IMPORT_LOCK_KEY = ROOT + ":lock:import";
const PHONE_INDEX_LAYOUT = "global-v1";
const BACKUP_INDEX_KEY = ROOT + ":backup:index";
const BACKUP_PREFIX = ROOT + ":backup:";
const MIGRATION_BACKUP_KEY = ROOT + ":migration-backup";
const MIGRATION_LOCK_KEY = ROOT + ":lock:migration";
const RESTORE_LOCK_KEY = ROOT + ":lock:restore";
const BACKUP_LOCK_KEY = ROOT + ":lock:backup";
const MAINTENANCE_KEY = ROOT + ":maintenance";

const MAX_BACKUPS = 1;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_CONTACTS = 5000;
const GZIP_PREFIX = "__gzip_base64_v1__:";

// Segredos SOMENTE do servidor. Este arquivo não é empacotado pelo Vite e não vai
// para o HTML/JavaScript entregue ao navegador. O usuário pediu explicitamente
// para não depender de configuração no Vercel.
const ADMIN_PASSWORD_SERVER = "bresilva";
const SELLER_PASSWORD_SERVER = "1020";
const SESSION_SECRET_SERVER = "07293d59b551087e0a7f0e97bfd9e83179a3efad00c5a55dee2bafbda9cd6780956a5618db1fe564eaa78d32f8bf6ffe";
const ADMIN_COOKIE = "pp_admin_session";
const SELLER_COOKIE = "pp_seller_session";
const ADMIN_LOGIN_WINDOW_SEC = 15 * 60;
const ADMIN_LOGIN_MAX_FAILS = 8;
const UNMARK_WINDOW_MS = 2 * 60 * 60 * 1000;

let redis;
function getRedis() {
  if (!redis) {
    if (!process.env.REDIS_URL) throw new Error("REDIS_URL não está definida no projeto");
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      connectTimeout: 8000,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    redis.on("error", () => {});
  }
  return redis;
}

function descartarConexao() {
  try { redis?.disconnect(); } catch {}
  redis = null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();
const num = (v) => Number(v) || 0;
const clampInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Math.min(max, Math.max(min, Math.floor(num(v))));
const dataLocalISO = (value = Date.now()) => {
  const d = new Date(value);
  // Produção está no Brasil; usar America/Sao_Paulo evita o erro de UTC perto da meia-noite.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "").replace(/^0+/, "");
  // Mesma regra usada no WhatsApp do frontend: telefone BR sem DDI recebe 55.
  // Assim 11999999999 e 5511999999999 não viram dois contatos diferentes.
  if (d && d.length <= 11) d = "55" + d;
  return d;
}
function normalizeName(raw) {
  return String(raw || "").trim().replace(/\s+/g, " ");
}
function nameKey(raw) {
  return normalizeName(raw).toLocaleLowerCase("pt-BR");
}
function assignmentKey(seg, uf) {
  return `${seg}|${uf}`;
}
function segToken(seg) {
  return Buffer.from(String(seg), "utf8").toString("base64url");
}
function stateRef(seg, uf) {
  return `${segToken(seg)}:${String(uf).toUpperCase()}`;
}
function parseStateRef(ref) {
  const idx = String(ref || "").lastIndexOf(":");
  if (idx < 1) return null;
  try {
    return {
      seg: Buffer.from(ref.slice(0, idx), "base64url").toString("utf8"),
      uf: ref.slice(idx + 1).toUpperCase(),
    };
  } catch { return null; }
}
// Compatibilidade apenas para migrar a primeira versão v4, que gravava um JSON por estado.
function legacyV4StateKey(seg, uf) {
  return `${ROOT}:state:${stateRef(seg, uf)}`;
}
function cityToken(city) {
  return Buffer.from(String(city || ""), "utf8").toString("base64url");
}
function cityKey(seg, uf, city) {
  return `${CITY_PREFIX}${stateRef(seg, uf)}:${cityToken(city)}`;
}
function cityLockKey(seg, uf, city) {
  return `${ROOT}:lock:city:${stateRef(seg, uf)}:${cityToken(city)}`;
}
function stateSummaryKey(seg, uf) {
  return `${STATE_SUMMARY_PREFIX}${stateRef(seg, uf)}`;
}

function jsonParse(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function execMultiOrThrow(tx, label = "transação Redis") {
  const out = await tx.exec();
  const failed = (out || []).find((row) => row?.[0]);
  if (failed?.[0]) {
    const e = failed[0] instanceof Error ? failed[0] : new Error(String(failed[0]));
    e.message = `${label}: ${e.message}`;
    throw e;
  }
  return out;
}

const gzipAsync = promisify(gzip);
async function compact(value) {
  const packed = await gzipAsync(Buffer.from(value, "utf8"), { level: 9 });
  return GZIP_PREFIX + packed.toString("base64");
}
function expand(value) {
  if (typeof value !== "string" || !value.startsWith(GZIP_PREFIX)) return value;
  return gunzipSync(Buffer.from(value.slice(GZIP_PREFIX.length), "base64")).toString("utf8");
}

function isOOM(err) {
  return /OOM command not allowed|maxmemory|out of memory/i.test(String(err?.message || err));
}

async function ensureRoomForLargeValue(client, serialized, force = false) {
  const bytes = Buffer.byteLength(serialized || "", "utf8");
  // Valores pequenos não justificam um INFO MEMORY em cada clique normal.
  // Importação força a checagem porque é justamente a operação que faz a base crescer.
  if (!force && bytes < 256 * 1024) return;
  try {
    let info = await client.info("memory");
    let used = num(/used_memory:(\d+)/.exec(info)?.[1]);
    const max = num(/maxmemory:(\d+)/.exec(info)?.[1]);
    if (!max) return;
    // SET precisa de folga para alocar o novo valor antes de substituir o antigo.
    // Se estiver apertado, primeiro libera o backup automático (dados de produção
    // têm prioridade absoluta) e mede novamente.
    if (used + bytes >= max * 0.94) {
      await trimBackups(client, 0).catch(() => {});
      info = await client.info("memory");
      used = num(/used_memory:(\d+)/.exec(info)?.[1]);
    }
    if (used + bytes >= max * 0.96) {
      const e = new Error("o Redis está muito próximo do limite de memória; a alteração não foi iniciada para evitar gravação parcial");
      e.statusCode = 507;
      throw e;
    }
  } catch (e) {
    if (e?.statusCode === 507) throw e;
    // Falhar ao consultar INFO não impede uma gravação normal; o Redis ainda
    // continuará sendo a autoridade final da persistência.
  }
}

async function withLock(client, lockKey, fn, { ttl = 10000, retries = 80 } = {}) {
  const token = randomUUID();
  let acquired = false;
  for (let i = 0; i < retries; i++) {
    const ok = await client.set(lockKey, token, "PX", ttl, "NX");
    if (ok === "OK") { acquired = true; break; }
    await sleep(25 + Math.min(125, i * 4));
  }
  if (!acquired) {
    const e = new Error("o banco está ocupado com outra alteração; tente novamente em alguns segundos");
    e.statusCode = 409;
    throw e;
  }

  // Renova o lock enquanto a operação estiver viva. Isso evita que uma cidade
  // grande, um backup ou uma restauração ultrapasse o TTL e deixe outra
  // requisição entrar no meio da gravação.
  let renewing = false;
  const renewEvery = Math.max(1000, Math.floor(ttl / 3));
  const heartbeat = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      await client.eval(
        "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end",
        1, lockKey, token, String(ttl),
      );
    } catch {} finally { renewing = false; }
  }, renewEvery);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      await client.eval(
        "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
        1, lockKey, token,
      );
    } catch {}
  }
}

function defaultMeta() {
  return {
    version: 4,
    storageLayout: "city-v1",
    statsLayout: null,
    ordemSegmentos: ["Contabilidade"],
    vendedoresInfo: [],
    atribuicoes: {}, // chave segmento|UF -> sellerId
    authVersions: {},
    adminVersion: 1,
    historico: [],
    meta: 0,
    mensagens: {},
    senhasEstado: {},
    metasVendedor: {}, // sellerId -> meta
    metaAlteracoesVendedor: {}, // sellerId -> [{dia,valor,ts}]
    createdAt: now(),
    updatedAt: now(),
  };
}
function defaultStats() {
  return { version: 1, porVendedor: {}, totalPorDia: {}, updatedAt: now() };
}
function defaultResults() {
  return { version: 1, porVendedor: {}, updatedAt: now() };
}
function defaultState(seg, uf) {
  return { version: 1, segmento: seg, uf, cidades: {}, updatedAt: now() };
}
function defaultCity() {
  return { empresas: "", fechados: "", valor: "", status: "nao_iniciado", obs: "", contatos: [], vendedor: "" };
}

function activeSellers(meta) {
  return (meta.vendedoresInfo || []).filter((s) => s && s.active !== false);
}
function sellerById(meta, id) {
  return (meta.vendedoresInfo || []).find((s) => s.id === id) || null;
}
function sellerByName(meta, name) {
  const k = nameKey(name);
  return (meta.vendedoresInfo || []).find((s) => nameKey(s.name) === k) || null;
}
function ensureSeller(meta, name, active = true) {
  const clean = normalizeName(name);
  if (!clean) return null;
  let seller = sellerByName(meta, clean);
  if (!seller) {
    seller = { id: `vend_${randomUUID().replace(/-/g, "").slice(0, 16)}`, name: clean, active };
    meta.vendedoresInfo = [...(meta.vendedoresInfo || []), seller];
  } else if (active && seller.active === false) {
    seller.active = true;
  }
  return seller;
}

function incrementStats(stats, sellerId, day, segment, delta) {
  if (!sellerId || !day || !delta) return;
  stats.porVendedor ||= {};
  stats.totalPorDia ||= {};
  const s = stats.porVendedor[sellerId] ||= { total: 0, porDia: {}, porDiaSegmento: {} };
  s.total = Math.max(0, num(s.total) + delta);
  s.porDia[day] = Math.max(0, num(s.porDia[day]) + delta);
  if (s.porDia[day] === 0) delete s.porDia[day];
  s.porDiaSegmento[day] ||= {};
  s.porDiaSegmento[day][segment || "Sem segmento"] = Math.max(0, num(s.porDiaSegmento[day][segment || "Sem segmento"]) + delta);
  if (s.porDiaSegmento[day][segment || "Sem segmento"] === 0) delete s.porDiaSegmento[day][segment || "Sem segmento"];
  if (Object.keys(s.porDiaSegmento[day]).length === 0) delete s.porDiaSegmento[day];
  stats.totalPorDia[day] = Math.max(0, num(stats.totalPorDia[day]) + delta);
  if (stats.totalPorDia[day] === 0) delete stats.totalPorDia[day];
  stats.updatedAt = now();
}

async function cleanupLegacyBackups(client) {
  try {
    const old = await client.lrange(LEGACY_BACKUP_INDEX, 0, -1);
    if (old.length) await client.del(...old.map((ts) => LEGACY_BACKUP_PREFIX + ts));
    await client.del(LEGACY_BACKUP_INDEX);
  } catch {}
}

async function migrateV4StateDocsToCities(client) {
  const raw = await client.get(META_KEY);
  if (!raw) return;
  const existing = jsonParse(raw, null);
  if (existing?.storageLayout === "city-v1") return;

  await withLock(client, MIGRATION_LOCK_KEY, async () => {
    const currentRaw = await client.get(META_KEY);
    const meta = jsonParse(currentRaw, null);
    if (!meta || meta.storageLayout === "city-v1") return;
    const refs = await client.smembers(STATE_INDEX_KEY);
    for (const ref of refs) {
      const parsed = parseStateRef(ref);
      if (!parsed) continue;
      const oldKey = legacyV4StateKey(parsed.seg, parsed.uf);
      const state = jsonParse(await client.get(oldKey), null);
      if (!state?.cidades) continue;
      const tx = client.multi();
      for (const [cityName, rawCity] of Object.entries(state.cidades || {})) {
        const city = { ...defaultCity(), ...(rawCity || {}) };
        tx.set(cityKey(parsed.seg, parsed.uf, cityName), JSON.stringify(city));
        tx.hset(stateSummaryKey(parsed.seg, parsed.uf), cityName, JSON.stringify(publicCitySummary(city)));
      }
      await execMultiOrThrow(tx, "migração de cidades v4");
      await client.del(oldKey);
    }
    meta.storageLayout = "city-v1";
    meta.updatedAt = now();
    await client.set(META_KEY, JSON.stringify(meta));
  }, { ttl: 30000, retries: 160 });
}

async function migrateLegacy(client) {
  if (await client.exists(META_KEY)) { await migrateV4StateDocsToCities(client); return; }
  await withLock(client, MIGRATION_LOCK_KEY, async () => {
    if (await client.exists(META_KEY)) return;

    const legacyRaw = await client.get(LEGACY_KEY);
    const legacy = jsonParse(legacyRaw, null);
    const meta = defaultMeta();
    const stats = defaultStats();
    const results = defaultResults();

    if (!legacy) {
      await client.set(META_KEY, JSON.stringify(meta));
      await client.set(STATS_KEY, JSON.stringify(stats));
      await client.set(RESULTS_KEY, JSON.stringify(results));
      return;
    }

    meta.ordemSegmentos = Array.isArray(legacy.ordemSegmentos) && legacy.ordemSegmentos.length
      ? [...new Set(legacy.ordemSegmentos.filter(Boolean))]
      : Object.keys(legacy.segmentos || {});
    if (!meta.ordemSegmentos.length) meta.ordemSegmentos = ["Contabilidade"];
    meta.historico = Array.isArray(legacy.historico) ? legacy.historico.slice(0, 300) : [];
    meta.meta = num(legacy.meta);
    meta.mensagens = { ...(legacy.mensagens || {}) };
    meta.senhasEstado = { ...(legacy.senhasEstado || {}) };

    // Reúne todos os nomes já usados para não perder histórico antigo.
    const activeNames = new Set((legacy.vendedores || []).map(normalizeName).filter(Boolean));
    const allNames = new Set(activeNames);
    Object.values(legacy.atribuicoes || {}).forEach((n) => n && allNames.add(normalizeName(n)));
    Object.keys(legacy.metasVendedor || {}).forEach((n) => n && allNames.add(normalizeName(n)));
    Object.keys(legacy.metaAlteracoesVendedor || {}).forEach((n) => n && allNames.add(normalizeName(n)));
    Object.keys(legacy.resultadosProspeccao || {}).forEach((n) => n && allNames.add(normalizeName(n)));
    for (const e of legacy.enviosMensagens || []) if (e?.vendedor) allNames.add(normalizeName(e.vendedor));

    for (const name of allNames) ensureSeller(meta, name, activeNames.has(name));

    for (const [k, name] of Object.entries(legacy.atribuicoes || {})) {
      const s = ensureSeller(meta, name, true);
      if (s) meta.atribuicoes[k] = s.id;
      meta.authVersions[k] = 1;
    }

    for (const [name, value] of Object.entries(legacy.metasVendedor || {})) {
      const s = ensureSeller(meta, name, activeNames.has(normalizeName(name)));
      if (s) meta.metasVendedor[s.id] = clampInt(value);
    }
    for (const [name, history] of Object.entries(legacy.metaAlteracoesVendedor || {})) {
      const s = ensureSeller(meta, name, activeNames.has(normalizeName(name)));
      if (s) meta.metaAlteracoesVendedor[s.id] = Array.isArray(history) ? history : [];
    }

    // Contatos passam para chaves por CIDADE. Um clique em WhatsApp não regrava
    // mais milhares de contatos de um estado inteiro.
    const stateRefs = [];
    for (const [seg, ufs] of Object.entries(legacy.segmentos || {})) {
      if (!meta.ordemSegmentos.includes(seg)) meta.ordemSegmentos.push(seg);
      for (const [uf, cidades] of Object.entries(ufs || {})) {
        const ref = stateRef(seg, uf);
        stateRefs.push(ref);
        const tx = client.multi();
        for (const [cityName, rawCity] of Object.entries(cidades || {})) {
          const city = { ...defaultCity(), ...(rawCity || {}) };
          tx.set(cityKey(seg, uf, cityName), JSON.stringify(city));
          tx.hset(stateSummaryKey(seg, uf), cityName, JSON.stringify(publicCitySummary(city)));
        }
        await execMultiOrThrow(tx, "migração do banco legado");
        if (!meta.authVersions[assignmentKey(seg, uf)]) meta.authVersions[assignmentKey(seg, uf)] = 1;
      }
    }
    if (stateRefs.length) await client.sadd(STATE_INDEX_KEY, ...stateRefs);

    // Histórico agregado: não guardamos mais uma linha JSON para cada clique.
    const seenEvents = new Set();
    if (Array.isArray(legacy.enviosMensagens) && legacy.enviosMensagens.length) {
      for (const e of legacy.enviosMensagens) {
        const eventId = e?.id || `${e?.ts}|${e?.vendedor}|${e?.segmento}|${e?.uf}|${e?.cidade}|${e?.contatoId}`;
        if (!e?.ts || seenEvents.has(eventId)) continue;
        seenEvents.add(eventId);
        const s = ensureSeller(meta, e.vendedor || "", activeNames.has(normalizeName(e.vendedor)));
        if (!s) continue;
        incrementStats(stats, s.id, dataLocalISO(e.ts), e.segmento || "Sem segmento", 1);
      }
    } else {
      // Compatibilidade com bases antigas que ainda não tinham enviosMensagens.
      for (const [seg, ufs] of Object.entries(legacy.segmentos || {})) {
        for (const [uf, cidades] of Object.entries(ufs || {})) {
          const assigned = meta.atribuicoes[assignmentKey(seg, uf)] || null;
          for (const [cidade, info] of Object.entries(cidades || {})) {
            for (const c of info?.contatos || []) {
              if (!c?.enviado || !c?.enviadoTs) continue;
              const s = c.enviadoPor ? ensureSeller(meta, c.enviadoPor, activeNames.has(normalizeName(c.enviadoPor))) : sellerById(meta, assigned);
              if (!s) continue;
              incrementStats(stats, s.id, dataLocalISO(c.enviadoTs), c.enviadoSegmento || seg, 1);
            }
          }
        }
      }
    }

    for (const [name, perDay] of Object.entries(legacy.resultadosProspeccao || {})) {
      const s = ensureSeller(meta, name, activeNames.has(normalizeName(name)));
      if (s) results.porVendedor[s.id] = perDay || {};
    }

    meta.updatedAt = now();
    await client.set(STATS_KEY, JSON.stringify(stats));
    await client.set(RESULTS_KEY, JSON.stringify(results));
    await client.set(META_KEY, JSON.stringify(meta)); // META por último = migração concluída

    // Guarda uma cópia compactada temporária da v3 e libera o documento gigante.
    if (legacyRaw) {
      try {
        await client.set(MIGRATION_BACKUP_KEY, await compact(legacyRaw), "EX", 7 * 24 * 60 * 60);
      } catch {}
    }
    await client.del(LEGACY_KEY);
    await cleanupLegacyBackups(client);
  }, { ttl: 30000, retries: 160 });
}

async function readMeta(client) {
  await migrateLegacy(client);
  return jsonParse(await client.get(META_KEY), defaultMeta());
}
async function readResults(client) {
  return jsonParse(await client.get(RESULTS_KEY), defaultResults());
}
async function readCity(client, seg, uf, cityName) {
  return jsonParse(await client.get(cityKey(seg, uf, cityName)), defaultCity());
}
async function readStateSummaries(client, seg, uf) {
  const raw = await client.hgetall(stateSummaryKey(seg, uf));
  const cities = {};
  for (const [name, value] of Object.entries(raw || {})) cities[name] = jsonParse(value, publicCitySummary(defaultCity()));
  return cities;
}

function phoneIndexValue(seg, uf, city, contactId) {
  return JSON.stringify({ seg: String(seg || ""), uf: String(uf || "").toUpperCase(), city: normalizeName(city), contactId: String(contactId || "") });
}
function parsePhoneIndexValue(raw) {
  return jsonParse(raw, null);
}

// Índice global derivado dos contatos. Ele serve apenas para impedir que o mesmo
// telefone seja importado em outra cidade/estado/segmento. Dados antigos não são
// apagados automaticamente: se já houver duplicatas históricas, uma delas ocupa o
// índice e nenhuma nova duplicata entra.
async function rebuildPhoneIndexUnlocked(client) {
  await client.del(PHONE_INDEX_KEY);
  const refs = await client.smembers(STATE_INDEX_KEY);
  const seen = new Set();
  let indexed = 0;
  let historicalDuplicates = 0;
  let pipeline = client.pipeline();
  let queued = 0;
  const flush = async () => {
    if (!queued) return;
    const out = await pipeline.exec();
    const failed = (out || []).find((row) => row?.[0]);
    if (failed?.[0]) throw failed[0];
    pipeline = client.pipeline();
    queued = 0;
  };

  for (const ref of refs) {
    const parsed = parseStateRef(ref);
    if (!parsed) continue;
    const names = await client.hkeys(stateSummaryKey(parsed.seg, parsed.uf));
    for (const cityName of names) {
      const city = await readCity(client, parsed.seg, parsed.uf, cityName);
      for (const contact of Array.isArray(city.contatos) ? city.contatos : []) {
        const phone = normalizePhone(contact?.telefone);
        if (!phone || phone.length < 8) continue;
        if (seen.has(phone)) { historicalDuplicates++; continue; }
        seen.add(phone);
        pipeline.hset(PHONE_INDEX_KEY, phone, phoneIndexValue(parsed.seg, parsed.uf, cityName, contact?.id));
        queued++; indexed++;
        if (queued >= 500) await flush();
      }
    }
  }
  await flush();
  await client.set(PHONE_INDEX_READY_KEY, JSON.stringify({ layout: PHONE_INDEX_LAYOUT, indexed, historicalDuplicates, builtAt: now() }));
  return { indexed, historicalDuplicates };
}

async function ensurePhoneIndexUnlocked(client) {
  const ready = jsonParse(await client.get(PHONE_INDEX_READY_KEY), null);
  if (ready?.layout === PHONE_INDEX_LAYOUT) return ready;
  return rebuildPhoneIndexUnlocked(client);
}

async function findPhoneElsewhere(client, phone, exclude = null) {
  if (!phone) return null;
  const refs = await client.smembers(STATE_INDEX_KEY);
  for (const ref of refs) {
    const parsed = parseStateRef(ref);
    if (!parsed) continue;
    const names = await client.hkeys(stateSummaryKey(parsed.seg, parsed.uf));
    for (const cityName of names) {
      const city = await readCity(client, parsed.seg, parsed.uf, cityName);
      const found = (Array.isArray(city.contatos) ? city.contatos : []).find((c) => {
        if (normalizePhone(c?.telefone) !== phone) return false;
        if (!exclude) return true;
        return !(parsed.seg === exclude.seg && parsed.uf === exclude.uf && cityName === exclude.city && String(c?.id || "") === String(exclude.contactId || ""));
      });
      if (found) return { seg: parsed.seg, uf: parsed.uf, city: cityName, contactId: String(found.id || "") };
    }
  }
  return null;
}

// ----- Sessões assinadas -----
function tokenSecret() {
  return SESSION_SECRET_SERVER;
}
function b64url(value) {
  return Buffer.from(value).toString("base64url");
}
function signPayload(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", tokenSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyTokenRaw(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = createHmac("sha256", tokenSecret()).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload?.exp || payload.exp < now()) return null;
    return payload;
  } catch { return null; }
}
function parseCookies(req) {
  const raw = String(req.headers?.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
function bearer(req) {
  const h = String(req.headers?.authorization || "");
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}
function adminCookie(req) {
  return parseCookies(req)[ADMIN_COOKIE] || "";
}
function sellerCookie(req) {
  return parseCookies(req)[SELLER_COOKIE] || "";
}
function appendSetCookie(res, value) {
  const current = res.getHeader?.("Set-Cookie");
  if (!current) res.setHeader("Set-Cookie", value);
  else if (Array.isArray(current)) res.setHeader("Set-Cookie", [...current, value]);
  else res.setHeader("Set-Cookie", [current, value]);
}
function setAdminCookie(req, res, token) {
  const proto = String(req.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim().toLowerCase();
  const secure = proto === "https" ? "; Secure" : "";
  appendSetCookie(res, `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}
function clearAdminCookie(req, res) {
  const proto = String(req.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim().toLowerCase();
  const secure = proto === "https" ? "; Secure" : "";
  appendSetCookie(res, `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}
function setSellerCookie(req, res, token) {
  const proto = String(req.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim().toLowerCase();
  const secure = proto === "https" ? "; Secure" : "";
  appendSetCookie(res, `${SELLER_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}
function clearSellerCookie(req, res) {
  const proto = String(req.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim().toLowerCase();
  const secure = proto === "https" ? "; Secure" : "";
  appendSetCookie(res, `${SELLER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function issueAdmin(meta) {
  return signPayload({ type: "admin", v: meta.adminVersion || 1, iat: now(), exp: now() + TOKEN_TTL_MS });
}
function issueSeller() {
  // Acesso 2 é apenas o portal dos vendedores. A identidade usada nas
  // estatísticas vem exclusivamente do vendedor atribuído ao estado depois que
  // a senha daquele estado é validada.
  return signPayload({ type: "seller", iat: now(), exp: now() + TOKEN_TTL_MS });
}
function issueState(meta, seg, uf, sellerId) {
  const k = assignmentKey(seg, uf);
  return signPayload({ type: "state", seg, uf, sellerId, v: meta.authVersions?.[k] || 1, iat: now(), exp: now() + TOKEN_TTL_MS });
}
function validateSession(meta, req) {
  // Acesso 1: cookie HttpOnly administrativo.
  const adminPayload = verifyTokenRaw(adminCookie(req));
  if (adminPayload?.type === "admin" && adminPayload.v === (meta.adminVersion || 1)) return adminPayload;

  // Estado: token temporário emitido SOMENTE depois da senha do estado. O token
  // não contém a senha e fica limitado ao segmento/UF e ao vendedor atribuído.
  const statePayload = verifyTokenRaw(bearer(req));
  if (statePayload?.type === "state") {
    const k = assignmentKey(statePayload.seg, statePayload.uf);
    if (statePayload.v === (meta.authVersions?.[k] || 1) && meta.atribuicoes?.[k] === statePayload.sellerId) {
      return statePayload;
    }
  }

  // Acesso 2: cookie HttpOnly que libera apenas o mapa/segmentos. Ele NÃO libera
  // nenhum estado sozinho; cada estado exige sua própria senha.
  const sellerPayload = verifyTokenRaw(sellerCookie(req));
  if (sellerPayload?.type === "seller") return sellerPayload;
  return null;
}
function requireAdmin(meta, req) {
  const s = validateSession(meta, req);
  if (!s || s.type !== "admin") {
    const e = new Error("sessão administrativa inválida ou expirada"); e.statusCode = 401; throw e;
  }
  return s;
}
function requireSellerGate(meta, req) {
  const s = validateSession(meta, req);
  if (!s || s.type !== "seller") {
    const e = new Error("entre pelo Acesso 2 antes de abrir um estado"); e.statusCode = 401; throw e;
  }
  return s;
}
function requireStateOrAdmin(meta, req, seg, uf) {
  const s = validateSession(meta, req);
  if (!s) { const e = new Error("sessão inválida ou expirada"); e.statusCode = 401; throw e; }
  if (s.type === "admin") return s;
  if (s.type === "state" && s.seg === seg && s.uf === uf) {
    // O token do estado funciona somente enquanto o Acesso 2 HttpOnly também
    // estiver ativo. Sair do painel invalida imediatamente o uso dos tokens que
    // possam ter ficado no sessionStorage daquela aba.
    const gate = verifyTokenRaw(sellerCookie(req));
    if (gate?.type === "seller") return s;
    const e = new Error("sessão do Acesso 2 expirada; entre novamente"); e.statusCode = 401; throw e;
  }
  const e = new Error("digite a senha deste estado para continuar"); e.statusCode = 403; throw e;
}

function publicCitySummary(city) {
  const contacts = Array.isArray(city?.contatos) ? city.contatos : [];
  const sent = contacts.reduce((n, c) => n + (c?.enviado ? 1 : 0), 0);
  const { contatos, vendedor: _legacyVendedor, ...rest } = city || {};
  return {
    ...defaultCity(),
    ...rest,
    contatos: [],
    contatosCount: contacts.length,
    contatosEnviadosCount: sent,
    _contatosCarregados: false,
  };
}
function publicBootstrapCitySummary() {
  // Antes do login, revela apenas que a cidade existe. Não expõe empresas,
  // fechamentos, valor, observações, status real nem contagem de contatos.
  return {
    ...defaultCity(),
    contatos: [],
    contatosCount: 0,
    contatosEnviadosCount: 0,
    _contatosCarregados: false,
  };
}

function sellerCitySummary(city) {
  // Vendedor recebe somente o necessário para trabalhar os contatos.
  // Campos administrativos da cidade (empresas, fechados, valor, observações, status etc.)
  // ficam zerados no servidor e nunca são enviados para o navegador do vendedor.
  const contacts = Array.isArray(city?.contatos) ? city.contatos : [];
  const sent = contacts.reduce((n, c) => n + (c?.enviado ? 1 : 0), 0);
  return {
    ...defaultCity(),
    contatos: [],
    contatosCount: Number.isFinite(Number(city?.contatosCount)) ? Number(city.contatosCount) : contacts.length,
    contatosEnviadosCount: Number.isFinite(Number(city?.contatosEnviadosCount)) ? Number(city.contatosEnviadosCount) : sent,
    _contatosCarregados: false,
  };
}

function sellerContactView(contact) {
  // Não revela histórico interno, ids de vendedores anteriores ou metadados de atribuição.
  return {
    id: String(contact?.id || ""),
    nome: String(contact?.nome || ""),
    telefone: String(contact?.telefone || ""),
    endereco: String(contact?.endereco || ""),
    enviado: !!contact?.enviado,
  };
}

function fullCity(city) {
  const contacts = Array.isArray(city?.contatos) ? city.contatos : [];
  return {
    ...defaultCity(),
    ...(city || {}),
    contatos: contacts,
    contatosCount: contacts.length,
    contatosEnviadosCount: contacts.reduce((n, c) => n + (c?.enviado ? 1 : 0), 0),
    _contatosCarregados: true,
  };
}

function mapStatsForFrontend(meta, stats, allowedSellerIds = null) {
  const allowed = allowedSellerIds ? new Set(allowedSellerIds) : null;
  const out = { porVendedor: {}, totalPorDia: {} };
  for (const [id, info] of Object.entries(stats.porVendedor || {})) {
    if (allowed && !allowed.has(id)) continue;
    const seller = sellerById(meta, id);
    if (!seller?.name) continue;
    out.porVendedor[seller.name] = {
      total: num(info.total),
      porDia: { ...(info.porDia || {}) },
      porDiaSegmento: { ...(info.porDiaSegmento || {}) },
    };
    for (const [day, qty] of Object.entries(info.porDia || {})) {
      out.totalPorDia[day] = num(out.totalPorDia[day]) + num(qty);
    }
  }
  // Para admin (sem filtro), usa o total global materializado. Para vendedor,
  // totalPorDia é somente a soma dos vendedores permitidos acima.
  if (!allowed) out.totalPorDia = { ...(stats.totalPorDia || {}) };
  return out;
}
function mapResultsForFrontend(meta, results, allowedSellerIds = null) {
  const out = {};
  const allowed = allowedSellerIds ? new Set(allowedSellerIds) : null;
  for (const [id, perDay] of Object.entries(results.porVendedor || {})) {
    if (allowed && !allowed.has(id)) continue;
    const seller = sellerById(meta, id);
    if (seller?.name) out[seller.name] = perDay || {};
  }
  return out;
}
function frontendAdminFields(meta, stats, results) {
  const sellers = activeSellers(meta);
  const assignments = {};
  for (const [k, id] of Object.entries(meta.atribuicoes || {})) {
    const s = sellerById(meta, id);
    if (s?.name) assignments[k] = s.name;
  }
  const goals = {};
  const goalHistory = {};
  for (const s of sellers) {
    if (meta.metasVendedor?.[s.id] !== undefined) goals[s.name] = meta.metasVendedor[s.id];
    if (meta.metaAlteracoesVendedor?.[s.id]) goalHistory[s.name] = meta.metaAlteracoesVendedor[s.id];
  }
  return {
    vendedores: sellers.map((s) => s.name),
    atribuicoes: assignments,
    senhasEstado: { ...(meta.senhasEstado || {}) },
    metasVendedor: goals,
    metaAlteracoesVendedor: goalHistory,
    estatisticasMensagens: mapStatsForFrontend(meta, stats, null),
    resultadosProspeccao: mapResultsForFrontend(meta, results, null), // inclui ex-vendedores no histórico
  };
}

async function bootstrap(client, meta, session) {
  if (!session) return null;

  const isAdmin = session.type === "admin";
  const isSellerGate = session.type === "seller";
  const refs = await client.smembers(STATE_INDEX_KEY);
  const refsSet = new Set(refs);

  // Estados já atribuídos também aparecem mesmo que ainda estejam sem cidade.
  for (const k of Object.keys(meta.atribuicoes || {})) {
    const sep = k.lastIndexOf("|");
    if (sep > 0) refsSet.add(stateRef(k.slice(0, sep), k.slice(sep + 1)));
  }

  const order = [...(meta.ordemSegmentos || [])];
  const segmentos = {};
  for (const seg of order) segmentos[seg] = {};

  if (isAdmin) {
    const modes = [];
    const tx = client.pipeline();
    for (const ref of refsSet) {
      const parsed = parseStateRef(ref);
      if (!parsed) continue;
      modes.push({ ref, parsed });
      tx.hgetall(stateSummaryKey(parsed.seg, parsed.uf));
    }
    const summaryResults = modes.length ? await tx.exec() : [];
    modes.forEach((entry, i) => {
      const pair = summaryResults[i] || [null, {}];
      if (pair?.[0]) return;
      const { parsed } = entry;
      segmentos[parsed.seg] ||= {};
      const cities = {};
      for (const [name, raw] of Object.entries(pair[1] || {})) {
        cities[name] = jsonParse(raw, publicCitySummary(defaultCity()));
      }
      segmentos[parsed.seg][parsed.uf] = cities;
    });
  } else if (isSellerGate) {
    // Antes da senha do estado, o Acesso 2 recebe somente a existência dos
    // estados/segmentos. Nenhuma cidade, mensagem, vendedor ou estatística vaza.
    for (const ref of refsSet) {
      const parsed = parseStateRef(ref);
      if (!parsed) continue;
      segmentos[parsed.seg] ||= {};
      segmentos[parsed.seg][parsed.uf] = {};
    }
  }

  const base = {
    segmentos,
    ordemSegmentos: order,
    historico: isAdmin ? [...(meta.historico || [])] : [],
    meta: isAdmin ? num(meta.meta) : 0,
    mensagens: isAdmin ? { ...(meta.mensagens || {}) } : {},
    vendedores: [],
    atribuicoes: {},
    senhasEstado: {},
    metasVendedor: {},
    metaAlteracoesVendedor: {},
    enviosMensagens: [],
    estatisticasMensagens: { porVendedor: {}, totalPorDia: {} },
    resultadosProspeccao: {},
    _rev: meta.updatedAt || null,
    _storageVersion: 4,
  };

  if (isAdmin) {
    const [stats, results] = await Promise.all([readStats(client, meta), readResults(client)]);
    Object.assign(base, frontendAdminFields(meta, stats, results));
  }
  return base;
}

async function stateResponse(client, meta, seg, uf, session) {
  const assignmentId = meta.atribuicoes?.[assignmentKey(seg, uf)] || null;
  const seller = assignmentId ? sellerById(meta, assignmentId) : null;
  const sellersAllowed = seller ? [seller.id] : [];
  const [stats, results, rawCities] = await Promise.all([
    session?.type === "admin" ? readStats(client, meta) : readStats(client, meta, sellersAllowed),
    session?.type === "admin" ? readResults(client) : Promise.resolve(defaultResults()),
    readStateSummaries(client, seg, uf),
  ]);
  const cities = session?.type === "admin"
    ? rawCities
    : Object.fromEntries(Object.entries(rawCities || {}).map(([name, city]) => [name, sellerCitySummary(city)]));
  const metaGoal = seller ? { [seller.name]: num(meta.metasVendedor?.[seller.id]) } : {};
  const metaHistory = seller && meta.metaAlteracoesVendedor?.[seller.id] ? { [seller.name]: meta.metaAlteracoesVendedor[seller.id] } : {};
  return {
    segmento: seg,
    uf,
    cidades: cities,
    vendedor: seller?.name || "",
    atribuicao: seller ? { [assignmentKey(seg, uf)]: seller.name } : {},
    metasVendedor: metaGoal,
    metaAlteracoesVendedor: metaHistory,
    estatisticasMensagens: mapStatsForFrontend(meta, stats, sellersAllowed),
    resultadosProspeccao: session?.type === "admin" ? mapResultsForFrontend(meta, results, null) : {},
    mensagem: meta.mensagens?.[seg] || "",
    updatedAt: meta.updatedAt || null,
  };
}

async function cityResponse(client, seg, uf, cityName, offset = 0, limit = 1000, restricted = false) {
  const raw = { ...defaultCity(), ...(await readCity(client, seg, uf, cityName)) };
  const contacts = Array.isArray(raw.contatos) ? raw.contatos : [];
  const safeOffset = Math.max(0, clampInt(offset));
  const safeLimit = Math.min(1500, Math.max(100, clampInt(limit, 100, 1500)));
  const pageRaw = contacts.slice(safeOffset, safeOffset + safeLimit);
  const page = restricted ? pageRaw.map(sellerContactView) : pageRaw;
  const nextOffset = safeOffset + page.length < contacts.length ? safeOffset + page.length : null;
  const sent = contacts.reduce((n, c) => n + (c?.enviado ? 1 : 0), 0);
  return {
    ...defaultCity(),
    ...(restricted ? {} : raw),
    contatos: page,
    contatosCount: contacts.length,
    contatosEnviadosCount: sent,
    _contatosCarregados: nextOffset == null,
    nextOffset,
  };
}

async function searchContacts(client, digits, maxResults = 8, segFilter = "") {
  const q = String(digits || "").replace(/\D/g, "");
  if (q.length < 4) return [];
  const refs = await client.smembers(STATE_INDEX_KEY);
  const found = [];
  for (const ref of refs) {
    const parsed = parseStateRef(ref);
    if (!parsed) continue;
    if (segFilter && parsed.seg !== segFilter) continue;
    const names = await client.hkeys(stateSummaryKey(parsed.seg, parsed.uf));
    for (let i = 0; i < names.length; i += 40) {
      const batchNames = names.slice(i, i + 40);
      const raws = batchNames.length ? await client.mget(...batchNames.map((name) => cityKey(parsed.seg, parsed.uf, name))) : [];
      for (let j = 0; j < batchNames.length; j++) {
        const city = jsonParse(raws[j], null);
        if (!city) continue;
        for (const c of (Array.isArray(city.contatos) ? city.contatos : [])) {
          if (normalizePhone(c?.telefone).includes(q)) {
            found.push({ ...c, segmento: parsed.seg, uf: parsed.uf, cidadeNome: batchNames[j] });
            if (found.length >= maxResults) return found;
          }
        }
      }
    }
  }
  return found;
}

function sellerStatsKey(sellerId) {
  return STATS_SELLER_PREFIX + String(sellerId || "");
}
function sellerSegField(day, segment) {
  return `s:${day}:${segToken(segment || "Sem segmento")}`;
}
function parseSellerStatsHash(raw) {
  const out = { total: num(raw?.total), porDia: {}, porDiaSegmento: {} };
  for (const [field, value] of Object.entries(raw || {})) {
    if (field.startsWith("d:")) {
      const day = field.slice(2);
      if (day) out.porDia[day] = Math.max(0, num(value));
    } else if (field.startsWith("s:")) {
      const rest = field.slice(2);
      const idx = rest.indexOf(":");
      if (idx < 0) continue;
      const day = rest.slice(0, idx);
      const token = rest.slice(idx + 1);
      let segment = "Sem segmento";
      try { segment = Buffer.from(token, "base64url").toString("utf8") || segment; } catch {}
      out.porDiaSegmento[day] ||= {};
      out.porDiaSegmento[day][segment] = Math.max(0, num(value));
    }
  }
  return out;
}
async function readStats(client, meta, allowedSellerIds = null) {
  // Compatibilidade defensiva durante a primeira requisição de migração.
  if (meta?.statsLayout !== STATS_LAYOUT) return jsonParse(await client.get(STATS_KEY), defaultStats());
  const ids = allowedSellerIds ? [...new Set(allowedSellerIds.filter(Boolean))] : (meta.vendedoresInfo || []).map((s) => s.id).filter(Boolean);
  const pipe = client.pipeline();
  ids.forEach((id) => pipe.hgetall(sellerStatsKey(id)));
  if (!allowedSellerIds) pipe.hgetall(STATS_TOTAL_DAYS_KEY);
  const rows = ids.length || !allowedSellerIds ? await pipe.exec() : [];
  const stats = defaultStats();
  ids.forEach((id, i) => { stats.porVendedor[id] = parseSellerStatsHash(rows?.[i]?.[1] || {}); });
  if (!allowedSellerIds) {
    const totals = rows?.[ids.length]?.[1] || {};
    for (const [day, qty] of Object.entries(totals)) if (num(qty) > 0) stats.totalPorDia[day] = num(qty);
  } else {
    for (const info of Object.values(stats.porVendedor)) {
      for (const [day, qty] of Object.entries(info.porDia || {})) stats.totalPorDia[day] = num(stats.totalPorDia[day]) + num(qty);
    }
  }
  return stats;
}
function queueStatsDelta(tx, sellerId, day, segment, delta) {
  if (!sellerId || !day || !delta) return;
  const key = sellerStatsKey(sellerId);
  tx.hincrby(key, "total", delta);
  tx.hincrby(key, `d:${day}`, delta);
  tx.hincrby(key, sellerSegField(day, segment), delta);
  tx.hincrby(STATS_TOTAL_DAYS_KEY, day, delta);
}
async function replaceStatsShards(client, meta, stats) {
  const ids = new Set([...(meta.vendedoresInfo || []).map((s) => s.id), ...Object.keys(stats?.porVendedor || {})].filter(Boolean));
  const delKeys = [...ids].map(sellerStatsKey);
  if (delKeys.length) await client.del(...delKeys);
  await client.del(STATS_TOTAL_DAYS_KEY);
  const tx = client.multi();
  for (const [id, info] of Object.entries(stats?.porVendedor || {})) {
    const fields = { total: String(Math.max(0, num(info.total))) };
    for (const [day, qty] of Object.entries(info.porDia || {})) fields[`d:${day}`] = String(Math.max(0, num(qty)));
    for (const [day, segs] of Object.entries(info.porDiaSegmento || {})) {
      for (const [segment, qty] of Object.entries(segs || {})) fields[sellerSegField(day, segment)] = String(Math.max(0, num(qty)));
    }
    tx.hset(sellerStatsKey(id), fields);
  }
  const totals = stats?.totalPorDia || {};
  if (Object.keys(totals).length) tx.hset(STATS_TOTAL_DAYS_KEY, Object.fromEntries(Object.entries(totals).map(([k,v]) => [k, String(Math.max(0,num(v)))])));
  await execMultiOrThrow(tx, "migração das estatísticas");
}
async function migrateStatsStorage(client) {
  const meta = await readMeta(client);
  if (meta.statsLayout === STATS_LAYOUT) return;
  await withLock(client, STATS_MIGRATION_LOCK_KEY, async () => {
    const current = await readMeta(client);
    if (current.statsLayout === STATS_LAYOUT) return;
    const legacyStats = jsonParse(await client.get(STATS_KEY), defaultStats());
    await replaceStatsShards(client, current, legacyStats);
    current.statsLayout = STATS_LAYOUT;
    current.updatedAt = now();
    await client.set(META_KEY, JSON.stringify(current));
  }, { ttl: 30000, retries: 160 });
}

async function ensureNotMaintenance(client) {
  if (await client.exists(MAINTENANCE_KEY)) {
    const e = new Error("o painel está concluindo uma restauração administrativa; aguarde alguns segundos");
    e.statusCode = 503;
    throw e;
  }
}

async function waitForWriteLocksToDrain(client, maxWaitMs = 15000) {
  const started = now();
  while (now() - started < maxWaitMs) {
    let cursor = "0";
    let foundCityLock = false;
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", `${ROOT}:lock:city:*`, "COUNT", 100);
      cursor = next;
      if (keys?.length) { foundCityLock = true; break; }
    } while (cursor !== "0");
    const [metaBusy, resultsBusy, backupBusy, importBusy] = await Promise.all([
      client.exists(ROOT + ":lock:meta"),
      client.exists(ROOT + ":lock:results"),
      client.exists(BACKUP_LOCK_KEY),
      client.exists(IMPORT_LOCK_KEY),
    ]);
    if (!foundCityLock && !metaBusy && !resultsBusy && !backupBusy && !importBusy) return true;
    await sleep(100);
  }
  return false;
}

async function writeMeta(client, updater) {
  await ensureNotMaintenance(client);
  return withLock(client, ROOT + ":lock:meta", async () => {
    await ensureNotMaintenance(client);
    const meta = await readMeta(client);
    const next = await updater(meta) || meta;
    next.updatedAt = now();
    await client.set(META_KEY, JSON.stringify(next));
    return next;
  });
}

async function writeCity(client, seg, uf, cityName, updater, { forceMemoryCheck = false } = {}) {
  await ensureNotMaintenance(client);
  return withLock(client, cityLockKey(seg, uf, cityName), async () => {
    await ensureNotMaintenance(client);
    const city = { ...defaultCity(), ...(await readCity(client, seg, uf, cityName)) };
    const next = await updater(city) || city;
    const normalized = { ...defaultCity(), ...(next || {}) };
    const serialized = JSON.stringify(normalized);
    await ensureRoomForLargeValue(client, serialized, forceMemoryCheck);
    // SET da cidade + resumo + índice no mesmo MULTI: ou os três entram, ou nenhum.
    const tx = client.multi();
    tx.set(cityKey(seg, uf, cityName), serialized);
    tx.hset(stateSummaryKey(seg, uf), cityName, JSON.stringify(publicCitySummary(normalized)));
    tx.sadd(STATE_INDEX_KEY, stateRef(seg, uf));
    const out = await tx.exec();
    const failed = (out || []).find(([err]) => err);
    if (failed?.[0]) throw failed[0];
    return normalized;
  });
}

// Contato e contador entram no MESMO MULTI, porém cada vendedor tem seu próprio
// hash de estatísticas. Não existe mais lock global de stats entre 10–15 usuários.
async function writeCityAndStatDelta(client, seg, uf, cityName, updater) {
  await ensureNotMaintenance(client);
  return withLock(client, cityLockKey(seg, uf, cityName), async () => {
    await ensureNotMaintenance(client);
    const city = { ...defaultCity(), ...(await readCity(client, seg, uf, cityName)) };
    const result = await updater(city) || { city, delta: null, extra: {} };
    const normalized = { ...defaultCity(), ...(result.city || city) };
    const serialized = JSON.stringify(normalized);
    await ensureRoomForLargeValue(client, serialized);
    const tx = client.multi();
    tx.set(cityKey(seg, uf, cityName), serialized);
    tx.hset(stateSummaryKey(seg, uf), cityName, JSON.stringify(publicCitySummary(normalized)));
    tx.sadd(STATE_INDEX_KEY, stateRef(seg, uf));
    if (result.delta) queueStatsDelta(tx, result.delta.sellerId, result.delta.day, result.delta.segment, result.delta.amount);
    const out = await tx.exec();
    const failed = (out || []).find(([err]) => err);
    if (failed?.[0]) throw failed[0];
    return { city: normalized, ...(result.extra || {}) };
  });
}
async function writeResults(client, updater) {
  await ensureNotMaintenance(client);
  return withLock(client, ROOT + ":lock:results", async () => {
    await ensureNotMaintenance(client);
    const results = await readResults(client);
    const next = await updater(results) || results;
    next.updatedAt = now();
    await client.set(RESULTS_KEY, JSON.stringify(next));
    return next;
  });
}

async function maybeAppendHistory(client, event) {
  try {
    await writeMeta(client, (meta) => {
      meta.historico = [event, ...(meta.historico || [])].slice(0, 300);
      return meta;
    });
  } catch {}
}

let lastBackupCheckAt = 0;

async function buildBackupSnapshot(client) {
  const meta = await readMeta(client);
  const [resultsRaw, refs, stats] = await Promise.all([
    client.get(RESULTS_KEY), client.smembers(STATE_INDEX_KEY), readStats(client, meta),
  ]);
  const metaRaw = JSON.stringify(meta);
  const statsRaw = JSON.stringify(stats);
  const cities = {};
  for (const ref of refs) {
    const parsed = parseStateRef(ref);
    if (!parsed) continue;
    const names = await client.hkeys(stateSummaryKey(parsed.seg, parsed.uf));
    const raws = names.length ? await client.mget(...names.map((name) => cityKey(parsed.seg, parsed.uf, name))) : [];
    cities[ref] = {};
    names.forEach((name, i) => { if (raws[i] != null) cities[ref][name] = raws[i]; });
  }
  return JSON.stringify({ version: 4, layout: "city-v1", metaRaw, statsRaw, resultsRaw, cities, createdAt: now() });
}
async function trimBackups(client, limit = MAX_BACKUPS) {
  let len = num(await client.llen(BACKUP_INDEX_KEY));
  while (len > limit) {
    const ts = await client.rpop(BACKUP_INDEX_KEY);
    if (!ts) break;
    await client.del(BACKUP_PREFIX + ts);
    len--;
  }
}
async function hasMemoryRoomForBackup(client, bytes) {
  try {
    const info = await client.info("memory");
    const used = num(/used_memory:(\d+)/.exec(info)?.[1]);
    const max = num(/maxmemory:(\d+)/.exec(info)?.[1]);
    if (!max) return true;
    // Mantém folga para as gravações de produção; backup nunca pode voltar a causar OOM.
    return used + Math.max(0, bytes) < max * 0.82;
  } catch { return true; }
}
async function maybeBackup(client) {
  if (await client.exists(MAINTENANCE_KEY)) return;
  await trimBackups(client, MAX_BACKUPS);
  const latest = await client.lindex(BACKUP_INDEX_KEY, 0);
  const latestMs = latest ? new Date(latest).getTime() : 0;
  if (latestMs && now() - latestMs < BACKUP_INTERVAL_MS) return;
  const ts = new Date().toISOString();
  try {
    const packed = await compact(await buildBackupSnapshot(client));
    if (!(await hasMemoryRoomForBackup(client, Buffer.byteLength(packed, "utf8")))) return;

    // Primeiro confirma o NOVO backup. Só depois remove o anterior. Se a rede,
    // a Function ou o Redis falhar no meio, continuamos com o último backup bom.
    await client.set(BACKUP_PREFIX + ts, packed);
    await client.lpush(BACKUP_INDEX_KEY, ts);
    await trimBackups(client, MAX_BACKUPS);
  } catch (err) {
    if (!isOOM(err)) throw err;
    // OOM ao criar backup nunca apaga o backup anterior nem afeta a produção.
    try { await client.del(BACKUP_PREFIX + ts); } catch {}
  }
}
async function maybeBackupThrottled(client) {
  const t = now();
  if (t - lastBackupCheckAt < 10 * 60 * 1000) return;
  lastBackupCheckAt = t;
  try {
    // lastBackupCheckAt é apenas uma otimização por instância. O lock no Redis é
    // a proteção real entre várias instâncias serverless do Vercel.
    await withLock(client, BACKUP_LOCK_KEY, () => maybeBackup(client), { ttl: 120000, retries: 1 });
  } catch (e) {
    if (e?.statusCode !== 409) throw e;
  }
}

function sanitizeContact(c) {
  return {
    id: String(c?.id || randomUUID().replace(/-/g, "").slice(0, 12)).slice(0, 80),
    nome: String(c?.nome || "").slice(0, 500),
    telefone: String(c?.telefone || "").slice(0, 80),
    endereco: String(c?.endereco || "").slice(0, 1000),
    enviado: !!c?.enviado,
    enviadoTs: c?.enviadoTs ? num(c.enviadoTs) : null,
    enviadoPor: String(c?.enviadoPor || "").slice(0, 200),
    enviadoSellerId: String(c?.enviadoSellerId || "").slice(0, 100),
    enviadoSegmento: String(c?.enviadoSegmento || "").slice(0, 500),
    enviadoUf: String(c?.enviadoUf || "").slice(0, 5),
    enviadoCidade: String(c?.enviadoCidade || "").slice(0, 500),
  };
}

async function restoreBackup(client, ts) {
  return withLock(client, RESTORE_LOCK_KEY, async () => {
    const maintenanceToken = randomUUID();
    const maintenanceOk = await client.set(MAINTENANCE_KEY, maintenanceToken, "PX", 5 * 60 * 1000, "NX");
    if (maintenanceOk !== "OK") {
      const e = new Error("já existe uma manutenção/restauração em andamento"); e.statusCode = 409; throw e;
    }
    try {
      // Bloqueia novas gravações e espera as poucas que já estavam em andamento
      // concluírem antes de começar a substituir as chaves do banco.
      const drained = await waitForWriteLocksToDrain(client, 15000);
      if (!drained) {
        const e = new Error("não foi possível iniciar a restauração porque ainda existem gravações em andamento"); e.statusCode = 409; throw e;
      }

      const raw = await client.get(BACKUP_PREFIX + ts);
    if (!raw) { const e = new Error("esse backup não existe mais"); e.statusCode = 404; throw e; }
    const snapshot = jsonParse(expand(raw), null);
    if (!snapshot || snapshot.version !== 4) throw new Error("backup inválido");

    const currentRefs = await client.smembers(STATE_INDEX_KEY);
    for (const ref of currentRefs) {
      const parsed = parseStateRef(ref);
      if (!parsed) continue;
      const names = await client.hkeys(stateSummaryKey(parsed.seg, parsed.uf));
      if (names.length) await client.del(...names.map((name) => cityKey(parsed.seg, parsed.uf, name)));
      await client.del(stateSummaryKey(parsed.seg, parsed.uf));
      await client.del(legacyV4StateKey(parsed.seg, parsed.uf));
    }
    await client.del(STATE_INDEX_KEY);

    // Formato novo (por cidade).
    if (snapshot.cities) {
      for (const [ref, cityMap] of Object.entries(snapshot.cities || {})) {
        const parsed = parseStateRef(ref);
        if (!parsed) continue;
        const tx = client.multi();
        for (const [cityName, cityRaw] of Object.entries(cityMap || {})) {
          const city = jsonParse(cityRaw, defaultCity());
          tx.set(cityKey(parsed.seg, parsed.uf, cityName), JSON.stringify(city));
          tx.hset(stateSummaryKey(parsed.seg, parsed.uf), cityName, JSON.stringify(publicCitySummary(city)));
        }
        tx.sadd(STATE_INDEX_KEY, ref);
        await execMultiOrThrow(tx, "restauração das cidades");
      }
    } else if (snapshot.states) {
      // Compatibilidade com um backup da primeira revisão v4 (um JSON por estado).
      for (const [ref, stateRaw] of Object.entries(snapshot.states || {})) {
        const parsed = parseStateRef(ref);
        const state = jsonParse(stateRaw, null);
        if (!parsed || !state?.cidades) continue;
        const tx = client.multi();
        for (const [cityName, city] of Object.entries(state.cidades || {})) {
          tx.set(cityKey(parsed.seg, parsed.uf, cityName), JSON.stringify(city));
          tx.hset(stateSummaryKey(parsed.seg, parsed.uf), cityName, JSON.stringify(publicCitySummary(city)));
        }
        tx.sadd(STATE_INDEX_KEY, ref);
        await execMultiOrThrow(tx, "restauração dos estados legados");
      }
    }

    const restoredMeta = jsonParse(snapshot.metaRaw, defaultMeta());
    restoredMeta.storageLayout = "city-v1";
    restoredMeta.statsLayout = STATS_LAYOUT;
    restoredMeta.adminVersion = num(restoredMeta.adminVersion || 1) + 1;
    restoredMeta.authVersions ||= {};
    for (const key of Object.keys(restoredMeta.authVersions)) restoredMeta.authVersions[key] = num(restoredMeta.authVersions[key] || 1) + 1;
    restoredMeta.updatedAt = now();
    await client.set(META_KEY, JSON.stringify(restoredMeta));
    const restoredStats = jsonParse(snapshot.statsRaw, defaultStats());
    await replaceStatsShards(client, restoredMeta, restoredStats);
    await client.set(STATS_KEY, JSON.stringify(restoredStats)); // cópia compatível, não usada em produção
      await client.set(RESULTS_KEY, snapshot.resultsRaw || JSON.stringify(defaultResults()));
      // O índice de telefone é derivado das cidades. Uma restauração muda o
      // conjunto de contatos, então ele deve ser reconstruído na próxima importação.
      await client.del(PHONE_INDEX_KEY, PHONE_INDEX_READY_KEY);
      return true;
    } finally {
      try {
        await client.eval(
          "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
          1, MAINTENANCE_KEY, maintenanceToken,
        );
      } catch {}
    }
  }, { ttl: 30000, retries: 160 });
}

function sendError(res, err) {
  const status = err?.statusCode || 500;
  const msg = String(err?.message || err || "erro inesperado");
  res.status(status).json({ error: msg });
}

export default async function handler(req, res) {
  let client;
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    client = getRedis();
    await migrateLegacy(client);
    await migrateStatsStorage(client);
    const meta = await readMeta(client);

    if (req.method === "GET") {
      const mode = String(req.query?.mode || "bootstrap");
      const session = validateSession(meta, req);

      if (mode === "bootstrap") {
        const data = await bootstrap(client, meta, session);
        res.status(200).json({ data, session: session ? { type: session.type } : null });
        return;
      }

      if (mode === "state") {
        const seg = String(req.query?.seg || "");
        const uf = String(req.query?.uf || "").toUpperCase();
        const s = requireStateOrAdmin(meta, req, seg, uf);
        res.status(200).json(await stateResponse(client, meta, seg, uf, s));
        return;
      }

      if (mode === "city") {
        const seg = String(req.query?.seg || "");
        const uf = String(req.query?.uf || "").toUpperCase();
        const cityName = normalizeName(req.query?.city || "");
        const citySession = requireStateOrAdmin(meta, req, seg, uf);
        if (!cityName) { res.status(400).json({ error: "cidade inválida" }); return; }
        const offset = clampInt(req.query?.offset);
        const limit = clampInt(req.query?.limit || 1000, 100, 1500);
        res.status(200).json({ segmento: seg, uf, cidade: cityName, city: await cityResponse(client, seg, uf, cityName, offset, limit, citySession.type !== "admin") });
        return;
      }

      if (mode === "search_contacts") {
        requireAdmin(meta, req);
        const q = String(req.query?.q || "").replace(/\D/g, "");
        const seg = String(req.query?.seg || "");
        if (q.length < 4) { res.status(200).json({ items: [] }); return; }
        res.status(200).json({ items: await searchContacts(client, q, 8, seg) });
        return;
      }

      if (mode === "backups") {
        requireAdmin(meta, req);
        const backups = await client.lrange(BACKUP_INDEX_KEY, 0, MAX_BACKUPS - 1);
        res.status(200).json({ backups });
        return;
      }

      if (mode === "health") {
        requireAdmin(meta, req);
        const [refs, mem] = await Promise.all([
          client.scard(STATE_INDEX_KEY),
          client.info("memory").catch(() => ""),
        ]);
        const used = /used_memory:(\d+)/.exec(mem)?.[1] || null;
        const max = /maxmemory:(\d+)/.exec(mem)?.[1] || null;
        const phoneIndexReady = jsonParse(await client.get(PHONE_INDEX_READY_KEY), null);
        res.status(200).json({ ok: true, storageVersion: 4, states: num(refs), usedMemory: used ? num(used) : null, maxMemory: max ? num(max) : null, phoneIndex: phoneIndexReady });
        return;
      }

      res.status(400).json({ error: "modo inválido" });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "método não permitido" });
      return;
    }

    const body = typeof req.body === "string" ? jsonParse(req.body, {}) : (req.body || {});
    const action = String(body.action || "");

    if (action === "login_admin") {
      const ip = String(req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || "unknown").split(",")[0].trim().slice(0, 120);
      const ipHash = createHmac("sha256", SESSION_SECRET_SERVER).update(ip).digest("hex").slice(0, 24);
      const failKey = `${ROOT}:login:admin:${ipHash}`;
      const fails = num(await client.get(failKey));
      if (fails >= ADMIN_LOGIN_MAX_FAILS) {
        res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." }); return;
      }
      const supplied = String(body.password || "").trim();
      const a = Buffer.from(supplied);
      const b = Buffer.from(ADMIN_PASSWORD_SERVER);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (!ok) {
        const count = await client.incr(failKey);
        if (count === 1) await client.expire(failKey, ADMIN_LOGIN_WINDOW_SEC);
        res.status(401).json({ error: "Senha incorreta." }); return;
      }
      await client.del(failKey);
      const token = issueAdmin(meta);
      clearSellerCookie(req, res);
      setAdminCookie(req, res, token);
      const data = await bootstrap(client, meta, { type: "admin", v: meta.adminVersion || 1 });
      res.status(200).json({ ok: true, data, session: { type: "admin" } });
      return;
    }

    if (action === "login_seller") {
      const ip = String(req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || "unknown").split(",")[0].trim().slice(0, 120);
      const ipHash = createHmac("sha256", SESSION_SECRET_SERVER).update(ip).digest("hex").slice(0, 24);
      const failKey = `${ROOT}:login:seller:${ipHash}`;
      const fails = num(await client.get(failKey));
      if (fails >= ADMIN_LOGIN_MAX_FAILS) {
        res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." }); return;
      }
      const supplied = String(body.password || "").replace(/\s+/g, "");
      const a = Buffer.from(supplied);
      const b = Buffer.from(SELLER_PASSWORD_SERVER);
      const okPassword = a.length === b.length && timingSafeEqual(a, b);
      if (!okPassword) {
        const count = await client.incr(failKey);
        if (count === 1) await client.expire(failKey, ADMIN_LOGIN_WINDOW_SEC);
        res.status(401).json({ error: "Senha do Acesso 2 incorreta." }); return;
      }
      await client.del(failKey);
      clearAdminCookie(req, res);
      setSellerCookie(req, res, issueSeller());
      const payload = { type: "seller" };
      const data = await bootstrap(client, meta, payload);
      res.status(200).json({ ok: true, data, session: { type: "seller" } });
      return;
    }

    if (action === "logout_session" || action === "logout_admin") {
      clearAdminCookie(req, res);
      clearSellerCookie(req, res);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === "login_state") {
      requireSellerGate(meta, req);
      const seg = String(body.seg || "");
      const uf = String(body.uf || "").toUpperCase();
      const k = assignmentKey(seg, uf);
      const sellerId = meta.atribuicoes?.[k] || null;
      const seller = sellerId ? sellerById(meta, sellerId) : null;
      if (!seller?.active) {
        res.status(403).json({ error: "Este estado ainda não tem vendedor atribuído. O administrador precisa fazer a atribuição primeiro." }); return;
      }

      const ip = String(req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || "unknown").split(",")[0].trim().slice(0, 120);
      const ipHash = createHmac("sha256", SESSION_SECRET_SERVER).update(ip).digest("hex").slice(0, 20);
      const stateHash = createHmac("sha256", SESSION_SECRET_SERVER).update(k).digest("hex").slice(0, 12);
      const failKey = `${ROOT}:login:state:${ipHash}:${stateHash}`;
      const fails = num(await client.get(failKey));
      if (fails >= ADMIN_LOGIN_MAX_FAILS) {
        res.status(429).json({ error: "Muitas tentativas neste estado. Aguarde alguns minutos e tente novamente." }); return;
      }

      const expected = String(meta.senhasEstado?.[k] || "1234");
      const supplied = String(body.password || "");
      const a = Buffer.from(supplied);
      const b = Buffer.from(expected);
      const okPassword = a.length === b.length && timingSafeEqual(a, b);
      if (!okPassword) {
        const count = await client.incr(failKey);
        if (count === 1) await client.expire(failKey, ADMIN_LOGIN_WINDOW_SEC);
        res.status(401).json({ error: "Senha deste estado incorreta." }); return;
      }
      await client.del(failKey);

      const token = issueState(meta, seg, uf, seller.id);
      const payload = { type: "state", seg, uf, sellerId: seller.id, v: meta.authVersions?.[k] || 1 };
      const state = await stateResponse(client, meta, seg, uf, payload);
      res.status(200).json({ ok: true, token, state, sellerName: seller.name });
      return;
    }

    if (action === "add_segment") {
      requireAdmin(meta, req);
      const name = normalizeName(body.name);
      if (!name) { res.status(400).json({ error: "nome do segmento vazio" }); return; }
      const next = await writeMeta(client, (m) => {
        if (!m.ordemSegmentos.includes(name)) m.ordemSegmentos.push(name);
        return m;
      });
      await maybeBackupThrottled(client).catch(() => {});
      res.status(200).json({ ok: true, ordemSegmentos: next.ordemSegmentos });
      return;
    }

    if (action === "update_city") {
      const seg = String(body.seg || "");
      const uf = String(body.uf || "").toUpperCase();
      const cityName = normalizeName(body.city);
      const session = requireAdmin(meta, req);
      if (!cityName) { res.status(400).json({ error: "cidade inválida" }); return; }
      const allowed = ["empresas", "fechados", "valor", "status", "obs"];
      const patch = {};
      for (const key of allowed) if (Object.prototype.hasOwnProperty.call(body.patch || {}, key)) patch[key] = body.patch[key];
      const validStatuses = new Set(["nao_iniciado", "em_andamento", "concluido"]);
      if (patch.status !== undefined && !validStatuses.has(patch.status)) delete patch.status;
      if (patch.obs !== undefined) patch.obs = String(patch.obs || "").slice(0, 5000);
      for (const key of ["empresas", "fechados", "valor"]) if (patch[key] !== undefined) patch[key] = String(patch[key] || "").replace(/[^0-9]/g, "").slice(0, 20);

      let before;
      const after = await writeCity(client, seg, uf, cityName, (city) => {
        before = { ...defaultCity(), ...(city || {}) };
        return { ...before, ...patch };
      });
      if (patch.status === "concluido" && before?.status !== "concluido") {
        await maybeAppendHistory(client, { ts: now(), seg, uf, cidade: cityName, tipo: "concluido" });
      }
      res.status(200).json({ ok: true, citySummary: publicCitySummary(after), sessionType: session.type });
      return;
    }

    if (action === "import_contacts") {
      const seg = String(body.seg || "");
      const uf = String(body.uf || "").toUpperCase();
      const cityName = normalizeName(body.city);
      requireAdmin(meta, req);
      const incoming = Array.isArray(body.contacts) ? body.contacts.slice(0, MAX_BODY_CONTACTS).map(sanitizeContact) : [];
      if (!cityName || !incoming.length) { res.status(400).json({ error: "nenhum contato válido para importar" }); return; }

      // A importação usa um lock global curto porque a unicidade do telefone é
      // GLOBAL no painel. Isso serializa somente importações/remoções, nunca os
      // cliques de WhatsApp, metas ou edições normais dos vendedores.
      const result = await withLock(client, IMPORT_LOCK_KEY, async () => {
        await ensureNotMaintenance(client);
        await ensurePhoneIndexUnlocked(client);

        const normalizedIncoming = incoming.map((raw) => ({ raw, phone: normalizePhone(raw.telefone) }));
        const uniquePhones = [...new Set(normalizedIncoming.map((x) => x.phone).filter((p) => p && p.length >= 8))];
        const existingGlobalRaw = uniquePhones.length ? await client.hmget(PHONE_INDEX_KEY, ...uniquePhones) : [];
        const existingMap = new Map(uniquePhones.map((phone, i) => [phone, parsePhoneIndexValue(existingGlobalRaw[i])]));
        const acceptedInBatch = new Set();
        let invalidIgnored = 0;
        let duplicateIgnored = 0;
        let alreadyPresent = 0;
        const candidates = [];

        for (const item of normalizedIncoming) {
          const phone = item.phone;
          if (!phone || phone.length < 8) { invalidIgnored++; continue; }
          const indexed = existingMap.get(phone);
          if (indexed) {
            // Retry idempotente: se a primeira resposta HTTP se perdeu, o mesmo
            // contato (mesmo id e destino) já está no banco e conta como sucesso,
            // não como "duplicado".
            if (indexed.seg === seg && indexed.uf === uf && indexed.city === cityName && String(indexed.contactId || "") === String(item.raw.id || "")) alreadyPresent++;
            else duplicateIgnored++;
            continue;
          }
          if (acceptedInBatch.has(phone)) { duplicateIgnored++; continue; }
          acceptedInBatch.add(phone);
          candidates.push({ raw: item.raw, phone });
        }

        if (!candidates.length) {
          const city = await readCity(client, seg, uf, cityName);
          return { city, added: [], duplicateIgnored, invalidIgnored, alreadyPresent };
        }

        let added = [];
        const city = await withLock(client, cityLockKey(seg, uf, cityName), async () => {
          await ensureNotMaintenance(client);
          const current = { ...defaultCity(), ...(await readCity(client, seg, uf, cityName)) };
          const existing = Array.isArray(current.contatos) ? current.contatos : [];
          const ids = new Set(existing.map((c) => String(c?.id || "")).filter(Boolean));
          added = [];
          for (const item of candidates) {
            const c = { ...sanitizeContact(item.raw), enviado: false, enviadoTs: null, enviadoPor: "", enviadoSellerId: "", enviadoSegmento: "", enviadoUf: "", enviadoCidade: "" };
            while (!c.id || ids.has(String(c.id))) c.id = randomUUID().replace(/-/g, "").slice(0, 16);
            c._normalizedPhone = item.phone;
            added.push(c);
            ids.add(String(c.id));
          }
          const storedAdded = added.map(({ _normalizedPhone, ...c }) => c);
          const normalized = { ...defaultCity(), ...current, contatos: [...existing, ...storedAdded] };
          const serialized = JSON.stringify(normalized);
          await ensureRoomForLargeValue(client, serialized, true);

          const tx = client.multi();
          tx.set(cityKey(seg, uf, cityName), serialized);
          tx.hset(stateSummaryKey(seg, uf), cityName, JSON.stringify(publicCitySummary(normalized)));
          tx.sadd(STATE_INDEX_KEY, stateRef(seg, uf));
          for (const c of added) tx.hset(PHONE_INDEX_KEY, c._normalizedPhone, phoneIndexValue(seg, uf, cityName, c.id));
          await execMultiOrThrow(tx, "importação de contatos");
          return normalized;
        }, { ttl: 30000, retries: 160 });

        const cleanAdded = added.map(({ _normalizedPhone, ...c }) => c);
        return { city, added: cleanAdded, duplicateIgnored, invalidIgnored, alreadyPresent };
      }, { ttl: 45000, retries: 200 });

      await maybeBackupThrottled(client).catch(() => {});
      res.status(200).json({
        ok: true,
        added: result.added,
        addedCount: result.added.length,
        duplicateIgnored: result.duplicateIgnored,
        invalidIgnored: result.invalidIgnored,
        alreadyPresent: result.alreadyPresent || 0,
        citySummary: publicCitySummary(result.city),
      });
      return;
    }

    if (action === "send_contact") {
      const seg = String(body.seg || "");
      const uf = String(body.uf || "").toUpperCase();
      const cityName = normalizeName(body.city);
      const contactId = String(body.contactId || "");
      const session = requireStateOrAdmin(meta, req, seg, uf);
      const sellerId = meta.atribuicoes?.[assignmentKey(seg, uf)] || null;
      const seller = sellerId ? sellerById(meta, sellerId) : null;
      if (!cityName || !contactId) { res.status(400).json({ error: "cidade ou contato inválido" }); return; }
      if (!seller?.active) { res.status(409).json({ error: "atribua um vendedor ativo a este estado antes de registrar envios" }); return; }
      if (session.type === "state" && session.sellerId !== sellerId) { res.status(403).json({ error: "a atribuição deste estado mudou; entre novamente" }); return; }

      // O lock da própria cidade já serializa alterações concorrentes e a lógica
      // abaixo é idempotente. Evitar um segundo lock reduz round-trips e espera.
      const output = await writeCityAndStatDelta(client, seg, uf, cityName, (currentCity) => {
        const contacts = Array.isArray(currentCity.contatos) ? [...currentCity.contatos] : [];
        const idx = contacts.findIndex((c) => String(c.id) === contactId);
        if (idx < 0) { const e = new Error("contato não encontrado"); e.statusCode = 404; throw e; }
        const current = contacts[idx];
        if (current.enviado) {
          return { city: currentCity, delta: null, extra: { changed: false, contact: current } };
        }
        const ts = now();
        const next = {
          ...current,
          enviado: true,
          enviadoTs: ts,
          enviadoPor: seller.name,
          enviadoSellerId: seller.id,
          enviadoSegmento: seg,
          enviadoUf: uf,
          enviadoCidade: cityName,
        };
        contacts[idx] = next;
        return {
          city: { ...currentCity, contatos: contacts },
          delta: { sellerId: seller.id, day: dataLocalISO(ts), segment: seg, amount: 1 },
          extra: { changed: true, contact: next },
        };
      });
      res.status(200).json({
        ok: true, changed: output.changed, contact: session.type === "admin" ? output.contact : sellerContactView(output.contact),
        citySummary: session.type === "admin" ? publicCitySummary(output.city) : sellerCitySummary(output.city),
        estatisticasMensagens: mapStatsForFrontend(meta, await readStats(client, meta, [seller.id]), [seller.id]),
      });
      return;
    }

    if (action === "unmark_contact") {
      const seg = String(body.seg || "");
      const uf = String(body.uf || "").toUpperCase();
      const cityName = normalizeName(body.city);
      const contactId = String(body.contactId || "");
      const session = requireAdmin(meta, req);
      if (!cityName || !contactId) { res.status(400).json({ error: "cidade ou contato inválido" }); return; }
      const output = await writeCityAndStatDelta(client, seg, uf, cityName, (currentCity) => {
        const contacts = Array.isArray(currentCity.contatos) ? [...currentCity.contatos] : [];
        const idx = contacts.findIndex((c) => String(c.id) === contactId);
        if (idx < 0) { const e = new Error("contato não encontrado"); e.statusCode = 404; throw e; }
        const old = contacts[idx];
        if (!old.enviado) return { city: currentCity, delta: null, extra: { changed: false, contact: old } };
        const originalSeller = old.enviadoSellerId ? sellerById(meta, old.enviadoSellerId) : sellerByName(meta, old.enviadoPor || "");
        if (session.type === "state") {
          if (!originalSeller || originalSeller.id !== session.sellerId) {
            const e = new Error("somente o vendedor que fez este envio ou o administrador pode desfazê-lo"); e.statusCode = 403; throw e;
          }
          if (old.enviadoTs && now() - num(old.enviadoTs) > UNMARK_WINDOW_MS) {
            const e = new Error("este envio é antigo; somente o administrador pode corrigir o histórico"); e.statusCode = 403; throw e;
          }
        }
        const next = { ...old, enviado: false, enviadoTs: null, enviadoPor: "", enviadoSellerId: "", enviadoSegmento: "", enviadoUf: "", enviadoCidade: "" };
        contacts[idx] = next;
        return {
          city: { ...currentCity, contatos: contacts },
          delta: originalSeller && old.enviadoTs ? { sellerId: originalSeller.id, day: dataLocalISO(old.enviadoTs), segment: old.enviadoSegmento || seg, amount: -1 } : null,
          extra: { changed: true, contact: next },
        };
      });
      const assigned = meta.atribuicoes?.[assignmentKey(seg, uf)];
      res.status(200).json({
        ok: true, changed: output.changed, contact: output.contact,
        citySummary: publicCitySummary(output.city),
        estatisticasMensagens: mapStatsForFrontend(meta, await readStats(client, meta, assigned ? [assigned] : []), assigned ? [assigned] : []),
      });
      return;
    }

    if (action === "remove_contact") {
      const seg = String(body.seg || "");
      const uf = String(body.uf || "").toUpperCase();
      const cityName = normalizeName(body.city);
      const contactId = String(body.contactId || "");
      requireAdmin(meta, req);
      if (!cityName || !contactId) { res.status(400).json({ error: "cidade ou contato inválido" }); return; }

      const output = await withLock(client, IMPORT_LOCK_KEY, async () => {
        await ensurePhoneIndexUnlocked(client);
        let removed = false;
        let removedContact = null;
        const city = await writeCity(client, seg, uf, cityName, (currentCity) => {
          const contacts = Array.isArray(currentCity.contatos) ? currentCity.contatos : [];
          const found = contacts.find((c) => String(c.id) === contactId);
          if (!found) return currentCity; // retry idempotente
          removed = true; removedContact = found;
          return { ...currentCity, contatos: contacts.filter((c) => String(c.id) !== contactId) };
        });

        if (removedContact) {
          const phone = normalizePhone(removedContact.telefone);
          if (phone) {
            const indexed = parsePhoneIndexValue(await client.hget(PHONE_INDEX_KEY, phone));
            const wasThis = indexed && indexed.seg === seg && indexed.uf === uf && indexed.city === cityName && String(indexed.contactId || "") === contactId;
            if (wasThis) {
              // Se já existia uma duplicata histórica antes da barreira, mantém o
              // índice apontando para ela. Caso contrário, libera o telefone.
              const replacement = await findPhoneElsewhere(client, phone, { seg, uf, city: cityName, contactId });
              if (replacement) await client.hset(PHONE_INDEX_KEY, phone, phoneIndexValue(replacement.seg, replacement.uf, replacement.city, replacement.contactId));
              else await client.hdel(PHONE_INDEX_KEY, phone);
            }
          }
        }
        return { city, removed };
      }, { ttl: 30000, retries: 160 });

      // Histórico/estatística de produtividade NÃO é apagado quando o contato é removido.
      // Se a primeira resposta se perder na rede, repetir a operação continua dando sucesso.
      res.status(200).json({ ok: true, removed: output.removed, removedId: contactId, citySummary: publicCitySummary(output.city) });
      return;
    }

    if (action === "add_seller") {
      requireAdmin(meta, req);
      const name = normalizeName(body.name);
      if (!name) { res.status(400).json({ error: "nome vazio" }); return; }
      const next = await writeMeta(client, (m) => {
        const existing = sellerByName(m, name);
        if (existing?.active) return m;
        if (existing) existing.active = true;
        else ensureSeller(m, name, true);
        return m;
      });
      await maybeBackupThrottled(client).catch(() => {});
      const stats = await readStats(client, meta); const results = await readResults(client);
      res.status(200).json({ ok: true, admin: frontendAdminFields(next, stats, results) });
      return;
    }

    if (action === "remove_seller") {
      requireAdmin(meta, req);
      const name = normalizeName(body.name);
      const next = await writeMeta(client, (m) => {
        const seller = sellerByName(m, name);
        if (!seller) return m;
        seller.active = false;
        for (const [k, id] of Object.entries(m.atribuicoes || {})) {
          if (id === seller.id) {
            delete m.atribuicoes[k];
            m.authVersions[k] = num(m.authVersions[k] || 1) + 1;
          }
        }
        return m;
      });
      await maybeBackupThrottled(client).catch(() => {});
      const stats = await readStats(client, meta); const results = await readResults(client);
      res.status(200).json({ ok: true, admin: frontendAdminFields(next, stats, results) });
      return;
    }

    if (action === "assign_seller") {
      requireAdmin(meta, req);
      const seg = String(body.seg || ""); const uf = String(body.uf || "").toUpperCase();
      const name = normalizeName(body.seller || "");
      const next = await writeMeta(client, (m) => {
        const k = assignmentKey(seg, uf);
        if (!name) delete m.atribuicoes[k];
        else {
          const s = sellerByName(m, name);
          if (!s?.active) { const e = new Error("vendedor não encontrado ou inativo"); e.statusCode = 404; throw e; }
          m.atribuicoes[k] = s.id;
        }
        m.authVersions[k] = num(m.authVersions[k] || 1) + 1; // derruba sessão antiga do estado
        return m;
      });
      await maybeBackupThrottled(client).catch(() => {});
      const stats = await readStats(client, meta); const results = await readResults(client);
      res.status(200).json({ ok: true, admin: frontendAdminFields(next, stats, results) });
      return;
    }

    if (action === "set_message") {
      requireAdmin(meta, req);
      const seg = String(body.seg || "");
      const text = String(body.text || "").slice(0, 20000);
      const next = await writeMeta(client, (m) => { m.mensagens ||= {}; m.mensagens[seg] = text; return m; });
      res.status(200).json({ ok: true, mensagens: next.mensagens });
      return;
    }

    if (action === "set_global_meta") {
      requireAdmin(meta, req);
      const value = clampInt(body.value);
      const next = await writeMeta(client, (m) => { m.meta = value; return m; });
      res.status(200).json({ ok: true, meta: next.meta });
      return;
    }

    if (action === "set_seller_goal") {
      requireAdmin(meta, req);
      const seller = sellerByName(meta, body.seller || "");
      if (!seller) { res.status(404).json({ error: "vendedor não encontrado" }); return; }
      const value = clampInt(body.value);
      const day = dataLocalISO();
      const next = await writeMeta(client, (m) => {
        m.metasVendedor ||= {}; m.metaAlteracoesVendedor ||= {};
        m.metasVendedor[seller.id] = value;
        const hist = [...(m.metaAlteracoesVendedor[seller.id] || [])].filter((x) => x?.dia !== day);
        m.metaAlteracoesVendedor[seller.id] = [...hist, { dia: day, valor: value, ts: now() }].sort((a, b) => String(a.dia).localeCompare(String(b.dia)));
        return m;
      });
      const stats = await readStats(client, meta); const results = await readResults(client);
      res.status(200).json({ ok: true, admin: frontendAdminFields(next, stats, results) });
      return;
    }

    if (action === "save_conversion") {
      requireAdmin(meta, req);
      const seller = sellerByName(meta, body.seller || "");
      const day = String(body.day || "");
      if (!seller) { res.status(404).json({ error: "vendedor não encontrado" }); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { res.status(400).json({ error: "data inválida" }); return; }
      const solicitacoes = clampInt(body.solicitacoes);
      const vendas = clampInt(body.vendas);
      const next = await writeResults(client, (r) => {
        r.porVendedor ||= {}; r.porVendedor[seller.id] ||= {};
        if (solicitacoes === 0 && vendas === 0) delete r.porVendedor[seller.id][day];
        else r.porVendedor[seller.id][day] = { solicitacoes, vendas, atualizadoEm: now() };
        return r;
      });
      await maybeBackupThrottled(client).catch(() => {});
      res.status(200).json({ ok: true, resultadosProspeccao: mapResultsForFrontend(meta, next, null) });
      return;
    }

    if (action === "set_state_password") {
      requireAdmin(meta, req);
      const seg = String(body.seg || ""); const uf = String(body.uf || "").toUpperCase();
      const password = String(body.password || "").slice(0, 200);
      if (!password) { res.status(400).json({ error: "senha vazia" }); return; }
      const next = await writeMeta(client, (m) => {
        const k = assignmentKey(seg, uf);
        m.senhasEstado ||= {}; m.senhasEstado[k] = password;
        m.authVersions[k] = num(m.authVersions[k] || 1) + 1;
        return m;
      });
      res.status(200).json({ ok: true, senhasEstado: next.senhasEstado });
      return;
    }

    if (action === "restore_backup") {
      requireAdmin(meta, req);
      const ts = String(body.ts || "");
      await restoreBackup(client, ts);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: "ação inválida" });
  } catch (err) {
    const status = err?.statusCode || 500;
    if (status >= 500) console.error(err);
    const msg = String(err?.message || err);
    if (/connect|ECONNRESET|ETIMEDOUT|Connection is closed|Stream isn't writeable/i.test(msg)) descartarConexao();
    if (isOOM(err)) {
      err.message = msg + " O Redis atingiu o limite de memória; os dados atuais não foram confirmados.";
    }
    sendError(res, err);
  }
}
