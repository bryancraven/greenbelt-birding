#!/usr/bin/env node

import {
  loadBirdDatabase,
  readJson,
  speciesKey,
  writeJson,
} from '../model/shared.mjs';

const AUDIO_VERSION = 1;
const DEFAULT_PROXY_URL = 'https://xeno-canto-proxy.spudbc.workers.dev';
const DEFAULT_OUTPUT = 'data/audio-availability.json';
const DEFAULT_REPORT = 'data/audio-report.json';
const MAX_RECORDINGS_PER_SPECIES = 12;
const MAX_PLAYABLE_PER_SPECIES = 5;
const REQUEST_TIMEOUT_MS = 12000;
const CONCURRENCY = 3;
const QUERY_ALIASES = {
  haiwoo: ['Leuconotopicus villosus'],
};

const args = parseArgs(process.argv.slice(2));
const proxyUrl = args.proxy || DEFAULT_PROXY_URL;
const outputPath = args.output || DEFAULT_OUTPUT;
const reportPath = args.report || DEFAULT_REPORT;
const limit = Number.isFinite(args.limit) ? args.limit : null;
const date = args.date ? new Date(`${args.date}T12:00:00`) : new Date();
const hour = Number.isFinite(args.hour) ? args.hour : 8;

const birds = loadBirdDatabase().slice(0, limit || undefined);
const likelihoodModel = readJson('data/likelihood-model.json', null);

const startedAt = new Date();
const rows = await mapWithConcurrency(birds, CONCURRENCY, bird => checkBird(bird));
const species = Object.fromEntries(rows.map(row => [row.key, row]));
const top20 = getTopModeledBirds(birds, likelihoodModel, date, hour, 20);
const top20Playable = top20.filter(bird => species[speciesKey(bird)]?.recordings?.length > 0);
const speciesWithPlayable = rows.filter(row => row.recordings.length > 0).length;
const failureCounts = summarizeFailures(rows);

const availability = {
  version: AUDIO_VERSION,
  generatedAt: new Date().toISOString(),
  source: {
    type: 'xeno-canto-proxy',
    proxyUrl,
    checkedWith: 'metadata fetch plus audio URL HEAD/range checks',
    maxRecordingsPerSpecies: MAX_RECORDINGS_PER_SPECIES,
    maxPlayablePerSpecies: MAX_PLAYABLE_PER_SPECIES,
  },
  summary: {
    speciesTotal: birds.length,
    speciesWithPlayable,
    speciesWithoutPlayable: birds.length - speciesWithPlayable,
    totalPlayableRecordings: rows.reduce((sum, row) => sum + row.recordings.length, 0),
    top20Playable: top20Playable.length,
    top20Total: top20.length,
    top20HitRate: top20.length ? round(top20Playable.length / top20.length) : 0,
  },
  species,
};

const report = {
  generatedAt: availability.generatedAt,
  elapsedSeconds: round((new Date() - startedAt) / 1000, 2),
  summary: availability.summary,
  readinessScenario: {
    date: date.toISOString().slice(0, 10),
    hour,
    top20: top20.map((bird, index) => {
      const row = species[speciesKey(bird)];
      return {
        rank: index + 1,
        key: speciesKey(bird),
        name: bird.name,
        scientific: bird.scientific,
        playableRecordings: row?.recordings?.length || 0,
        status: row?.status || 'missing',
        preferredRecordingId: row?.preferredRecording?.id || null,
      };
    }),
  },
  failures: {
    counts: failureCounts,
    speciesWithoutPlayable: rows
      .filter(row => row.recordings.length === 0)
      .map(row => ({
        key: row.key,
        name: row.name,
        scientific: row.scientific,
        status: row.status,
        failures: row.failures.slice(0, 5),
      })),
  },
};

writeJson(outputPath, availability);
writeJson(reportPath, report);

console.log(`Audio availability written to ${outputPath}`);
console.log(`Audio report written to ${reportPath}`);
console.log(`Species with playable recordings: ${speciesWithPlayable}/${birds.length}`);
console.log(`Top-20 playable hit rate: ${availability.summary.top20Playable}/${availability.summary.top20Total} (${Math.round(availability.summary.top20HitRate * 100)}%)`);

async function checkBird(bird) {
  const key = speciesKey(bird);
  const failures = [];
  let rawRecordings = [];
  const queryNames = [bird.scientific, ...(QUERY_ALIASES[key] || [])];

  for (const quality of ['A', 'any']) {
    for (const queryName of queryNames) {
      try {
        const recordings = await fetchProxyRecordings(queryName, quality);
        rawRecordings = uniqueRecordings([...rawRecordings, ...recordings]);
        if (rawRecordings.length > 0) break;
      } catch (error) {
        failures.push({ reason: 'proxy-failed', queryName, quality, detail: error.message });
      }
    }
    if (rawRecordings.length > 0) break;
  }

  if (!rawRecordings.length && failures.length === queryNames.length) {
    return baseRow(bird, key, {
      status: 'proxy-failed',
      queryNames,
      failures,
    });
  }

  const ranked = rawRecordings
    .filter(recording => recording.file)
    .map(normalizeRecording)
    .sort((a, b) => recordingRank(b) - recordingRank(a))
    .slice(0, MAX_RECORDINGS_PER_SPECIES);

  const playable = [];
  for (const recording of ranked) {
    if (playable.length >= MAX_PLAYABLE_PER_SPECIES) break;
    const check = await checkAudioUrl(recording.url);
    if (check.ok) {
      playable.push({
        ...recording,
        contentType: check.contentType,
        checkedUrl: check.url,
      });
    } else {
      failures.push({
        id: recording.id,
        url: recording.url,
        reason: check.reason,
        detail: check.detail,
      });
    }
  }

  return baseRow(bird, key, {
    status: playable.length ? 'verified' : ranked.length ? 'no-playable-recordings' : 'no-recordings',
    preferredRecording: playable[0] || null,
    recordings: playable,
    checkedRecordings: ranked.length,
    availableRecordings: rawRecordings.length,
    queryNames,
    failures,
  });
}

function baseRow(bird, key, overrides = {}) {
  return {
    key,
    birdId: bird.id,
    name: bird.name,
    scientific: bird.scientific,
    ebirdCode: bird.ebirdCode || null,
    status: 'missing',
    preferredRecording: null,
    recordings: [],
    queryNames: [bird.scientific],
    checkedRecordings: 0,
    availableRecordings: 0,
    failures: [],
    ...overrides,
  };
}

function uniqueRecordings(recordings) {
  const seen = new Set();
  return recordings.filter(recording => {
    const key = String(recording.id || recording.file || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchProxyRecordings(scientificName, quality = 'A') {
  const url = `${proxyUrl}?species=${encodeURIComponent(scientificName)}&quality=${encodeURIComponent(quality)}`;
  const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`proxy returned ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.recordings) ? data.recordings : [];
}

function normalizeRecording(recording) {
  const staticUrl = getStaticXenoCantoAudioUrl(recording);
  return {
    id: String(recording.id || recording.file),
    url: normalizeAudioUrl(staticUrl || recording.file),
    downloadUrl: normalizeAudioUrl(recording.file),
    type: recording.type || 'call',
    location: recording.loc || null,
    recordist: recording.rec || null,
    quality: recording.q || null,
    length: recording.length || null,
    date: recording.date || null,
    fileName: recording['file-name'] || null,
    spectrogramUrl: recording.sono?.small || null,
  };
}

function normalizeAudioUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return url.replace(/^http:/, 'https:');
  return url;
}

function getStaticXenoCantoAudioUrl(recording) {
  const fileName = recording?.['file-name'];
  const spectrogram = recording?.sono?.small;
  const uploadKey = String(spectrogram || '').match(/\/sounds\/spectrograms\/([^/]+)\//)?.[1];
  if (!fileName || !uploadKey) return null;
  const encodedFileName = String(fileName).split('/').map(encodeURIComponent).join('/');
  return `https://xeno-canto.org/sounds/uploaded/${uploadKey}/${encodedFileName}`;
}

function recordingRank(recording) {
  const type = String(recording.type || '').toLowerCase();
  const quality = String(recording.quality || '').toUpperCase();
  const seconds = durationToSeconds(recording.length);
  let score = 0;
  score += ({ A: 5, B: 4, C: 3, D: 1, E: 0 }[quality] ?? 2) * 10;
  if (type.includes('song')) score += 18;
  if (type.includes('call')) score += 12;
  if (type.includes('alarm')) score -= 4;
  if (type.includes('flight')) score -= 5;
  if (type.includes('background')) score -= 8;
  if (seconds > 0 && seconds <= 90) score += 8;
  if (seconds > 180) score -= 10;
  return score;
}

async function checkAudioUrl(url) {
  if (!url) return { ok: false, reason: 'missing-url' };

  let head;
  try {
    head = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow' });
  } catch (error) {
    return { ok: false, reason: 'head-failed', detail: error.message };
  }

  if (head.ok && isAudioContentType(head.headers.get('content-type'))) {
    return { ok: true, contentType: head.headers.get('content-type'), url: head.url };
  }

  try {
    const range = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Range: 'bytes=0-2047' },
    });
    const contentType = range.headers.get('content-type');
    if (range.ok && isAudioContentType(contentType)) {
      return { ok: true, contentType, url: range.url };
    }
    return {
      ok: false,
      reason: 'not-audio-response',
      detail: `status ${range.status}, content-type ${contentType || 'unknown'}`,
    };
  } catch (error) {
    return { ok: false, reason: 'range-get-failed', detail: error.message };
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isAudioContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  return value.startsWith('audio/') || value.includes('octet-stream');
}

function getTopModeledBirds(birds, model, date, hour, count) {
  const monthIndex = date.getMonth();
  return birds
    .map(bird => {
      const row = model?.species?.[speciesKey(bird)];
      const baseline = row?.baselineByMonth?.[monthIndex] ?? bird.commonality ?? 0.1;
      const hourValue = row?.activityByHour?.[hour] ?? 0.6;
      const vocalScore = row?.vocalScore ?? 0.5;
      return { ...bird, readinessScore: baseline * hourValue * vocalScore };
    })
    .sort((a, b) => b.readinessScore - a.readinessScore)
    .slice(0, count);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
      console.log(`${index + 1}/${items.length} ${items[index].name}: ${results[index].recordings.length} playable`);
    }
  }));
  return results;
}

function summarizeFailures(rows) {
  const counts = {};
  rows.forEach(row => {
    row.failures.forEach(failure => {
      counts[failure.reason] = (counts[failure.reason] || 0) + 1;
    });
  });
  return counts;
}

function durationToSeconds(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function round(value, places = 4) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    parsed[key] = value;
  }
  if (parsed.limit) parsed.limit = Number(parsed.limit);
  if (parsed.hour) parsed.hour = Number(parsed.hour);
  return parsed;
}
