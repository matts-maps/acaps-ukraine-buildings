/* ============================================================================
   Mapbox oblast damage example
   ============================================================================
   Standalone example: a Mapbox GL JS choropleth of damaged buildings per
   oblast. Deliberately independent of MapCore (map-analysis-core.js) - that
   module is Leaflet-specific and built for the full filterable dashboard;
   this page is just a map.

   Data/values are intentionally kept in parity with oblast_analysis.html's
   default (all-filters-cleared) view: same source CSV, same pcode join, and
   the same default date range (1 Jan of the current year through today) -
   see MapCore.initDateRangeControls in map-analysis-core.js.
   ========================================================================== */

(function () {
  "use strict";

  // Public (pk.*) Mapbox access token - safe to expose client-side, this is
  // the standard way Mapbox GL JS is configured in a static site with no
  // build/server step to inject it from an env var.
  mapboxgl.accessToken = "pk.eyJ1IjoibWFwYWN0aW9uIiwiYSI6ImNqOG9sbmQ5dTA0bG0zMnF1anB2M2wwZmYifQ.CKWhThHWbjRXUBnBcRoOqQ";

  // Swap this for your own Mapbox Studio style URL (mapbox://styles/<user>/<style-id>).
  const styleUrl = window.MAP_STYLE_URL || "mapbox://styles/mapbox/light-v11";

  const geojsonPath = window.MAP_GEOJSON_PATH || "/data/ukr_admn_ad1_py_s0_fieldmaps_pp_oblast.json";
  const csvPath = window.MAP_CSV_PATH || "/data/ukraine-damages.csv";

  // Sequential single-hue ramp (light to dark) - color encodes magnitude,
  // matching the choropleth convention used across cartography best
  // practice (and this site's own proportional-circle green, #00734C,
  // reused here as the ramp's dark end for visual consistency).
  const FILL_STEPS = [
    { max: 0, color: "#eef2f0" },
    { max: 10, color: "#c7e0d3" },
    { max: 50, color: "#8cc2a3" },
    { max: 200, color: "#4a9d6f" },
    { max: Infinity, color: "#00734C" }
  ];

  function buildFillColorExpression() {
    // ['step', input, output0, stop1, output1, stop2, output2, ...]
    const expr = ["step", ["get", "damaged_total"], FILL_STEPS[0].color];
    for (let i = 1; i < FILL_STEPS.length; i++) {
      expr.push(FILL_STEPS[i - 1].max, FILL_STEPS[i].color);
    }
    return expr;
  }

  function renderLegend(dateFromISO, dateToISO) {
    const el = document.getElementById("map-legend");
    if (!el) return;
    const labels = ["0", "1–10", "11–50", "51–200", "200+"];
    el.innerHTML = `<strong>Damaged buildings (${dateFromISO} to ${dateToISO})</strong>` +
      FILL_STEPS.map((step, i) =>
        `<div class="legend-row"><span class="legend-swatch" style="background:${step.color}"></span>${labels[i]}</div>`
      ).join("");
  }

  // Same default window MapCore.initDateRangeControls uses on the Leaflet
  // Oblast page: 1 Jan of the current year through today, clamped into the
  // range the CSV actually contains.
  function computeDefaultDateRange(rows) {
    let minDate = null;
    let maxDate = null;
    rows.forEach(row => {
      const d = new Date((row.date_of_event || "").trim());
      if (isNaN(d)) return;
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    });
    if (!minDate || !maxDate) return null;

    const clamp = d => new Date(Math.min(Math.max(d.getTime(), minDate.getTime()), maxDate.getTime()));
    const now = new Date();
    const defaultFrom = clamp(new Date(Date.UTC(2026, 0, 1)));
    const defaultTo = clamp(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    return { from: defaultFrom, to: defaultTo };
  }

  // Counts one damaged building per CSV row (the raw ukraine-damages.csv is
  // incident-level, one row per damaged building) within [from, to], joined
  // to its oblast the same way canonicalOblastName() does in
  // oblast_analysis.js: pcode first, falling back to the CSV's own oblast
  // name field.
  function aggregateCountsByOblast(rows, pcodeToName, from, to) {
    const totals = {};
    const fromMs = from.getTime();
    const toMsExclusive = to.getTime() + 86400000; // "to" day inclusive
    rows.forEach(row => {
      const rowMs = Date.parse((row.date_of_event || "").trim() + "T00:00:00Z");
      if (isNaN(rowMs) || rowMs < fromMs || rowMs >= toMsExclusive) return;

      const pcode = (row.pcode || "").trim();
      const name = (pcode && pcodeToName[pcode]) || (row.oblast || "").trim();
      if (!name) return;

      totals[name] = (totals[name] || 0) + 1;
    });
    return totals;
  }

  const map = new mapboxgl.Map({
    container: "map",
    style: styleUrl,
    center: [31.1656, 48.3794],
    zoom: 5
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");

  map.on("load", () => {
    Promise.all([
      fetch(geojsonPath).then(res => res.json()),
      fetch(csvPath).then(res => res.text()).then(text =>
        Papa.parse(text, { header: true, skipEmptyLines: true }).data
      )
    ]).then(([geoData, csvRows]) => {
      // pcode (geojson adm1_src) -> display name (geojson adm1_name), the
      // same lookup oblast_analysis.js builds - a stable join key beats
      // matching on the free-text oblast name string.
      const pcodeToName = {};
      geoData.features.forEach(f => {
        const pcode = f.properties.adm1_src;
        if (pcode) pcodeToName[pcode] = f.properties.adm1_name || "";
      });

      const range = computeDefaultDateRange(csvRows);
      if (!range) {
        console.error("mapbox-oblast-example: no valid date_of_event values found in", csvPath);
        return;
      }
      const totalsByOblast = aggregateCountsByOblast(csvRows, pcodeToName, range.from, range.to);

      // A geojson feature with no matching key in totalsByOblast is a
      // legitimate zero (no incidents fell in the selected date range for
      // that oblast) - not a join failure, so it's not worth warning about.
      // The real join-completeness check runs the other way: every name key
      // aggregateCountsByOblast produced (via the pcode lookup, falling
      // back to the CSV's own oblast string) should match a real geojson
      // feature, or its counts are silently missing from the map entirely.
      const featureNames = new Set(geoData.features.map(f => f.properties.adm1_name));
      const droppedNames = Object.keys(totalsByOblast).filter(n => !featureNames.has(n));
      if (droppedNames.length) {
        console.warn("mapbox-oblast-example: CSV oblast name(s) with no matching boundary feature (counts dropped from map):", droppedNames);
      }

      geoData.features.forEach(f => {
        f.properties.damaged_total = totalsByOblast[f.properties.adm1_name] || 0;
      });

      map.addSource("oblasts", { type: "geojson", data: geoData });

      map.addLayer({
        id: "oblasts-fill",
        type: "fill",
        source: "oblasts",
        paint: {
          "fill-color": buildFillColorExpression(),
          "fill-opacity": 0.85
        }
      });

      map.addLayer({
        id: "oblasts-outline",
        type: "line",
        source: "oblasts",
        paint: {
          "line-color": "#ffffff",
          "line-width": 1
        }
      });

      const bounds = new mapboxgl.LngLatBounds();
      geoData.features.forEach(f => {
        const coords = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates.flat(2) : f.geometry.coordinates.flat(1);
        coords.forEach(([lng, lat]) => bounds.extend([lng, lat]));
      });
      map.fitBounds(bounds, { padding: 20, animate: false });

      const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });

      map.on("mousemove", "oblasts-fill", e => {
        if (!e.features.length) return;
        map.getCanvas().style.cursor = "pointer";
        const { adm1_name, damaged_total } = e.features[0].properties;
        popup
          .setLngLat(e.lngLat)
          .setHTML(`<strong>${adm1_name}</strong><br>${damaged_total.toLocaleString()} damaged buildings`)
          .addTo(map);
      });

      map.on("mouseleave", "oblasts-fill", () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });

      const iso = d => d.toISOString().slice(0, 10);
      renderLegend(iso(range.from), iso(range.to));
    })
    .catch(err => console.error("mapbox-oblast-example: failed to load map data", err));
  });
})();
