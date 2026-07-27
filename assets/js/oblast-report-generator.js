/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" config for oblast_analysis.html
   ============================================================================

   Shared PDF-building logic lives in report-generator-core.js (loaded before
   this file, see its own header for the full INSTALL notes). This file only
   supplies the handful of labels/keys that make the Oblast report differ
   from the Raion one.
   ========================================================================== */

(function () {
  "use strict";

  window.EPACCReportGenerator.init({
    entityFilterKey: "oblastFilter",
    entitySelectId: "map-oblast-select",
    entityCountsKey: "oblastCounts",
    entitySeriesKey: "topOblasts",
    entityChartLabel: "Top Oblasts by Reported Damage",
    reportSubtitle: "Oblast Damage Analysis Report",
    mapImageHeading: "Damage Buildings per Oblast",
    filenamePrefix: "EPACC_Oblast_Report",

    buildSummaryLeftLines(state) {
      return [
        `Oblast coverage: ${state.oblastLabel}`,
        `Building type filter: ${state.infraFilter || "Total"}`,
        `Damage level filter: ${state.extentFilter || "All"}`,
        `Affected Oblasts: ${Object.keys(state.oblastCounts).length}`
      ];
    },

    getExtraStateFromHook(state) {
      return { oblastLabel: state.oblastFilter || "All Oblasts" };
    },

    getExtraStateFallback() {
      const oblastEl = document.getElementById("map-oblast-select");
      return { oblastLabel: oblastEl && oblastEl.value ? oblastEl.value : "All Oblasts" };
    },
  });
})();
