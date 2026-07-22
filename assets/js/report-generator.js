/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" config for raion_analysis.html
   ============================================================================

   Shared PDF-building logic lives in report-generator-core.js (loaded before
   this file, see its own header for the full INSTALL notes). This file only
   supplies the handful of labels/keys that make the Raion report differ
   from the Oblast one.
   ========================================================================== */

(function () {
  "use strict";

  window.EPACCReportGenerator.init({
    entityDimension: "raion",
    entityCountsKey: "raionCounts",
    entitySeriesKey: "topRaions",
    entityChartLabel: "Top Raions by Reported Damage",
    reportSubtitle: "Raion Damage Analysis Report",
    mapImageHeading: "Damage Buildings per Raion",
    filenamePrefix: "EPACC_Raion_Report",

    buildSummaryLeftLines(state) {
      return [
        `Oblast coverage: ${state.oblastLabel}`,
        `Raion coverage: ${state.raionLabel}`,
        `Affected Raions: ${Object.keys(state.raionCounts).length}`
      ];
    },

    getExtraStateFromHook(state) {
      return {
        oblastLabel: state.oblastFilter || "All Oblasts",
        raionLabel: state.raionFilter || "All Raions",
      };
    },

    getExtraStateFallback() {
      const oblastEl = document.getElementById("map-oblast-select");
      const raionEl = document.getElementById("map-raion-select");
      return {
        oblastLabel: oblastEl && oblastEl.value ? oblastEl.value : "All Oblasts",
        raionLabel: raionEl && raionEl.value ? raionEl.value : "All Raions",
      };
    },
  });
})();
