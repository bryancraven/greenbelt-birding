#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import {
  MODEL_VERSION,
  applyManualOverride,
  circlePolygonWkt,
  clamp,
  confidenceForSample,
  fallbackHourlyActivity,
  fallbackMonthlyBaseline,
  haversineKm,
  inferVocalScore,
  loadBirdDatabase,
  loadConfig,
  normalizeScientificName,
  presentMonthSet,
  round,
  speciesKey,
  writeJson,
} from './shared.mjs';

const args = parseArgs(process.argv.slice(2));
const source = args.source || 'gbif';
const config = loadConfig(args.config || 'tools/model/config.json');
const birds = loadBirdDatabase(args.index || 'index.html');
const outputPath = args.out || 'data/likelihood-model.json';
const reportPath = args.report || 'data/model-report.json';

const warnings = [];
const sourceSummary = {
  type: source === 'ebird-ebd' ? 'ebird-ebd' : source === 'fallback' ? 'app-fallback' : 'gbif-bootstrap',
  recordsUsed: 0,
  dateRange: [null, null],
};

let sourceData = new Map();
if (source === 'gbif') {
  sourceData = await loadGbifSourceData(birds, config, warnings, sourceSummary);
} else if (source === 'ebird-ebd') {
  if (!args.ebd || !args.sed) {
    throw new Error('Use --source ebird-ebd with --ebd /path/to/ebd.txt --sed /path/to/sampling-events.txt');
  }
  sourceData = await loadEbirdEbdSourceData(birds, config, args.ebd, args.sed, warnings, sourceSummary);
} else if (source !== 'fallback') {
  throw new Error(`Unsupported source: ${source}`);
}

const species = {};
const reportSpecies = {};

for (const bird of birds) {
  const key = speciesKey(bird);
  const data = sourceData.get(key);
  const fallbackMonths = fallbackMonthlyBaseline(bird);
  const fallbackHours = fallbackHourlyActivity(bird);
  const sampleSize = data?.sampleSize || 0;
  const confidence = confidenceForSample(sampleSize, config.confidenceThresholds);

  let row = {
    birdId: bird.id,
    name: bird.name,
    scientific: bird.scientific,
    ebirdCode: bird.ebirdCode || null,
    baselineByMonth: data ? buildMonthlyBaseline(bird, data.monthCounts, fallbackMonths, confidence, data.monthTotals) : fallbackMonths,
    activityByHour: data ? buildHourlyActivity(data.hourCounts, fallbackHours, data.hourTotals) : fallbackHours,
    vocalScore: round(inferVocalScore(bird), 2),
    sampleSize,
    confidence,
  };

  row = applyManualOverride(row, config.manualOverrides[key]);
  species[key] = row;
  reportSpecies[key] = {
    name: bird.name,
    confidence: row.confidence,
    sampleSize: row.sampleSize,
    source: data ? sourceSummary.type : 'fallback',
    modeled: Boolean(data),
  };
}

const model = {
  version: MODEL_VERSION,
  generatedAt: new Date().toISOString(),
  region: config.region,
  source: sourceSummary,
  species,
};

const report = {
  generatedAt: model.generatedAt,
  source: sourceSummary,
  speciesCount: birds.length,
  modeledSpeciesCount: Object.values(reportSpecies).filter(row => row.modeled).length,
  fallbackSpeciesCount: Object.values(reportSpecies).filter(row => !row.modeled).length,
  confidenceCounts: countBy(Object.values(species).map(row => row.confidence)),
  warnings,
  species: reportSpecies,
};

writeJson(outputPath, model);
writeJson(reportPath, report);

console.log(`Wrote ${outputPath}`);
console.log(`Wrote ${reportPath}`);
console.log(`Modeled ${report.modeledSpeciesCount}/${report.speciesCount} species from ${sourceSummary.type}`);
console.log(`Confidence: ${JSON.stringify(report.confidenceCounts)}`);
if (warnings.length) console.log(`Warnings: ${warnings.length}`);

function buildMonthlyBaseline(bird, monthCounts, fallbackMonths, confidence, monthTotals = null) {
  if (!monthCounts.some(Boolean) || confidence === 'fallback') return fallbackMonths;

  const presentMonths = presentMonthSet(bird);
  const monthSignals = monthTotals
    ? monthCounts.map((count, index) => monthTotals[index] > 0 ? count / monthTotals[index] : 0)
    : monthCounts;
  const maxSignal = Math.max(...monthSignals, 0.0001);
  const commonality = Number(bird.commonality || 0.2);

  return monthSignals.map((signal, index) => {
    const month = index + 1;
    if (!presentMonths.has(month)) return round(Math.max(0.005, commonality * 0.04));
    const seasonalStrength = signal / maxSignal;
    const floor = bird.presence === 'year-round' ? 0.18 : 0.28;
    const baseline = commonality * (floor + (1 - floor) * seasonalStrength);
    return round(clamp(baseline, 0.005, 0.95));
  });
}

function buildHourlyActivity(hourCounts, fallbackHours, hourTotals = null) {
  const total = hourCounts.reduce((sum, count) => sum + count, 0);
  if (total < 25) return fallbackHours;

  const hourSignals = hourTotals
    ? hourCounts.map((count, index) => hourTotals[index] > 0 ? count / hourTotals[index] : 0)
    : hourCounts;
  const maxSignal = Math.max(...hourSignals, 0.0001);
  return hourSignals.map((signal, hour) => {
    const observed = 0.35 + 0.85 * (signal / maxSignal);
    const blended = fallbackHours[hour] * 0.7 + observed * 0.3;
    return round(clamp(blended, 0.25, 1.2));
  });
}

async function loadGbifSourceData(appBirds, modelConfig, modelWarnings, summary) {
  const result = new Map();
  const geometry = circlePolygonWkt(modelConfig.region.center, modelConfig.region.radiusKm);

  for (const [index, bird] of appBirds.entries()) {
    const key = speciesKey(bird);
    process.stdout.write(`GBIF ${index + 1}/${appBirds.length}: ${bird.name}\r`);
    try {
      const monthCounts = await fetchGbifMonthCounts(bird.scientific, geometry);
      await delay(modelConfig.gbif.requestDelayMs);
      const sample = await fetchGbifSample(bird.scientific, geometry, modelConfig.gbif.maxOccurrenceSamples);
      await delay(modelConfig.gbif.requestDelayMs);

      const hourCounts = Array.from({ length: 24 }, () => 0);
      for (const record of sample.records) {
        const hour = parseHour(record.eventDate);
        if (hour !== null) hourCounts[hour] += 1;
      }

      const sampleSize = monthCounts.reduce((sum, count) => sum + count, 0);
      if (sampleSize > 0) {
        result.set(key, { monthCounts, hourCounts, sampleSize });
        summary.recordsUsed += sampleSize;
        mergeDateRange(summary, sample.dateRange);
      }
    } catch (error) {
      modelWarnings.push(`${bird.name}: GBIF fetch failed: ${error.message}`);
    }
  }

  process.stdout.write('\n');
  return result;
}

async function fetchGbifMonthCounts(scientificName, geometry) {
  const params = new URLSearchParams({
    scientificName,
    hasCoordinate: 'true',
    occurrenceStatus: 'PRESENT',
    basisOfRecord: 'HUMAN_OBSERVATION',
    geometry,
    facet: 'month',
    facetLimit: '12',
    limit: '0',
  });
  const data = await fetchJson(`https://api.gbif.org/v1/occurrence/search?${params}`);
  const counts = Array.from({ length: 12 }, () => 0);
  for (const entry of data.facets?.[0]?.counts || []) {
    const month = Number(entry.name);
    if (month >= 1 && month <= 12) counts[month - 1] = Number(entry.count || 0);
  }
  return counts;
}

async function fetchGbifSample(scientificName, geometry, limit) {
  const params = new URLSearchParams({
    scientificName,
    hasCoordinate: 'true',
    occurrenceStatus: 'PRESENT',
    basisOfRecord: 'HUMAN_OBSERVATION',
    geometry,
    limit: String(limit),
  });
  const data = await fetchJson(`https://api.gbif.org/v1/occurrence/search?${params}`);
  const dateRange = [null, null];
  for (const record of data.results || []) {
    mergeDateRange({ dateRange }, [record.eventDate, record.eventDate]);
  }
  return { records: data.results || [], dateRange };
}

async function loadEbirdEbdSourceData(appBirds, modelConfig, ebdPath, sedPath, modelWarnings, summary) {
  const appSpecies = new Map(appBirds.map(bird => [normalizeScientificName(bird.scientific), speciesKey(bird)]));
  const checklistMeta = new Map();
  const checklistMonthTotals = Array.from({ length: 12 }, () => 0);
  const checklistHourTotals = Array.from({ length: 24 }, () => 0);

  await readTsvRows(sedPath, (row) => {
    if (!isCompleteChecklist(row)) return;
    const lat = Number(row.LATITUDE || row.Latitude || row.latitude);
    const lon = Number(row.LONGITUDE || row.Longitude || row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (haversineKm(modelConfig.region.center, { lat, lon }) > modelConfig.region.radiusKm) return;

    const date = row['OBSERVATION DATE'] || row.observation_date || row.DATE;
    const hour = parseTimeHour(row['TIME OBSERVATIONS STARTED'] || row.time_observations_started || '');
    const month = parseMonth(date);
    const subId = row['SAMPLING EVENT IDENTIFIER'] || row['GLOBAL UNIQUE IDENTIFIER'] || row.SUB_ID || row.subId;
    if (!subId || !month) return;

    checklistMeta.set(subId, { month, hour });
    checklistMonthTotals[month - 1] += 1;
    if (hour !== null) checklistHourTotals[hour] += 1;
    mergeDateRange(summary, [date, date]);
  });

  const speciesMonthChecklists = new Map();
  const speciesHourChecklists = new Map();
  await readTsvRows(ebdPath, (row) => {
    const subId = row['SAMPLING EVENT IDENTIFIER'] || row['GLOBAL UNIQUE IDENTIFIER'] || row.SUB_ID || row.subId;
    const meta = checklistMeta.get(subId);
    if (!meta) return;
    const scientific = row['SCIENTIFIC NAME'] || row.scientific_name || row.SCIENTIFIC_NAME;
    const key = appSpecies.get(normalizeScientificName(scientific));
    if (!key) return;

    if (!speciesMonthChecklists.has(key)) speciesMonthChecklists.set(key, new Set());
    if (!speciesHourChecklists.has(key)) speciesHourChecklists.set(key, new Set());
    speciesMonthChecklists.get(key).add(`${subId}:${meta.month}`);
    if (meta.hour !== null) speciesHourChecklists.get(key).add(`${subId}:${meta.hour}`);
    summary.recordsUsed += 1;
  });

  const output = new Map();
  for (const bird of appBirds) {
    const key = speciesKey(bird);
    const monthCounts = Array.from({ length: 12 }, () => 0);
    const hourCounts = Array.from({ length: 24 }, () => 0);
    for (const value of speciesMonthChecklists.get(key) || []) {
      const month = Number(value.split(':')[1]);
      monthCounts[month - 1] += 1;
    }
    for (const value of speciesHourChecklists.get(key) || []) {
      const hour = Number(value.split(':')[1]);
      hourCounts[hour] += 1;
    }
    const sampleSize = monthCounts.reduce((sum, count) => sum + count, 0);
    if (sampleSize > 0) {
      output.set(key, {
        monthCounts,
        hourCounts,
        monthTotals: checklistMonthTotals,
        hourTotals: checklistHourTotals,
        sampleSize,
      });
    }
  }

  if (output.size === 0) modelWarnings.push('No app species matched the provided EBD files.');
  return output;
}

async function readTsvRows(path, onRow) {
  const stream = fs.createReadStream(path);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  for await (const line of rl) {
    if (!headers) {
      headers = line.split('\t');
      continue;
    }
    const values = line.split('\t');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    onRow(row);
  }
}

function isCompleteChecklist(row) {
  const value = String(row['ALL SPECIES REPORTED'] || row.all_species_reported || row.COMPLETE_CHECKLIST || '').toLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(value);
}

async function fetchJson(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'greenbelt-birding-model/1.0' } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    } catch (error) {
      lastError = error;
      await delay(500 * attempt);
    }
  }
  throw lastError;
}

function parseHour(value) {
  if (!value) return null;
  const match = String(value).match(/T(\d{2}):/);
  if (!match) return null;
  const hour = Number(match[1]);
  return hour >= 0 && hour <= 23 ? hour : null;
}

function parseTimeHour(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2}):/);
  if (!match) return null;
  const hour = Number(match[1]);
  return hour >= 0 && hour <= 23 ? hour : null;
}

function parseMonth(value) {
  if (!value) return null;
  const match = String(value).match(/^\d{4}-(\d{2})-/);
  if (!match) return null;
  const month = Number(match[1]);
  return month >= 1 && month <= 12 ? month : null;
}

function mergeDateRange(summary, range) {
  if (!range?.[0]) return;
  const start = String(range[0]).slice(0, 10);
  const end = String(range[1] || range[0]).slice(0, 10);
  if (!summary.dateRange[0] || start < summary.dateRange[0]) summary.dateRange[0] = start;
  if (!summary.dateRange[1] || end > summary.dateRange[1]) summary.dateRange[1] = end;
}

function countBy(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}
