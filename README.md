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

- Local species data and Greenbelt-specific likelihood logic
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

## Project Structure

```text
.
├── index.html                  # Static React app
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
