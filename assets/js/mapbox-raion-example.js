/* ============================================================================
   Mapbox raion damage example
   ============================================================================
   Standalone example: a Mapbox GL JS proportional-circle map of damaged
   buildings per raion. Deliberately independent of MapCore (map-analysis-core.js)
   and of raion_analysis.js - that module is Leaflet-specific and built for
   the full filterable dashboard; this page is just a map. Mirrors
   mapbox-oblast-example.js one admin level down - see that file for the
   oblast-level counterpart; keep both in sync by hand when changing shared
   logic (radius scale, legend, circle styling).

   Data/values are intentionally kept in parity with raion_analysis.html's
   default (all-filters-cleared) view: same source CSV, same pcode_rayon
   join (falling back to the CSV's own `rayon` field via RAION_NAME_MAP for
   the handful of raions whose CSV/geoJSON names differ - see
   RAION_NAME_MAP in raion_analysis.js), and the same default date range
   (1 Jan of the current year through today) - see
   MapCore.initDateRangeControls in map-analysis-core.js.
   ========================================================================== */

(function () {
  "use strict";

  // Public (pk.*) Mapbox access token - safe to expose client-side, this is
  // the standard way Mapbox GL JS is configured in a static site with no
  // build/server step to inject it from an env var.
  mapboxgl.accessToken = "pk.eyJ1IjoibWFwYWN0aW9uIiwiYSI6ImNqOG9sbmQ5dTA0bG0zMnF1anB2M2wwZmYifQ.CKWhThHWbjRXUBnBcRoOqQ";

  // Swap this for your own Mapbox Studio style URL (mapbox://styles/<user>/<style-id>).
  const styleUrl = window.MAP_STYLE_URL || "mapbox://styles/mapbox/light-v11";

  const geojsonPath = window.MAP_GEOJSON_PATH || "/data/ukr_admn_ad2_py_s0_fieldmaps_pp_raions.json";
  const csvPath = window.MAP_CSV_PATH || "/data/ukraine-damages.csv";

  // Corrects for a handful of raion boundary names that differ between the
  // geoJSON source and the CSV's spelling - copied from RAION_NAME_MAP in
  // raion_analysis.js. Only used as a fallback for CSV rows that don't have
  // a (matching) `pcode_rayon` value yet.
  const RAION_NAME_MAP = {
    "Kerchynskyi": "Kerchenskyi",
    "Krasnoperekopskyi": "Perekopskyi",
    "Chervonohradskyi": "Sheptytskyi",
    "Sievierodonetskyi": "Siverskodonetskyi"
  };
  const RAION_NAME_MAP_REVERSE = Object.fromEntries(
    Object.entries(RAION_NAME_MAP).map(([geoName, csvName]) => [csvName, geoName])
  );

  // Single colour for every proportional damage circle (size, not hue,
  // carries the value) - matches MapCore.PROPORTIONAL_CIRCLE_COLOR /
  // MapCore.damageCircleStyle in map-analysis-core.js, kept in sync by hand
  // since this file is deliberately independent of MapCore.
  const CIRCLE_FILL_COLOR = "#00734C";
  const CIRCLE_STROKE_COLOR = "#00512f";

  // Damage volume is encoded as circle area (sqrt of value), matching
  // MapCore.computeRadiusScale's convention and constants exactly.
  function computeRadiusScale(counts) {
    const minRadius = 4;
    const maxRadius = 32;
    const values = Object.values(counts).filter(v => v > 0);
    const maxValue = values.length ? Math.max(...values) : 0;
    const scale = value => {
      if (!value || value <= 0 || maxValue <= 0) return 0;
      return minRadius + (maxRadius - minRadius) * Math.sqrt(value / maxValue);
    };
    return { scale, maxValue };
  }

  // Rounds a number to a "nice" value (1/2/5/10 x a power of ten), same as
  // MapCore.roundNice, so legend labels read cleanly.
  function roundNice(n) {
    if (n < 10) return Math.round(n);
    const magnitude = Math.pow(10, Math.floor(Math.log10(n)));
    const normalized = n / magnitude;
    let niceNormalized;
    if (normalized <= 1) niceNormalized = 1;
    else if (normalized <= 2) niceNormalized = 2;
    else if (normalized <= 5) niceNormalized = 5;
    else niceNormalized = 10;
    return niceNormalized * magnitude;
  }

  // Opacity applied to each ring, largest (outermost) to smallest
  // (innermost) - matches MapCore's NESTED_RING_OPACITIES.
  const NESTED_RING_OPACITIES = [0.28, 0.55, 0.85];

  // Renders 3 reference circles (max, and two "nice" smaller fractions of
  // it) as one set of nested circles sharing a horizontal centre and a
  // common bottom edge, each with a leader line out to its value - ported
  // from MapCore.updateProportionalLegend for visual parity with the other
  // pages' proportional-circle maps.
  function renderLegend(radiusInfo, dateFromISO, dateToISO) {
    const el = document.getElementById("map-legend");
    if (!el) return;

    const { scale, maxValue } = radiusInfo;
    if (!maxValue || maxValue <= 0) {
      el.innerHTML = "<strong>Damaged buildings</strong><br>No data in range";
      return;
    }

    const refValues = [...new Set([
      maxValue,
      roundNice(maxValue / 3),
      roundNice(maxValue / 10)
    ])].filter(v => v > 0 && v <= maxValue).sort((a, b) => b - a); // largest first

    const maxR = scale(maxValue);
    const pad = 6;
    const cx = maxR + pad;
    const leaderLength = 16;
    const labelGap = 6;
    const svgWidth = cx + maxR + leaderLength + 60;
    const svgHeight = maxR * 2 + pad * 2;
    const baseline = svgHeight - pad;

    const points = refValues.map((v, i) => ({
      v,
      r: scale(v),
      opacity: NESTED_RING_OPACITIES[Math.min(i, NESTED_RING_OPACITIES.length - 1)]
    }));
    points.forEach(p => { p.cy = baseline - p.r; p.topY = p.cy - p.r; p.labelY = p.topY; });
    points.sort((a, b) => a.labelY - b.labelY);
    const MIN_LABEL_GAP = 14;
    for (let i = 1; i < points.length; i++) {
      if (points[i].labelY - points[i - 1].labelY < MIN_LABEL_GAP) {
        points[i].labelY = points[i - 1].labelY + MIN_LABEL_GAP;
      }
    }

    let circlesSvg = "";
    [...points].sort((a, b) => b.r - a.r).forEach(p => {
      circlesSvg += `<circle cx="${cx}" cy="${p.cy}" r="${p.r}" fill="${CIRCLE_FILL_COLOR}" fill-opacity="${p.opacity}" stroke="${CIRCLE_FILL_COLOR}" stroke-width="1" stroke-opacity="0.6"></circle>`;
    });

    let labelsSvg = "";
    const lineEndX = cx + maxR + leaderLength;
    points.forEach(p => {
      labelsSvg += `<line x1="${cx}" y1="${p.topY}" x2="${lineEndX}" y2="${p.labelY}" stroke="#999" stroke-width="1"></line>` +
        `<circle cx="${cx}" cy="${p.topY}" r="1.5" fill="#999"></circle>` +
        `<text x="${lineEndX + labelGap}" y="${p.labelY}" dominant-baseline="middle" font-size="11" fill="#333">${p.v.toLocaleString()}</text>`;
    });

    const svg = `<svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">${circlesSvg}${labelsSvg}</svg>`;

    el.innerHTML = `<strong>Damaged buildings (${dateFromISO} to ${dateToISO})</strong><div class="map-proportional-legend-nested">${svg}</div>`;
  }

  // Bounding-box centre of a feature's geometry (mirrors Leaflet's
  // L.geoJSON(f).getBounds().getCenter() used on the sibling Oblast/Raion
  // pages - a simple bbox midpoint, not a true area centroid, kept
  // consistent with those pages' circle placement).
  function bboxCenterOfFeature(f) {
    const coords = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates.flat(2) : f.geometry.coordinates.flat(1);
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    coords.forEach(([lng, lat]) => {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    });
    return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  }

  // Same default window MapCore.initDateRangeControls uses on the Leaflet
  // Raion page: 1 Jan of the current year through today, clamped into the
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
  // to its raion the same way canonicalRaionName() does in
  // raion_analysis.js: pcode_rayon first, falling back to the CSV's own
  // `rayon` field (corrected for known spelling mismatches via
  // RAION_NAME_MAP_REVERSE).
  function aggregateCountsByRaion(rows, pcodeToRaionName, from, to) {
    const totals = {};
    const fromMs = from.getTime();
    const toMsExclusive = to.getTime() + 86400000; // "to" day inclusive
    rows.forEach(row => {
      const rowMs = Date.parse((row.date_of_event || "").trim() + "T00:00:00Z");
      if (isNaN(rowMs) || rowMs < fromMs || rowMs >= toMsExclusive) return;

      const pcode = (row.pcode_rayon || "").trim();
      const rawName = (row.rayon || "").trim();
      const name = (pcode && pcodeToRaionName[pcode]) || RAION_NAME_MAP_REVERSE[rawName] || rawName;
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
      // pcode (geojson adm2_src) -> display name (geojson adm2_name), the
      // same lookup raion_analysis.js builds - a stable join key beats
      // matching on the free-text raion name string.
      const pcodeToRaionName = {};
      geoData.features.forEach(f => {
        const pcode = f.properties.adm2_src;
        if (pcode) pcodeToRaionName[pcode] = f.properties.adm2_name || "";
      });

      const range = computeDefaultDateRange(csvRows);
      if (!range) {
        console.error("mapbox-raion-example: no valid date_of_event values found in", csvPath);
        return;
      }
      const totalsByRaion = aggregateCountsByRaion(csvRows, pcodeToRaionName, range.from, range.to);

      // A geojson feature with no matching key in totalsByRaion is a
      // legitimate zero (no incidents fell in the selected date range for
      // that raion) - not a join failure, so it's not worth warning about.
      // The real join-completeness check runs the other way: every name key
      // aggregateCountsByRaion produced (via the pcode lookup, falling back
      // to the CSV's own rayon string) should match a real geojson feature,
      // or its counts are silently missing from the map entirely.
      const featureNames = new Set(geoData.features.map(f => f.properties.adm2_name));
      const droppedNames = Object.keys(totalsByRaion).filter(n => !featureNames.has(n));
      if (droppedNames.length) {
        console.warn("mapbox-raion-example: CSV raion name(s) with no matching boundary feature (counts dropped from map):", droppedNames);
      }

      geoData.features.forEach(f => {
        f.properties.damaged_total = totalsByRaion[f.properties.adm2_name] || 0;
      });

      // Proportional circles at each raion's centroid, sized by damage
      // count - matches the Leaflet Oblast/Raion pages' convention, which
      // draw no boundary polygon layer of their own (the custom Mapbox
      // style's own "Admin Areas" group provides that context here).
      const radiusInfo = computeRadiusScale(totalsByRaion);
      const circlePoints = geoData.features
        .filter(f => (f.properties.damaged_total || 0) > 0)
        .map(f => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: bboxCenterOfFeature(f) },
          properties: {
            adm2_name: f.properties.adm2_name,
            damaged_total: f.properties.damaged_total,
            radius: radiusInfo.scale(f.properties.damaged_total)
          }
        }));

      map.addSource("raion-circles", {
        type: "geojson",
        data: { type: "FeatureCollection", features: circlePoints }
      });

      map.addLayer({
        id: "raion-circles",
        type: "circle",
        source: "raion-circles",
        paint: {
          "circle-radius": ["get", "radius"],
          "circle-color": CIRCLE_FILL_COLOR,
          "circle-opacity": 0.75,
          "circle-stroke-color": CIRCLE_STROKE_COLOR,
          "circle-stroke-width": 1
        }
      });

      const bounds = new mapboxgl.LngLatBounds();
      geoData.features.forEach(f => {
        const coords = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates.flat(2) : f.geometry.coordinates.flat(1);
        coords.forEach(([lng, lat]) => bounds.extend([lng, lat]));
      });
      map.fitBounds(bounds, { padding: 20, animate: false });

      const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });

      map.on("mousemove", "raion-circles", e => {
        if (!e.features.length) return;
        map.getCanvas().style.cursor = "pointer";
        const { adm2_name, damaged_total } = e.features[0].properties;
        popup
          .setLngLat(e.lngLat)
          .setHTML(`<strong>${adm2_name}</strong><br>${damaged_total.toLocaleString()} damaged buildings`)
          .addTo(map);
      });

      map.on("mouseleave", "raion-circles", () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });

      const iso = d => d.toISOString().slice(0, 10);
      renderLegend(radiusInfo, iso(range.from), iso(range.to));
    })
    .catch(err => console.error("mapbox-raion-example: failed to load map data", err));
  });
})();
