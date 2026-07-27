/* ============================================================================
   Map/chart/table export buttons — shared by oblast_analysis.html and
   raion_analysis.html.
   ============================================================================
   None of this ever screenshots the DOM (and so never captures these very
   buttons, or anything else in #map-controls): the map PNG reuses
   MapPdfRenderer.renderMapCanvas() (already redraws the map from source
   data for the PDF export), and each chart's SVG is rebuilt from
   window.__mapReportState.chartSeries via the same ChartSVGBuilders
   functions the PDF report embeds - so the downloaded SVG and the PDF's
   chart are always identical.

   INSTALL: include after the page's own analysis script (oblast_analysis.js
   / raion_analysis.js), which is what populates window.__mapReportState and
   MapCore.chartInstances that everything here reads from.
   ========================================================================== */

(function () {
  "use strict";

  const CHART_LABELS = { timeline: "timeline", entity: "top-areas", infra: "building-type", extent: "damage-level" };

  function todayStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  // The "entity" chart's series is stashed under "topOblasts" or
  // "topRaions" depending on the page - whichever count object the current
  // page's __mapReportState actually populated tells us which.
  function entitySeriesKey(state) {
    return state.oblastCounts ? "topOblasts" : "topRaions";
  }

  function exportMapChart(chartKey, format) {
    const state = window.__mapReportState;
    if (!state) {
      alert("Data hasn't finished loading yet.");
      return;
    }

    const filenameBase = `epacc-${CHART_LABELS[chartKey] || chartKey}-${todayStamp()}`;

    if (format === "png") {
      const chartInstance = MapCore.chartInstances[chartKey];
      if (!chartInstance) {
        alert("Chart isn't ready yet.");
        return;
      }
      MapCore.downloadUrl(chartInstance.toBase64Image("image/png", 1.0), `${filenameBase}.png`);
      return;
    }

    if (format === "svg") {
      const series = state.chartSeries || {};
      const seriesKey = chartKey === "entity" ? entitySeriesKey(state) : chartKey;
      const s = series[seriesKey];
      if (!s || !s.labels.length) {
        alert("No data to export.");
        return;
      }

      let svgElement;
      if (chartKey === "timeline") {
        svgElement = ChartSVGBuilders.buildColumnChartSVG(s.labels, s.values, 960, 400);
      } else if (chartKey === "extent") {
        svgElement = ChartSVGBuilders.buildDonutSVG(s.labels, s.values, 700, 500, ChartSVGBuilders.CHART_PALETTE);
      } else {
        svgElement = ChartSVGBuilders.buildHorizontalBarSVG(s.labels, s.values, 700, 500);
      }

      const svgString = new XMLSerializer().serializeToString(svgElement);
      const blob = new Blob([svgString], { type: "image/svg+xml" });
      MapCore.downloadUrl(URL.createObjectURL(blob), `${filenameBase}.svg`, true);
    }
  }
  window.exportMapChart = exportMapChart;

  async function downloadMapPng() {
    if (typeof MapPdfRenderer === "undefined") {
      alert("Map renderer isn't loaded.");
      return;
    }
    const result = await MapPdfRenderer.renderMapCanvas(2);
    if (!result) {
      alert("Could not render the map.");
      return;
    }
    MapCore.downloadUrl(result.dataUrl, `epacc-map-${todayStamp()}.png`);
  }
  window.downloadMapPng = downloadMapPng;

  function csvCell(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  function exportSummaryTable(format) {
    const state = window.__mapReportState;
    const table = state && state.summaryTable;
    if (!table || !table.rows.length) {
      alert("No data to export.");
      return;
    }

    const filenameBase = `epacc-summary-${todayStamp()}`;
    const header = [table.areaLabel, ...table.columns, "Total"];
    const rows = table.rows.map(r => [r.area, ...table.columns.map(c => r.cols[c] || 0), r.total]);

    if (format === "csv") {
      const lines = [header, ...rows].map(row => row.map(csvCell).join(","));
      const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      MapCore.downloadUrl(URL.createObjectURL(blob), `${filenameBase}.csv`, true);
      return;
    }

    if (format === "xlsx") {
      if (typeof XLSX === "undefined") {
        alert("XLSX export library failed to load; try CSV instead.");
        return;
      }
      const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Summary");
      XLSX.writeFile(wb, `${filenameBase}.xlsx`);
    }
  }
  window.exportSummaryTable = exportSummaryTable;
})();
