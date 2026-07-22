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
    entityDimension: "oblast",
    entityCountsKey: "oblastCounts",
    entitySeriesKey: "topOblasts",
    entityChartLabel: "Top Oblasts by Reported Damage",
    reportSubtitle: "Oblast Damage Analysis Report",
    mapImageHeading: "Damage Buildings per Oblast",
    filenamePrefix: "EPACC_Oblast_Report",

    buildSummaryLeftLines(state) {
      return [
        `Active filter: ${state.activeFilterText}`,
        `Affected Oblasts: ${Object.keys(state.oblastCounts).length}`
      ];
    },

    getExtraStateFromHook() {
      return {};
    },

    getExtraStateFallback() {
      return {};
    },
  });
})();
