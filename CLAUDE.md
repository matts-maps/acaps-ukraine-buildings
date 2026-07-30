# acaps-ukraine-buildings

Jekyll site visualizing ACAPS Ukraine building-damage data (maps, charts, PDF export).
No test suite, no linter, no npm build — don't invent one; there isn't a convention to match.

## Dev server
`bundle install` once, then `bundle exec jekyll serve --port 4000` (also wired as the
`jekyll-serve` launch config). Jekyll ignores `data/` by default — `_config.yml`'s
`include: [data]` is what makes the data folder ship; don't remove it.

## Generated files — do not hand-edit
`data/ukraine-damages*.csv`, `data/damage-summary-*.csv/.zip`, and `index.html` are
overwritten daily by `.github/workflows/weekly_update.yml` (`github-actions[bot]`, runs
`scripts/update.py` → `summarise.py` → `summarise_admin.py`, then commits straight to `main`).
Hand edits to these will conflict with or be silently clobbered by the next bot run.

Note: the workflow is named `weekly_update.yml` and README.md says "every Monday" / "weekly"
— both are stale. The cron is actually `0 0 * * *` (daily). Trust the cron, not the name.

## Two page scripts that must move together
`assets/js/oblast_analysis.js` and `assets/js/raion_analysis.js` share `MapCore`
(`assets/js/map-analysis-core.js`) but are deliberately NOT merged further — see the header
comments in each file for exactly what's shared vs. page-specific. Both now join by P-code
(Oblast: CSV `pcode` → geoJSON `adm1_src`, via `pcodeToName`; Raion: CSV `pcode_rayon` →
geoJSON `adm2_src`, via `pcodeToRaionName`/`canonicalRaionName`). Raion also keeps a
`RAION_NAME_MAP` name-mismatch table (`raion_analysis.js`) as a fallback for CSV rows without
a (matching) `pcode_rayon` value — `pcode_rayon` is a newer ACAPS API field and may not be
backfilled on every historical row yet. A fix to filtering, chart rendering, or date-bucket
handling in one page's script usually needs the same check in the sibling page — use the
`duplicate-surface-review` skill when touching either.

## Donut chart label geometry is duplicated — keep both copies in sync
The outside-label "elbow" leader-line math (`elbowRadius = (lineEndY - y) / sin(midAngle)`,
guarded for near-horizontal slices where `sin` → 0) is solved independently in
`map-analysis-core.js` (live chart) and `chart-svg-builders.js:560-568` (`buildDonutSVG`, used
for PDF/static export). Changing the geometry in one file without the other makes the live
chart and the exported PDF visibly diverge. Use the `svg-label-declutter` skill for this area.

## Map PDF/PNG export doesn't screenshot the DOM
`assets/js/map-pdf-renderer.js` (top-of-file comment) deliberately redraws the map on an
offscreen canvas from live Leaflet/esri-leaflet data rather than using html2canvas —
html2canvas can't render the SVG hatch-pattern fills and causes tile seams. Don't reach for
html2canvas here; use the `map-export-to-pdf` skill instead.

## Project skills
This repo has custom Claude Code skills tailored to it — reach for them instead of solving
from scratch: `geo-admin-join` (name/boundary joins), `svg-label-declutter` (donut/pie label
layout), `map-export-to-pdf` (map/PDF export), `duplicate-surface-review` (oblast/raion
sibling-file changes), `scheduled-data-pipeline-review` (the daily GitHub Actions pipeline).
