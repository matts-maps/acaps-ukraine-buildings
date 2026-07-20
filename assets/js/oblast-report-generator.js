/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" config for oblast_analysis.html
   ============================================================================
   All shared report-building logic lives in report-generator-core.js, which
   must be loaded before this file. This file only supplies the labels/keys
   that differ from the raion view (see report-generator.js).
   ========================================================================== */

(function () {
  "use strict";

  window.EPACCReportGenerator.init({
    dimension: "oblast",
    countsKey: "oblastCounts",
    seriesKey: "topOblasts",
    topChartLabel: "Top Oblasts by Reported Damage",
    reportTitleLine: "Oblast Damage Analysis Report",
    mapHeading: "Damage Buildings per Oblast",
    filenamePrefix: "Oblast",

    getExtraStateFromHook() {
      return {};
    },

    getExtraStateFromDom() {
      return {};
    },

    buildLeftStats(state) {
      return [
        `Active filter: ${state.activeFilterText}`,
        `Affected Oblasts: ${Object.keys(state.oblastCounts).length || "N/A"}`
      ];
    },
  });
})();
