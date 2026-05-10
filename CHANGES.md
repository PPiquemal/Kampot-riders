# Kampot Riders — Patch summary

## Identity restored
- **New PNG icon set** generated from the legacy seahorse, **keeping the original white background** (Pascal's preference — better contrast and readability than transparent):
  - `assets/icon-192.png` / `icon-512.png` (purpose: any) — white background, rounded corners (the OS-level mask hides the corners gracefully)
  - `assets/icon-192-maskable.png` / `icon-512-maskable.png` (purpose: maskable) — full-bleed white background, logo within central 62% safe zone for circular/squircle masks (Pixel etc.)
  - `assets/logo.png` — original legacy PNG (white bg, full text), used unchanged for header and splash
  - `assets/favicon-32.png` — full legacy resampled to 32×32; text becomes blurry but the seahorse silhouette stays recognizable
- The legacy SVG icons are removed from the manifest and service worker (they were a placeholder "X").
- **PWA `background_color`** in the manifest changed from `#1a0a0a` to `#ffffff` so the white logo fits seamlessly on the install/splash screen on Android. `theme_color` stays brown for the status bar.

## Bug fix
- `index.html` referenced `./legacy/legacy-icon-192.png` but the file is at `./assets/legacy/...` — header and splash logos were broken in the refactor. Now both point to `./assets/logo.png`.

## Visual polish lost in refactor — restored
- Splash subtitle **"Ride · Explore · Share"**
- Splash GPS row with pulsing dot, `splashFadeUp` staggered animations on logo / title / subtitle / GPS row
- Header title back to **KAMPOT RIDERS** (uppercase), `v0.2` tag removed (move it to a debug-only build flag if you want it back)
- **Tracks button** is a hamburger SVG icon again (was previously the text "Rides", which clashed with the GPX text button next to it)

## Behaviour improvements
- Splash dismisses on **first valid GPS fix** rather than a hard 4 s timeout. Splash status updates live ("Acquiring GPS… ±42m" → "GPS locked · ±5m"). 8 s safety fallback still dismisses the splash if GPS never arrives, so the user is never trapped.
- **Position markers** (`posMarker`, `accCircle`) are added to the map exactly once. Previously they were re-added on every position update — Leaflet tolerates it, but it was wasted work.

## Satellite layer (Esri) — informed user choice
- `maxZoom` of the Esri World Imagery layer is now **18** (was 19). At z19 most regions return blank or stale tiles; capping it avoids the "where did the map go?" effect.
- When the user manually selects Satellite, an **info notice** appears explaining: imagery is older than Google's, zoom is limited, and there's no API-key cost. Notice doesn't reappear on automatic restoration of the saved layer.
- On layer switch from cycle/osm (z19) to satellite (z18), the current zoom is now clamped down so the user never lands on a blank screen.
- Service worker now also caches satellite tiles (was previously only OSM/CyclOSM), so repeated rides over the same area don't keep refetching from Esri.

## Service worker
- Cache version bumped to `kr-v8` so existing users pick up the new assets on next reload.
- `APP_SHELL` updated to reference the new PNG icons + logo + favicon, and the new CyclOSM subdomain hosts (a/b/c).
- Dropped the dead Google tile request branch (you weren't using it).

## What's unchanged
`gps.js`, `gpx.js`, `storage.js` are byte-identical to the version you uploaded.

## To install
Replace files at the repo root with everything in this folder. Commit, push, GitHub Pages will serve the new version. Existing PWA installs will pick up the new icons + assets after the next visit (service worker triggers update on registration).

## Suggestion for later
For Cambodia specifically, consider adding **OpenTopoMap** as a fourth layer — it shows contour lines and is excellent for cycling (climbs are visible). It uses tile.opentopomap.org, also free and key-less. Let me know if you want it wired in.
