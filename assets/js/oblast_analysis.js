/* ============================================================================
   Oblast Analysis page
   ============================================================================
   Shared map/legend/filter/chart machinery lives in MapCore
   (map-analysis-core.js, loaded before this file). This file only holds
   what's genuinely specific to the Oblast view: CSV loading, oblast name
   normalization against the boundary geoJSON, and the row-filtering loop.
   ========================================================================== */

let rawDamageCSV = [];
let geoJSONData = null;
let leafletGeoLayer = null;
let mapInstance = null;

// A handful of oblast names differ between the geoJSON boundary properties
// and the CSV's spelling by a trailing "ska" suffix (e.g. "Kyivska" vs
// "Kyiv"); stripped off here so both sides match up consistently.
function normalizeOblastName(raw) {
  return raw ? raw.replace("ska", "") : raw;
}

window.addEventListener("load", () => {
  const csvPath = window.MAP_CSV_PATH || "/data/ukraine-damages.csv";
  const geojsonPath = window.MAP_GEOJSON_PATH || "/data/ukr_admn_ad1_py_s0_fieldmaps_pp_oblast.json";

  if (typeof L === "undefined" || typeof Papa === "undefined") return;

  MapCore.init({
    dimensionLabels: {
      oblast: "Oblast",
      infra: "Infrastructure Type",
      extent: "Extent of Damage",
      period: "Time Period"
    },
    onRerender: processMapVisualisations
  });
  mapInstance = MapCore.initMapElement("Oblast Metric Profile");

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
      mapInstance.fitBounds(bounds, { padding: [15, 15] });
    }

    MapCore.buildYearOptions(rawDamageCSV);
  });
});

function processMapVisualisations() {
  if (!geoJSONData || !rawDamageCSV) return;

  const yearEl = document.getElementById("map-year-select");
  const startEl = document.getElementById("map-period-start-select");
  const endEl = document.getElementById("map-period-end-select");
  const aggEl = document.getElementById("map-aggregation-select");
  const totalEl = document.getElementById("map-total-value");

  if (!yearEl || !startEl || !endEl || !aggEl) return;

  const targetYear = parseInt(yearEl.value);
  let startPeriod = parseInt(startEl.value);
  let endPeriod = parseInt(endEl.value);
  if (startPeriod > endPeriod) [startPeriod, endPeriod] = [endPeriod, startPeriod];
  const step = parseInt(aggEl.value);

  const counts = {};
  const infraCounts = {};
  const extentCounts = {};

  const { timeCounts, labelsList } = MapCore.computeTimeBuckets(step, startPeriod, endPeriod);

  rawDamageCSV.forEach(r => {
    const rawOblast = r.oblast?.trim();
    if (!rawOblast) return;

    const d = new Date(r.date_of_event);
    if (isNaN(d) || d.getFullYear() !== targetYear) return;

    const day = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    const p = step === 30 ? d.getMonth() : Math.floor((day - 1) / step);
    if (p < startPeriod || p > endPeriod) return;

    const name = normalizeOblastName(rawOblast);
    const infraType = r.type_of_infrastructure?.trim() || "Unspecified";
    const extent = r.extent_of_damage?.trim() || "Unspecified";

    const timeLabel = step === 30 ? MapCore.monthsList[p] : `${step === 7 ? "Week" : "Fortnight"} ${p + 1}`;

    // Cross-filter evaluation:
    const activeFilter = MapCore.activeFilter;
    if (activeFilter) {
      if (activeFilter.dimension === "oblast" && name !== activeFilter.value) return;
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
    entityDimension: "oblast",
    entityKey: "topOblasts",
    infraCounts, extentCounts, timeCounts, labelsList
  });

  // Expose the current filter state + underlying numbers for anything
  // outside this module that needs them (e.g. the PDF report generator).
  window.__mapReportState = {
    year: targetYear,
    aggregationLabel: aggEl.options[aggEl.selectedIndex]?.text || "",
    startLabel: startEl.options[startEl.selectedIndex]?.text || "",
    endLabel: endEl.options[endEl.selectedIndex]?.text || "",
    activeFilter: MapCore.activeFilter ? { ...MapCore.activeFilter } : null,
    nationalTotal: Object.values(counts).reduce((a, b) => a + b, 0),
    oblastCounts: { ...counts },
    infraCounts: { ...infraCounts },
    extentCounts: { ...extentCounts },
    timeCounts: { ...timeCounts },
    labelsList: [...labelsList],
    chartSeries
  };

  if (leafletGeoLayer) mapInstance.removeLayer(leafletGeoLayer);

  leafletGeoLayer = L.geoJSON(geoJSONData, {
    style: f => {
      const rawGeoName = (f.properties.adm1_name || f.properties.ADM1_EN || "");
      const geoName = normalizeOblastName(rawGeoName);
      const isSelected = MapCore.activeFilter && MapCore.activeFilter.dimension === "oblast" && MapCore.activeFilter.value === geoName;
      return {
        fillColor: MapCore.getThematicColor(counts[geoName] || 0, breaks),
        weight: isSelected ? 3 : 1,
        color: isSelected ? "#1a3a5c" : "#666",
        fillOpacity: 0.7
      };
    },
    onEachFeature: (f, l) => {
      const rawGeoName = (f.properties.adm1_name || f.properties.ADM1_EN || "");
      const geoName = normalizeOblastName(rawGeoName);

      l.on("mouseover", e => {
        window.mapInfoPanel._div.innerHTML = `<h4>${f.properties.adm1_name}</h4><b>Damages:</b> ${(counts[geoName] || 0).toLocaleString()}`;
      });
      l.on("click", e => {
        MapCore.setActiveFilter("oblast", geoName);
      });
    }
  }).addTo(mapInstance);
}
