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
  // 3. Build the PDF (STYLED WITH RAION_ANALYSIS.CSS THEME)
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

      // --- BRAND HEADER BAND ---
      // Adds a top layout bar using the primary color #1a3a5c
      doc.setFillColor(26, 58, 92); 
      doc.rect(0, 0, pageWidth, 8, "F");
      y += 15;

      // Title (#1a3a5c primary color)
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

      // Metadata details line (#888)
      doc.setFontSize(9);
      doc.setTextColor(136, 136, 136); 
      doc.text(`Period: ${formatPeriod(state)}`, margin, y);
      doc.text(`Generated: ${generatedAt}`, pageWidth - margin - 150, y);
      
      y += 12;
      doc.setDrawColor(224, 224, 224); // Subtle horizontal rule
      doc.setLineWidth(1);
      doc.line(margin, y, pageWidth - margin, y);
      y += 25;

      // --- SUMMARY STATISTICS (Styled like .map-summary-box) ---
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(26, 58, 92);
      doc.text("Summary Statistics", margin, y);
      y += 12;

      // Background card block for statistics (using #f0f4f8 background)
      const statBoxHeight = 110;
      doc.setFillColor(240, 244, 248); 
      doc.roundedRect(margin, y, pageWidth - (margin * 2), statBoxHeight, 6, 6, "F");
      
      // Accent vertical bar on the left (matches border-left: 4px solid #1a3a5c)
      doc.setFillColor(26, 58, 92);
      doc.rect(margin, y, 4, statBoxHeight, "F");

      // Text elements inside the card styled matching #444 body text
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(68, 68, 68); 

      const leftColX = margin + 20;
      const rightColX = pageWidth / 2 + 10;
      let cardY = y + 22;

      // Left column values
      doc.text(`Oblast coverage: ${state.oblastLabel}`, leftColX, cardY);
      doc.text(`Raion coverage: ${state.raionLabel}`, leftColX, cardY + 18);
      doc.text(`Affected Raions: ${Object.keys(state.raionCounts).length || "N/A"}`, leftColX, cardY + 36);

      // Right column values
      const topRaion = topEntry(state.raionCounts);
      const topInfra = topEntry(state.infraCounts);
      const topExtent = topEntry(state.extentCounts);

      doc.text(topRaion ? `Most affected: ${topRaion[0]} (${topRaion[1].toLocaleString()})` : "Most affected: N/A", rightColX, cardY);
      doc.text(topInfra ? `Top Infra category: ${topInfra[0]} (${topInfra[1].toLocaleString()})` : "Top Infra: N/A", rightColX, cardY + 18);
      doc.text(topExtent ? `Top Damage Severity: ${topExtent[0]} (${topExtent[1].toLocaleString()})` : "Top Severity: N/A", rightColX, cardY + 36);

      // Total count highlight - styled like the dynamic .map-summary-box .value
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(26, 58, 92);
      doc.text(`Total Buildings Impacted: ${state.nationalTotal}`, leftColX, cardY + 65);

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
          pageHeight
        );
      } else {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(10);
        doc.setTextColor(192, 57, 43); // Matches error text colors #c0392b
        doc.text(
          "(Map image unavailable - likely a basemap CORS issue)",
          margin,
          y
        );
        y += 20;
      }

      // --- CHARTS ATTACHMENT ---
      for (const chartDef of IDS.charts) {
        const canvasEl = document.getElementById(chartDef.id);
        const img = await captureCanvas(canvasEl);
        if (!img) {
          doc.addPage();
          y = margin + 15;
          doc.setFontSize(11);
          doc.setTextColor(136, 136, 136);
          doc.text(`(Chart "${chartDef.label}" could not be captured)`, margin, y);
          y += 20;
          continue;
        }
        y = addImageWithHeading(doc, chartDef.label, img, y, margin, pageWidth, pageHeight);
      }

      // --- FOOTER AND PAGE NUMBERING ---
      const pageCount = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(136, 136, 136); // #888 muted color
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

  // Helper utility styled similarly to CSS's ".map-chart-card" borders
  function addImageWithHeading(doc, heading, imgDataUrl, y, margin, pageWidth, pageHeight) {
    const maxImgWidth = pageWidth - margin * 2;
    const props = doc.getImageProperties(imgDataUrl);
    let imgWidth = maxImgWidth;
    let imgHeight = (props.height * imgWidth) / props.width;

    const maxImgHeight = pageHeight - margin * 2 - 60;
    if (imgHeight > maxImgHeight) {
      imgHeight = maxImgHeight;
      imgWidth = (props.width * imgHeight) / props.height;
    }

    // Check if both heading and image can fit on this page. If not, add page.
    if (y + imgHeight + 50 > pageHeight - margin) {
      doc.addPage();
      y = margin + 15; // Set page padding
    }

    // Render Heading styled like .map-chart-card h3 / #map-wrapper-card h2
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(26, 58, 92); // #1a3a5c
    doc.text(heading, margin, y);
    y += 12;

    // Outer card border layout box similar to .map-chart-card border/shadow rules
    doc.setDrawColor(235, 240, 245); 
    doc.setLineWidth(1);
    doc.roundedRect(margin - 8, y - 4, imgWidth + 16, imgHeight + 10, 6, 6, "D");

    // Embed Image
    doc.addImage(imgDataUrl, "PNG", margin, y, imgWidth, imgHeight);
    return y + imgHeight + 35; // Returns next element coordinate space + spacing padding
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