/* ============================================================================
   E-PACC UKRAINE — "Generate PDF Report" for raion_analysis.html
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

  // --------------------------------------------------------------------
  // State Reading
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

    if (state) {
      return {
        year: state.year,
        aggregationLabel: state.aggregationLabel,
        startLabel: state.startLabel,
        endLabel: state.endLabel,
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
    return `${state.year} — ${state.aggregationLabel} — ${range}`;
  }

  function topEntry(counts) {
    const entries = Object.entries(counts || {});
    if (!entries.length) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0];
  }

  // --------------------------------------------------------------------
  // Capturing Assets
  // --------------------------------------------------------------------
  async function captureCanvas(canvasEl) {
    if (!canvasEl) return null;
    try { return canvasEl.toDataURL("image/png", 1.0); } 
    catch (e) { console.warn("Chart capture failed:", e); return null; }
  }

  async function captureMap(mapEl) {
    if (!mapEl || typeof html2canvas === "undefined") return null;
    try {
      const canvas = await html2canvas(mapEl, { useCORS: true, backgroundColor: "#ffffff", scale: 2, logging: false });
      return canvas.toDataURL("image/png", 1.0);
    } catch (e) { return null; }
  }

  // --------------------------------------------------------------------
  // PDF Generation
  // --------------------------------------------------------------------
  async function generateReport() {
    const btn = document.getElementById("generate-report-btn");
    if (btn) btn.disabled = true;

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 40;
      let y = margin;

      const state = getReportState();
      const generatedAt = new Date().toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" });

      // Theme Colors
      const primaryColor = [26, 58, 92]; // #1a3a5c
      const textColor = [50, 50, 50];

      // Title
      doc.setTextColor(primaryColor[0], primaryColor[1], primaryColor[2]);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(24);
      doc.text("E-PACC Ukraine — Raion Analysis", margin, y);
      y += 35;

      // Metadata
      doc.setTextColor(textColor[0], textColor[1], textColor[2]);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.text(`Period: ${formatPeriod(state)}`, margin, y);
      y += 18;
      doc.text(`Generated: ${generatedAt}`, margin, y);
      y += 30;

      // Summary
      doc.setTextColor(primaryColor[0], primaryColor[1], primaryColor[2]);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text("Summary Statistics", margin, y);
      y += 20;

      doc.setTextColor(textColor[0], textColor[1], textColor[2]);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);

      const topRaion = topEntry(state.raionCounts);
      const topInfra = topEntry(state.infraCounts);
      const raionsAffected = Object.keys(state.raionCounts).length;

      const stats = [
        { label: "Active Filter", val: state.activeFilterText },
        { label: "National Frame Total", val: state.nationalTotal },
        { label: "Raions with Damage", val: raionsAffected || "N/A" },
        topRaion ? { label: "Most-affected Raion", val: `${topRaion[0]} (${topRaion[1].toLocaleString()})` } : null,
        topInfra ? { label: "Most-reported Infra Type", val: `${topInfra[0]} (${topInfra[1].toLocaleString()})` } : null
      ].filter(Boolean);

      stats.forEach((item) => {
        doc.setFont("helvetica", "bold");
        doc.text(`${item.label}:`, margin, y);
        doc.setFont("helvetica", "normal");
        doc.text(item.val, margin + 160, y);
        y += 18;
      });
      y += 20;

      // Map & Charts
      const mapEl = document.getElementById(IDS.mapContainer);
      const mapImg = await captureMap(mapEl);
      if (mapImg) y = addImageWithHeading(doc, "Spatial Damage Assessment Mapping Profile", mapImg, y, margin, pageWidth, pageHeight);

      for (const chartDef of IDS.charts) {
        const canvasEl = document.getElementById(chartDef.id);
        const img = await captureCanvas(canvasEl);
        if (img) y = addImageWithHeading(doc, chartDef.label, img, y, margin, pageWidth, pageHeight);
      }

      doc.save(`EPACC_Raion_Report_${state.year || 'data'}.pdf`);
    } catch (err) { console.error(err); alert("Report generation failed."); }
    finally { if (btn) btn.disabled = false; }
  }

  function addImageWithHeading(doc, heading, imgDataUrl, y, margin, pageWidth, pageHeight) {
    const maxImgWidth = pageWidth - margin * 2;
    const props = doc.getImageProperties(imgDataUrl);
    let imgHeight = (props.height * maxImgWidth) / props.width;
    if (y + imgHeight + 40 > pageHeight - margin) { doc.addPage(); y = margin; }
    
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(heading, margin, y);
    doc.addImage(imgDataUrl, "PNG", margin, y + 10, maxImgWidth, imgHeight);
    return y + imgHeight + 40;
  }

  // --------------------------------------------------------------------
  // Injection
  // --------------------------------------------------------------------
  function injectButton() {
    const anchor = document.querySelector(BUTTON_INSERT_AFTER_SELECTOR);
    if (!anchor || document.getElementById("generate-report-btn")) return;

    const btn = document.createElement("button");
    btn.id = "generate-report-btn";
    btn.className = "map-report-btn";
    btn.textContent = "Generate PDF Report";
    btn.addEventListener("click", generateReport);
    anchor.insertAdjacentElement("afterend", btn);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectButton);
  else injectButton();
})();