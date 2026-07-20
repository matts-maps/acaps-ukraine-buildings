/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" config for raion_analysis.html
   ============================================================================
   All shared report-building logic lives in report-generator-core.js, which
   must be loaded before this file. This file only supplies the labels/keys
   that differ from the oblast view (see oblast-report-generator.js).
   ========================================================================== */

(function () {
  "use strict";

  window.EPACCReportGenerator.init({
    dimension: "raion",
    countsKey: "raionCounts",
    seriesKey: "topRaions",
    topChartLabel: "Most damaged Raions",
    reportTitleLine: "Raion Damage Analysis Report",
    mapHeading: "Damage Buildings per Raion",
    filenamePrefix: "Raion",

    getExtraStateFromHook(state) {
      return {
        oblastLabel: state.oblastFilter || "All Oblasts",
        raionLabel: state.raionFilter || "All Raions",
      };
    },

    getExtraStateFromDom() {
      const oblastEl = document.getElementById("map-oblast-select");
      const raionEl = document.getElementById("map-raion-select");
      return {
        oblastLabel: oblastEl && oblastEl.value ? oblastEl.value : "All Oblasts",
        raionLabel: raionEl && raionEl.value ? raionEl.value : "All Raions",
      };
    },

    buildLeftStats(state) {
      return [
        `Oblast coverage: ${state.oblastLabel}`,
        `Raion coverage: ${state.raionLabel}`,
        `Affected Raions: ${Object.keys(state.raionCounts).length || "N/A"}`
      ];
    },
  });
})();
