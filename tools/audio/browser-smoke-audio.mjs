#!/usr/bin/env node

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readJson } from '../model/shared.mjs';

const args = parseArgs(process.argv.slice(2));
const limit = Number.isFinite(args.limit) ? args.limit : 20;
const channel = args.channel || 'chrome';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const audioPath = args.audio || path.join(repoRoot, 'data/audio-availability.json');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (error) {
  try {
    const requireFromCwd = createRequire(`${process.cwd()}/`);
    ({ chromium } = requireFromCwd('playwright'));
  } catch (fallbackError) {
    console.error('Playwright is not installed in this working directory.');
    console.error('Install it in a temporary directory, then run this script from there.');
    process.exit(1);
  }
}

const audioAvailability = readJson(audioPath);
if (!audioAvailability?.species) {
  console.error(`Could not read audio availability data from ${audioPath}`);
  process.exit(1);
}

const recordings = Object.values(audioAvailability.species)
  .filter(row => row.recordings?.length)
  .slice(0, limit)
  .map(row => ({
    key: row.key,
    name: row.name,
    url: row.preferredRecording?.url || row.recordings[0].url,
  }));

const browser = await launchBrowser(chromium, channel);
const page = await browser.newPage();
const results = [];

for (const recording of recordings) {
  const result = await page.evaluate(async ({ url }) => {
    const audio = new Audio();
    audio.src = url;
    audio.preload = 'auto';
    audio.load();
    return Promise.race([
      new Promise(resolve => audio.addEventListener('canplay', () => resolve({ ok: true, readyState: audio.readyState }), { once: true })),
      new Promise(resolve => audio.addEventListener('error', () => resolve({ ok: false, code: audio.error?.code || null, message: audio.error?.message || null }), { once: true })),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, timeout: true, readyState: audio.readyState }), 8000)),
    ]);
  }, recording);
  results.push({ ...recording, ...result });
  console.log(`${result.ok ? 'ok' : 'fail'} ${recording.name} ${recording.url}`);
}

await browser.close();

const passed = results.filter(result => result.ok).length;
const report = {
  checked: results.length,
  passed,
  failed: results.length - passed,
  hitRate: results.length ? Math.round((passed / results.length) * 100) / 100 : 0,
  failures: results.filter(result => !result.ok),
};

console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;

async function launchBrowser(chromium, preferredChannel) {
  try {
    return await chromium.launch({ channel: preferredChannel, headless: true });
  } catch (error) {
    return chromium.launch({ headless: true });
  }
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
  return parsed;
}
