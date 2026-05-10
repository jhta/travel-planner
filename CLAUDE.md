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

## Deployment

Deployed to Cloudflare Workers Static Assets via `wrangler.jsonc` (root). Live at **https://travel-planner.jsonlabs.workers.dev**.

```sh
wrangler deploy
```

The token in use has `workers (write)` scope only — do not switch to `wrangler pages deploy`. `.assetsignore` excludes `CLAUDE.md`, `.git`, `.wrangler`, the wrangler config itself, etc.

## Architecture

The app's source lives at the repo root: `index.html`, `styles.css`, `app.js`, `trips.json`, plus PWA assets (`manifest.webmanifest`, `service-worker.js`, `icon.svg`). Leaflet 1.9.4 and leaflet-polylinedecorator 1.6.0 are loaded from CDN in `index.html` — there is no module system, everything in `app.js` is one IIFE-ish global script.

### State and persistence (app.js)

- Single module-level `state = { trips, activeTripId }` plus UI scalars: `editingPlaceId`, `selectedPlaceId`, `expandedPlaceId`, `gapAction` (`{ index, mode: 'menu' | 'place' | 'transport' }`), `tripEditing`, `foodSectionOpen`, `focusAfterRender`, and Leaflet layer handles (`map`, `markersLayer`, `polylineLayer`, `arrowsLayer`, `placeMarkers`).
- `loadState()` reads `localStorage[STORAGE_KEY]` first; only falls back to `fetch('trips.json')` if storage is empty/corrupt. Every mutation calls `saveState()` which writes back to `localStorage`. `trips.json` on disk is just the seed/snapshot — the Export button downloads current state as `trips.json`, the Reload button clears localStorage and re-fetches the file.
- Trip shape: `{ id, name, startDate, endDate, notes?, flights, documents[], packing[], foods[], places: [...] }`. Checklist item shape (used by `documents` and `packing`): `{ id, name, checked }` — note `name`/`checked`, NOT `text`/`done`. Place shape: `{ id, name, lat, lng, arrival, departure, notes, photoUrl, lodging?: { url, name? }, activities?: [{ id, text, done, link?, day?, notes? }], transportTo?: { mode, duration, notes, link } }` — activities use `text`/`done`. Food shape: `{ id, name, imageUrl, link? }`. `photoUrl` and `imageUrl` share the same tri-state: `null` = not fetched, `''` = fetched but no photo found (don't retry), string URL = use it.
- `transportTo` lives on the **destination** place (i.e. `places[i+1].transportTo` describes how you got from `places[i]` to `places[i+1]`).

### Adding new persistent fields

Whenever a new array/field is added to a trip or place (e.g. `activities`, `documents`, `packing`), extend `ensureTripFields(trip)` to back-fill the default. It runs on every `loadState()` and import, so existing localStorage payloads stay forward-compatible. Skipping this step breaks users mid-session.

### Render pipeline

`render()` is the single entry point — it rebuilds the sidebar from scratch and calls `updateMap()`. There is no diffing; mutations call `saveState()` then `render()`. Selection state is kept out of `render()`'s rebuild path: `selectPlace()` toggles classes directly on existing DOM/markers and animates the map, so clicks don't trigger a re-render.

`focusAfterRender` is a CSS-selector string set just before a mutation that would normally steal focus. After `render()` rebuilds the DOM, it queries the selector and refocuses the matched element, then clears itself. Use it whenever a mutation shouldn't visibly interrupt typing (`addActivity`, `addChecklistItem`, opening the inline gap place-input, etc.).

### Inline expand/edit pattern

Each "expandable" UI follows the same 3-piece recipe:

1. A scalar in module state tracks which target is open (`editingPlaceId`, `expandedPlaceId`, `gapAction`). Reset it to `null` on trip switch / import / reload / delete of the underlying entity.
2. The owning render function conditionally appends the expanded content (`renderPlaceEdit`, `renderActivities`, `renderTransportForm`) inside the parent card/gap.
3. The expanded content uses the shared `body-in` keyframe (opacity 0→1, translateY -4px→0, 0.25s ease) for a consistent reveal. Reuse it; don't invent new entrance animations.

### Map specifics (gotchas)

- Pins are `L.divIcon` with `className: 'map-pin'` so selection styling is CSS-driven (`.map-pin.selected .pin-inner`) — selected state is toggled via `marker.getElement().classList`, not by re-creating markers.
- Route arrows use **per-segment** `L.polylineDecorator` (one decorator per A→B pair, arrow at `offset: '50%'`). Decorating the full multi-point polyline produces wrong-direction arrows — keep the per-segment loop.
- `arrowsLayer` is added directly to the map (not into `markersLayer`) and must be torn down explicitly at the top of `updateMap()`.
- `placeMarkers` is a `{ placeId: marker }` registry rebuilt on every `updateMap()`; `selectPlace()` reads from it to update map markers without a full redraw.

### Onboarding (Typeform-style)

`startOnboarding({ initial })` builds a full-screen overlay (`<div class="onboarding">` appended to `<body>`, plus `body.onboarding-active` to hide the app shell). It runs a 3-step wizard (name → dates → places) against an `onboardingDraft`, then on completion pushes the draft into `state.trips` and calls `enterApp()`. The `initial` flag controls whether a Cancel button is shown — first-run has no Cancel, subsequent "+ New trip" does. **There is no separate `createTrip()` function** — all trip creation flows through onboarding.

### External APIs

- Geocoding: `https://nominatim.openstreetmap.org/search` (debounced 350 ms in `setupAddPlaceInput` and the onboarding places step). Uses an `AbortController` (`geocodeAbort`) shared across both consumers. `setupAddPlaceInput` accepts an optional `onPick` callback so the inline gap variant can `insertPlaceAt(index, ...)` instead of `addPlace()`.
- Photos: `fetchPhoto(place)` tries Wikidata SPARQL (most-famous landmark within 25km of `lat`/`lng`) first, then falls back to Wikipedia REST `page/summary/{title}`. Result is cached on the place; a one-shot `migratePhotosOnce()` (keyed by `travel-planner-photo-migrated-v2` in localStorage) clears stale Wikipedia URLs from older clients exactly once. CORS-friendly, no API key — keep it that way.

### Sharing trips via URL

`encodeTripToHash(trip)` strips cached `photoUrl` / `imageUrl` (recipient re-fetches), wraps in `{ v: 1, trip }`, and runs through `LZString.compressToEncodedURIComponent` (lz-string CDN in `index.html`). The result lives in `location.hash` as `#trip=<encoded>` — never in a query param, so it's never sent to the worker. On boot, `decodeTripFromHash` parses the hash; if a trip is found, the import modal pops with stop/activity counts. Accept → new IDs assigned (always, to prevent collisions) → `ensureTripFields` runs → pushed into `state.trips`. Hash is cleared via `history.replaceState` after import or dismiss.

### Calendar export (.ics)

`exportTripICS(trip)` (triggered by the "Calendar" button in the trip header) writes an RFC 5545 calendar with one VEVENT per lodging stay (multi-day all-day, `DTEND = departure + 1 day` per the exclusive-end convention) and one VEVENT per activity (all-day on `activity.day`, falling back to `place.arrival` then `trip.startDate`). UIDs are deterministic (`stay-<placeId>` / `activity-<activityId>@travel-planner.jsonlabs.workers.dev`) so re-imports update existing events instead of duplicating. Lines are folded to 75 octets (UTF-8-aware) and text fields are escaped per spec.

### PWA / offline

`manifest.webmanifest` + `service-worker.js` at the repo root make the app installable. The service worker pre-caches the app shell (HTML, JS, CSS, manifest, icon, plus the three CDN scripts) on install, then runs cache-first with a network refresh-and-store on same-origin GETs. Bypassed (no caching, network-only): `tile.openstreetmap.org`, `nominatim.openstreetmap.org`, Wikipedia/Wikidata/Wikimedia — they have their own caching and would bloat the cache. Bump `CACHE_NAME` (`tp-shell-v1`) when the shell changes; the activate handler deletes old caches. Registration happens after `load` from `app.js`.

### Conventions

- **Always-orange empty-state CTAs**: high-priority empty states (no flights, no activities, etc.) render their CTA at rest in `--accent` orange — not just on hover. The "no flights" button and the empty-state activity pill both follow this; new empty-state CTAs should too.
- **URL inputs auto-prepend `https://`**: any URL field (activity link, transport link, future booking links) accepts schemeless input and rewrites it as `/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'https://' + v` before saving. Keeps `prompt()` ergonomics good.
- **Stop event propagation on nested clickable buttons**: place-card row click selects the pin; nested buttons (edit, activity pill, link, gap +) must `e.stopPropagation()` or be filtered via `e.target.closest()` in the row handler. Otherwise clicks select the place as a side effect.
- **Inline icons via `svgIcon(path, opts)`**: small UI icons use the shared SVG helper (12×12 viewBox, `currentColor` stroke). Don't drop unicode chevrons/arrows into pills — they sit off-baseline and shift on rotation.

### Theming

CSS custom properties drive the palette. Three modes: no `data-theme` attr → follow `prefers-color-scheme`; `data-theme="light"` / `data-theme="dark"` → forced. `toggleTheme()` rotates light → dark → light and calls `updateMap()` because the polyline/arrow color is read from `--accent` via `getComputedStyle` at draw time.
