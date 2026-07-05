# Boise River Greenbelt Bird Guide

A lightweight field companion for birding along the Boise River Greenbelt.

[Open the live guide](https://bryancraven.github.io/greenbelt-birding/)

## What It Does

- Predicts likely birds for the selected date, time, and Boise weather
- Shows Greenbelt-relevant species cards with photos, field marks, behavior, and seasonal notes
- Plays bird calls through xeno-canto recordings
- Includes call flashcards for quick listening practice
- Includes a test mode that plays a mystery call and asks you to identify the bird from likely candidates
- Links out to local birding resources, weather, Wikimedia Commons, and eBird

## How It Works

This is a static React app in a single `index.html` file. It runs directly on GitHub Pages without a build step.

The app combines:

- Static Greenbelt likelihood model data generated from public occurrence records
- Static audio availability data generated from xeno-canto recording checks
- Local species data and Greenbelt-specific fallback logic
- Open-Meteo weather data for Boise
- Wikimedia Commons images
- xeno-canto bird audio through a small Cloudflare Worker proxy

## Local Preview

Open `index.html` directly in a browser, or run a simple static server:

```sh
python3 -m http.server 8000
```

Then visit:

```text
http://localhost:8000
```

## Deployment

The public app is served by GitHub Pages:

```text
https://bryancraven.github.io/greenbelt-birding/
```

For normal site updates, commit changes to the GitHub Pages branch configured for the repository.

## Likelihood Model

The guide consumes `data/likelihood-model.json`, a static climatology model that covers all 12 months and 24 hours for the app's species list. The model is generated locally, committed to the repo, and served by GitHub Pages like any other static asset. If the JSON is missing or has invalid rows, the app falls back to the built-in hand-tuned likelihood logic.

The generated model is not a live recent-sightings feed. It is designed to keep working for a year or more without refresh because it represents seasonal and hourly patterns, while current weather is still applied at runtime.

Refresh the model on demand:

```sh
node tools/model/build-likelihood-model.mjs --source gbif
node tools/model/verify-likelihood-model.mjs
node tools/model/spot-check-model.mjs
```

The default builder uses public GBIF occurrence data around the Boise River Greenbelt and writes:

```text
data/likelihood-model.json
data/model-report.json
```

For a higher-quality local refresh, you can use eBird Basic Dataset and Sampling Event Data files stored outside the repo:

```sh
node tools/model/build-likelihood-model.mjs --source ebird-ebd --ebd /path/to/ebd.txt --sed /path/to/sampling-events.txt
```

Do not commit raw eBird data, API keys, or private source files. Commit only the generated JSON/report and any intentional tooling changes.

## Audio Availability

The guide also consumes `data/audio-availability.json`, a static index of xeno-canto recordings that were reachable during local validation. This keeps call flashcards and test mode from depending on the first live recording returned by the proxy.

Refresh the audio checks on demand:

```sh
node tools/audio/check-audio-availability.mjs --date 2026-07-05 --hour 8
```

Optional browser media smoke test, using a temporary Playwright install outside the repo:

```sh
tmpdir=$(mktemp -d)
cd "$tmpdir"
npm init -y
npm install playwright
node /path/to/greenbelt-birding/tools/audio/browser-smoke-audio.mjs --limit 20
```

The checker writes:

```text
data/audio-availability.json
data/audio-report.json
```

The public site does not bundle audio files. It stores only metadata and public recording URLs. If the generated audio JSON is missing, the app falls back to live proxy lookup.

## Audio Proxy

Bird calls are fetched through the Cloudflare Worker in `worker/xeno-canto-proxy.js`.

The app currently points at:

```text
https://xeno-canto-proxy.spudbc.workers.dev
```

To deploy your own worker:

```sh
cd worker
wrangler deploy
```

If you have a xeno-canto API key, configure it as `XENO_CANTO_API_KEY`. The worker can also make public API requests without a key where xeno-canto allows it.

The worker supports an optional `quality` parameter. The app first asks for A-quality recordings, then can fall back to broader quality results if the worker has been redeployed with the current source.

## Project Structure

```text
.
├── index.html                  # Static React app
├── assets/art/                 # Generated decorative artwork for the public site
├── data/
│   ├── audio-availability.json # Generated verified recording metadata
│   ├── audio-report.json       # Generated audio QA report
│   ├── likelihood-model.json   # Generated static likelihood model
│   └── model-report.json       # Generated model QA/provenance report
├── tools/
│   ├── audio/                  # Local audio availability checker
│   └── model/                  # Local model build and verification scripts
├── worker/
│   ├── wrangler.toml           # Cloudflare Worker config
│   └── xeno-canto-proxy.js     # Bird-call proxy with CORS and caching
└── README.md
```

## Public Data Credits

- Bird observations and species references: eBird
- Bird calls: xeno-canto
- Species photos: Wikimedia Commons
- Weather: Open-Meteo
- Local birding links: Golden Eagle Audubon, Idaho Birding Trail, and local park resources

## Contributing Notes

This is a public, static project. Please keep changes small, readable, and easy to verify in a browser. Do not commit API keys or generated local artifacts.
