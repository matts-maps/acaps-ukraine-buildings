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
      timeline: { id: "map-timeline-chart", label: "Timeline of damaged buildings" },
      topRaions: { id: "map-top-oblasts-chart", label: "Most damaged Raions" },
      infra: { id: "map-infra-type-chart", label: "Damage by infrastructure type" },
      extent: { id: "map-extent-chart", label: "Level of damage" }
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
  // 2. Capture helpers (Includes Synchronized Alignment for Overlays)
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

  // ------------------------------------------------------------------
  // Leaflet's SVG renderer positions the overlay <svg> with a CSS
  // transform of translate3d(vx, vy, 0), and sets its viewBox to
  // "vx vy width height" so the two offsets cancel out and vector
  // paths (e.g. the raion polygons) land at the correct absolute
  // pixel position on top of the raster tiles.
  //
  // html2canvas honours the CSS transform but does NOT apply the
  // viewBox origin offset, so the compensating shift is dropped and
  // the vector layer renders shifted by (vx, vy) relative to the
  // tiles underneath it. See:
  //   https://github.com/Leaflet/Leaflet/issues/4754
  //   https://github.com/niklasvh/html2canvas/issues/661
  //
  // Fix: right before capture, zero out both the transform and the
  // viewBox origin on every Leaflet overlay <svg>, so there is no
  // offset left for html2canvas to mishandle. Restore both afterward
  // so the live, interactive map is unaffected.
  // ------------------------------------------------------------------
  function neutralizeLeafletSvgOffsets(mapEl) {
    const svgs = mapEl.querySelectorAll(".leaflet-overlay-pane svg");
    const restoreFns = [];

    svgs.forEach((svg) => {
      const viewBoxAttr = svg.getAttribute("viewBox");
      if (!viewBoxAttr) return;

      const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number);
      if (parts.length !== 4 || parts.some(Number.isNaN)) return;
      const [vx, vy, vw, vh] = parts;
      if (!vx && !vy) return; // already at origin, nothing to neutralize

      const originalViewBox = viewBoxAttr;
      const originalTransform = svg.style.transform;

      svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
      svg.style.transform = "translate3d(0px, 0px, 0px)";

      restoreFns.push(() => {
        svg.setAttribute("viewBox", originalViewBox);
        svg.style.transform = originalTransform;
      });
    });

    return function restoreAll() {
      restoreFns.forEach((fn) => fn());
    };
  }

  async function captureMap(mapEl) {
    if (!mapEl) return null;
    if (typeof html2canvas === "undefined") {
      console.error("html2canvas is not loaded.");
      return null;
    }

    const mapInstance = window.__leafletMap || (window.map instanceof L.Map ? window.map : null);
    let originalCenter = null;
    let originalZoom = null;

    if (mapInstance) {
      originalCenter = mapInstance.getCenter();
      originalZoom = mapInstance.getZoom();

      let targetBounds = null;
      mapInstance.eachLayer((layer) => {
        if (layer.getBounds && typeof layer.getBounds === "function" && layer.feature) {
          if (!targetBounds) {
            targetBounds = layer.getBounds();
          } else {
            targetBounds.extend(layer.getBounds());
          }
        }
      });

      if (targetBounds && targetBounds.isValid()) {
        // We use a Promise wrapper to halt execution until Leaflet fires 'moveend'.
        // This ensures vectors and base tiles are locked in place before capturing.
        await new Promise((resolve) => {
          mapInstance.once("moveend", () => {
            // Extra 500ms safety buffer to ensure raster basemap tiles are fully loaded and rendered
            setTimeout(resolve, 500);
          });
          mapInstance.fitBounds(targetBounds, { padding: [20, 20], animate: false });
        });
      }
    }

    // Neutralize the Leaflet SVG transform/viewBox offset that html2canvas
    // mishandles (see notes above) — must be done AFTER the view has
    // settled (fitBounds/moveend above) so we read the final offsets, and
    // must always be reverted, success or failure, so the live map isn't
    // left broken for the user.
    const restoreSvgOffsets = neutralizeLeafletSvgOffsets(mapEl);

    try {
      const canvas = await html2canvas(mapEl, {
        useCORS: true,
        backgroundColor: "#ffffff",
        scale: 2,
        logging: false,
        onclone: (clonedDoc) => {
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

      // Safely revert user view coordinates back to original state
      if (mapInstance && originalCenter !== null && originalZoom !== null) {
        mapInstance.setView(originalCenter, originalZoom, { animate: false });
      }

      return canvas.toDataURL("image/png", 1.0);
    } catch (e) {
      console.error("Map capture failed due to CORS or rendering issues:", e);
      
      if (mapInstance && originalCenter !== null && originalZoom !== null) {
        mapInstance.setView(originalCenter, originalZoom, { animate: false });
      }
      return null;
    } finally {
      // Always put the live map's SVG overlay back exactly as it was,
      // regardless of whether the capture succeeded or failed.
      restoreSvgOffsets();
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

      // Accent border header
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
      doc.setTextColor(102, 102, 102);
      doc.text("Raion Damage Analysis Report", margin, y);
      y += 25;

      // Meta Line
      doc.setFontSize(9);
      doc.setTextColor(136, 136, 136);
      doc.text(`Period: ${formatPeriod(state)}`, margin, y);
      doc.text(`Generated: ${generatedAt}`, pageWidth - margin - 150, y);
      
      y += 12;
      doc.setDrawColor(224, 224, 224); 
      doc.setLineWidth(1);
      doc.line(margin, y, pageWidth - margin, y);
      y += 25;

      // Summary Statistics Panel
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(26, 58, 92);
      doc.text("Summary Statistics", margin, y);
      y += 12;

      const topRaion = topEntry(state.raionCounts);
      const topInfra = topEntry(state.infraCounts);
      const topExtent = topEntry(state.extentCounts);

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
        topInfra ? `Most damaged infrastructure: ${topInfra[0]} (${topInfra[1].toLocaleString()})` : "Most damaged infrastructure: N/A",
        topExtent ? `Most common level of damage: ${topExtent[0]} (${topExtent[1].toLocaleString()})` : "Most common level of damage: N/A"
      ];

      const leftWrapped = leftRaw.map(str => doc.splitTextToSize(str, colWidth));
      const rightWrapped = rightRaw.map(str => doc.splitTextToSize(str, colWidth));

      const getColHeight = (wrappedArray) => {
        return wrappedArray.reduce((acc, lines) => acc + (lines.length * 13) + 6, 0);
      };
      
      const leftColHeight = getColHeight(leftWrapped);
      const rightColHeight = getColHeight(rightWrapped);
      const contentHeight = Math.max(leftColHeight, rightColHeight);
      
      const statBoxHeight = contentHeight + 45;

      doc.setFillColor(240, 244, 248); 
      doc.roundedRect(margin, y, pageWidth - (margin * 2), statBoxHeight, 6, 6, "F");
      doc.setFillColor(26, 58, 92);
      doc.rect(margin, y, 4, statBoxHeight, "F");

      doc.setTextColor(68, 68, 68);
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
        doc.setTextColor(192, 57, 43);
        doc.text("(Map image unavailable - likely a basemap CORS issue)", margin, y);
        y += 25;
      }

      // --- GRID CHARTS ATTACHMENT ---
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
          pageWidth - margin * 2
        );
      }

      const gridGap = 16;
      const colChartWidth = (pageWidth - margin * 2 - gridGap) / 2;

      // 2. Top Raions & 3. Infra Type (Side-by-Side)
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
          margin
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
          margin + colChartWidth + gridGap
        );
        maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
      }

      y = rowYStart + (maxRowHeight > 0 ? maxRowHeight : 0);

      // 4. Extent of Damage (Centered)
      const extentCanvas = document.getElementById(IDS.charts.extent.id);
      const extentImg = await captureCanvas(extentCanvas);
      if (extentImg) {
        const centerX = (pageWidth - colChartWidth) / 2;
        y = addImageWithHeading(
          doc,
          IDS.charts.extent.label,
          extentImg,
          y,
          margin,
          pageWidth,
          pageHeight,
          colChartWidth,
          centerX
        );
      }

      // --- FOOTER AND PAGE NUMBERING ---
      const pageCount = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(136, 136, 136);
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

  function addImageWithHeading(doc, heading, imgDataUrl, y, margin, pageWidth, pageHeight, targetWidth, explicitX = null) {
    const xPos = explicitX !== null ? explicitX : margin;
    const props = doc.getImageProperties(imgDataUrl);
    const imgWidth = targetWidth;
    const imgHeight = (props.height * imgWidth) / props.width;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(26, 58, 92);

    const headingLines = doc.splitTextToSize(heading, targetWidth);
    const headingHeight = headingLines.length * 13;

    if (y + imgHeight + headingHeight + 20 > pageHeight - margin) {
      doc.addPage();
      y = margin + 15;
    }

    headingLines.forEach((line) => {
      doc.text(line, xPos, y);
      y += 13;
    });
    y += 6;

    doc.addImage(imgDataUrl, "PNG", xPos, y, imgWidth, imgHeight);
    return y + imgHeight + 30;
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