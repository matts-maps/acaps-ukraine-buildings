/* ============================================================================
   MapCore — shared logic for the Oblast and Raion analysis pages.
   ============================================================================
   This file holds everything that was previously duplicated verbatim (or
   near-verbatim) between oblast_analysis.js and raion_analysis.js: map/
   legend setup, the cross-filter state machine, period dropdown building,
   time-bucket seeding, and chart rendering (including the "value labels
   drawn on the chart itself" style, via chartjs-plugin-datalabels, that
   previously only the Raion page used — both pages render identically now).

   What deliberately stays OUT of this file, because it's genuinely
   different per page rather than duplicated:
     - CSV parsing / geoJSON name matching (oblast uses a "ska"-suffix
       strip + name map, raion uses RAION_NAME_MAP)
     - The Oblast/Raion cascading dropdown filters (raion-only feature)
       and the scoped map zoom-to-selection behaviour that goes with it
     - The row-filtering loop in processMapVisualisations() itself, since
       the two pages filter/match on different CSV columns

   USAGE (see oblast_analysis.js / raion_analysis.js for the full pattern):
     MapCore.init({
       dimensionLabels: { oblast: 'Oblast', infra: 'Infrastructure Type', ... },
       onRerender: processMapVisualisations   // page's own re-render function
     });
     mapInstance = MapCore.initMapElement('Oblast Metric Profile');
     ...
     MapCore.buildYearOptions(rawDamageCSV);
     ...
     const radiusInfo = MapCore.computeRadiusScale(counts);
     MapCore.updateProportionalLegend(radiusInfo);
     const chartSeries = MapCore.buildSummaryCharts({
       entityCounts: counts, entityDimension: 'oblast', entityKey: 'topOblasts',
       infraCounts, extentCounts, timeCounts, labelsList
     });

   INSTALL: include this script (deferred, after Chart.js and
   chartjs-plugin-datalabels, before oblast_analysis.js / raion_analysis.js).
   ========================================================================== */

(function () {
  "use strict";

  // Registers the chartjs-plugin-datalabels plugin (loaded via CDN in the
  // HTML) so every bar/column/doughnut chart below can render its values as
  // labels on the chart itself, rather than relying on a value axis.
  if (typeof Chart !== "undefined" && typeof ChartDataLabels !== "undefined") {
    Chart.register(ChartDataLabels);
  }

  const CHART_PALETTE = ["#1a3a5c", "#2c5f8a", "#4a90c4", "#7cb4dd", "#a8d0e8", "#d94801", "#f16913", "#fdae6b", "#fdd0a2", "#999999"];
  const FILTER_HIGHLIGHT_COLOR = "#d94801";

  // The CSV's type_of_infrastructure values are the source of truth, but a
  // handful are shortened here for display (charts, legends, PDF report)
  // per the agreed report-label list. Anything not listed below (including
  // any brand-new CSV value) is shown verbatim, unchanged.
  const INFRA_LABEL_MAP = {
    "Industrial/Business/Enterprise facilities": "Industrial/Business/Enterprise",
    "Education facility (school, etc.)": "Education",
    "Government facilities": "Government",
    "Cultural facilities (museum, theater etc.)": "Cultural",
    "Health facility (hospital, health clinic)": "Health",
    "Agricultural facilities": "Agricultural",
    "Religious facilities": "Religious"
  };
  const BLANK_INFRA_LABEL = "(blank/missing)";

  // Fill colour for every proportional damage circle (single colour — size,
  // not hue, carries the value).
  const PROPORTIONAL_CIRCLE_COLOR = "#00734C";

  const monthsList = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const MapCore = {
    CHART_PALETTE,
    FILTER_HIGHLIGHT_COLOR,
    PROPORTIONAL_CIRCLE_COLOR,
    monthsList,
    activeFilter: null, // { dimension: string, value: string | number } | null
    mapInstance: null,
    dimensionLabels: {},
    onRerender: function () {},
    chartInstances: { entity: null, infra: null, extent: null, timeline: null },
    minDataDate: null,
    maxDataDate: null
  };

  // Calculate min and max dates from the CSV data for real date ranges in dropdowns
  MapCore.calculateDataDateRange = function (rawDamageCSV) {
    if (!rawDamageCSV || rawDamageCSV.length === 0) return;
    
    let minDate = null;
    let maxDate = null;
    
    rawDamageCSV.forEach(row => {
      const dateStr = (row.date_of_event || '').trim();
      if (!dateStr) return;
      
      const d = new Date(dateStr);
      if (isNaN(d)) return;
      
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    });
    
    MapCore.minDataDate = minDate;
    MapCore.maxDataDate = maxDate;
  };

  // --------------------------------------------------------------------
  // Setup
  // --------------------------------------------------------------------
  // Called once by the page script before anything else, so the shared
  // filter/legend machinery knows how to label the active-filter dimension
  // and how to trigger a page-specific re-render.
  MapCore.init = function (config) {
    MapCore.dimensionLabels = (config && config.dimensionLabels) || {};
    MapCore.onRerender = (config && config.onRerender) || function () {};
  };

  // Draw order (top to bottom): damaged-building circles, then the ISW
  // "areas of control" layers (pre-2022 hatch, occupied, advances), then the
  // basemap tiles — each on its own pane at a fixed z-index, so the order
  // holds regardless of what's toggled on/off or the sequence it happens in.
  // Leaflet's default overlayPane sits at z-index 400; the basemap's
  // tilePane is 200, well below all of these.
  MapCore.DAMAGE_CIRCLES_PANE = "map-damage-circles-pane";
  const DAMAGE_CIRCLES_Z_INDEX = 440;

  MapCore.initMapElement = function (infoPanelTitle) {
    // Start on a reasonable default view; this gets replaced by fitBounds()
    // once the boundary geoJSON has loaded.
    const instance = L.map("map-container", { zoomSnap: 0.5 }).setView([48.3794, 31.1656], 6);
    window.__leafletMap = instance;
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap", maxZoom: 20
    }).addTo(instance);
    instance.createPane(MapCore.DAMAGE_CIRCLES_PANE).style.zIndex = DAMAGE_CIRCLES_Z_INDEX;

    // UI: Info Panel
    window.mapInfoPanel = L.control({ position: "topright" });
    window.mapInfoPanel.onAdd = function () {
      this._div = L.DomUtil.create("div", "map-info-panel");
      this._div.innerHTML = `<h4>${infoPanelTitle}</h4>Hover over an administrative region`;
      return this._div;
    };
    window.mapInfoPanel.addTo(instance);

    // UI: Legend and "Areas of control" layer list render as regular page
    // content below the map (see #map-legend-panel / #map-layers-panel in
    // the page HTML) rather than as floating map overlays, to keep the map
    // itself uncluttered. window.mapLegend._div keeps the same shape the
    // rest of MapCore already expects (see updateProportionalLegend below).
    window.mapLegend = { _div: document.getElementById("map-legend-panel") };

    MapCore.mapInstance = instance;
    MapCore.addFrontlineControl(instance);
    return instance;
  };

  // --------------------------------------------------------------------
  // ISW frontline overlay (optional context layer)
  // --------------------------------------------------------------------
  // Adds a handful of live ArcGIS FeatureServer layers as an opt-in overlay,
  // sourced from ISW/CTP's public "Interactive Map: Russia's Invasion of
  // Ukraine" webmap (arcgis.com item 9f04944a2fe84edab9da31750c2b15eb), so
  // damage patterns can be read against the current front line. Each layer
  // is off by default and fetched live from Esri on toggle — there's no
  // local copy, since front-line control is reassessed daily.
  const FRONTLINE_HATCH_COLOR = "#f2b6b6";
  const FRONTLINE_OCCUPIED_COLOR = "#f4b8b7";
  const FRONTLINE_ADVANCES_COLOR = "#cbb98a";
  const FRONTLINE_HATCH_PATTERN_ID = "isw-pre2022-hatch-pattern";

  // Pane z-indices place these, in order, directly beneath the damaged-
  // buildings pane (440) and above the basemap's tilePane (200) — see the
  // draw-order comment by MapCore.DAMAGE_CIRCLES_PANE above.
  const FRONTLINE_LAYERS = [
    {
      key: "pre2022",
      label: "Russian controlled Ukrainian territory before 24 February 2022",
      url: "https://services5.arcgis.com/SaBe5HMtmnbqSWlu/arcgis/rest/services/VIEW_Russian_controlled_Ukrainian_Territory_before_February_24_2022/FeatureServer/36",
      swatchCss: `repeating-linear-gradient(45deg, ${FRONTLINE_HATCH_COLOR} 0, ${FRONTLINE_HATCH_COLOR} 2px, transparent 2px, transparent 6px)`,
      style: { stroke: false, fillColor: `url(#${FRONTLINE_HATCH_PATTERN_ID})`, fillOpacity: 1 },
      pane: "isw-pre2022-pane",
      paneZIndex: 430
    },
    {
      key: "occupied",
      label: "Assessed Russian-occupied territories",
      url: "https://services5.arcgis.com/SaBe5HMtmnbqSWlu/arcgis/rest/services/VIEW_RussiaCoTinUkraine_V3/FeatureServer/49",
      swatchCss: FRONTLINE_OCCUPIED_COLOR,
      style: { stroke: false, fillColor: FRONTLINE_OCCUPIED_COLOR, fillOpacity: 0.7 },
      pane: "isw-occupied-pane",
      paneZIndex: 420
    },
    {
      key: "advances",
      label: "Assessed Russian advances in Ukraine",
      url: "https://services5.arcgis.com/SaBe5HMtmnbqSWlu/arcgis/rest/services/AssessedRussianAdvanceInUkraine_V2_view/FeatureServer/0",
      swatchCss: FRONTLINE_ADVANCES_COLOR,
      style: { stroke: false, fillColor: FRONTLINE_ADVANCES_COLOR, fillOpacity: 0.7 },
      pane: "isw-advances-pane",
      paneZIndex: 410
    }
  ];

  MapCore.frontlineLayerInstances = {};

  // Defines the diagonal-stripe SVG pattern used by the "before 24 Feb 2022"
  // layer's fillColor (a plain "url(#id)" is valid as an SVG fill value).
  // Injected once into a standalone hidden <svg>, independent of Leaflet's
  // own SVG renderer root, since SVG id references resolve document-wide.
  function ensureFrontlineHatchPattern() {
    if (document.getElementById(FRONTLINE_HATCH_PATTERN_ID)) return;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    svg.innerHTML =
      `<defs><pattern id="${FRONTLINE_HATCH_PATTERN_ID}" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">` +
      `<rect width="8" height="8" fill="#ffffff" fill-opacity="0"></rect>` +
      `<line x1="0" y1="0" x2="0" y2="8" stroke="${FRONTLINE_HATCH_COLOR}" stroke-width="3"></line>` +
      `</pattern></defs>`;
    document.body.appendChild(svg);
  }

  MapCore.addFrontlineControl = function (map) {
    if (typeof L.esri === "undefined") return; // esri-leaflet failed to load; skip silently

    const panel = document.getElementById("map-layers-panel");
    if (!panel) return;

    ensureFrontlineHatchPattern();

    // Each layer overlaps the others (e.g. pre-2022 hatch over "occupied"
    // over Crimea), so each needs to always paint in a fixed position in the
    // stack regardless of the order they're toggled in — a dedicated pane
    // per layer guarantees that without reordering DOM nodes on every
    // toggle. Z-indices are set on FRONTLINE_LAYERS itself (paneZIndex).
    FRONTLINE_LAYERS.forEach(l => {
      if (l.pane && !map.getPane(l.pane)) {
        map.createPane(l.pane).style.zIndex = l.paneZIndex;
      }
    });

    let html = "<strong>Areas of control</strong>";
    FRONTLINE_LAYERS.forEach(l => {
      html += `<label><i class="map-frontline-swatch" style="background:${l.swatchCss}"></i><input type="checkbox" data-frontline-key="${l.key}" checked> ${l.label}</label>`;
    });
    html += '<span class="map-frontline-attribution">Source: <a href="https://storymaps.arcgis.com/stories/36a7f6a6f5a9448496de641cf64bd375" target="_blank" rel="noopener noreferrer">ISW &amp; CTP</a></span>';
    panel.innerHTML = html;

    function setFrontlineLayerVisible(l, visible) {
      if (visible) {
        if (MapCore.frontlineLayerInstances[l.key]) return;
        const layerOptions = {
          url: l.url,
          style: () => l.style,
          simplifyFactor: 0.5,
          precision: 5
        };
        if (l.pane) layerOptions.pane = l.pane;
        MapCore.frontlineLayerInstances[l.key] = L.esri.featureLayer(layerOptions).addTo(map);
      } else if (MapCore.frontlineLayerInstances[l.key]) {
        map.removeLayer(MapCore.frontlineLayerInstances[l.key]);
        delete MapCore.frontlineLayerInstances[l.key];
      }
    }

    FRONTLINE_LAYERS.forEach(l => {
      const input = panel.querySelector(`[data-frontline-key="${l.key}"]`);
      if (!input) return;
      input.addEventListener("change", () => setFrontlineLayerVisible(l, input.checked));
      // Checked by default (see the "checked" attribute above), so load
      // each layer immediately rather than waiting for a user toggle.
      if (input.checked) setFrontlineLayerVisible(l, true);
    });
  };

  // --------------------------------------------------------------------
  // Legend / proportional circle scale
  // --------------------------------------------------------------------
  // Damage volume is encoded as circle area (not fill colour), per the
  // standard proportional-symbol map convention: area, not radius, should
  // scale linearly with value so the *perceived* size follows the data
  // rather than exaggerating large values. A value of 0 gets no circle.
  MapCore.computeRadiusScale = function (counts, options) {
    const minRadius = (options && options.minRadius) || 4;
    const maxRadius = (options && options.maxRadius) || 32;
    const values = Object.values(counts).filter(v => v > 0);
    const maxValue = values.length ? Math.max(...values) : 0;

    const scale = function (value) {
      if (!value || value <= 0 || maxValue <= 0) return 0;
      return minRadius + (maxRadius - minRadius) * Math.sqrt(value / maxValue);
    };

    return { scale, maxValue, minRadius, maxRadius };
  };

  // Rounds a number to a "nice" value (1/2/5/10 x a power of ten) so legend
  // labels read cleanly instead of showing arbitrary decimals.
  MapCore.roundNice = function (n) {
    if (n < 10) return Math.round(n);
    const magnitude = Math.pow(10, Math.floor(Math.log10(n)));
    const normalized = n / magnitude;
    let niceNormalized;
    if (normalized <= 1) niceNormalized = 1;
    else if (normalized <= 2) niceNormalized = 2;
    else if (normalized <= 5) niceNormalized = 5;
    else niceNormalized = 10;
    return niceNormalized * magnitude;
  };

  // Opacity applied to each ring, largest (outermost) to smallest
  // (innermost), so overlapping rings read as progressively darker toward
  // the shared baseline — matching the standard "nested circle" proportional
  // symbol legend convention.
  const NESTED_RING_OPACITIES = [0.28, 0.55, 0.85];

  // Renders 3 reference circles (max, and two "nice" smaller fractions of
  // it) as one set of nested circles sharing a horizontal centre and a
  // common bottom edge (baseline), each with a leader line out to its
  // value, rather than as separate side-by-side circles.
  MapCore.updateProportionalLegend = function (radiusInfo) {
    if (!window.mapLegend || !window.mapLegend._div) return;

    const { scale, maxValue } = radiusInfo;
    if (!maxValue || maxValue <= 0) {
      window.mapLegend._div.innerHTML = "<strong>Damaged Buildings</strong><br>No data in range";
      return;
    }

    const refValues = [...new Set([
      maxValue,
      MapCore.roundNice(maxValue / 3),
      MapCore.roundNice(maxValue / 10)
    ])].filter(v => v > 0 && v <= maxValue).sort((a, b) => b - a); // largest first

    const maxR = scale(maxValue);
    const pad = 6;
    const cx = maxR + pad;
    const leaderLength = 16;
    const labelGap = 6;
    const svgWidth = cx + maxR + leaderLength + 60;
    const svgHeight = maxR * 2 + pad * 2;
    const baseline = svgHeight - pad; // shared bottom edge every ring sits on

    // Each ring's label sits level with its top edge; when two rings are
    // close enough in size that their labels would overlap, nudge the
    // lower one down so labels stay legible.
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
      circlesSvg += `<circle cx="${cx}" cy="${p.cy}" r="${p.r}" fill="${PROPORTIONAL_CIRCLE_COLOR}" fill-opacity="${p.opacity}" stroke="${PROPORTIONAL_CIRCLE_COLOR}" stroke-width="1" stroke-opacity="0.6"></circle>`;
    });

    let labelsSvg = "";
    const lineEndX = cx + maxR + leaderLength;
    points.forEach(p => {
      labelsSvg += `<line x1="${cx}" y1="${p.topY}" x2="${lineEndX}" y2="${p.labelY}" stroke="#999" stroke-width="1"></line>` +
        `<circle cx="${cx}" cy="${p.topY}" r="1.5" fill="#999"></circle>` +
        `<text x="${lineEndX + labelGap}" y="${p.labelY}" dominant-baseline="middle" font-size="11" fill="#333">${p.v.toLocaleString()}</text>`;
    });

    const svg = `<svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">${circlesSvg}${labelsSvg}</svg>`;

    window.mapLegend._div.innerHTML = `<strong>Damaged Buildings</strong><div class="map-proportional-legend-nested">${svg}</div>`;
  };

  // --------------------------------------------------------------------
  // Cross-filter state machine
  // --------------------------------------------------------------------
  // Sets (or, if the same value is clicked again, clears) the active
  // cross-filter selection, then asks the page to re-render everything.
  MapCore.setActiveFilter = function (dimension, value) {
    if (MapCore.activeFilter && MapCore.activeFilter.dimension === dimension && MapCore.activeFilter.value === value) {
      MapCore.activeFilter = null;
    } else {
      MapCore.activeFilter = { dimension, value };
    }
    MapCore.updateActiveFilterUI();
    MapCore.onRerender();
  };

  MapCore.clearMapFilter = function () {
    MapCore.activeFilter = null;
    MapCore.updateActiveFilterUI();
    MapCore.onRerender();
  };

  MapCore.updateActiveFilterUI = function () {
    const group = document.getElementById("map-active-filter-group");
    const label = document.getElementById("map-active-filter-label");
    if (!group || !label) return;

    const af = MapCore.activeFilter;
    if (af) {
      const labels = MapCore.dimensionLabels;
      label.textContent = (labels[af.dimension] || af.dimension) + ": " + af.value;
      group.style.display = "flex";
    } else {
      group.style.display = "none";
    }
  };

  MapCore.isFilterableLabel = function (label) {
    return label !== "Other";
  };

  // Maps a raw type_of_infrastructure CSV value to its report/display label.
  MapCore.normalizeInfraLabel = function (raw) {
    const trimmed = raw ? raw.trim() : "";
    if (!trimmed) return BLANK_INFRA_LABEL;
    return INFRA_LABEL_MAP[trimmed] || trimmed;
  };

  // --------------------------------------------------------------------
  // Dropdown / time-bucket helpers
  // --------------------------------------------------------------------
  // Populates #map-year-select from whatever years exist in the CSV, then
  // builds the period dropdowns for the currently-selected aggregation.
  MapCore.buildYearOptions = function (rawDamageCSV) {
    const yearSel = document.getElementById("map-year-select");
    if (!yearSel) return;
    const years = [...new Set(rawDamageCSV.map(r => r.date_of_event?.slice(0, 4)).filter(y => y))].sort((a, b) => b - a);
    yearSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join("");
    
    // Calculate date range when years are loaded
    MapCore.calculateDataDateRange(rawDamageCSV);
    MapCore.buildMapPeriodDropdowns();
  };

  // UPDATED: Generate period labels with real dates from data
  MapCore.buildMapPeriodDropdowns = function () {
    const aggType = document.getElementById("map-aggregation-select").value;
    const startSel = document.getElementById("map-period-start-select");
    const endSel = document.getElementById("map-period-end-select");
    if (!startSel || !endSel) return;

    // Use the year currently selected in the "Target Assessment Year"
    // dropdown so period labels reflect that year's actual calendar (this
    // matters across leap-year boundaries); fall back to the max year seen
    // in the data, then to the current year, before the selector has options.
    const yearSel = document.getElementById("map-year-select");
    const selectedYear = yearSel && yearSel.value ? parseInt(yearSel.value, 10) : NaN;
    const referenceYear = !isNaN(selectedYear)
      ? selectedYear
      : (MapCore.maxDataDate ? MapCore.maxDataDate.getFullYear() : new Date().getFullYear());

    let options = "";
    if (aggType === "30") {
      // Months - show actual date ranges
      options = monthsList.map((m, i) => {
        const dStart = new Date(referenceYear, i, 1);
        const dEnd = new Date(referenceYear, i + 1, 0);
        const fmt = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const dateRange = `${fmt(dStart)} – ${fmt(dEnd)}`;
        return `<option value="${i}">${m} (${dateRange})</option>`;
      }).join("");
    } else {
      // Weeks or Fortnights - calculate with real dates
      const periodDays = parseInt(aggType);
      const totalPeriods = Math.ceil(365 / periodDays);
      const prefix = aggType === "7" ? "Week" : "Fortnight";
      
      for (let i = 0; i < totalPeriods; i++) {
        const startDay = i * periodDays + 1;
        let endDay = startDay + periodDays - 1;
        if (endDay > 365) endDay = 365;
        
        const dStart = new Date(referenceYear, 0, startDay);
        const dEnd = new Date(referenceYear, 0, endDay);
        const fmt = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const dateRange = `${fmt(dStart)} – ${fmt(dEnd)}`;
        
        options += `<option value="${i}">${prefix} ${i + 1} (${dateRange})</option>`;
      }
    }

    startSel.innerHTML = options;
    endSel.innerHTML = options;

    // Default to a single-window range
    startSel.selectedIndex = 0;
    endSel.selectedIndex = 0;

    MapCore.onRerender();
  };

  // Seeds the time-series tracker keys within the active dashboard range,
  // so every period in the window is represented even if it has zero rows.
  MapCore.computeTimeBuckets = function (step, startPeriod, endPeriod) {
    const timeCounts = {};
    const labelsList = [];
    if (step === 30) {
      for (let i = startPeriod; i <= endPeriod; i++) {
        timeCounts[monthsList[i]] = 0;
        labelsList.push(monthsList[i]);
      }
    } else {
      const prefix = step === 7 ? "Week" : "Fortnight";
      for (let i = startPeriod; i <= endPeriod; i++) {
        const key = `${prefix} ${i + 1}`;
        timeCounts[key] = 0;
        labelsList.push(key);
      }
    }
    return { timeCounts, labelsList };
  };

  // --------------------------------------------------------------------
  // Chart rendering
  // --------------------------------------------------------------------
  // Measures how wide a datalabel string would render at a given font size,
  // so a chart can decide whether there's enough room to draw it without
  // colliding with its neighbours (see renderTimelineBarChart below).
  function measureLabelWidth(ctx, text, fontSizePx) {
    ctx.save();
    ctx.font = `600 ${fontSizePx}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    const width = ctx.measureText(text).width;
    ctx.restore();
    return width;
  }

  // Renders labels for the "Extent of Damage" doughnut outside the ring, each
  // with a short leader line back to its slice, so the ring doesn't need a
  // value axis or an on-chart legend to be readable.
  const outsideDoughnutLabelsPlugin = {
    id: "outsideDoughnutLabels",
    afterDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      const dataset = chart.data.datasets[0];
      if (!meta || !dataset) return;
      const total = dataset.data.reduce((a, b) => a + b, 0);
      if (!total) return;

      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textBaseline = "middle";

      // Minimum vertical gap enforced between two label lines on the same
      // side of the ring, so neighbouring slices with similar angles never
      // draw text on top of each other.
      const LINE_HEIGHT = 14;

      const leftLabels = [];
      const rightLabels = [];

      meta.data.forEach((arc, i) => {
        const value = dataset.data[i];
        if (!value) return;

        const { x, y, startAngle, endAngle, outerRadius } =
          arc.getProps(["x", "y", "startAngle", "endAngle", "outerRadius"], true);
        const midAngle = (startAngle + endAngle) / 2;
        const cos = Math.cos(midAngle);
        const sin = Math.sin(midAngle);
        const isRight = cos >= 0;

        const lineStart = { x: x + cos * (outerRadius + 2), y: y + sin * (outerRadius + 2) };
        const bend = { x: x + cos * (outerRadius + 16), y: y + sin * (outerRadius + 16) };
        const textX = bend.x + (isRight ? 14 : -14);

        const pct = Math.round((value / total) * 100);
        const text = `${chart.data.labels[i]}: ${value.toLocaleString()} (${pct}%)`;

        const entry = { lineStart, bend, textX, textY: bend.y, text, isRight };
        (isRight ? rightLabels : leftLabels).push(entry);
      });

      // Within each side, walk top-to-bottom and push any label that's too
      // close to the one above it further down. If that runs the stack past
      // the bottom of the chart, walk back up compressing gaps instead, so
      // the whole stack stays on screen.
      function declutter(list) {
        list.sort((a, b) => a.textY - b.textY);

        for (let i = 1; i < list.length; i++) {
          if (list[i].textY - list[i - 1].textY < LINE_HEIGHT) {
            list[i].textY = list[i - 1].textY + LINE_HEIGHT;
          }
        }

        const maxY = chartArea.bottom - 4;
        if (list.length && list[list.length - 1].textY > maxY) {
          list[list.length - 1].textY = maxY;
          for (let i = list.length - 2; i >= 0; i--) {
            if (list[i + 1].textY - list[i].textY < LINE_HEIGHT) {
              list[i].textY = list[i + 1].textY - LINE_HEIGHT;
            }
          }
        }
      }

      declutter(leftLabels);
      declutter(rightLabels);

      [...leftLabels, ...rightLabels].forEach(({ lineStart, bend, textX, textY, text, isRight }) => {
        ctx.strokeStyle = "#999";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lineStart.x, lineStart.y);
        // Elbow at the slice's natural angle first, then a vertical run to
        // the label's (possibly decluttered) final height.
        ctx.lineTo(bend.x, bend.y);
        ctx.lineTo(bend.x, textY);
        ctx.lineTo(textX + (isRight ? -4 : 4), textY);
        ctx.stroke();

        ctx.fillStyle = "#333";
        ctx.textAlign = isRight ? "left" : "right";
        ctx.fillText(text, textX, textY);
      });

      ctx.restore();
    }
  };

  function renderBarChart(canvasId, existingInstance, labels, data, dimension) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return existingInstance;

    const backgroundColor = labels.map(l =>
      (MapCore.activeFilter && MapCore.activeFilter.dimension === dimension && MapCore.activeFilter.value === l)
        ? FILTER_HIGHLIGHT_COLOR : CHART_PALETTE[0]
    );

    if (existingInstance) {
      existingInstance.data.labels = labels;
      existingInstance.data.datasets[0].data = data;
      existingInstance.data.datasets[0].backgroundColor = backgroundColor;
      existingInstance.update();
      return existingInstance;
    }

    return new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{ data, backgroundColor, borderRadius: 4 }]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { right: 34 } },
        plugins: {
          legend: { display: false },
          // Value labels rendered just past the end of each bar, so the
          // value axis below is no longer needed to read amounts.
          datalabels: {
            anchor: "end",
            align: "end",
            clip: false,
            color: "#1a3a5c",
            font: { size: 10, weight: "600" },
            formatter: value => value.toLocaleString()
          }
        },
        scales: {
          // Value axis removed - each bar now carries its own label.
          x: { display: false, beginAtZero: true, grace: "12%" },
          y: { grid: { display: false } }
        },
        onClick: (evt, elements, chart) => {
          if (!elements.length) return;
          const label = chart.data.labels[elements[0].index];
          if (!MapCore.isFilterableLabel(label)) return;
          MapCore.setActiveFilter(dimension, label);
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? "pointer" : "default";
        }
      }
    });
  }

  function renderDoughnutChart(canvasId, existingInstance, labels, data, dimension) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return existingInstance;

    const borderWidth = labels.map(l =>
      (MapCore.activeFilter && MapCore.activeFilter.dimension === dimension && MapCore.activeFilter.value === l) ? 4 : 0
    );

    if (existingInstance) {
      existingInstance.data.labels = labels;
      existingInstance.data.datasets[0].data = data;
      existingInstance.data.datasets[0].borderWidth = borderWidth;
      existingInstance.update();
      return existingInstance;
    }

    return new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{ data, backgroundColor: CHART_PALETTE, borderColor: "#1a3a5c", borderWidth }]
      },
      plugins: [outsideDoughnutLabelsPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Extra room on every side for the outside labels + leader lines
        // drawn by outsideDoughnutLabelsPlugin.
        layout: { padding: { top: 36, bottom: 36, left: 84, right: 84 } },
        // The legend is dropped in favour of the outside labels, which
        // already carry the category name, value, and percentage.
        plugins: { legend: { display: false }, datalabels: { display: false } },
        onClick: (evt, elements, chart) => {
          if (!elements.length) return;
          const label = chart.data.labels[elements[0].index];
          if (!MapCore.isFilterableLabel(label)) return;
          MapCore.setActiveFilter(dimension, label);
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? "pointer" : "default";
        }
      }
    });
  }

  function renderTimelineBarChart(canvasId, existingInstance, labels, data, dimension) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return existingInstance;

    const backgroundColor = labels.map(l =>
      (MapCore.activeFilter && MapCore.activeFilter.dimension === dimension && MapCore.activeFilter.value === l)
        ? FILTER_HIGHLIGHT_COLOR : CHART_PALETTE[0]
    );

    if (existingInstance) {
      existingInstance.data.labels = labels;
      existingInstance.data.datasets[0].data = data;
      existingInstance.data.datasets[0].backgroundColor = backgroundColor;
      existingInstance.update();
      return existingInstance;
    }

    return new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{ data, backgroundColor, borderRadius: 4 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 26 } },
        plugins: {
          legend: { display: false },
          // Value labels rendered just above each column, so the value
          // axis below is no longer needed to read amounts.
          datalabels: {
            anchor: "end",
            align: "end",
            clip: false,
            color: "#1a3a5c",
            font: { size: 8, weight: "600" },
            formatter: value => value.toLocaleString(),
            // Skip empty periods entirely rather than stamping a "0" above
            // every zero-value column. Also skip a label if its column is
            // too narrow to fit the text without overlapping its neighbours.
            display: context => {
              const value = context.dataset.data[context.dataIndex];
              if (!value) return false;

              const barCount = context.dataset.data.length;
              const { chartArea } = context.chart;
              if (!chartArea) return true;

              const availableWidth = chartArea.width / barCount;
              const textWidth = measureLabelWidth(context.chart.ctx, value.toLocaleString(), 8);
              return textWidth <= availableWidth * 0.85;
            }
          }
        },
        scales: {
          x: { grid: { drawOnChartArea: false, drawTicks: true } },
          // Value axis removed - each column now carries its own label.
          y: { display: false, beginAtZero: true, grace: "18%" }
        },
        onClick: (evt, elements, chart) => {
          if (!elements.length) return;
          const label = chart.data.labels[elements[0].index];
          MapCore.setActiveFilter(dimension, label);
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? "pointer" : "default";
        }
      }
    });
  }

  // Renders/updates all four summary charts from one call, and returns the
  // exact series each was drawn with, so the PDF report can rebuild
  // identical vector charts without re-deriving the Top-N / "Other"
  // bucketing / sort order logic a second time.
  //
  //   entityDimension - 'oblast' | 'raion', used for cross-filter matching
  //   entityKey       - 'topOblasts' | 'topRaions', the key name the PDF
  //                     report generator expects in the returned object
  MapCore.buildSummaryCharts = function ({ entityCounts, entityDimension, entityKey, infraCounts, extentCounts, timeCounts, labelsList }) {
    if (typeof Chart === "undefined") return null;

    const topEntity = Object.entries(entityCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    MapCore.chartInstances.entity = renderBarChart(
      "map-top-oblasts-chart", MapCore.chartInstances.entity,
      topEntity.map(e => e[0]), topEntity.map(e => e[1]), entityDimension
    );

    const infraEntries = Object.entries(infraCounts).sort((a, b) => b[1] - a[1]);
    const topInfra = infraEntries.slice(0, 7);
    const otherInfraTotal = infraEntries.slice(7).reduce((sum, e) => sum + e[1], 0);
    const infraLabels = topInfra.map(e => e[0]);
    const infraValues = topInfra.map(e => e[1]);
    if (otherInfraTotal > 0) {
      infraLabels.push("Other");
      infraValues.push(otherInfraTotal);
    }
    MapCore.chartInstances.infra = renderBarChart("map-infra-type-chart", MapCore.chartInstances.infra, infraLabels, infraValues, "infra");

    const extentEntries = Object.entries(extentCounts).sort((a, b) => b[1] - a[1]);
    MapCore.chartInstances.extent = renderDoughnutChart(
      "map-extent-chart", MapCore.chartInstances.extent,
      extentEntries.map(e => e[0]), extentEntries.map(e => e[1]), "extent"
    );

    const timelineValues = labelsList.map(lbl => timeCounts[lbl] || 0);
    MapCore.chartInstances.timeline = renderTimelineBarChart(
      "map-timeline-chart", MapCore.chartInstances.timeline,
      labelsList, timelineValues, "period"
    );

    return {
      [entityKey]: { labels: topEntity.map(e => e[0]), values: topEntity.map(e => e[1]) },
      infra: { labels: infraLabels, values: infraValues },
      extent: { labels: extentEntries.map(e => e[0]), values: extentEntries.map(e => e[1]) },
      timeline: { labels: labelsList, values: timelineValues }
    };
  };

  window.MapCore = MapCore;

  // The pages' HTML calls these as bare globals via inline onclick/onchange
  // attributes, so keep them available at window scope too.
  window.clearMapFilter = MapCore.clearMapFilter;
  window.buildMapPeriodDropdowns = MapCore.buildMapPeriodDropdowns;
})();