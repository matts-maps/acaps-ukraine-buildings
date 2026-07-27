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
let leafletCircleLayer = null;
let mapInstance = null;

// A handful of oblast names differ between the geoJSON boundary properties
// and the CSV's spelling by a trailing "ska" suffix (e.g. "Kyivska" vs
// "Kyiv"); stripped off here so both sides match up consistently.
function normalizeOblastName(raw) {
  return raw ? raw.replace("ska", "") : raw;
}

function formatDateLabel(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Runs immediately: this script is loaded with `defer`, so the DOM is
// already parsed and the Leaflet/PapaParse/MapCore scripts before it in the
// page have already executed. Waiting for the "load" event instead (which
// also waits on map tile images) left a window where a user could click a
// filter control before MapCore.init() had wired up MapCore.onRerender,
// silently no-op'ing the interaction.
(() => {
  const csvPath = window.MAP_CSV_PATH || "/data/ukraine-damages.csv";
  const geojsonPath = window.MAP_GEOJSON_PATH || "/data/ukr_admn_ad1_py_s0_fieldmaps_pp_oblast.json";

  if (typeof L === "undefined" || typeof Papa === "undefined") return;

  MapCore.init({ onRerender: processMapVisualisations });
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
      MapCore.setNationalBounds(bounds);
      // animate: false - this runs automatically on page load, before any
      // user interaction, so there's nothing to gain from an animated pan
      // and (unlike a user-triggered fitBounds) no one is watching for it
      // to fail: an animated zoom transition that doesn't complete (e.g. a
      // backgrounded/inactive tab pausing the animation) would silently
      // leave the map at its pre-fit default view instead of the country.
      mapInstance.fitBounds(bounds, { padding: [15, 15], animate: false });
    }

    buildOblastFilterOptions();
    MapCore.buildFilterSelectOptions("map-infra-select", "Total", rawDamageCSV.map(r => MapCore.normalizeInfraLabel(r.type_of_infrastructure)));
    MapCore.buildFilterSelectOptions("map-extent-select", "All", rawDamageCSV.map(r => MapCore.normalizeExtentLabel(r.extent_of_damage)));

    // Triggers the first render once the date inputs have real min/max/
    // default values.
    MapCore.initDateRangeControls(rawDamageCSV);
  });
})();

// Builds the Oblast dropdown (all unique oblasts, alphabetical). Called
// once after the CSV loads.
function buildOblastFilterOptions() {
  const oblastSel = document.getElementById("map-oblast-select");
  if (!oblastSel) return;

  const oblasts = [...new Set(
    rawDamageCSV.map(r => normalizeOblastName(r.oblast?.trim())).filter(Boolean)
  )].sort();

  oblastSel.innerHTML = '<option value="">All Oblasts</option>' +
    oblasts.map(o => `<option value="${o}">${o}</option>`).join("");
}

function onOblastFilterChange() {
  processMapVisualisations();
}
window.onOblastFilterChange = onOblastFilterChange;

// Computes the Leaflet bounds covering the given oblast selection ('' = no
// spatial narrowing, caller should fall back to MapCore.nationalBounds).
function computeScopedBoundsForOblast(oblastValue) {
  if (!geoJSONData || !oblastValue) return null;

  const matched = geoJSONData.features.filter(f => {
    const rawGeoName = f.properties.adm1_name || f.properties.ADM1_EN || "";
    return normalizeOblastName(rawGeoName) === oblastValue;
  });

  if (!matched.length) return null;
  const bounds = L.geoJSON({ type: "FeatureCollection", features: matched }).getBounds();
  return bounds.isValid() ? bounds : null;
}

function processMapVisualisations() {
  if (!geoJSONData || !rawDamageCSV) return;

  const fromEl = document.getElementById("map-date-from");
  const toEl = document.getElementById("map-date-to");
  const aggEl = document.getElementById("map-aggregation-select");
  const oblastEl = document.getElementById("map-oblast-select");
  const infraEl = document.getElementById("map-infra-select");
  const extentEl = document.getElementById("map-extent-select");
  const totalEl = document.getElementById("map-total-value");

  if (!fromEl || !toEl || !aggEl || !fromEl.value || !toEl.value) return;

  const granularity = aggEl.value;
  const oblastFilter = oblastEl ? oblastEl.value : "";
  const infraFilter = infraEl ? infraEl.value : "";
  const extentFilter = extentEl ? extentEl.value : "";

  const buckets = MapCore.buildDateBuckets(fromEl.value, toEl.value, granularity);

  const counts = {};
  const infraCounts = {};
  const extentCounts = {};
  const timeCounts = {};
  buckets.order.forEach(k => { timeCounts[k] = 0; });

  // Area x damage-level matrix for the new summary table - eligible once a
  // row passes the date/oblast/building-type filters, but NOT the damage-
  // level filter itself, so every column the data actually has is
  // populated before the damage-level filter (if any) selectively zeroes
  // out the columns that don't match it below.
  const tableMatrix = {};
  const tableColumns = new Set();

  rawDamageCSV.forEach(r => {
    const rawOblast = r.oblast?.trim();
    if (!rawOblast) return;
    const name = normalizeOblastName(rawOblast);
    if (oblastFilter && name !== oblastFilter) return;

    const rowMs = Date.parse(r.date_of_event + "T00:00:00Z");
    const bucketKey = buckets.keyForTimestamp(rowMs);
    if (bucketKey === null) return;

    const infraType = MapCore.normalizeInfraLabel(r.type_of_infrastructure);
    if (infraFilter && infraType !== infraFilter) return;

    const extent = MapCore.normalizeExtentLabel(r.extent_of_damage);

    if (!tableMatrix[name]) tableMatrix[name] = {};
    tableMatrix[name][extent] = (tableMatrix[name][extent] || 0) + 1;
    tableColumns.add(extent);

    if (extentFilter && extent !== extentFilter) return;

    counts[name] = (counts[name] || 0) + 1;
    infraCounts[infraType] = (infraCounts[infraType] || 0) + 1;
    extentCounts[extent] = (extentCounts[extent] || 0) + 1;
    timeCounts[bucketKey] += 1;
  });

  // If a damage-level filter is active, the table should only show that
  // one column as non-zero, matching the fact the rest of the view is
  // fully filtered to it.
  if (extentFilter) {
    Object.values(tableMatrix).forEach(cols => {
      Object.keys(cols).forEach(c => { if (c !== extentFilter) cols[c] = 0; });
    });
  }

  const tableColumnsList = [...tableColumns].sort();
  const summaryRows = Object.entries(tableMatrix)
    .map(([area, cols]) => ({ area, cols, total: Object.values(cols).reduce((a, b) => a + b, 0) }))
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total);

  if (totalEl) totalEl.textContent = Object.values(counts).reduce((a, b) => a + b, 0).toLocaleString();

  const radiusInfo = MapCore.computeRadiusScale(counts);
  MapCore.updateProportionalLegend(radiusInfo);

  const timelineLabels = buckets.order.map(k => buckets.labelsByKey[k]);
  const timelineValues = buckets.order.map(k => timeCounts[k] || 0);

  const chartSeries = MapCore.buildSummaryCharts({
    entityCounts: counts,
    entityKey: "topOblasts",
    entitySelectedValue: oblastFilter,
    onEntityClick: label => MapCore.selectOrToggle("map-oblast-select", label),
    infraCounts,
    infraSelectedValue: infraFilter,
    onInfraClick: label => MapCore.selectOrToggle("map-infra-select", label),
    extentCounts,
    extentSelectedValue: extentFilter,
    onExtentClick: label => MapCore.selectOrToggle("map-extent-select", label),
    timelineLabels,
    timelineValues,
    onTimelineClick: index => {
      const key = buckets.order[index];
      const range = buckets.bucketRangeByKey[key];
      if (range) MapCore.selectDateRangeBucket(range.startISO, range.endISO);
    }
  });

  MapCore.renderSummaryTable("map-summary-table-wrap", { areaLabel: "Oblast", rows: summaryRows, columns: tableColumnsList });

  // Zoom the map to the selected oblast (falls back to the national view
  // once cleared).
  MapCore.applyZoomForScope(oblastFilter, () => computeScopedBoundsForOblast(oblastFilter));

  const filterParts = [];
  if (oblastFilter) filterParts.push(`Oblast: ${oblastFilter}`);
  if (infraFilter) filterParts.push(`Building type: ${infraFilter}`);
  if (extentFilter) filterParts.push(`Damage level: ${extentFilter}`);
  MapCore.updateActiveFiltersSummary(filterParts);

  // Expose the current filter state + underlying numbers for anything
  // outside this module that needs them (e.g. the PDF report generator,
  // the export buttons).
  window.__mapReportState = {
    dateFrom: fromEl.value,
    dateTo: toEl.value,
    dateFromLabel: formatDateLabel(fromEl.value),
    dateToLabel: formatDateLabel(toEl.value),
    granularity,
    granularityLabel: aggEl.options[aggEl.selectedIndex]?.text || "",
    oblastFilter: oblastFilter || null,
    infraFilter: infraFilter || null,
    extentFilter: extentFilter || null,
    nationalTotal: Object.values(counts).reduce((a, b) => a + b, 0),
    oblastCounts: { ...counts },
    infraCounts: { ...infraCounts },
    extentCounts: { ...extentCounts },
    chartSeries,
    summaryTable: { areaLabel: "Oblast", columns: tableColumnsList, rows: summaryRows }
  };

  if (leafletCircleLayer) mapInstance.removeLayer(leafletCircleLayer);

  MapCore.damageCircleData = [];

  const circleMarkers = geoJSONData.features.map(f => {
    const rawGeoName = (f.properties.adm1_name || f.properties.ADM1_EN || "");
    const geoName = normalizeOblastName(rawGeoName);
    const value = counts[geoName] || 0;
    const radius = radiusInfo.scale(value);
    if (radius <= 0) return null;

    const isSelected = Boolean(oblastFilter) && oblastFilter === geoName;
    const center = L.geoJSON(f).getBounds().getCenter();
    const style = MapCore.damageCircleStyle(isSelected);

    const marker = L.circleMarker(center, {
      radius,
      pane: MapCore.DAMAGE_CIRCLES_PANE,
      fillColor: style.fillColor,
      color: style.strokeColor,
      weight: style.strokeWeight,
      fillOpacity: style.fillOpacity
    });

    marker.on("mouseover", () => {
      window.mapInfoPanel._div.innerHTML = `<h4>${rawGeoName}</h4><b>Damages:</b> ${value.toLocaleString()}`;
    });
    marker.on("click", () => {
      MapCore.selectOrToggle("map-oblast-select", geoName);
    });

    MapCore.damageCircleData.push({ lat: center.lat, lng: center.lng, radius, ...style });

    return marker;
  }).filter(Boolean);

  leafletCircleLayer = L.layerGroup(circleMarkers).addTo(mapInstance);
}
