/* ============================================================================
   Raion Analysis page
   ============================================================================
   Shared map/legend/filter/chart machinery lives in MapCore
   (map-analysis-core.js, loaded before this file). This file holds what's
   genuinely specific to the Raion view: raion name normalization against
   the boundary geoJSON, the row-filtering loop, and the extra Oblast/Raion
   cascading dropdown filters + scoped map zoom that only this page has.
   ========================================================================== */

let rawDamageCSV = [];
let geoJSONData = null;
let leafletGeoLayer = null;
let mapInstance = null;

// The full-country view, captured once the boundary geoJSON first loads, so
// we can zoom back out to it when the Oblast/Raion filters are cleared.
let nationalBounds = null;

// Tracks which oblast/raion scope the map is currently zoomed to, so we only
// re-fit the view when that scope actually changes (not on every re-render
// triggered by e.g. a time-window change).
let lastZoomScopeKey = "";

// Column name for oblast in the CSV. ASSUMPTION: adjust this single value if
// your data uses a different column name (e.g. 'oblast_name', 'region').
const OBLAST_FIELD = "oblast";

// Property name for oblast on the raion boundary geoJSON features. ASSUMPTION:
// adjust this if your geoJSON uses a different property (e.g. 'ADM1_EN',
// 'oblast_name'). Check `geoJSONData.features[0].properties` in devtools if
// the oblast zoom doesn't work.
const GEOJSON_OBLAST_PROPERTY = "adm1_name";

// Corrects for a handful of raion boundary names that differ between the
// geoJSON source and the CSV's spelling. Used both for map styling/click
// handling and for computing zoom bounds.
const RAION_NAME_MAP = {
  "Kerchynskyi": "Kerchenskyi",
  "Krasnoperekopskyi": "Perekopskyi",
  "Chervonohradskyi": "Sheptytskyi",
  "Sievierodonetskyi": "Siverskodonetskyi"
};

function normalizeRaionName(raw) {
  return RAION_NAME_MAP[raw] || raw;
}

window.addEventListener("load", () => {
  const csvPath = window.MAP_CSV_PATH || "/data/ukraine-damages.csv";
  const geojsonPath = window.MAP_GEOJSON_PATH || "/data/ukr_admn_ad2_py_s0_fieldmaps_pp_raions.json";

  if (typeof L === "undefined" || typeof Papa === "undefined") return;

  MapCore.init({
    dimensionLabels: {
      raion: "Raion",
      infra: "Infrastructure Type",
      extent: "Extent of Damage",
      period: "Time Period"
    },
    onRerender: processMapVisualisations
  });
  mapInstance = MapCore.initMapElement("Raion Metric Profile");

  Promise.all([
    fetch(geojsonPath).then(res => res.json()),
    new Promise((resolve, reject) => {
      Papa.parse(csvPath, {
        download: true, header: true, skipEmptyLines: true,
        complete: results => resolve(results.data),
        error: err => reject(err)
      });
    })
  ])
  .then(([geoData, csvData]) => {
    geoJSONData = geoData;
    rawDamageCSV = csvData;

    // Fit the view to the full extent of the administrative boundaries so
    // the whole of Ukraine is visible, regardless of screen size.
    const bounds = L.geoJSON(geoData).getBounds();
    if (bounds.isValid()) {
      nationalBounds = bounds;
      mapInstance.fitBounds(bounds, { padding: [15, 15] });
    }

    MapCore.buildYearOptions(rawDamageCSV);
    buildOblastRaionFilterOptions();
  });
});

// Builds the Oblast dropdown (all unique oblasts, alphabetical) and the
// initial Raion dropdown (all unique raions). Called once after the CSV
// loads. The Raion list is re-scoped to the selected oblast whenever the
// oblast dropdown changes (see onOblastFilterChange below).
function buildOblastRaionFilterOptions() {
  const oblastSel = document.getElementById("map-oblast-select");
  const raionSel = document.getElementById("map-raion-select");
  if (!oblastSel || !raionSel) return;

  const oblasts = [...new Set(
    rawDamageCSV.map(r => r[OBLAST_FIELD]?.trim()).filter(Boolean)
  )].sort();

  oblastSel.innerHTML = '<option value="">All Oblasts</option>' +
    oblasts.map(o => `<option value="${o}">${o}</option>`).join("");

  populateRaionOptions("");
}

// Rebuilds the Raion dropdown, scoped to the given oblast ('' = all raions).
function populateRaionOptions(oblastValue) {
  const raionSel = document.getElementById("map-raion-select");
  if (!raionSel) return;

  const rows = oblastValue
    ? rawDamageCSV.filter(r => r[OBLAST_FIELD]?.trim() === oblastValue)
    : rawDamageCSV;

  const raions = [...new Set(
    rows.map(r => r.rayon?.trim()).filter(Boolean)
  )].sort();

  raionSel.innerHTML = '<option value="">All Raions</option>' +
    raions.map(r => `<option value="${r}">${r}</option>`).join("");
}

// Called on Oblast dropdown change: rescope the Raion dropdown to the
// selected oblast, reset any specific raion selection, then re-render.
function onOblastFilterChange() {
  const oblastSel = document.getElementById("map-oblast-select");
  populateRaionOptions(oblastSel ? oblastSel.value : "");
  processMapVisualisations();
}
window.onOblastFilterChange = onOblastFilterChange;

function onRaionFilterChange() {
  processMapVisualisations();
}
window.onRaionFilterChange = onRaionFilterChange;

// Computes the Leaflet bounds covering the given oblast or raion selection.
// Precedence: a specific raion narrows furthest, then oblast, then null
// (meaning: no spatial narrowing, caller should fall back to nationalBounds).
function computeScopedBounds(oblastValue, raionValue) {
  if (!geoJSONData) return null;

  let matched;
  if (raionValue) {
    matched = geoJSONData.features.filter(f => {
      const raw = f.properties.adm2_name || "";
      return normalizeRaionName(raw) === raionValue;
    });
  } else if (oblastValue) {
    matched = geoJSONData.features.filter(f =>
      (f.properties[GEOJSON_OBLAST_PROPERTY] || "").trim() === oblastValue
    );
  } else {
    return null;
  }

  if (!matched.length) return null;
  const bounds = L.geoJSON({ type: "FeatureCollection", features: matched }).getBounds();
  return bounds.isValid() ? bounds : null;
}

function applyMapZoomForScope(oblastValue, raionValue) {
  const scopeKey = `${oblastValue || ""}|${raionValue || ""}`;
  if (scopeKey === lastZoomScopeKey) return; // scope hasn't changed, leave the user's current pan/zoom alone
  lastZoomScopeKey = scopeKey;

  const scopedBounds = computeScopedBounds(oblastValue, raionValue);
  if (scopedBounds) {
    mapInstance.fitBounds(scopedBounds, { padding: [30, 30], maxZoom: 10 });
  } else if (nationalBounds) {
    mapInstance.fitBounds(nationalBounds, { padding: [15, 15] });
  }
}

function processMapVisualisations() {
  if (!geoJSONData || !rawDamageCSV) return;

  const yearEl = document.getElementById("map-year-select");
  const startEl = document.getElementById("map-period-start-select");
  const endEl = document.getElementById("map-period-end-select");
  const aggEl = document.getElementById("map-aggregation-select");
  const totalEl = document.getElementById("map-total-value");
  const oblastEl = document.getElementById("map-oblast-select");
  const raionEl = document.getElementById("map-raion-select");

  if (!yearEl || !startEl || !endEl || !aggEl) return;

  const targetYear = parseInt(yearEl.value);
  let startPeriod = parseInt(startEl.value);
  let endPeriod = parseInt(endEl.value);
  if (startPeriod > endPeriod) [startPeriod, endPeriod] = [endPeriod, startPeriod];
  const step = parseInt(aggEl.value);
  const oblastFilter = oblastEl ? oblastEl.value : "";
  const raionFilter = raionEl ? raionEl.value : "";

  const counts = {};
  const infraCounts = {};
  const extentCounts = {};

  const { timeCounts, labelsList } = MapCore.computeTimeBuckets(step, startPeriod, endPeriod);

  rawDamageCSV.forEach(r => {
    const rawRaion = r.rayon?.trim();
    if (!rawRaion) return;

    // Oblast / Raion filter panel selections
    if (oblastFilter && r[OBLAST_FIELD]?.trim() !== oblastFilter) return;
    if (raionFilter && rawRaion !== raionFilter) return;

    const d = new Date(r.date_of_event);
    if (isNaN(d) || d.getFullYear() !== targetYear) return;

    const day = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    const p = step === 30 ? d.getMonth() : Math.floor((day - 1) / step);
    if (p < startPeriod || p > endPeriod) return;

    const name = rawRaion;
    const infraType = r.type_of_infrastructure?.trim() || "Unspecified";
    const extent = r.extent_of_damage?.trim() || "Unspecified";

    const timeLabel = step === 30 ? MapCore.monthsList[p] : `${step === 7 ? "Week" : "Fortnight"} ${p + 1}`;

    // Cross-filter evaluation:
    const activeFilter = MapCore.activeFilter;
    if (activeFilter) {
      if (activeFilter.dimension === "raion" && name !== activeFilter.value) return;
      if (activeFilter.dimension === "infra" && infraType !== activeFilter.value) return;
      if (activeFilter.dimension === "extent" && extent !== activeFilter.value) return;
      if (activeFilter.dimension === "period" && timeLabel !== activeFilter.value) return;
    }

    counts[name] = (counts[name] || 0) + 1;
    infraCounts[infraType] = (infraCounts[infraType] || 0) + 1;
    extentCounts[extent] = (extentCounts[extent] || 0) + 1;

    if (timeCounts[timeLabel] !== undefined) {
      timeCounts[timeLabel] += 1;
    }
  });

  if (totalEl) totalEl.textContent = Object.values(counts).reduce((a, b) => a + b, 0).toLocaleString();

  const breaks = MapCore.computeDynamicBreaks(counts);
  MapCore.updateLegend(breaks);

  const chartSeries = MapCore.buildSummaryCharts({
    entityCounts: counts,
    entityDimension: "raion",
    entityKey: "topRaions",
    infraCounts, extentCounts, timeCounts, labelsList
  });

  // Zoom the map to the filtered area: a raion selected via the dropdown
  // takes precedence, then a raion selected by clicking the map/a chart,
  // then the oblast dropdown; otherwise zoom back out to all of Ukraine.
  const activeFilter = MapCore.activeFilter;
  const effectiveRaion = raionFilter || (activeFilter && activeFilter.dimension === "raion" ? activeFilter.value : null);
  applyMapZoomForScope(oblastFilter, effectiveRaion);

  // Expose the current filter state + underlying numbers for anything
  // outside this module that needs them (e.g. the PDF report generator).
  window.__mapReportState = {
    year: targetYear,
    aggregationLabel: aggEl.options[aggEl.selectedIndex]?.text || "",
    startLabel: startEl.options[startEl.selectedIndex]?.text || "",
    endLabel: endEl.options[endEl.selectedIndex]?.text || "",
    oblastFilter: oblastFilter || null,
    raionFilter: raionFilter || null,
    activeFilter: activeFilter ? { ...activeFilter } : null,
    nationalTotal: Object.values(counts).reduce((a, b) => a + b, 0),
    raionCounts: { ...counts },
    infraCounts: { ...infraCounts },
    extentCounts: { ...extentCounts },
    timeCounts: { ...timeCounts },
    labelsList: [...labelsList],
    chartSeries
  };

  if (leafletGeoLayer) mapInstance.removeLayer(leafletGeoLayer);

  leafletGeoLayer = L.geoJSON(geoJSONData, {
    style: f => {
      const rawGeoName = f.properties.adm2_name || "";
      const geoName = normalizeRaionName(rawGeoName);
      const isSelected = activeFilter && activeFilter.dimension === "raion" && activeFilter.value === geoName;
      return {
        fillColor: MapCore.getThematicColor(counts[geoName] || 0, breaks),
        weight: isSelected ? 3 : 1,
        color: isSelected ? "#1a3a5c" : "#666",
        fillOpacity: 0.7
      };
    },
    onEachFeature: (f, l) => {
      const rawGeoName = f.properties.adm2_name || "";
      const geoName = normalizeRaionName(rawGeoName);

      l.on("mouseover", e => {
        window.mapInfoPanel._div.innerHTML = `<h4>${rawGeoName}</h4><b>Damages:</b> ${(counts[geoName] || 0).toLocaleString()}`;
      });
      l.on("click", e => {
        MapCore.setActiveFilter("raion", geoName);
      });
    }
  }).addTo(mapInstance);
}
