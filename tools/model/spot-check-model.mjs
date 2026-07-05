#!/usr/bin/env node
import {
  loadBirdDatabase,
  loadConfig,
  readJson,
  speciesKey,
} from './shared.mjs';

const model = readJson(process.argv[2] || 'data/likelihood-model.json');
if (!model) throw new Error('Missing data/likelihood-model.json. Run build-likelihood-model.mjs first.');

const birds = loadBirdDatabase('index.html');
const config = loadConfig('tools/model/config.json');

const scenarios = [
  { label: 'January morning river walk', month: 1, hour: 8, habitat: 'river' },
  { label: 'April morning migration walk', month: 4, hour: 8, habitat: 'riparian' },
  { label: 'July morning riparian walk', month: 7, hour: 7, habitat: 'riparian' },
  { label: 'September evening walk', month: 9, hour: 18, habitat: 'parks' },
  { label: 'November midday river walk', month: 11, hour: 12, habitat: 'river' },
];

for (const scenario of scenarios) {
  const ranked = birds
    .filter(bird => !scenario.habitat || bird.habitat.includes(scenario.habitat))
    .map(bird => {
      const row = model.species?.[speciesKey(bird)];
      const baseline = row?.baselineByMonth?.[scenario.month - 1] ?? bird.commonality ?? 0.1;
      const activity = row?.activityByHour?.[scenario.hour] ?? 0.6;
      return {
        name: bird.name,
        score: baseline * activity,
        confidence: row?.confidence || 'fallback',
        vocalScore: row?.vocalScore ?? 0.5,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  console.log(`\n${scenario.label}`);
  console.log(`Region: ${config.region.name}, hour ${scenario.hour}:00, habitat ${scenario.habitat}`);
  ranked.forEach((item, index) => {
    console.log(`${String(index + 1).padStart(2, ' ')}. ${item.name.padEnd(28)} ${item.score.toFixed(3)}  ${item.confidence.padEnd(8)} vocal ${item.vocalScore.toFixed(2)}`);
  });
}
