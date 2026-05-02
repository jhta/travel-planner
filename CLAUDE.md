# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

Static site, no build step, no package.json, no tests. Serve over HTTP from the repo root — `file://` will block the `fetch('trips.json')` call in `loadFromFile()`.

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Quick syntax check after edits to `app.js`:

```sh
node --check app.js
```

## Architecture

The whole app is four files at the repo root: `index.html`, `styles.css`, `app.js`, `trips.json`. Leaflet 1.9.4 and leaflet-polylinedecorator 1.6.0 are loaded from CDN in `index.html` — there is no module system, everything in `app.js` is one IIFE-ish global script.

### State and persistence (app.js)

- Single module-level `state = { trips, activeTripId }` plus a handful of UI scalars: `editingPlaceId`, `selectedPlaceId`, `tripEditing`, and Leaflet layer handles (`map`, `markersLayer`, `polylineLayer`, `arrowsLayer`, `placeMarkers`).
- `loadState()` reads `localStorage[STORAGE_KEY]` first; only falls back to `fetch('trips.json')` if storage is empty/corrupt. Every mutation calls `saveState()` which writes back to `localStorage`. `trips.json` on disk is just the seed/snapshot — the Export button downloads current state as `trips.json`, the Reload button clears localStorage and re-fetches the file.
- Trip shape: `{ id, name, startDate, endDate, places: [{ id, name, lat, lng, arrival, departure, notes, photoUrl }] }`. `photoUrl` tri-state: `null` = not fetched, `''` = fetched but no photo found (don't retry), string URL = use it.

### Render pipeline

`render()` is the single entry point — it rebuilds the sidebar from scratch and calls `updateMap()`. There is no diffing; mutations call `saveState()` then `render()`. Selection state is kept out of `render()`'s rebuild path: `selectPlace()` toggles classes directly on existing DOM/markers and animates the map, so clicks don't trigger a re-render.

### Map specifics (gotchas)

- Pins are `L.divIcon` with `className: 'map-pin'` so selection styling is CSS-driven (`.map-pin.selected .pin-inner`) — selected state is toggled via `marker.getElement().classList`, not by re-creating markers.
- Route arrows use **per-segment** `L.polylineDecorator` (one decorator per A→B pair, arrow at `offset: '50%'`). Decorating the full multi-point polyline produces wrong-direction arrows — keep the per-segment loop.
- `arrowsLayer` is added directly to the map (not into `markersLayer`) and must be torn down explicitly at the top of `updateMap()`.
- `placeMarkers` is a `{ placeId: marker }` registry rebuilt on every `updateMap()`; `selectPlace()` reads from it to update map markers without a full redraw.

### Onboarding (Typeform-style)

`startOnboarding({ initial })` builds a full-screen overlay (`<div class="onboarding">` appended to `<body>`, plus `body.onboarding-active` to hide the app shell). It runs a 3-step wizard (name → dates → places) against an `onboardingDraft`, then on completion pushes the draft into `state.trips` and calls `enterApp()`. The `initial` flag controls whether a Cancel button is shown — first-run has no Cancel, subsequent "+ New trip" does. **There is no separate `createTrip()` function** — all trip creation flows through onboarding.

### External APIs

- Geocoding: `https://nominatim.openstreetmap.org/search` (debounced 350 ms in `setupAddPlaceInput` and the onboarding places step). Uses an `AbortController` (`geocodeAbort`) shared across both consumers.
- Photos: Wikipedia REST `page/summary/{title}` — title is `place.name.split(',')[0].trim()`. `applyPhoto()` lazy-fetches on render and writes the result back to the place (or `''` on miss) so it persists.

### Theming

CSS custom properties drive the palette. Three modes: no `data-theme` attr → follow `prefers-color-scheme`; `data-theme="light"` / `data-theme="dark"` → forced. `toggleTheme()` rotates light → dark → light and calls `updateMap()` because the polyline/arrow color is read from `--accent` via `getComputedStyle` at draw time.
