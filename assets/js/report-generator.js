/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" (Integrated & Refactored)
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

  const SVG_NS = "http://www.w3.org/2000/svg";
  const BUTTON_INSERT_AFTER_SELECTOR = ".map-hint";

  // --- Core Utility: Create SVG Nodes ---
  function createSVGElement(tagName, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tagName);
    for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, val);
    return el;
  }

  // --- Logic Placeholder: Existing helper functions ---
  function getReportState() { /* ... Your existing implementation ... */ return {}; }
  function formatPeriod(state) { /* ... Your existing implementation ... */ return ""; }
  function topEntry(counts) { /* ... Your existing implementation ... */ return null; }
  function getWebpageFontFamily() { return "helvetica"; }
  function getChartInstance(canvasEl) { return typeof Chart !== "undefined" ? Chart.getChart(canvasEl) : null; }
  function extractChartModel(chart) { /* ... Your existing implementation ... */ return null; }

  // --- REFACTORED: SVG Construction using DOM Nodes ---
  function buildChartSVG(canvasEl, width, height) {
    const chart = getChartInstance(canvasEl);
    if (!chart) return null;
    
    const svg = createSVGElement("svg", { width, height, viewBox: `0 0 ${width} ${height}` });
    svg.appendChild(createSVGElement("rect", { width: "100%", height: "100%", fill: "#ffffff" }));
    
    // NOTE: You would replace the string-concatenation inside your buildBar/Line/Pie functions
    // with calls to createSVGElement and append them to 'svg' here.
    return svg;
  }

  // --- REFACTORED: PDF Integration ---
  async function addSVGChart(doc, font, heading, svgEl, y, margin, pageWidth, pageHeight, targetW, targetH, explicitX = null) {
    const x = explicitX || margin;
    if (y + targetH + 40 > pageHeight - margin) { doc.addPage(); y = margin + 15; }
    
    doc.setFont(font, "bold"); doc.setFontSize(10); doc.setTextColor(26, 58, 92);
    doc.text(heading, x, y);
    
    try {
        await doc.svg(svgEl, { x, y: y + 10, width: targetW, height: targetH });
    } catch (e) { console.error("SVG PDF render failed", e); }
    return y + targetH + 30;
  }

  // --- Main Generate Logic ---
  async function generateReport() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;
    
    // ... [Add your Header, Summary Stats, and Map capture code here] ...

    // Injecting vector charts using the new node-based engine
    const canvas = document.getElementById(IDS.charts.timeline.id);
    const svgEl = buildChartSVG(canvas, pageWidth - margin * 2, 200);
    if (svgEl) {
        await addSVGChart(doc, "helvetica", "Timeline", svgEl, 200, margin, pageWidth, 842, pageWidth - margin*2, 200);
    }

    doc.save("Report.pdf");
  }

  function injectButton() {
    const anchor = document.querySelector(BUTTON_INSERT_AFTER_SELECTOR);
    if (anchor) {
        const btn = document.createElement("button");
        btn.textContent = "Generate PDF";
        btn.onclick = generateReport;
        anchor.insertAdjacentElement("afterend", btn);
    }
  }

  window.addEventListener("DOMContentLoaded", injectButton);
})();