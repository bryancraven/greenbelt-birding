#!/usr/bin/env node
import {
  MODEL_VERSION,
  loadBirdDatabase,
  readJson,
  speciesKey,
  validateSpeciesRow,
} from './shared.mjs';

const modelPath = process.argv[2] || 'data/likelihood-model.json';
const reportPath = 'data/model-report.json';
const birds = loadBirdDatabase('index.html');
const model = readJson(modelPath);
const report = readJson(reportPath, {});
const errors = [];
const warnings = [];

if (!model) {
  errors.push(`Missing model file: ${modelPath}`);
} else {
  if (model.version !== MODEL_VERSION) errors.push(`Unsupported model version: ${model.version}`);
  if (!model.species || typeof model.species !== 'object') errors.push('model.species must be an object');
  if (!model.generatedAt) warnings.push('model.generatedAt is missing');
  if (!model.source?.type) warnings.push('model.source.type is missing');
}

if (model?.species) {
  for (const bird of birds) {
    const key = speciesKey(bird);
    const row = model.species[key];
    if (!row) {
      errors.push(`${bird.name}: missing species row for key ${key}`);
      continue;
    }

    for (const problem of validateSpeciesRow(row)) {
      errors.push(`${bird.name}: ${problem}`);
    }

    if (Math.max(...row.baselineByMonth) <= 0) {
      errors.push(`${bird.name}: baselineByMonth is all zero`);
    }
  }

  ecologicalChecks(model, birds, errors, warnings);
}

if (report?.warnings?.length) {
  warnings.push(`Builder emitted ${report.warnings.length} warning(s); inspect data/model-report.json`);
}

console.log(`Verified ${birds.length} app species against ${modelPath}`);
console.log(`Errors: ${errors.length}`);
console.log(`Warnings: ${warnings.length}`);
if (warnings.length) {
  for (const warning of warnings.slice(0, 20)) console.log(`WARN ${warning}`);
  if (warnings.length > 20) console.log(`WARN ... ${warnings.length - 20} more`);
}
if (errors.length) {
  for (const error of errors.slice(0, 30)) console.error(`ERROR ${error}`);
  if (errors.length > 30) console.error(`ERROR ... ${errors.length - 30} more`);
  process.exit(1);
}

function ecologicalChecks(currentModel, appBirds, currentErrors, currentWarnings) {
  const byName = new Map(appBirds.map(bird => [bird.name, currentModel.species[speciesKey(bird)]]));

  expectHigher(byName, 'Bufflehead', [11, 12, 1, 2], [6, 7, 8], currentWarnings);
  expectHigher(byName, 'Bald Eagle', [12, 1, 2], [6, 7, 8], currentWarnings);
  expectHigher(byName, 'Barn Swallow', [5, 6, 7], [12, 1, 2], currentWarnings);
  expectHigher(byName, "Bullock's Oriole", [5, 6, 7], [12, 1, 2], currentWarnings);
  expectHigher(byName, 'Common Yellowthroat', [5, 6, 7, 8], [12, 1, 2], currentWarnings);
  expectHigher(byName, 'Yellow-rumped Warbler', [4, 5, 9, 10], [12, 1, 2], currentWarnings);

  for (const bird of appBirds) {
    const row = currentModel.species[speciesKey(bird)];
    if (!row) continue;
    if (bird.presence !== 'year-round' && Array.isArray(bird.months)) {
      const inSeason = averageMonths(row.baselineByMonth, bird.months);
      const outSeasonMonths = Array.from({ length: 12 }, (_, i) => i + 1).filter(month => !bird.months.includes(month));
      const outSeason = averageMonths(row.baselineByMonth, outSeasonMonths);
      if (outSeason > inSeason * 0.45) {
        currentWarnings.push(`${bird.name}: out-of-season baseline is high relative to in-season baseline`);
      }
    }
  }

  if (currentErrors.length === 0 && currentWarnings.length === 0) {
    console.log('Ecological sanity checks passed without warnings.');
  }
}

function expectHigher(byName, name, highMonths, lowMonths, currentWarnings) {
  const row = byName.get(name);
  if (!row) return;
  const high = averageMonths(row.baselineByMonth, highMonths);
  const low = averageMonths(row.baselineByMonth, lowMonths);
  if (high <= low) {
    currentWarnings.push(`${name}: expected months ${highMonths.join(',')} to exceed ${lowMonths.join(',')}`);
  }
}

function averageMonths(values, months) {
  if (!months.length) return 0;
  return months.reduce((sum, month) => sum + Number(values[month - 1] || 0), 0) / months.length;
}
