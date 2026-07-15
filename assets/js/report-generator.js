/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" for raion_analysis.html
   ============================================================================

   INSTALL
   -------
   1. Add the hook in raion_analysis.js so window.__mapReportState is populated 
      with the real numbers behind the current view.

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
    charts: {
      timeline: { id: "map-timeline-chart", label: "Damage Timeline Over Selected Window" },
      topRaions: { id: "map-top-oblasts-chart", label: "Top Raions by Reported Damage" },
      infra: { id: "map-infra-type-chart", label: "Damage by Infrastructure Type" },
      extent: { id: "map-extent-chart", label: "Extent of Damage" }
    },
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

    // Fallback directly scraping the DOM
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
    return entries[0];
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
      console.error("html2canvas is not loaded.");
      return null;
    }
    try {
      const canvas = await html2canvas(mapEl, {
        useCORS: true,
        backgroundColor: "#ffffff",
        scale: 2,
        logging: false,
        onclone: (clonedDoc) => {
          // CSS-targeted UI removal for clean map exports
          const selectorsToHide = [
            ".leaflet-control-zoom", 
            ".map-info-panel", 
            ".leaflet-control-attribution"
          ];
          selectorsToHide.forEach(selector => {
            const element = clonedDoc.querySelector(selector);
            if (element) {
              element.style.setProperty("display", "none", "important");
            }
          });
        }
      });
      return canvas.toDataURL("image/png", 1.0);
    } catch (e) {
      console.error("Map capture failed due to CORS or rendering issues:", e);
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
        alert("jsPDF failed to load.");
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

      // Top brand accent header line (#1a3a5c)
      doc.setFillColor(26, 58, 92); 
      doc.rect(0, 0, pageWidth, 8, "F");
      y += 15;

      // Report Header
      doc.setFont("helvetica", "bold");
      doc.setFontSize(22);
      doc.setTextColor(26, 58, 92);
      doc.text("E-PACC Ukraine", margin, y);
      y += 22;

      doc.setFontSize(14);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(102, 102, 102); // #666
      doc.text("Raion Damage Analysis Report", margin, y);
      y += 25;

      // Meta Line
      doc.setFontSize(9);
      doc.setTextColor(136, 136, 136); // #888
      doc.text(`Period: ${formatPeriod(state)}`, margin, y);
      doc.text(`Generated: ${generatedAt}`, pageWidth - margin - 150, y);
      
      y += 12;
      doc.setDrawColor(224, 224, 224); 
      doc.setLineWidth(1);
      doc.line(margin, y, pageWidth - margin, y);
      y += 25;

      // --- SUMMARY STATISTICS (Dynamic Auto-Wrap Structure) ---
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(26, 58, 92);
      doc.text("Summary Statistics", margin, y);
      y += 12;

      const topRaion = topEntry(state.raionCounts);
      const topInfra = topEntry(state.infraCounts);
      const topExtent = topEntry(state.extentCounts);

      // Define columns & target text wraps
      const colWidth = (pageWidth - (margin * 2) - 40) / 2; 
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);

      const leftRaw = [
        `Oblast coverage: ${state.oblastLabel}`,
        `Raion coverage: ${state.raionLabel}`,
        `Affected Raions: ${Object.keys(state.raionCounts).length || "N/A"}`
      ];

      const rightRaw = [
        topRaion ? `Most affected: ${topRaion[0]} (${topRaion[1].toLocaleString()})` : "Most affected: N/A",
        topInfra ? `Top Infra category: ${topInfra[0]} (${topInfra[1].toLocaleString()})` : "Top Infra: N/A",
        topExtent ? `Top Damage Severity: ${topExtent[0]} (${topExtent[1].toLocaleString()})` : "Top Severity: N/A"
      ];

      // Convert raw texts to safe-wrapped line arrays
      const leftWrapped = leftRaw.map(str => doc.splitTextToSize(str, colWidth));
      const rightWrapped = rightRaw.map(str => doc.splitTextToSize(str, colWidth));

      // Compute dynamic box sizes based on line wrapping
      const getColHeight = (wrappedArray) => {
        return wrappedArray.reduce((acc, lines) => acc + (lines.length * 13) + 6, 0);
      };
      
      const leftColHeight = getColHeight(leftWrapped);
      const rightColHeight = getColHeight(rightWrapped);
      const contentHeight = Math.max(leftColHeight, rightColHeight);
      
      const statBoxHeight = contentHeight + 45; // Include padding for overall layout

      // Background summary panel block (#f0f4f8) with accent vertical border
      doc.setFillColor(240, 244, 248); 
      doc.roundedRect(margin, y, pageWidth - (margin * 2), statBoxHeight, 6, 6, "F");
      doc.setFillColor(26, 58, 92);
      doc.rect(margin, y, 4, statBoxHeight, "F");

      // Draw wrapped statistics text
      doc.setTextColor(68, 68, 68); // #444
      let currentLeftY = y + 20;
      leftWrapped.forEach(lines => {
        lines.forEach(line => {
          doc.text(line, margin + 20, currentLeftY);
          currentLeftY += 13;
        });
        currentLeftY += 6;
      });

      let currentRightY = y + 20;
      const rightColX = pageWidth / 2 + 10;
      rightWrapped.forEach(lines => {
        lines.forEach(line => {
          doc.text(line, rightColX, currentRightY);
          currentRightY += 13;
        });
        currentRightY += 6;
      });

      // Total count highlighted layout block at base
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(26, 58, 92);
      doc.text(`Total Buildings Impacted: ${state.nationalTotal}`, margin + 20, y + statBoxHeight - 15);

      y += statBoxHeight + 25;

      // --- MAP ATTACHMENT ---
      const mapEl = document.getElementById(IDS.mapContainer);
      const mapImg = await captureMap(mapEl);
      if (mapImg) {
        y = addImageWithHeading(
          doc,
          "Damage Buildings per Raion",
          mapImg,
          y,
          margin,
          pageWidth,
          pageHeight,
          pageWidth - margin * 2
        );
      } else {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(10);
        doc.setTextColor(192, 57, 43); // Error accent color #c0392b
        doc.text("(Map image unavailable - likely a basemap CORS issue)", margin, y);
        y += 25;
      }

      // --- WEB-ALIGNED GRID CHARTS ATTACHMENT ---
      // Page Break before Charts section to keep layouts clean and readable
      doc.addPage();
      y = margin + 15;

      // 1. Timeline (Full Width)
      const timelineCanvas = document.getElementById(IDS.charts.timeline.id);
      const timelineImg = await captureCanvas(timelineCanvas);
      if (timelineImg) {
        y = addImageWithHeading(
          doc,
          IDS.charts.timeline.label,
          timelineImg,
          y,
          margin,
          pageWidth,
          pageHeight,
          pageWidth - margin * 2 // Spans 100% of writable width
        );
      }

      // Grid System Constants for secondary charts (Side-by-Side)
      const gridGap = 16;
      const colChartWidth = (pageWidth - margin * 2 - gridGap) / 2;

      // 2. Top Raions & 3. Infra Type (Rendered side-by-side in grid row)
      const topRaionsCanvas = document.getElementById(IDS.charts.topRaions.id);
      const infraCanvas = document.getElementById(IDS.charts.infra.id);
      const topRaionsImg = await captureCanvas(topRaionsCanvas);
      const infraImg = await captureCanvas(infraCanvas);

      let rowYStart = y;
      let maxRowHeight = 0;

      if (topRaionsImg) {
        const nextY = addImageWithHeading(
          doc,
          IDS.charts.topRaions.label,
          topRaionsImg,
          rowYStart,
          margin,
          pageWidth,
          pageHeight,
          colChartWidth,
          margin // Left col alignment
        );
        maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
      }

      if (infraImg) {
        const nextY = addImageWithHeading(
          doc,
          IDS.charts.infra.label,
          infraImg,
          rowYStart,
          margin,
          pageWidth,
          pageHeight,
          colChartWidth,
          margin + colChartWidth + gridGap // Right col alignment
        );
        maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
      }

      // Advance layout baseline past the side-by-side row
      y = rowYStart + (maxRowHeight > 0 ? maxRowHeight : 0);

      // 4. Extent of Damage (Rendered half-width on its own row matching grid structure)
      const extentCanvas = document.getElementById(IDS.charts.extent.id);
      const extentImg = await captureCanvas(extentCanvas);
      if (extentImg) {
        y = addImageWithHeading(
          doc,
          IDS.charts.extent.label,
          extentImg,
          y,
          margin,
          pageWidth,
          pageHeight,
          colChartWidth,
          margin
        );
      }

      // --- FOOTER AND PAGE NUMBERING ---
      const pageCount = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(136, 136, 136); // #888
        doc.text(
          "E-PACC Ukraine Project - Created by MapAction and ACAPS. Data sourced from ACAPS.",
          margin,
          pageHeight - 20
        );
        doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin - 45, pageHeight - 20);
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

  // Helper utility styled to lay elements out without card borders (bounding boxes)
  function addImageWithHeading(doc, heading, imgDataUrl, y, margin, pageWidth, pageHeight, targetWidth, explicitX = null) {
    const xPos = explicitX !== null ? explicitX : margin;
    const props = doc.getImageProperties(imgDataUrl);
    const imgWidth = targetWidth;
    const imgHeight = (props.height * imgWidth) / props.width;

    // Page overflow checking before printing titles/images
    if (y + imgHeight + 40 > pageHeight - margin) {
      doc.addPage();
      y = margin + 15;
    }

    // Render Heading styled matching Web h2/h3 styles (#1a3a5c)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(26, 58, 92);
    doc.text(heading, xPos, y);
    y += 14;

    // Draw raw visual assets directly without bounding boxes
    doc.addImage(imgDataUrl, "PNG", xPos, y, imgWidth, imgHeight);
    return y + imgHeight + 30; // Returns calculated spacing placement
  }

  // --------------------------------------------------------------------
  // 4. Button Setup
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
        "report-generator.js: could not find '.map-hint' to attach the button near."
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();