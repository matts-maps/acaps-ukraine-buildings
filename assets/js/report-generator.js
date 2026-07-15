/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" for raion_analysis.html
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

  // 1. Read current filter state
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

  // Detect live webpage font to ensure styling coherence
  function getWebpageFontFamily() {
    try {
      const bodyFont = window.getComputedStyle(document.body).fontFamily;
      if (bodyFont.toLowerCase().includes("sans-serif")) return "helvetica";
      return "helvetica";
    } catch (e) {
      return "helvetica";
    }
  }

  // ------------------------------------------------------------------
  // High-Fidelity Capture: Hides native chart text, extracts exact 
  // coordinate positions, and captures a clean shapes-only graphic.
  // ------------------------------------------------------------------
  async function captureChartDataAndCleanGraphic(canvasEl, heightPx) {
    if (!canvasEl) return null;
    if (typeof Chart === "undefined" || typeof Chart.getChart !== "function") return null;

    const chart = Chart.getChart(canvasEl);
    if (!chart) return null;

    const container = canvasEl.parentElement;
    const currentWidth = canvasEl.getBoundingClientRect().width;

    const original = {
      aspectRatio: chart.options.maintainAspectRatio,
      containerHeight: container ? container.style.height : null,
      legendDisplay: chart.options.plugins?.legend?.display,
      xColor: chart.options.scales?.x?.ticks?.color,
      yColor: chart.options.scales?.y?.ticks?.color,
    };

    try {
      // 1. Enforce size and suppress legend to free space up for graphic mapping
      chart.options.maintainAspectRatio = false;
      if (container && heightPx) container.style.height = `${heightPx}px`;
      if (chart.options.plugins?.legend) chart.options.plugins.legend.display = false;
      
      chart.resize(currentWidth, heightPx || 220);
      chart.update("none");

      // 2. Extract Metadata mappings now that layout is frozen
      const parseLabel = (l) => Array.isArray(l) ? l.join(" ") : (l !== undefined && l !== null ? String(l) : "");
      
      const metaData = {
        type: chart.config.type,
        labels: chart.data.labels || [],
        legendLabels: [],
        xTicks: [],
        yTicks: [],
        canvas: { width: chart.width, height: chart.height },
        chartArea: chart.chartArea ? { ...chart.chartArea } : null
      };

      // Legend Extractor
      if (original.legendDisplay !== false) {
        if (chart.config.type === 'doughnut' || chart.config.type === 'pie') {
           const bgColors = chart.data.datasets[0]?.backgroundColor || [];
           metaData.legendLabels = (chart.data.labels || []).map((lbl, i) => ({
               text: lbl,
               fillStyle: Array.isArray(bgColors) ? bgColors[i] : bgColors
           }));
        } else {
           metaData.legendLabels = chart.data.datasets.map(d => ({
               text: d.label,
               fillStyle: Array.isArray(d.backgroundColor) ? d.backgroundColor[0] : (d.backgroundColor || '#ccc')
           }));
        }
      }

      // X/Y Ticks Extractor mapped to precise canvas pixels
      if (chart.scales.x) {
          metaData.xTicks = chart.scales.x.getTicks().map((t, index) => ({
              label: parseLabel(t.label !== undefined ? t.label : t.value),
              x: chart.scales.x.getPixelForTick(index)
          }));
      }
      if (chart.scales.y) {
          metaData.yTicks = chart.scales.y.getTicks().map((t, index) => ({
              label: parseLabel(t.label !== undefined ? t.label : t.value),
              y: chart.scales.y.getPixelForTick(index)
          }));
      }

      // 3. Make text transparent to capture a clean chart graphic
      if (chart.options.scales?.x?.ticks) chart.options.scales.x.ticks.color = 'transparent';
      if (chart.options.scales?.y?.ticks) chart.options.scales.y.ticks.color = 'transparent';
      chart.update("none");

      const graphicDataUrl = canvasEl.toDataURL("image/png", 1.0);

      return { img: graphicDataUrl, meta: metaData };
    } catch (e) {
      console.warn("Clean chart graphic extraction failed:", e);
      return null;
    } finally {
      // Restore live map cleanly
      if (chart.options.plugins?.legend) chart.options.plugins.legend.display = original.legendDisplay;
      if (chart.options.scales?.x?.ticks) chart.options.scales.x.ticks.color = original.xColor;
      if (chart.options.scales?.y?.ticks) chart.options.scales.y.ticks.color = original.yColor;
      
      chart.options.maintainAspectRatio = original.aspectRatio;
      if (container) container.style.height = original.containerHeight || "";
      chart.resize();
      chart.update("none");
    }
  }

  // --------------------------------------------------------------------
  // Capture Map (html2canvas)
  // --------------------------------------------------------------------
  async function captureMap(mapEl) {
    if (!mapEl) return null;
    if (typeof html2canvas === "undefined") return null;

    const mapInstance = window.__leafletMap || (window.map instanceof L.Map ? window.map : null);
    let originalCenter = null, originalZoom = null;

    if (mapInstance) {
      originalCenter = mapInstance.getCenter();
      originalZoom = mapInstance.getZoom();
      let targetBounds = null;
      mapInstance.eachLayer((layer) => {
        if (layer.getBounds && typeof layer.getBounds === "function" && layer.feature) {
          targetBounds = !targetBounds ? layer.getBounds() : targetBounds.extend(layer.getBounds());
        }
      });
      if (targetBounds && targetBounds.isValid()) {
        await new Promise((resolve) => {
          mapInstance.once("moveend", () => setTimeout(resolve, 500));
          mapInstance.fitBounds(targetBounds, { padding: [20, 20], animate: false });
        });
      }
    }

    try {
      const canvas = await html2canvas(mapEl, {
        useCORS: true,
        backgroundColor: "#ffffff",
        scale: 2,
        logging: false,
        onclone: (clonedDoc) => {
          const hidden = [".leaflet-control-zoom", ".map-info-panel", ".leaflet-control-attribution"];
          hidden.forEach(s => {
            const el = clonedDoc.querySelector(s);
            if (el) el.style.setProperty("display", "none", "important");
          });
        }
      });

      if (mapInstance && originalCenter) mapInstance.setView(originalCenter, originalZoom, { animate: false });
      return canvas.toDataURL("image/png", 1.0);
    } catch (e) {
      if (mapInstance && originalCenter) mapInstance.setView(originalCenter, originalZoom, { animate: false });
      return null;
    }
  }

  // --------------------------------------------------------------------
  // Main PDF Generation Pipeline
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
      const font = getWebpageFontFamily();
      const generatedAt = new Date().toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" });

      // Page Top Accent line
      doc.setFillColor(26, 58, 92); 
      doc.rect(0, 0, pageWidth, 8, "F");
      y += 15;

      doc.setFont(font, "bold");
      doc.setFontSize(22);
      doc.setTextColor(26, 58, 92);
      doc.text("E-PACC Ukraine", margin, y);
      y += 22;

      doc.setFontSize(14);
      doc.setFont(font, "normal");
      doc.setTextColor(102, 102, 102);
      doc.text("Raion Damage Analysis Report", margin, y);
      y += 25;

      doc.setFontSize(9);
      doc.setTextColor(136, 136, 136);
      doc.text(`Period: ${formatPeriod(state)}`, margin, y);
      doc.text(`Generated: ${generatedAt}`, pageWidth - margin - 150, y);
      
      y += 12;
      doc.setDrawColor(224, 224, 224); 
      doc.setLineWidth(1);
      doc.line(margin, y, pageWidth - margin, y);
      y += 25;

      // Statistics Section
      doc.setFont(font, "bold");
      doc.setFontSize(13);
      doc.setTextColor(26, 58, 92);
      doc.text("Summary Statistics", margin, y);
      y += 12;

      const topRaion = topEntry(state.raionCounts);
      const topInfra = topEntry(state.infraCounts);
      const topExtent = topEntry(state.extentCounts);
      const colWidth = (pageWidth - (margin * 2) - 40) / 2; 

      doc.setFont(font, "normal");
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
      const leftColHeight = leftWrapped.reduce((acc, lines) => acc + (lines.length * 13) + 6, 0);
      const rightColHeight = rightWrapped.reduce((acc, lines) => acc + (lines.length * 13) + 6, 0);
      const statBoxHeight = Math.max(leftColHeight, rightColHeight) + 45;

      // Draw Box Layout
      doc.setFillColor(240, 244, 248); 
      doc.roundedRect(margin, y, pageWidth - (margin * 2), statBoxHeight, 6, 6, "F");
      doc.setFillColor(26, 58, 92);
      doc.rect(margin, y, 4, statBoxHeight, "F");

      doc.setTextColor(68, 68, 68);
      let currentLeftY = y + 20;
      leftWrapped.forEach(lines => {
        lines.forEach(line => { doc.text(line, margin + 20, currentLeftY); currentLeftY += 13; });
        currentLeftY += 6;
      });

      let currentRightY = y + 20;
      const rightColX = pageWidth / 2 + 10;
      rightWrapped.forEach(lines => {
        lines.forEach(line => { doc.text(line, rightColX, currentRightY); currentRightY += 13; });
        currentRightY += 6;
      });

      doc.setFont(font, "bold");
      doc.setFontSize(11);
      doc.setTextColor(26, 58, 92);
      doc.text(`Total Buildings Impacted: ${state.nationalTotal}`, margin + 20, y + statBoxHeight - 15);

      y += statBoxHeight + 25;

      // Add Map
      const mapEl = document.getElementById(IDS.mapContainer);
      const mapImg = await captureMap(mapEl);
      if (mapImg) {
        y = addImageWithHeading(doc, font, "Damage Buildings per Raion", mapImg, y, margin, pageWidth, pageHeight, pageWidth - margin * 2);
      } else {
        doc.setFont(font, "italic");
        doc.setFontSize(10);
        doc.setTextColor(192, 57, 43);
        doc.text("(Map image unavailable due to CORS settings)", margin, y);
        y += 25;
      }

      // --- PAGE 2: CHARTS WITH NATIVE SELECTABLE PDF TEXTS ---
      doc.addPage();
      y = margin + 15;

      // 1. Timeline Chart
      const timelineCanvas = document.getElementById(IDS.charts.timeline.id);
      const timelineData = await captureChartDataAndCleanGraphic(timelineCanvas, 200);

      if (timelineData) {
        y = addVectorLabeledChart(doc, font, IDS.charts.timeline.label, timelineData, y, margin, pageWidth, pageHeight, pageWidth - margin * 2, 200);
      }

      // Bottom Grid Column Charts Row
      const gridGap = 20;
      const colChartWidth = (pageWidth - margin * 2 - gridGap) / 2;
      const smallChartHeight = 220;

      const topRaionsCanvas = document.getElementById(IDS.charts.topRaions.id);
      const infraCanvas = document.getElementById(IDS.charts.infra.id);
      const extentCanvas = document.getElementById(IDS.charts.extent.id);

      const topRaionsData = await captureChartDataAndCleanGraphic(topRaionsCanvas, smallChartHeight);
      const infraData = await captureChartDataAndCleanGraphic(infraCanvas, smallChartHeight);
      const extentData = await captureChartDataAndCleanGraphic(extentCanvas, smallChartHeight);

      let rowYStart = y;
      let maxRowHeight = 0;

      if (topRaionsData) {
        const nextY = addVectorLabeledChart(doc, font, IDS.charts.topRaions.label, topRaionsData, rowYStart, margin, pageWidth, pageHeight, colChartWidth, smallChartHeight, margin);
        maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
      }

      if (infraData) {
        const nextY = addVectorLabeledChart(doc, font, IDS.charts.infra.label, infraData, rowYStart, margin, pageWidth, pageHeight, colChartWidth, smallChartHeight, margin + colChartWidth + gridGap);
        maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
      }

      y = rowYStart + (maxRowHeight > 0 ? maxRowHeight : 0);

      if (extentData) {
        const centerX = (pageWidth - colChartWidth) / 2;
        y = addVectorLabeledChart(doc, font, IDS.charts.extent.label, extentData, y, margin, pageWidth, pageHeight, colChartWidth, smallChartHeight, centerX);
      }

      // Footer stamp
      const pageCount = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFont(font, "normal");
        doc.setFontSize(8);
        doc.setTextColor(136, 136, 136);
        doc.text("E-PACC Ukraine Project - Sourced from ACAPS. Built using Vector PDF Text standards.", margin, pageHeight - 20);
        doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin - 45, pageHeight - 20);
      }

      const safeYear = String(state.year || "report").replace(/\s+/g, "_");
      doc.save(`EPACC_Raion_Report_${safeYear}.pdf`);
    } catch (err) {
      console.error("Report generation failed:", err);
      alert("Error generating report. See browser debugger console for details.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    }
  }

  // ------------------------------------------------------------------
  // Native PDF Engine (Reconstructs Texts at Exact Pixel Coords)
  // ------------------------------------------------------------------
  function addVectorLabeledChart(doc, font, heading, chartPayload, y, margin, pageWidth, pageHeight, targetWidth, targetHeight, explicitX = null) {
    const xPos = explicitX !== null ? explicitX : margin;
    const requiredTotalHeight = targetHeight + 65; // Headings + chart + legends margin

    if (y + requiredTotalHeight > pageHeight - margin) {
      doc.addPage();
      y = margin + 15;
    }

    // 1. Draw Heading Vector Text
    doc.setFont(font, "bold");
    doc.setFontSize(10);
    doc.setTextColor(26, 58, 92);
    doc.text(heading, xPos, y);
    y += 14;

    // 2. Plot Raw Blank Shape Graphic
    doc.addImage(chartPayload.img, "PNG", xPos, y, targetWidth, targetHeight);

    // 3. Render Precise Axis Texts dynamically as clean vector text labels
    const FONT_SIZE = 9; // <--- Hard requirement for 9pt text implemented here
    doc.setFont(font, "normal");
    doc.setFontSize(FONT_SIZE);
    doc.setTextColor(110, 110, 110);

    const meta = chartPayload.meta;
    const ratioX = targetWidth / meta.canvas.width;
    const ratioY = targetHeight / meta.canvas.height;

    // X-Axis Vector Ticks
    if (meta.xTicks && meta.xTicks.length > 0) {
        // If data labels are dense, angle them
        const angle = meta.xTicks.length > 8 ? -45 : 0; 
        
        meta.xTicks.forEach(tick => {
            const tickX = xPos + (tick.x * ratioX);
<<<<<<< HEAD
            const tickY = y + (meta.chartArea.bottom * ratioY) + 12; // Standard padding beneath axis
            
            // Protect borders
            if (tickX >= xPos && tickX <= xPos + targetWidth) {
                if (angle !== 0) {
                    doc.text(tick.label, tickX, tickY, { align: "right", angle: angle });
                } else {
                    doc.text(tick.label, tickX, tickY, { align: "center" });
                }
=======
            const tickY = y + (meta.chartArea.bottom * ratioY) + 12; 
            
            if (tickX >= xPos - 5 && tickX <= xPos + targetWidth + 5) {
                doc.text(tick.label, tickX, tickY, { align: angle !== 0 ? "right" : "center", angle: angle });
>>>>>>> parent of c39cc56 (Update report-generator.js)
            }
        });
    }

    // Y-Axis Vector Ticks
    if (meta.yTicks && meta.yTicks.length > 0) {
        meta.yTicks.forEach(tick => {
<<<<<<< HEAD
            const tickY = y + (tick.y * ratioY) + 3; // +3 to align to vertical middle
            const tickX = xPos + (meta.chartArea.left * ratioX) - 5; // offset slightly off the axis line
            
            if (tickY >= y && tickY <= y + targetHeight) {
=======
            const tickY = y + (tick.y * ratioY) + 3; 
            const tickX = xPos + (meta.chartArea.left * ratioX) - 5; 
            
            if (tickY >= y - 10 && tickY <= y + targetHeight + 10) {
>>>>>>> parent of c39cc56 (Update report-generator.js)
                doc.text(tick.label, tickX, tickY, { align: "right" });
            }
        });
    }

    // 4. Render Manual Interactive Legend
    if (meta.legendLabels && meta.legendLabels.length > 0) {
        let totalLegendWidth = 0;
        meta.legendLabels.forEach(leg => {
            totalLegendWidth += 12 + 6 + doc.getTextWidth(leg.text) + 15;
        });
        totalLegendWidth -= 15;
        
        let legendX = xPos + (targetWidth / 2) - (totalLegendWidth / 2);
        if (legendX < xPos) legendX = xPos;
        const legendY = y + targetHeight + 30;

        meta.legendLabels.forEach(leg => {
            const colorStr = typeof leg.fillStyle === 'string' ? leg.fillStyle : '#888888';
            
            doc.setFillColor(colorStr);
            doc.rect(legendX, legendY - 7, 9, 9, "F");
            
            doc.setTextColor(80, 80, 80);
            doc.text(leg.text, legendX + 13, legendY + 1);
            
            legendX += 13 + doc.getTextWidth(leg.text) + 15;
        });
    }

    return y + targetHeight + 50;
  }

  function addImageWithHeading(doc, font, heading, imgDataUrl, y, margin, pageWidth, pageHeight, targetWidth, explicitX = null) {
    const xPos = explicitX !== null ? explicitX : margin;
    const props = doc.getImageProperties(imgDataUrl);
    const imgHeight = targetWidth / (props.width / props.height);

    doc.setFont(font, "bold");
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

    doc.addImage(imgDataUrl, "PNG", xPos, y, targetWidth, imgHeight);
    return y + imgHeight + 30;
  }

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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();