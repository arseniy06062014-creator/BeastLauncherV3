const fs = require('fs');
const path = require('path');
const paths = require('./paths.cjs');
const { fetchJson, downloadFile, urlExists } = require('./http.cjs');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FORGE_PROMOS_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

function parseMc(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function cmpMc(a, b) {
  const A = parseMc(a);
  const B = parseMc(b);
  if (!A || !B) return 0;
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
}

let cache = { t: 0, data: null };

async function load() {
  if (cache.data && Date.now() - cache.t < 10 * 60 * 1000) return cache.data;
  const [manifest, promos] = await Promise.all([
    fetchJson(MANIFEST_URL),
    fetchJson(FORGE_PROMOS_URL),
  ]);
  cache = { t: Date.now(), data: { manifest, promos } };
  return cache.data;
}

// All Minecraft versions (Mojang manifest) + every Minecraft version that has a Forge build.
async function getVersions({ snapshots = false } = {}) {
  const { manifest, promos } = await load();
  const all = manifest.versions;
  const order = new Map(all.map((v, i) => [v.id, i]));
  const releaseIds = new Set(all.filter((v) => v.type === 'release').map((v) => v.id));

  const vanilla = all
    .filter((v) => v.type === 'release' || (snapshots && v.type === 'snapshot'))
    .map((v) => ({ id: v.id, type: v.type }));

  const byMc = {};
  for (const [key, value] of Object.entries(promos.promos || {})) {
    const m = /^(.+)-(latest|recommended)$/.exec(key);
    if (!m) continue;
    (byMc[m[1]] ||= {})[m[2]] = value;
  }

  const forge = Object.entries(byMc)
    .filter(([mc]) => releaseIds.has(mc) && cmpMc(mc, '1.7.10') >= 0)
    .sort((a, b) => order.get(a[0]) - order.get(b[0]))
    .map(([mc, v]) => ({
      mc,
      forge: v.recommended || v.latest,
      recommended: !!v.recommended,
    }));

  return { vanilla, forge };
}

async function getVersionType(mc) {
  const { manifest } = await load();
  return manifest.versions.find((v) => v.id === mc)?.type || 'release';
}

// Forge < 1.13 is launched from the "universal" jar, 1.13+ from the "installer" jar.
async function ensureForge(mc, onProgress) {
  const { forge } = await getVersions();
  const entry = forge.find((f) => f.mc === mc);
  if (!entry) throw new Error(`Для Minecraft ${mc} нет сборки Forge`);

  const legacy = cmpMc(mc, '1.13') < 0;
  const suffix = legacy ? 'universal.jar' : 'installer.jar';
  // Some old versions have a "-<mc>" branch suffix in the maven path (e.g. 1.7.10).
  const candidates = [`${mc}-${entry.forge}`, `${mc}-${entry.forge}-${mc}`];
  const dir = path.join(paths.cacheDir(), 'forge');

  for (const full of candidates) {
    const file = path.join(dir, `forge-${full}-${suffix}`);
    if (fs.existsSync(file)) return file;
  }
  for (const full of candidates) {
    const name = `forge-${full}-${suffix}`;
    const url = `${FORGE_MAVEN}/${full}/${name}`;
    if (await urlExists(url)) {
      const dest = path.join(dir, name);
      await downloadFile(url, dest, { onProgress });
      return dest;
    }
  }
  throw new Error(`Не удалось найти файл Forge для Minecraft ${mc}`);
}

module.exports = { getVersions, getVersionType, ensureForge, cmpMc };
