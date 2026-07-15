/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" for raion_analysis.html
   ============================================================================

   INSTALL
   -------
   1. Add the hook in raion_analysis.js (see the patch notes provided
      alongside this file) so window.__mapReportState is populated with the
      real numbers behind the current view.

   2. Add these two CDN libraries to raion_analysis.html, then this file,
      all AFTER the existing Leaflet / Chart.js / raion_analysis.js scripts:

        <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js" defer></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js" defer></script>
        <script src="{{ '/assets/js/report-generator.js' | relative_url }}" defer></script>

   3. The button is injected automatically into #map-controls, right after
      the ".map-hint" paragraph. No HTML edits required.
   ========================================================================== */

(function () {
  "use strict";

  const IDS = {
    mapContainer: "map-container",
    charts: [
      { id: "map-timeline-chart", label: "Damage Timeline Over Selected Window", dimension: "period" },
      { id: "map-top-oblasts-chart", label: "Top Raions by Reported Damage", dimension: "raion" },
      { id: "map-infra-type-chart", label: "Damage by Infrastructure Type", dimension: "infra" },
      { id: "map-extent-chart", label: "Extent of Damage", dimension: "extent" },
    ],
    yearSelect: "map-year-select",
    aggSelect: "map-aggregation-select",
    startSelect: "map-period-start-select",
    endSelect: "map-period-end-select",
    totalValue: "map-total-value",
    activeFilterGroup: "map-active-filter-group",
    activeFilterLabel: "map-active-filter-label",
  };

  const BUTTON_INSERT_AFTER_SELECTOR = ".map-hint";

  // --------------------------------------------------------------------
  // 1. Read current filter state - prefer the window.__mapReportState hook
  //    (real numbers), fall back to scraping visible DOM text if it's
  //    missing (e.g. before the patch to raion_analysis.js is applied).
  // --------------------------------------------------------------------
  function getReportState() {
    const state = window.__mapReportState;
    const yearEl = document.getElementById(IDS.yearSelect);
    const aggEl = document.getElementById(IDS.aggSelect);
    const startEl = document.getElementById(IDS.startSelect);
    const endEl = document.getElementById(IDS.endSelect);
    const totalEl = document.getElementById(IDS.totalValue);
    const filterGroup = document.getElementById(IDS.activeFilterGroup);
    const filterLabel = document.getElementById(IDS.activeFilterLabel);

    const activeFilterText =
      filterGroup && filterGroup.style.display !== "none" && filterLabel
        ? filterLabel.textContent.trim()
        : "None (national view)";

    const oblastEl = document.getElementById("map-oblast-select");
    const raionEl = document.getElementById("map-raion-select");

    if (state) {
      return {
        year: state.year,
        aggregationLabel: state.aggregationLabel,
        startLabel: state.startLabel,
        endLabel: state.endLabel,
        oblastLabel: state.oblastFilter || "All Oblasts",
        raionLabel: state.raionFilter || "All Raions",
        nationalTotal: state.nationalTotal.toLocaleString(),
        activeFilterText,
        raionCounts: state.raionCounts || {},
        infraCounts: state.infraCounts || {},
        extentCounts: state.extentCounts || {},
      };
    }

    // Fallback: scrape the DOM directly (fewer derived stats available)
    return {
      year: yearEl ? yearEl.value : "N/A",
      aggregationLabel: aggEl ? aggEl.options[aggEl.selectedIndex]?.text : "N/A",
      startLabel: startEl ? startEl.options[startEl.selectedIndex]?.text : "N/A",
      endLabel: endEl ? endEl.options[endEl.selectedIndex]?.text : "N/A",
      oblastLabel: oblastEl && oblastEl.value ? oblastEl.value : "All Oblasts",
      raionLabel: raionEl && raionEl.value ? raionEl.value : "All Raions",
      nationalTotal: totalEl ? totalEl.textContent.trim() : "0",
      activeFilterText,
      raionCounts: {},
      infraCounts: {},
      extentCounts: {},
    };
  }

  function formatPeriod(state) {
    const range =
      state.startLabel === state.endLabel
        ? state.startLabel
        : `${state.startLabel} to ${state.endLabel}`;
    return `${state.year} - ${state.aggregationLabel} - ${range}`;
  }

  function topEntry(counts) {
    const entries = Object.entries(counts || {});
    if (!entries.length) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0]; // [label, value]
  }

  // --------------------------------------------------------------------
  // 2. Capture helpers
  // --------------------------------------------------------------------
  async function captureCanvas(canvasEl) {
    if (!canvasEl) return null;
    try {
      return canvasEl.toDataURL("image/png", 1.0);
    } catch (e) {
      console.warn("Chart canvas capture failed:", e);
      return null;
    }
  }

  async function captureMap(mapEl) {
    if (!mapEl) return null;
    if (typeof html2canvas === "undefined") {
      console.error("html2canvas is not loaded - check the CDN script tag.");
      return null;
    }
    try {
      const canvas = await html2canvas(mapEl, {
        useCORS: true,
        backgroundColor: "#ffffff",
        scale: 2,
        logging: false,
      });
      return canvas.toDataURL("image/png", 1.0);
    } catch (e) {
      // Most likely cause: the basemap tile server didn't send CORS
      // headers, which taints the canvas and blocks toDataURL().
      console.error(
        "Map capture failed (likely a CORS-tainted canvas from the basemap tiles):",
        e
      );
      return null;
    }
  }

  // --------------------------------------------------------------------
  // 3. Build the PDF
  // --------------------------------------------------------------------
  async function generateReport() {
    const btn = document.getElementById("generate-report-btn");
    const originalLabel = btn ? btn.textContent : null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Generating report…";
    }

    try {
      if (typeof window.jspdf === "undefined") {
        alert("jsPDF failed to load. Check your network/CDN script tags.");
        return;
      }
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 40;
      let y = margin;

      const state = getReportState();
      const generatedAt = new Date().toLocaleString("en-GB", {
        dateStyle: "long",
        timeStyle: "short",
      });

      // Title
      doc.setFont("helvetica", "bold");
      doc.setFontSize(20);
      doc.text("E-PACC Ukraine - Raion Analysis Report", margin, y);
      y += 26;

      // Period covered
      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);
      doc.text(`Period covered: ${formatPeriod(state)}`, margin, y);
      y += 16;
      doc.text(`Report generated: ${generatedAt}`, margin, y);
      y += 24;

      // Summary statistics
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text("Summary Statistics", margin, y);
      y += 18;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      const topRaion = topEntry(state.raionCounts);
      const topInfra = topEntry(state.infraCounts);
      const topExtent = topEntry(state.extentCounts);
      const raionsAffected = Object.keys(state.raionCounts).length;

      const lines = [
        `Oblast coverage: ${state.oblastLabel}`,
        `Raion coverage: ${state.raionLabel}`,
       // `Active selection filter: ${state.activeFilterText}`,
        `Total damaged buildings: ${state.nationalTotal}`,
        `Raions with recorded damage: ${raionsAffected || "N/A"}`,
        topRaion ? `Most affected raion: ${topRaion[0]} (${topRaion[1].toLocaleString()})` : null,
        topInfra ? `Most reported damage infrastructure: ${topInfra[0]} (${topInfra[1].toLocaleString()})` : null,
        topExtent ? `Most common level of damage: ${topExtent[0]} (${topExtent[1].toLocaleString()})` : null,
      ].filter(Boolean);

      lines.forEach((line) => {
        doc.text(line, margin, y);
        y += 16;
      });
      y += 10;

      // Map
      const mapEl = document.getElementById(IDS.mapContainer);
      const mapImg = await captureMap(mapEl);
      if (mapImg) {
        y = addImageWithHeading(
          doc,
          "Damage buildings per Raion",
          mapImg,
          y,
          margin,
          pageWidth,
          pageHeight
        );
      } else {
        doc.text(
          "(Map image unavailable - see console for details, likely a basemap CORS issue)",
          margin,
          y
        );
        y += 20;
      }

      // Charts
      for (const chartDef of IDS.charts) {
        const canvasEl = document.getElementById(chartDef.id);
        const img = await captureCanvas(canvasEl);
        if (!img) {
          doc.addPage();
          y = margin;
          doc.setFontSize(11);
          doc.text(`(Chart "${chartDef.label}" could not be captured)`, margin, y);
          y += 20;
          continue;
        }
        y = addImageWithHeading(doc, chartDef.label, img, y, margin, pageWidth, pageHeight);
      }

      // Footer
      const pageCount = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(120);
        doc.text(
          "E-PACC Ukraine Project - Created by MapAction and ACAPS. Data sourced from ACAPS.",
          margin,
          pageHeight - 20
        );
        doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin - 60, pageHeight - 20);
      }

      const safeYear = String(state.year || "report").replace(/\s+/g, "_");
      doc.save(`EPACC_Raion_Report_${safeYear}.pdf`);
    } catch (err) {
      console.error("Report generation failed:", err);
      alert("Something went wrong generating the report. See console for details.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    }
  }

  function addImageWithHeading(doc, heading, imgDataUrl, y, margin, pageWidth, pageHeight) {
    const maxImgWidth = pageWidth - margin * 2;
    const props = doc.getImageProperties(imgDataUrl);
    let imgWidth = maxImgWidth;
    let imgHeight = (props.height * imgWidth) / props.width;

    const maxImgHeight = pageHeight - margin * 2 - 40;
    if (imgHeight > maxImgHeight) {
      imgHeight = maxImgHeight;
      imgWidth = (props.width * imgHeight) / props.height;
    }

    if (y + imgHeight + 30 > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(heading, margin, y);
    y += 14;

    doc.addImage(imgDataUrl, "PNG", margin, y, imgWidth, imgHeight);
    return y + imgHeight + 24;
  }

  // --------------------------------------------------------------------
  // 4. Button
  // --------------------------------------------------------------------
  function injectButton() {
    if (document.getElementById("generate-report-btn")) return;
    const anchor = document.querySelector(BUTTON_INSERT_AFTER_SELECTOR);
    if (!anchor) return;

    const btn = document.createElement("button");
    btn.id = "generate-report-btn";
    btn.type = "button";
    btn.textContent = "Generate PDF Report";
    btn.className = "map-report-btn";
    btn.style.cssText =
      "margin-top:12px;padding:10px 16px;background:#1a3a5c;color:#fff;" +
      "border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;width:100%;";
    btn.addEventListener("mouseenter", () => (btn.style.background = "#12283f"));
    btn.addEventListener("mouseleave", () => (btn.style.background = "#1a3a5c"));
    btn.addEventListener("click", generateReport);

    anchor.insertAdjacentElement("afterend", btn);
  }

  function init() {
    injectButton();
    if (!document.getElementById("generate-report-btn")) {
      console.warn(
        "report-generator.js: could not find '.map-hint' to attach the button near. " +
          "Add <button id=\"generate-report-btn\">Generate PDF Report</button> manually and it will still work."
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();