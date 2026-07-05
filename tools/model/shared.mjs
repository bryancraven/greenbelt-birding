import fs from 'node:fs';
import vm from 'node:vm';

export const MODEL_VERSION = 1;
export const MONTH_COUNT = 12;
export const HOUR_COUNT = 24;

export const DEFAULT_CONFIG = {
  region: {
    name: 'Boise River Greenbelt',
    center: { lat: 43.615, lon: -116.2023 },
    radiusKm: 20,
  },
  gbif: {
    maxOccurrenceSamples: 300,
    requestDelayMs: 125,
  },
  confidenceThresholds: {
    high: 200,
    medium: 50,
    low: 10,
  },
  manualOverrides: {},
};

export function readJson(path, fallback = null) {
  if (!fs.existsSync(path)) return fallback;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  fs.mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadConfig(path = 'tools/model/config.json') {
  return {
    ...DEFAULT_CONFIG,
    ...readJson(path, {}),
    region: {
      ...DEFAULT_CONFIG.region,
      ...(readJson(path, {})?.region || {}),
      center: {
        ...DEFAULT_CONFIG.region.center,
        ...(readJson(path, {})?.region?.center || {}),
      },
    },
    gbif: {
      ...DEFAULT_CONFIG.gbif,
      ...(readJson(path, {})?.gbif || {}),
    },
    confidenceThresholds: {
      ...DEFAULT_CONFIG.confidenceThresholds,
      ...(readJson(path, {})?.confidenceThresholds || {}),
    },
    manualOverrides: readJson(path, {})?.manualOverrides || {},
  };
}

export function loadBirdDatabase(indexPath = 'index.html') {
  const html = fs.readFileSync(indexPath, 'utf8');
  const match = html.match(/const BIRD_DATABASE = (\[[\s\S]*?\n\]);\n\n\/\/ Weather condition impacts/);
  if (!match) throw new Error('Could not extract BIRD_DATABASE from index.html');

  const context = {
    wikiImg: (filename) => `wiki:${filename}`,
  };
  return vm.runInNewContext(`(${match[1]})`, context);
}

export function speciesKey(bird) {
  return bird.ebirdCode || normalizeScientificName(bird.scientific);
}

export function normalizeScientificName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function clamp(value, min = 0.01, max = 0.99) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value, places = 4) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function presentMonthSet(bird) {
  if (Array.isArray(bird.months) && bird.months.length > 0) {
    return new Set(bird.months.map(Number));
  }
  return new Set(Array.from({ length: MONTH_COUNT }, (_, i) => i + 1));
}

export function fallbackMonthlyBaseline(bird) {
  const presentMonths = presentMonthSet(bird);
  const commonality = Number(bird.commonality || 0.2);
  return Array.from({ length: MONTH_COUNT }, (_, i) => {
    const month = i + 1;
    if (!presentMonths.has(month)) return round(Math.max(0.005, commonality * 0.04));
    return round(clamp(commonality, 0.01, 0.95));
  });
}

export function fallbackHourlyActivity(bird) {
  const peaks = new Set((bird.peakHours || []).map(Number));
  return Array.from({ length: HOUR_COUNT }, (_, hour) => {
    if (peaks.has(hour)) return 1.15;
    const nearPeak = [...peaks].some(peak => Math.abs(peak - hour) === 1 || Math.abs(peak - hour) === 23);
    if (nearPeak) return 0.9;
    if (hour >= 5 && hour <= 20) return 0.6;
    return 0.35;
  }).map(value => round(value));
}

export function confidenceForSample(sampleSize, thresholds) {
  if (sampleSize >= thresholds.high) return 'high';
  if (sampleSize >= thresholds.medium) return 'medium';
  if (sampleSize >= thresholds.low) return 'low';
  return 'fallback';
}

export function inferVocalScore(bird) {
  const family = String(bird.family || '').toLowerCase();
  const name = String(bird.name || '').toLowerCase();
  const description = String(bird.description || '').toLowerCase();
  const text = `${family} ${name} ${description}`;

  if (text.match(/warbler|wren|sparrow|finch|thrush|chickadee|blackbird|oriole|vireo|towhee|bunting|kinglet/)) return 0.9;
  if (text.match(/dove|quail|magpie|crow|jay|kingfisher|woodpecker|nuthatch|swallow|phoebe|kingbird/)) return 0.75;
  if (text.match(/goose|duck|swan|gull|rail|coot|crane|killdeer|nightjar|nighthawk/)) return 0.65;
  if (text.match(/hawk|eagle|falcon|osprey|vulture|heron|egret|cormorant|grebe|hummingbird/)) return 0.35;
  return 0.55;
}

export function applyManualOverride(row, override = {}) {
  return {
    ...row,
    ...(override.baselineByMonth ? { baselineByMonth: override.baselineByMonth } : {}),
    ...(override.activityByHour ? { activityByHour: override.activityByHour } : {}),
    ...(Number.isFinite(override.vocalScore) ? { vocalScore: override.vocalScore } : {}),
    ...(override.confidence ? { confidence: override.confidence } : {}),
    ...(override.notes ? { notes: override.notes } : {}),
  };
}

export function validateSpeciesRow(row) {
  const problems = [];
  if (!row || typeof row !== 'object') problems.push('row is not an object');
  if (!Array.isArray(row?.baselineByMonth) || row.baselineByMonth.length !== MONTH_COUNT) problems.push('baselineByMonth must have 12 values');
  if (!Array.isArray(row?.activityByHour) || row.activityByHour.length !== HOUR_COUNT) problems.push('activityByHour must have 24 values');
  for (const [field, values] of [['baselineByMonth', row?.baselineByMonth], ['activityByHour', row?.activityByHour]]) {
    if (!Array.isArray(values)) continue;
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) problems.push(`${field}[${index}] is not finite`);
      if (value < 0 || value > 1.25) problems.push(`${field}[${index}] is outside 0-1.25`);
    });
  }
  if (!Number.isFinite(row?.vocalScore) || row.vocalScore < 0 || row.vocalScore > 1) problems.push('vocalScore must be 0-1');
  if (!['high', 'medium', 'low', 'fallback'].includes(row?.confidence)) problems.push('confidence is invalid');
  return problems;
}

export function haversineKm(a, b) {
  const radius = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

export function circlePolygonWkt(center, radiusKm, points = 32) {
  const latRadius = radiusKm / 111.32;
  const lonRadius = radiusKm / (111.32 * Math.cos(toRad(center.lat)));
  const coords = [];
  for (let i = 0; i < points; i += 1) {
    const angle = (Math.PI * 2 * i) / points;
    const lon = center.lon + Math.cos(angle) * lonRadius;
    const lat = center.lat + Math.sin(angle) * latRadius;
    coords.push(`${round(lon, 6)} ${round(lat, 6)}`);
  }
  coords.push(coords[0]);
  return `POLYGON((${coords.join(',')}))`;
}

function toRad(value) {
  return (value * Math.PI) / 180;
}
