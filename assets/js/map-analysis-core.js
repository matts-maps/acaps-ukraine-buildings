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
     const breaks = MapCore.computeDynamicBreaks(counts);
     MapCore.updateLegend(breaks);
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

  // 5 colour groups for values of 1 and above. A value of exactly 0 is
  // handled separately and always renders as plain white.
  const THEMATIC_COLORS = ["#fee6ce", "#fdd0a2", "#fdae6b", "#f16913", "#d94801"];
  const ZERO_COLOR = "#ffffff";

  const monthsList = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const MapCore = {
    CHART_PALETTE,
    FILTER_HIGHLIGHT_COLOR,
    THEMATIC_COLORS,
    ZERO_COLOR,
    monthsList,
    activeFilter: null, // { dimension: string, value: string | number } | null
    mapInstance: null,
    dimensionLabels: {},
    onRerender: function () {},
    chartInstances: { entity: null, infra: null, extent: null, timeline: null },
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

  MapCore.initMapElement = function (infoPanelTitle) {
    // Start on a reasonable default view; this gets replaced by fitBounds()
    // once the boundary geoJSON has loaded.
    const instance = L.map("map-container", { zoomSnap: 0.5 }).setView([48.3794, 31.1656], 6);
    window.__leafletMap = instance;
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap", maxZoom: 20
    }).addTo(instance);

    // UI: Info Panel
    window.mapInfoPanel = L.control({ position: "topright" });
    window.mapInfoPanel.onAdd = function () {
      this._div = L.DomUtil.create("div", "map-info-panel");
      this._div.innerHTML = `<h4>${infoPanelTitle}</h4>Hover over an administrative region`;
      return this._div;
    };
    window.mapInfoPanel.addTo(instance);

    // UI: Legend (populated/refreshed dynamically by MapCore.updateLegend())
    window.mapLegend = L.control({ position: "bottomleft" });
    window.mapLegend.onAdd = function () {
      this._div = L.DomUtil.create("div", "map-legend");
      this._div.innerHTML = "<strong>Damage Scale</strong><br>Loading&hellip;";
      return this._div;
    };
    window.mapLegend.addTo(instance);

    MapCore.mapInstance = instance;
    return instance;
  };

  // --------------------------------------------------------------------
  // Legend / colour scale
  // --------------------------------------------------------------------
  // Computes 5 ascending thematic breakpoints (covering values of 1 and
  // above) from whatever data is currently on screen, so the legend/colour
  // scale adapts to the selected period instead of using a fixed scale.
  // A value of 0 is always white and isn't part of this scale.
  MapCore.computeDynamicBreaks = function (counts) {
    const values = Object.values(counts).filter(v => v > 0);
    const max = values.length ? Math.max(...values) : 0;

    if (max <= 4) {
      // Small counts: keep the scale simple and integer-based.
      return [0, 1, 2, 3, 4];
    }

    const proportions = [0.15, 0.35, 0.65, 1];
    const breaks = [0];
    proportions.forEach(p => {
      let v = MapCore.roundNice(max * p);
      if (v <= breaks[breaks.length - 1]) v = breaks[breaks.length - 1] + 1;
      breaks.push(v);
    });
    return breaks; // [0, g1, g2, g3, g4] - 5 elements, 5 colour groups
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

  MapCore.getThematicColor = function (val, breaks) {
    if (val <= 0) return ZERO_COLOR;
    const grades = breaks || [0, 50, 200, 500, 1000];
    return val > grades[4] ? THEMATIC_COLORS[4]
      : val > grades[3] ? THEMATIC_COLORS[3]
      : val > grades[2] ? THEMATIC_COLORS[2]
      : val > grades[1] ? THEMATIC_COLORS[1]
      : THEMATIC_COLORS[0];
  };

  MapCore.updateLegend = function (breaks) {
    if (!window.mapLegend || !window.mapLegend._div) return;
    let html = "<strong>Damage Scale</strong><br>";
    html += '<i style="background:' + ZERO_COLOR + '; border:1px solid #ccc;"></i> 0<br>';
    for (let i = 0; i < THEMATIC_COLORS.length; i++) {
      const lower = breaks[i] + 1;
      const upper = breaks[i + 1];
      html += '<i style="background:' + THEMATIC_COLORS[i] + '"></i> ' +
        lower + (upper !== undefined ? "&ndash;" + upper : "+") + "<br>";
    }
    window.mapLegend._div.innerHTML = html;
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
    MapCore.buildMapPeriodDropdowns();
  };

  MapCore.buildMapPeriodDropdowns = function () {
    const aggType = document.getElementById("map-aggregation-select").value;
    const startSel = document.getElementById("map-period-start-select");
    const endSel = document.getElementById("map-period-end-select");
    if (!startSel || !endSel) return;

    const options = aggType === "30"
      ? monthsList.map((m, i) => `<option value="${i}">${m}</option>`).join("")
      : Array.from({ length: Math.ceil(365 / aggType) }, (_, i) => `<option value="${i}">${aggType == 7 ? "Week" : "Fortnight"} ${i + 1}</option>`).join("");

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
