/* ============================================================================
   E-PACC UKRAINE — "Generate PDF Report" (Updated with Robust Error Handling)
   ============================================================================ */

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

  // --- Helper: Get State ---
  function getReportState() {
    const state = window.__mapReportState || {};
    return {
      year: state.year || document.getElementById(IDS.yearSelect)?.value || "N/A",
      aggregationLabel: state.aggregationLabel || "N/A",
      startLabel: state.startLabel || "N/A",
      endLabel: state.endLabel || "N/A",
      nationalTotal: state.nationalTotal?.toLocaleString() || document.getElementById(IDS.totalValue)?.textContent.trim() || "0",
      activeFilterText: state.activeFilterText || "None (national view)",
      raionCounts: state.raionCounts || {},
      infraCounts: state.infraCounts || {},
      extentCounts: state.extentCounts || {},
    };
  }

  // --- Capture Helpers ---
  async function captureCanvas(canvasEl) {
    if (!canvasEl) return null;
    try { 
      // Ensure canvas is not empty
      return canvasEl.toDataURL("image/png", 1.0); 
    } catch (e) { 
      console.warn("Chart capture skipped:", e); 
      return null; 
    }
  }

  async function captureMap(mapEl) {
    if (!mapEl || typeof html2canvas === "undefined") return null;
    try {
      // Small delay to ensure rendering settles
      await new Promise(resolve => setTimeout(resolve, 500));
      const canvas = await html2canvas(mapEl, { 
        useCORS: true, 
        allowTaint: true, // Attempt to bypass strict CORS if tiles allow
        backgroundColor: "#ffffff", 
        scale: 2 
      });
      return canvas.toDataURL("image/png", 1.0);
    } catch (e) { 
      console.error("Map capture failed (likely CORS):", e); 
      return null; // Return null so report continues without map
    }
  }

  // --- PDF Generation ---
  async function generateReport() {
    const btn = document.getElementById("generate-report-btn");
    const originalText = btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Generating..."; }

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF("p", "pt", "a4");
      const margin = 40;
      let y = margin;

      const state = getReportState();
      
      // Title
      doc.setTextColor(26, 58, 92);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(22);
      doc.text("E-PACC Ukraine — Raion Analysis", margin, y);
      y += 40;

      // Statistics
      doc.setTextColor(50, 50, 50);
      doc.setFontSize(11);
      doc.text(`Period: ${state.year} | National Total: ${state.nationalTotal}`, margin, y);
      y += 30;

      // Capture Map
      const mapImg = await captureMap(document.getElementById(IDS.mapContainer));
      if (mapImg) {
        y = addImageWithHeading(doc, "Spatial Damage Assessment", mapImg, y, margin);
      }

      // Capture Charts
      for (const chartDef of IDS.charts) {
        const img = await captureCanvas(document.getElementById(chartDef.id));
        if (img) y = addImageWithHeading(doc, chartDef.label, img, y, margin);
      }

      doc.save(`EPACC_Report_${state.year}.pdf`);
    } catch (err) { 
      console.error("PDF Fatal Error:", err); 
      alert("Report failed to generate. Please check the console for details."); 
    } finally { 
      if (btn) { btn.disabled = false; btn.textContent = originalText; } 
    }
  }

  function addImageWithHeading(doc, heading, imgDataUrl, y, margin) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const maxW = pageWidth - (margin * 2);
    const props = doc.getImageProperties(imgDataUrl);
    const h = (props.height * maxW) / props.width;

    if (y + h + 40 > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
    
    doc.setFont("helvetica", "bold");
    doc.text(heading, margin, y);
    doc.addImage(imgDataUrl, "PNG", margin, y + 10, maxW, h);
    return y + h + 40;
  }

  function injectButton() {
    const anchor = document.querySelector(BUTTON_INSERT_AFTER_SELECTOR);
    if (anchor && !document.getElementById("generate-report-btn")) {
      const btn = document.createElement("button");
      btn.id = "generate-report-btn";
      btn.className = "map-report-btn";
      btn.textContent = "Generate PDF Report";
      btn.onclick = generateReport;
      anchor.insertAdjacentElement("afterend", btn);
    }
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", injectButton) : injectButton();
})();