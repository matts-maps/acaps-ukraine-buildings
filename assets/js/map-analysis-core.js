/* ============================================================================
   MapCore — shared logic for the Oblast and Raion analysis pages.
   ============================================================================
   This file holds everything that was previously duplicated verbatim (or
   near-verbatim) between oblast_analysis.js and raion_analysis.js: map/
   legend setup, the date-range bucket engine, filter-control helpers, and
   chart rendering (including the "value labels drawn on the chart itself"
   style, via chartjs-plugin-datalabels).

   Every filter (date range, granularity, area, building type, damage
   level) lives in exactly one DOM control - there is no separate
   cross-filter state object. Clicking a map circle or a chart bar/slice
   just writes a value into the relevant <select> (via MapCore.selectOrToggle)
   or the date inputs (via MapCore.selectDateRangeBucket) and dispatches a
   change, so the control itself is always the single source of truth.

   What deliberately stays OUT of this file, because it's genuinely
   different per page rather than duplicated:
     - CSV parsing / geoJSON name matching (oblast uses a "ska"-suffix
       strip + name map, raion uses RAION_NAME_MAP)
     - The Oblast/Raion cascading dropdown filters (raion-only feature)
     - The row-filtering loop in processMapVisualisations() itself, since
       the two pages filter/match on different CSV columns

   USAGE (see oblast_analysis.js / raion_analysis.js for the full pattern):
     MapCore.init({ onRerender: processMapVisualisations });
     mapInstance = MapCore.initMapElement('Oblast Metric Profile');
     ...
     MapCore.initDateRangeControls(rawDamageCSV);
     ...
     const buckets = MapCore.buildDateBuckets(fromISO, toISO, granularity);
     const radiusInfo = MapCore.computeRadiusScale(counts);
     MapCore.updateProportionalLegend(radiusInfo);
     const chartSeries = MapCore.buildSummaryCharts({
       entityCounts: counts, entityKey: 'topOblasts',
       entitySelectedValue: oblastFilter, onEntityClick: label => MapCore.selectOrToggle('map-oblast-select', label),
       infraCounts, infraSelectedValue: infraFilter, onInfraClick: label => MapCore.selectOrToggle('map-infra-select', label),
       extentCounts, extentSelectedValue: extentFilter, onExtentClick: label => MapCore.selectOrToggle('map-extent-select', label),
       timeCounts, labelsList, onTimelineClick: (label, index) => { ... }
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

  const MapCore = {
    CHART_PALETTE,
    FILTER_HIGHLIGHT_COLOR,
    PROPORTIONAL_CIRCLE_COLOR,
    mapInstance: null,
    onRerender: function () {},
    chartInstances: { entity: null, infra: null, extent: null, timeline: null },
    minDataDate: null,
    maxDataDate: null,
    // The full-country view, captured once the boundary geoJSON first loads
    // on either page, so applyZoomForScope() can zoom back out to it when
    // an area filter is cleared.
    nationalBounds: null,
    // Tracks which area scope the map is currently zoomed to, so
    // applyZoomForScope() only re-fits the view when that scope actually
    // changes (not on every re-render triggered by e.g. a date change).
    lastZoomScopeKey: "",
    // Plain-data mirror of the circle markers currently on the map (center,
    // radius, style), rebuilt by oblast_analysis.js/raion_analysis.js
    // alongside the real L.circleMarker layer. Exists so the PDF export
    // renderer (map-pdf-renderer.js) can redraw the same circles onto its
    // own canvas without reaching into the page script's private closure.
    damageCircleData: []
  };

  // Single source of truth for a damage circle's non-size styling, shared
  // between the live L.circleMarker options and the plain-data record in
  // MapCore.damageCircleData, so the two can't drift apart.
  MapCore.damageCircleStyle = function (isSelected) {
    return {
      fillColor: PROPORTIONAL_CIRCLE_COLOR,
      strokeColor: isSelected ? "#1a3a5c" : "#00512f",
      strokeWeight: isSelected ? 3 : 1,
      fillOpacity: 0.75
    };
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
  // filter/legend machinery knows how to trigger a page-specific re-render.
  MapCore.init = function (config) {
    MapCore.onRerender = (config && config.onRerender) || function () {};
  };

  // --------------------------------------------------------------------
  // Zoom-to-scope
  // --------------------------------------------------------------------
  // Shared by both pages: the Raion page has always zoomed the map to the
  // selected Oblast/Raion; the Oblast page now gets the same behaviour for
  // its own new Oblast select. computeBoundsFn is page-local (oblast/raion
  // boundary-geoJSON name matching genuinely differs per page).
  MapCore.setNationalBounds = function (bounds) {
    MapCore.nationalBounds = bounds;
  };

  MapCore.applyZoomForScope = function (scopeKey, computeBoundsFn) {
    if (scopeKey === MapCore.lastZoomScopeKey) return; // scope hasn't changed, leave the user's current pan/zoom alone
    MapCore.lastZoomScopeKey = scopeKey;

    // animate: false - an animated zoom transition that doesn't complete
    // (e.g. a backgrounded/inactive tab pausing the animation) would
    // silently leave the map at the wrong scope with no visible error, so
    // every automatic map fit in this app snaps directly to its target
    // instead of relying on the animation finishing.
    const scopedBounds = computeBoundsFn();
    if (scopedBounds) {
      MapCore.mapInstance.fitBounds(scopedBounds, { padding: [30, 30], maxZoom: 10, animate: false });
    } else if (MapCore.nationalBounds) {
      MapCore.mapInstance.fitBounds(MapCore.nationalBounds, { padding: [15, 15], animate: false });
    }
  };

  // Draw order (top to bottom): damaged-building circles, then the ISW
  // "areas of control" layers (pre-2022 hatch, occupied, advances), then the
  // basemap tiles — each on its own pane at a fixed z-index, so the order
  // holds regardless of what's toggled on/off or the sequence it happens in.
  // Leaflet's default overlayPane sits at z-index 400; the basemap's
  // tilePane is 200, well below all of these.
  MapCore.DAMAGE_CIRCLES_PANE = "map-damage-circles-pane";
  const DAMAGE_CIRCLES_Z_INDEX = 440;

  // Leaflet's built-in panes (tilePane, overlayPane, markerPane, ...) get the
  // "leaflet-zoom-animated" class automatically, which is what makes them
  // track the map smoothly during a zoom gesture. A pane created via
  // map.createPane() does NOT get that class unless you add it yourself —
  // without it, that pane's content stays frozen at its pre-zoom pixel
  // position while the basemap animates underneath it, which reads as the
  // layer being "offset" from the map (it self-corrects once the zoom
  // settles, but looks wrong throughout the gesture, and can leave things
  // misaligned if a capture/screenshot happens mid-animation). Every custom
  // pane in this app should be created through this helper, not
  // map.createPane() directly.
  function createSyncedPane(map, name, zIndex) {
    if (map.getPane(name)) return map.getPane(name);
    const pane = map.createPane(name);
    pane.classList.add("leaflet-zoom-animated");
    pane.style.zIndex = zIndex;
    return pane;
  }

  MapCore.initMapElement = function (infoPanelTitle) {
    // Start on a reasonable default view; this gets replaced by fitBounds()
    // once the boundary geoJSON has loaded.
    const instance = L.map("map-container", { zoomSnap: 0.5 }).setView([48.3794, 31.1656], 6);
    window.__leafletMap = instance;
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap", maxZoom: 20,
      // Needed so the PDF export renderer (map-pdf-renderer.js) can draw
      // these tile images onto its own canvas without tainting it -
      // CartoDB's tile CDN sends Access-Control-Allow-Origin: *.
      crossOrigin: true
    }).addTo(instance);
    createSyncedPane(instance, MapCore.DAMAGE_CIRCLES_PANE, DAMAGE_CIRCLES_Z_INDEX);

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
  const FRONTLINE_HATCH_COLOR = "#EF0000";
  const FRONTLINE_OCCUPIED_COLOR = "#f4b8b7";
  const FRONTLINE_ADVANCES_COLOR = "#cbb98a";
  const FRONTLINE_HATCH_PATTERN_ID = "isw-pre2022-hatch-pattern";

  // The on-page legend swatch background (#map-layers-panel checkboxes): a
  // small PNG rasterized on a scratch <canvas> at load time, rather than a
  // CSS repeating-linear-gradient or an SVG data URI, for simple reliable
  // cross-browser rendering as a background-image. (The PDF export builds
  // its own areas-of-control legend directly - see map-pdf-renderer.js's
  // buildAreasOfControlLegendSvg - and doesn't use this value at all.)
  function buildHatchSwatchDataUrl() {
    const tile = document.createElement("canvas");
    tile.width = 8;
    tile.height = 8;
    const ctx = tile.getContext("2d");
    ctx.strokeStyle = FRONTLINE_HATCH_COLOR;
    ctx.lineWidth = 2;
    [-8, 0, 8].forEach(k => {
      ctx.beginPath();
      ctx.moveTo(k, 8);
      ctx.lineTo(k + 8, 0);
      ctx.stroke();
    });
    return tile.toDataURL("image/png");
  }
  const FRONTLINE_HATCH_SWATCH_CSS = `url(${buildHatchSwatchDataUrl()}) repeat`;

  // Pane z-indices place these, in order, directly beneath the damaged-
  // buildings pane (440) and above the basemap's tilePane (200) — see the
  // draw-order comment by MapCore.DAMAGE_CIRCLES_PANE above.
  const FRONTLINE_LAYERS = [
    {
      key: "pre2022",
      label: "Russian controlled Ukrainian territory before 24 February 2022",
      url: "https://services5.arcgis.com/SaBe5HMtmnbqSWlu/arcgis/rest/services/VIEW_Russian_controlled_Ukrainian_Territory_before_February_24_2022/FeatureServer/36",
      swatchCss: FRONTLINE_HATCH_SWATCH_CSS,
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
  // Exposed (not just used internally) so the PDF export renderer
  // (map-pdf-renderer.js) can draw each layer's fill/pattern in the same
  // order and colors as the live map, without a second copy of this config.
  MapCore.FRONTLINE_LAYERS = FRONTLINE_LAYERS;

  MapCore.frontlineLayerInstances = {};

  // Defines the diagonal-stripe SVG pattern used by the "before 24 Feb 2022"
  // layer's fillColor (a plain "url(#id)" is valid as an SVG fill value).
  // Injected once into a standalone hidden <svg>, independent of Leaflet's
  // own SVG renderer root, since SVG id references resolve document-wide.
  // Exposed on MapCore (not just called internally) - and accepts an
  // optional targetDocument - because map-pdf-renderer.js's areas-of-control
  // legend needs this same pattern definition self-contained inside a
  // standalone SVG it builds for the PDF (svg2pdf.js may not resolve a
  // url(#id) reference across document/embed boundaries), rather than
  // relying on this page-wide hidden <svg>.
  MapCore.ensureFrontlineHatchPattern = function (targetDocument) {
    const doc = targetDocument || document;
    if (doc.getElementById(FRONTLINE_HATCH_PATTERN_ID)) return;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    svg.innerHTML =
      `<defs><pattern id="${FRONTLINE_HATCH_PATTERN_ID}" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">` +
      `<rect width="8" height="8" fill="#ffffff" fill-opacity="0"></rect>` +
      `<line x1="0" y1="0" x2="0" y2="8" stroke="${FRONTLINE_HATCH_COLOR}" stroke-width="3"></line>` +
      `</pattern></defs>`;
    doc.body.appendChild(svg);
  };

  MapCore.addFrontlineControl = function (map) {
    if (typeof L.esri === "undefined") return; // esri-leaflet failed to load; skip silently

    const panel = document.getElementById("map-layers-panel");
    if (!panel) return;

    MapCore.ensureFrontlineHatchPattern();

    // Each layer overlaps the others (e.g. pre-2022 hatch over "occupied"
    // over Crimea), so each needs to always paint in a fixed position in the
    // stack regardless of the order they're toggled in — a dedicated pane
    // per layer guarantees that without reordering DOM nodes on every
    // toggle. Z-indices are set on FRONTLINE_LAYERS itself (paneZIndex).
    FRONTLINE_LAYERS.forEach(l => {
      if (l.pane) createSyncedPane(map, l.pane, l.paneZIndex);
    });

    let html = "<strong>Areas of control</strong>";
    FRONTLINE_LAYERS.forEach(l => {
      html += `<label><i class="map-frontline-swatch" style="background:${l.swatchCss}"></i><input type="checkbox" data-frontline-key="${l.key}" checked> ${l.label}</label>`;
    });
    html += '<span class="map-frontline-attribution">Source: <a href="https://storymaps.arcgis.com/stories/36a7f6a6f5a9448496de641cf64bd375" target="_blank" rel="noopener noreferrer">ISW &amp; CTP</a></span>';
    panel.innerHTML = html;

    // These layers are fetched live from Esri with no local fallback (see
    // the module header) - occasionally the underlying request just stalls
    // (neither "load" nor "requesterror" ever fires) rather than failing
    // outright, leaving the layer permanently empty with no visible error.
    // A single stall-recovery retry (remove + recreate the layer once)
    // resolves this in practice; capped at one retry so a genuinely
    // unreachable service doesn't loop forever.
    const FRONTLINE_STALL_TIMEOUT_MS = 8000;

    function createFrontlineLayer(l, isRetry) {
      const layerOptions = {
        url: l.url,
        style: () => l.style,
        simplifyFactor: 0.5,
        precision: 5
      };
      if (l.pane) layerOptions.pane = l.pane;

      const layer = L.esri.featureLayer(layerOptions);
      MapCore.frontlineLayerInstances[l.key] = layer;

      let settled = false;
      layer.once("load requesterror", () => { settled = true; });

      layer.addTo(map);

      if (!isRetry) {
        setTimeout(() => {
          // Only recover if this is still the current instance for the
          // layer (it wasn't toggled off/on again in the meantime) and it
          // never actually settled.
          if (!settled && MapCore.frontlineLayerInstances[l.key] === layer) {
            map.removeLayer(layer);
            console.warn(`MapCore: "${l.key}" areas-of-control layer stalled loading; retrying once.`);
            createFrontlineLayer(l, true);
          }
        }, FRONTLINE_STALL_TIMEOUT_MS);
      }
    }

    function setFrontlineLayerVisible(l, visible) {
      if (visible) {
        if (MapCore.frontlineLayerInstances[l.key]) return;
        createFrontlineLayer(l, false);
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
  // Filter-control helpers
  // --------------------------------------------------------------------
  // Every filter lives in exactly one DOM control (the date inputs, the
  // granularity select, and one <select> per area/building-type/damage-
  // level dimension). A map-circle or chart click just writes into the
  // relevant control and dispatches change - no separate cross-filter
  // state object, so combining filters is just "more than one control has
  // a non-default value" rather than something MapCore has to arbitrate.

  // Toggles a <select>'s value: sets it to `value`, or clears it back to
  // "" (its "All"/"Total" default option) if it's already set to `value` -
  // matching the old cross-filter's "click again to clear" behaviour.
  MapCore.selectOrToggle = function (selectId, value) {
    const el = document.getElementById(selectId);
    if (!el) return;
    el.value = (el.value === value) ? "" : value;
    el.dispatchEvent(new Event("change"));
  };

  // Timeline-bar clicks narrow the date range to that bucket directly,
  // rather than setting a dimension/value pair - there's no other control
  // a "period" click could write into once periods are arbitrary date
  // buckets instead of a fixed Week-N/Fortnight-N/Month label.
  MapCore.selectDateRangeBucket = function (startISO, endISO) {
    const fromEl = document.getElementById("map-date-from");
    const toEl = document.getElementById("map-date-to");
    if (!fromEl || !toEl) return;
    fromEl.value = startISO;
    toEl.value = endISO;
    MapCore.onRerender();
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

  // Maps a raw extent_of_damage CSV value to its display label. Blank values
  // and the literal "Unknown" value are both surfaced as "Unknown" (one
  // merged category) — extracted out of the two pages' identical expression
  // so it's defined once.
  MapCore.normalizeExtentLabel = function (raw) {
    const trimmed = raw ? raw.trim() : "";
    return trimmed || "Unknown";
  };

  // Builds the "Building type"/"Damage level" <select> options from
  // whatever distinct normalized labels are actually present in the CSV,
  // each page calling this identically for its own <select> id.
  MapCore.buildFilterSelectOptions = function (selectId, defaultLabel, values) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const sorted = [...new Set(values)].sort();
    sel.innerHTML = `<option value="">${defaultLabel}</option>` +
      sorted.map(v => `<option value="${v}">${v}</option>`).join("");
  };

  MapCore.updateActiveFiltersSummary = function (parts) {
    const group = document.getElementById("map-active-filter-group");
    const label = document.getElementById("map-active-filter-label");
    if (!group || !label) return;

    if (parts && parts.length) {
      label.textContent = parts.join(" · ");
      group.style.display = "flex";
    } else {
      group.style.display = "none";
    }
  };

  // Resets every filter back to its default (full date range, no area/
  // building-type/damage-level filter). extraSelectIds lets each page pass
  // its own area select id(s) ("map-oblast-select", or both oblast+raion
  // on the Raion page) without MapCore hardcoding page-specific ids.
  MapCore.resetAllFilters = function (extraSelectIds) {
    const fromEl = document.getElementById("map-date-from");
    const toEl = document.getElementById("map-date-to");
    if (fromEl && MapCore.minDataDate) fromEl.value = MapCore.minDataDate.toISOString().slice(0, 10);
    if (toEl && MapCore.maxDataDate) toEl.value = MapCore.maxDataDate.toISOString().slice(0, 10);

    ["map-infra-select", "map-extent-select", ...(extraSelectIds || [])].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });

    MapCore.onRerender();
  };
  window.resetAllFilters = MapCore.resetAllFilters;

  // Small file-download helper shared by every export button (map PNG,
  // per-chart PNG/SVG, summary-table CSV/XLSX).
  MapCore.downloadUrl = function (url, filename, revoke) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // --------------------------------------------------------------------
  // Date-range controls / bucket engine
  // --------------------------------------------------------------------
  // Populates the #map-date-from/#map-date-to inputs' min/max/default
  // value from whatever date range actually exists in the CSV, defaulting
  // to the full range (the "no filter" starting point).
  MapCore.initDateRangeControls = function (rawDamageCSV) {
    MapCore.calculateDataDateRange(rawDamageCSV);
    const fromEl = document.getElementById("map-date-from");
    const toEl = document.getElementById("map-date-to");
    if (!fromEl || !toEl || !MapCore.minDataDate || !MapCore.maxDataDate) return;

    const iso = d => d.toISOString().slice(0, 10);
    fromEl.min = toEl.min = iso(MapCore.minDataDate);
    fromEl.max = toEl.max = iso(MapCore.maxDataDate);
    fromEl.value = iso(MapCore.minDataDate);
    toEl.value = iso(MapCore.maxDataDate);

    MapCore.onRerender();
  };

  // Builds the ordered list of date buckets covering [fromISO, toISO]
  // (inclusive of the whole "to" day) at the given granularity - "1"/"7"/
  // "14" for a fixed day-step, or "monthly" for real calendar months, so a
  // range can read "Jul 2026, Aug 2026, ..." across a year boundary
  // instead of resetting to January. All arithmetic is done on UTC
  // timestamps (Date.parse(iso + "T00:00:00Z") / Date.UTC(...)) throughout
  // - never mixing in a locally-constructed `new Date(y, m, d)` - so bucket
  // boundaries can't drift by a day depending on the browser's timezone.
  // Single-letter month initials (J F M A M J J A S O N D) for the
  // timeline's monthly-granularity axis, per the agreed compact style -
  // the year (shown on its own row, see below) is what actually
  // disambiguates repeated letters across a multi-year range.
  const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

  MapCore.buildDateBuckets = function (fromISO, toISO, granularity) {
    const fromMs = Date.parse(fromISO + "T00:00:00Z");
    const toMsExclusive = Date.parse(toISO + "T00:00:00Z") + 86400000; // "to" day is inclusive
    const order = [];
    // Each value is [primaryLine, yearLine, tooltipLine] - primaryLine is
    // the compact axis text (blanked of its year, and reduced to a single
    // letter for monthly), yearLine is blank except on the one bucket
    // chosen to carry each calendar year, and tooltipLine is always a full,
    // unambiguous description (e.g. "June 2026") independent of both -
    // read on hover, where a bare "J" would be ambiguous between January/
    // June/July.
    const labelsByKey = {};
    const bucketRangeByKey = {};

    const fmtDay = ms => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

    if (granularity === "monthly") {
      let cursor = Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), 1);
      while (cursor < toMsExclusive) {
        const y = new Date(cursor).getUTCFullYear();
        const m = new Date(cursor).getUTCMonth();
        const key = `${y}-${String(m + 1).padStart(2, "0")}`;
        const monthStartMs = Date.UTC(y, m, 1);
        const monthEndMs = Date.UTC(y, m + 1, 0);
        order.push(key);
        const fullLabel = new Date(monthStartMs).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
        labelsByKey[key] = [MONTH_INITIALS[m], String(y), fullLabel];
        bucketRangeByKey[key] = {
          startISO: new Date(monthStartMs).toISOString().slice(0, 10),
          endISO: new Date(monthEndMs).toISOString().slice(0, 10)
        };
        cursor = Date.UTC(y, m + 1, 1);
      }
    } else {
      const stepDays = parseInt(granularity, 10);
      const stepMs = stepDays * 86400000;
      let bucketStartMs = fromMs;
      while (bucketStartMs < toMsExclusive) {
        const bucketEndExclusiveMs = Math.min(bucketStartMs + stepMs, toMsExclusive);
        const key = new Date(bucketStartMs).toISOString().slice(0, 10);
        const endMs = bucketEndExclusiveMs - 86400000;
        order.push(key);
        // The year always renders on its own second row (see
        // renderTimelineBarChart / buildColumnChartSVG), even for a bucket
        // that straddles a year boundary (e.g. 27 Dec - 2 Jan) - in that
        // rare case the bucket's start year is shown, matching how the
        // bucket itself is keyed/labelled by its start date everywhere else.
        const primary = stepDays === 1 ? fmtDay(bucketStartMs) : `${fmtDay(bucketStartMs)} – ${fmtDay(endMs)}`;
        const yearStr = String(new Date(bucketStartMs).getUTCFullYear());
        labelsByKey[key] = [primary, yearStr, `${primary}, ${yearStr}`];
        bucketRangeByKey[key] = { startISO: key, endISO: new Date(endMs).toISOString().slice(0, 10) };
        bucketStartMs = bucketEndExclusiveMs;
      }
    }

    const keyForTimestamp = rowMs => {
      if (rowMs === null || isNaN(rowMs) || rowMs < fromMs || rowMs >= toMsExclusive) return null;
      if (granularity === "monthly") {
        const d = new Date(rowMs);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      }
      const stepMs = parseInt(granularity, 10) * 86400000;
      const bucketStartMs = fromMs + Math.floor((rowMs - fromMs) / stepMs) * stepMs;
      return new Date(bucketStartMs).toISOString().slice(0, 10);
    };

    // One year label per year, not one per bucket: blank out every
    // bucket's year line except the one nearest the middle of that year's
    // run of buckets, so the year reads once, roughly centered under its
    // own group of bars, instead of repeating under every single bar.
    const indicesByYear = {};
    order.forEach((key, i) => {
      const yr = labelsByKey[key][1];
      (indicesByYear[yr] = indicesByYear[yr] || []).push(i);
    });
    Object.values(indicesByYear).forEach(indices => {
      const centerIdx = indices[Math.floor((indices.length - 1) / 2)];
      indices.forEach(i => {
        if (i !== centerIdx) labelsByKey[order[i]][1] = "";
      });
    });

    return { order, labelsByKey, bucketRangeByKey, keyForTimestamp };
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
      // draw text on top of each other. Generous on purpose - this is the
      // main defence against a cluttered-looking label stack.
      const LINE_HEIGHT = 22;
      // Slices whose mid-angles are this close together (e.g. several tiny
      // slivers bunched at the seam where the ring wraps back to its
      // start) keep whichever side the previous one landed on, rather than
      // being independently split left/right by a hair's-width angle
      // difference - that's what previously sent their leader lines
      // criss-crossing each other and the ring itself.
      const SAME_SIDE_ANGLE_THRESHOLD = 8 * (Math.PI / 180);
      // How far outside the ring a label's line bends toward its text.
      const ELBOW_OFFSET = 28;
      // A slice whose mid-angle sits this close to due-up/due-down has
      // barely any geometric lean toward either side, so it's free to
      // settle on whichever side is less crowded rather than being stuck
      // with whatever the cosine's sign happens to be.
      const NEAR_POLE_COS = 0.05;

      const leftEntries = [];
      const rightEntries = [];
      let lastMidAngle = null;
      let lastIsRight = null;

      meta.data.forEach((arc, i) => {
        const value = dataset.data[i];
        if (!value) return;

        const { x, y, startAngle, endAngle, outerRadius } =
          arc.getProps(["x", "y", "startAngle", "endAngle", "outerRadius"], true);
        const midAngle = (startAngle + endAngle) / 2;
        let isRight = Math.cos(midAngle) >= 0;
        if (lastMidAngle !== null && Math.abs(midAngle - lastMidAngle) < SAME_SIDE_ANGLE_THRESHOLD) {
          isRight = lastIsRight;
        }
        lastMidAngle = midAngle;
        lastIsRight = isRight;

        const text = `${chart.data.labels[i]}: ${value.toLocaleString()}`;
        const textWidth = measureLabelWidth(ctx, text, 11);
        // The ring departure point always stays at the slice's own true
        // angle - nudging it toward a neighbour (as an earlier version
        // did, to fan out tightly clustered slivers) could flip which
        // side of the ring it geometrically sits on, sending its leader
        // line back across the chart to reach a label anchored on the
        // opposite side.
        const entry = { x, y, outerRadius, midAngle, text, textWidth, isRight };
        (isRight ? rightEntries : leftEntries).push(entry);
      });

      // A near-pole entry can just as validly anchor its label on the
      // other side; move it there when that side has meaningfully fewer
      // labels stacked already, since that's what actually relieves
      // crowding rather than an angle nudge that only shifts where the
      // line leaves the ring by a pixel or two. Where several entries
      // qualify, the one closest to true up/down (smallest |cos|) moves
      // first - it has the least geometric preference for either side, so
      // it's the one that should give way.
      function rebalanceNearPole(from, to) {
        const candidates = from
          .filter(e => Math.abs(Math.cos(e.midAngle)) < NEAR_POLE_COS)
          .sort((a, b) => Math.abs(Math.cos(a.midAngle)) - Math.abs(Math.cos(b.midAngle)));
        for (const e of candidates) {
          if (to.length < from.length - 1) {
            from.splice(from.indexOf(e), 1);
            e.isRight = !e.isRight;
            to.push(e);
          }
        }
      }
      rebalanceNearPole(leftEntries, rightEntries);
      rebalanceNearPole(rightEntries, leftEntries);

      // Derives each label's line-start (on the ring) and elbow point (a
      // short way further out) from its true departure angle. The elbow's
      // height doubles as the label's natural, pre-declutter textY.
      function computeGeometry(entries) {
        entries.forEach(e => {
          const cos = Math.cos(e.midAngle);
          const sin = Math.sin(e.midAngle);
          e.lineStart = { x: e.x + cos * (e.outerRadius + 4), y: e.y + sin * (e.outerRadius + 4) };
          e.elbowX = e.x + cos * (e.outerRadius + ELBOW_OFFSET);
          e.elbowY = e.y + sin * (e.outerRadius + ELBOW_OFFSET);
          e.textY = e.elbowY;
        });
      }
      computeGeometry(leftEntries);
      computeGeometry(rightEntries);

      const leftLabels = leftEntries;
      const rightLabels = rightEntries;

      // Within each side, walk top-to-bottom and push any label that's too
      // close to the one above it further down. If that runs the stack past
      // the bottom of the chart, walk back up compressing gaps instead, so
      // the whole stack stays on screen. Mirrored at the top edge too - a
      // cluster of small slivers near 12 o'clock (e.g. Destroyed/Unknown/
      // Unspecified against a dominant Partially damaged slice) otherwise
      // has nothing pulling its topmost label back into frame, which is
      // what let it get cut off above the chart. If the column still can't
      // fit even after both clamps, give up on strict LINE_HEIGHT spacing
      // and distribute it evenly across the available range instead of
      // letting anything clip or overlap.
      function declutter(list, minY, maxY) {
        list.sort((a, b) => a.textY - b.textY);

        for (let i = 1; i < list.length; i++) {
          if (list[i].textY - list[i - 1].textY < LINE_HEIGHT) {
            list[i].textY = list[i - 1].textY + LINE_HEIGHT;
          }
        }

        if (list.length && list[list.length - 1].textY > maxY) {
          list[list.length - 1].textY = maxY;
          for (let i = list.length - 2; i >= 0; i--) {
            if (list[i + 1].textY - list[i].textY < LINE_HEIGHT) {
              list[i].textY = list[i + 1].textY - LINE_HEIGHT;
            }
          }
        }

        if (list.length && list[0].textY < minY) {
          list[0].textY = minY;
          for (let i = 1; i < list.length; i++) {
            if (list[i].textY - list[i - 1].textY < LINE_HEIGHT) {
              list[i].textY = list[i - 1].textY + LINE_HEIGHT;
            }
          }
        }

        if (list.length > 1 && list[list.length - 1].textY > maxY) {
          const step = (maxY - minY) / (list.length - 1);
          list.forEach((entry, i) => { entry.textY = minY + i * step; });
        }
      }

      // Bounds are canvas-relative, not chartArea-relative: outerRadius
      // fills chartArea edge-to-edge in its limiting dimension, so the ring
      // itself already touches chartArea.top/bottom. The actual free space
      // for stacked labels is the layout.padding band between chartArea and
      // the canvas edge - clamping to chartArea would push labels back onto
      // the ring instead of into that padding band. A 10px buffer keeps
      // labels from ever touching the canvas edge itself.
      const EDGE_BUFFER = 10;
      const minY = EDGE_BUFFER;
      const maxY = chart.height - EDGE_BUFFER;
      declutter(leftLabels, minY, maxY);
      declutter(rightLabels, minY, maxY);

      // Gap between the elbow point and the text, and how close text may
      // come to the canvas edge before its reach gets pulled back in -
      // this is what stops a label (especially a near-vertical sliver
      // whose elbow sits close to the ring's own left/right edge) from
      // running its text off the side of the canvas.
      const TEXT_GAP = 16;

      [...leftLabels, ...rightLabels].forEach(({ lineStart, elbowX, elbowY, textY, text, textWidth, isRight }) => {
        // Text normally reaches TEXT_GAP past the elbow and extends away
        // from the ring by its own width. If that would run past the
        // canvas edge, pull the near edge back in just enough to fit.
        const nearEdge = isRight
          ? Math.min(elbowX + TEXT_GAP, chart.width - EDGE_BUFFER - textWidth)
          : Math.max(elbowX - TEXT_GAP, EDGE_BUFFER + textWidth);
        const textX = nearEdge;

        ctx.strokeStyle = "#999";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lineStart.x, lineStart.y);
        // First leg leaves the ring at the slice's own (possibly spread)
        // angle; second leg runs to the text. When declutter/the edge
        // clamp didn't need to move this label, elbowY === textY and
        // elbowX is within TEXT_GAP of nearEdge, so the second leg is a
        // short, barely-there continuation - no visible kink. Only labels
        // that actually needed repositioning show a real bend.
        ctx.lineTo(elbowX, elbowY);
        ctx.lineTo(nearEdge + (isRight ? -4 : 4), textY);
        ctx.stroke();

        ctx.fillStyle = "#333";
        ctx.textAlign = isRight ? "left" : "right";
        ctx.fillText(text, textX, textY);
      });

      ctx.restore();
    }
  };

  function renderBarChart(canvasId, existingInstance, labels, data, selectedValue, onClickLabel) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return existingInstance;

    const backgroundColor = labels.map(l =>
      (selectedValue && l === selectedValue) ? FILTER_HIGHLIGHT_COLOR : CHART_PALETTE[0]
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
          if (!elements.length || !onClickLabel) return;
          const label = chart.data.labels[elements[0].index];
          if (!MapCore.isFilterableLabel(label)) return;
          onClickLabel(label, elements[0].index);
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? "pointer" : "default";
        }
      }
    });
  }

  function renderDoughnutChart(canvasId, existingInstance, labels, data, selectedValue, onClickLabel) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return existingInstance;

    const borderWidth = labels.map(l => (selectedValue && l === selectedValue) ? 4 : 0);

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
        // drawn by outsideDoughnutLabelsPlugin. Widened further than the
        // labels alone strictly need, since staggering same-side leader
        // lines' elbow radius (to fan out clustered slivers) pushes the
        // outermost ones further out than a single fixed radius would.
        layout: { padding: { top: 48, bottom: 48, left: 100, right: 100 } },
        // The legend is dropped in favour of the outside labels, which
        // already carry the category name and value.
        plugins: { legend: { display: false }, datalabels: { display: false } },
        onClick: (evt, elements, chart) => {
          if (!elements.length || !onClickLabel) return;
          const label = chart.data.labels[elements[0].index];
          if (!MapCore.isFilterableLabel(label)) return;
          onClickLabel(label, elements[0].index);
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? "pointer" : "default";
        }
      }
    });
  }

  // Timeline bucket labels are either a plain string or a 2-element
  // [primaryLine, yearLine] array (MapCore.buildDateBuckets always uses the
  // latter - one non-empty yearLine per calendar year, blank everywhere
  // else). Both renderers (this one and buildColumnChartSVG) treat the
  // year row as fully independent of whichever primary labels end up
  // visually thinned/skipped for space - so the year is never silently
  // dropped just because autoSkip (or the SVG's own thinning step) didn't
  // happen to land on that particular bucket's index.
  function timelinePrimaryLine(label) {
    return Array.isArray(label) ? label[0] : label;
  }
  function timelineYearLine(label) {
    return Array.isArray(label) ? label[1] : null;
  }
  function timelineTooltipLine(label) {
    return Array.isArray(label) ? (label[2] || label[0]) : label;
  }

  // Draws each bucket's year (where present) at its own x position,
  // entirely independent of the x-axis's own tick/autoSkip decisions -
  // registered as a per-chart plugin so it participates in the normal
  // draw cycle (and therefore redraws automatically on every .update()).
  const timelineYearRowPlugin = {
    id: "timelineYearRow",
    afterDraw(chart) {
      const xScale = chart.scales.x;
      const labels = chart.data.labels;
      if (!xScale || !labels) return;
      const { ctx } = chart;
      ctx.save();
      ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = "#666";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      labels.forEach((label, i) => {
        const year = timelineYearLine(label);
        if (!year) return;
        const x = xScale.getPixelForValue(i);
        ctx.fillText(year, x, xScale.bottom + 2);
      });
      ctx.restore();
    }
  };

  function renderTimelineBarChart(canvasId, existingInstance, labels, data, onClickIndex) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return existingInstance;

    // The timeline has no "selected bucket" concept to highlight - clicking
    // a bar narrows the date range itself, so every other bar disappears on
    // the next render rather than staying visible-but-highlighted.
    const backgroundColor = labels.map(() => CHART_PALETTE[0]);
    // Monthly-granularity primary labels are single letters (J F M A M J J
    // A S O N D) - narrow enough to always show in full, so autoSkip is
    // only left on for the longer date-range labels the other
    // granularities use, where thinning is genuinely needed to avoid
    // overlap.
    const showAllPrimaryLabels = labels.every(l => timelinePrimaryLine(l).length <= 2);

    if (existingInstance) {
      existingInstance.data.labels = labels;
      existingInstance.data.datasets[0].data = data;
      existingInstance.data.datasets[0].backgroundColor = backgroundColor;
      existingInstance.options.scales.x.ticks.autoSkip = !showAllPrimaryLabels;
      existingInstance.update();
      return existingInstance;
    }

    return new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{ data, backgroundColor, borderRadius: 4 }]
      },
      plugins: [timelineYearRowPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Extra bottom room for the year row the plugin above draws below
        // the x-axis's own tick labels.
        layout: { padding: { top: 26, bottom: 14 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              // Reads straight from the live chart's own current data
              // (context[0].chart.data.labels), never a closed-over
              // `labels` reference from whenever this chart was first
              // created - the whole point being that a persisted Chart.js
              // instance's data changes on every re-render (see the
              // existingInstance branch below) but a plain closure
              // variable captured at creation time would not, which is
              // exactly what silently desynced this chart's tooltip/axis
              // from its own bars after a date-range or granularity change.
              // Always the full "Month Year" / "1 Jun – 7 Jun, 2026" form,
              // never the bare single-letter axis abbreviation, which is
              // ambiguous in isolation (e.g. "J" alone could be Jan/Jun/Jul).
              title: (items) => {
                if (!items.length) return "";
                const lbl = items[0].chart.data.labels[items[0].dataIndex];
                return timelineTooltipLine(lbl);
              }
            }
          },
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
          x: {
            grid: { drawOnChartArea: false, drawTicks: true },
            ticks: {
              autoSkip: !showAllPrimaryLabels,
              // Ticks render the primary line only - the year is drawn
              // separately by timelineYearRowPlugin, decoupled from
              // whichever ticks autoSkip decides to keep.
              //
              // A plain (non-arrow) function, deliberately: Chart.js calls
              // tick callbacks with `this` bound to the scale, which has
              // `this.chart` - reading the label from there (the chart's
              // own *current* data) rather than closing over the `labels`
              // parameter above is what makes this keep working correctly
              // after a re-render. This callback function itself is only
              // ever created once (here, the first time this canvas's
              // chart is built); every later filter change goes through
              // the `existingInstance` branch below, which updates
              // `data.labels` in place but never recreates this callback -
              // so a closure over the original `labels` array would keep
              // reading further and further out-of-date buckets forever,
              // while the bars themselves (and the tooltip, fixed the same
              // way above) moved on to the current data.
              callback: function (value, index) {
                return timelinePrimaryLine(this.chart.data.labels[index]);
              }
            }
          },
          // Value axis removed - each column now carries its own label.
          y: { display: false, beginAtZero: true, grace: "18%" }
        },
        onClick: (evt, elements, chart) => {
          if (!elements.length || !onClickIndex) return;
          onClickIndex(elements[0].index);
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? "pointer" : "default";
        }
      }
    });
  }

  // Renders/updates all four summary charts from one call, and returns the
  // exact series each was drawn with, so the PDF report (and the on-page
  // per-chart SVG export buttons) can rebuild identical vector charts
  // without re-deriving the Top-N / "Other" bucketing / sort order logic a
  // second time.
  //
  //   entityKey - 'topOblasts' | 'topRaions', the key name the PDF report
  //               generator (and the exports) expect in the returned object
  //   entitySelectedValue/infraSelectedValue/extentSelectedValue - the
  //               current value of the corresponding <select>, so the
  //               matching bar/slice can be highlighted
  //   onEntityClick/onInfraClick/onExtentClick - (label) => void, called on
  //               a bar/slice click; onTimelineClick - (index) => void
  MapCore.buildSummaryCharts = function ({
    entityCounts, entityKey, entitySelectedValue, onEntityClick,
    infraCounts, infraSelectedValue, onInfraClick,
    extentCounts, extentSelectedValue, onExtentClick,
    timelineLabels, timelineValues, onTimelineClick
  }) {
    if (typeof Chart === "undefined") return null;

    const topEntity = Object.entries(entityCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    MapCore.chartInstances.entity = renderBarChart(
      "map-top-oblasts-chart", MapCore.chartInstances.entity,
      topEntity.map(e => e[0]), topEntity.map(e => e[1]), entitySelectedValue, onEntityClick
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
    MapCore.chartInstances.infra = renderBarChart(
      "map-infra-type-chart", MapCore.chartInstances.infra,
      infraLabels, infraValues, infraSelectedValue, onInfraClick
    );

    const extentEntries = Object.entries(extentCounts).sort((a, b) => b[1] - a[1]);
    MapCore.chartInstances.extent = renderDoughnutChart(
      "map-extent-chart", MapCore.chartInstances.extent,
      extentEntries.map(e => e[0]), extentEntries.map(e => e[1]), extentSelectedValue, onExtentClick
    );

    MapCore.chartInstances.timeline = renderTimelineBarChart(
      "map-timeline-chart", MapCore.chartInstances.timeline,
      timelineLabels, timelineValues, onTimelineClick
    );

    return {
      [entityKey]: { labels: topEntity.map(e => e[0]), values: topEntity.map(e => e[1]) },
      infra: { labels: infraLabels, values: infraValues },
      extent: { labels: extentEntries.map(e => e[0]), values: extentEntries.map(e => e[1]) },
      timeline: { labels: timelineLabels, values: timelineValues }
    };
  };

  // --------------------------------------------------------------------
  // Summary table
  // --------------------------------------------------------------------
  // Renders the area x damage-level matrix built by each page's
  // processMapVisualisations() into a plain HTML table. Shared since the
  // layout is identical between the two pages - only areaLabel differs.
  MapCore.renderSummaryTable = function (containerId, { areaLabel, rows, columns }) {
    const el = document.getElementById(containerId);
    if (!el) return;

    if (!rows.length) {
      el.innerHTML = "<p>No data for the current filters.</p>";
      return;
    }

    const thead = `<thead><tr><th>${areaLabel}</th>${columns.map(c => `<th>${c}</th>`).join("")}<th>Total</th></tr></thead>`;
    const tbody = rows.map(r => {
      const cells = columns.map(c => `<td>${(r.cols[c] || 0).toLocaleString()}</td>`).join("");
      return `<tr><td>${r.area}</td>${cells}<td class="total-col">${r.total.toLocaleString()}</td></tr>`;
    }).join("");

    el.innerHTML = `<table class="map-summary-table">${thead}<tbody>${tbody}</tbody></table>`;
  };

  window.MapCore = MapCore;
})();