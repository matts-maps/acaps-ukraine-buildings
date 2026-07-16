/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" for raion_analysis.html
   ============================================================================ */

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
        chartSeries: state.chartSeries || null,
        activeFilter: state.activeFilter || null,
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
      chartSeries: null,
      activeFilter: null,
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

  const PDF_CHART_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const CHART_PALETTE = ["#1a3a5c", "#2c5f8a", "#4a90c4", "#7cb4dd", "#a8d0e8", "#d94801", "#f16913", "#fdae6b", "#fdd0a2", "#999999"];
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null) el.setAttribute(k, v);
    });
    return el;
  }

  function newSvgRoot(width, height) {
    return svgEl("svg", { xmlns: SVG_NS, width, height, viewBox: `0 0 ${width} ${height}` });
  }

  function buildHorizontalBarSVG(labels, values, width, height, highlightSet) {
    const svg = newSvgRoot(width, height);
    if (!labels.length) return svg;
    const max = Math.max(1, ...values);
    const rowH = height / labels.length;
    const barH = Math.min(20, rowH * 0.55);
    const labelColW = Math.min(width * 0.34, 150);
    const valueColW = 50;
    const barAreaW = Math.max(20, width - labelColW - valueColW - 10);
    labels.forEach((label, i) => {
      const cy = rowH * i + rowH / 2;
      const barW = Math.max((values[i] / max) * barAreaW, 1);
      const isHighlighted = Boolean(highlightSet && highlightSet.has(label));
      const catText = svgEl("text", { x: labelColW - 8, y: cy, "text-anchor": "end", "dominant-baseline": "middle", "font-size": "8", "font-family": PDF_CHART_FONT, fill: "#444" });
      catText.textContent = label;
      svg.appendChild(catText);
      svg.appendChild(svgEl("rect", { x: labelColW, y: cy - barH / 2, width: barW, height: barH, rx: 4, ry: 4, fill: isHighlighted ? "#d94801" : "#1a3a5c" }));
      const valText = svgEl("text", { x: labelColW + barW + 8, y: cy, "text-anchor": "start", "dominant-baseline": "middle", "font-size": "8", "font-family": PDF_CHART_FONT, "font-weight": "600", fill: "#1a3a5c" });
      valText.textContent = values[i].toLocaleString();
      svg.appendChild(valText);
    });
    return svg;
  }

  function buildColumnChartSVG(labels, values, width, height) {
    const svg = newSvgRoot(width, height);
    if (!labels.length) return svg;
    const max = Math.max(1, ...values);
    const topPad = 22;
    const bottomPad = 34;
    const plotH = height - topPad - bottomPad;
    const colW = width / labels.length;
    const barW = Math.min(26, colW * 0.6);
    const rotateLabels = labels.length > 10;
    labels.forEach((label, i) => {
      const cx = colW * i + colW / 2;
      const value = values[i];
      if (value > 0) {
        const barH = Math.max((value / max) * plotH, 1);
        const barY = topPad + (plotH - barH);
        svg.appendChild(svgEl("rect", { x: cx - barW / 2, y: barY, width: barW, height: barH, rx: 3, ry: 3, fill: "#1a3a5c" }));
        const valText = svgEl("text", { x: cx, y: barY - 6, "text-anchor": "middle", "font-size": "8", "font-family": PDF_CHART_FONT, "font-weight": "600", fill: "#1a3a5c" });
        valText.textContent = value.toLocaleString();
        svg.appendChild(valText);
      }
      const lblY = height - bottomPad + 14;
      const lbl = svgEl("text", { x: cx, y: lblY, "text-anchor": rotateLabels ? "end" : "middle", "font-size": "8", "font-family": PDF_CHART_FONT, fill: "#666", transform: rotateLabels ? `rotate(-40 ${cx} ${lblY})` : undefined });
      lbl.textContent = label;
      svg.appendChild(lbl);
    });
    return svg;
  }

  function polarPoint(cx, cy, r, angle) { return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }; }

  function donutSlicePath(cx, cy, innerR, outerR, startAngle, endAngle) {
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    const p1 = polarPoint(cx, cy, outerR, startAngle);
    const p2 = polarPoint(cx, cy, outerR, endAngle);
    const p3 = polarPoint(cx, cy, innerR, endAngle);
    const p4 = polarPoint(cx, cy, innerR, startAngle);
    return `M ${p1.x} ${p1.y} A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${innerR} ${innerR} 0 ${largeArc} 0 ${p4.x} ${p4.y} Z`;
  }

  function buildDonutSVG(labels, values, width, height, palette) {
    const svg = newSvgRoot(width, height);
    const total = values.reduce((a, b) => a + b, 0);
    if (!total) return svg;
    const cx = width / 2;
    const cy = height / 2;
    const outerR = Math.max(30, Math.min(width, height) / 2 - 62);
    const innerR = outerR * 0.55;
    let angle = -Math.PI / 2;
    labels.forEach((label, i) => {
      const value = values[i];
      const frac = value / total;
      const startAngle = angle;
      const endAngle = angle + frac * Math.PI * 2;
      angle = endAngle;
      if (!value) return;
      svg.appendChild(svgEl("path", { d: donutSlicePath(cx, cy, innerR, outerR, startAngle, endAngle), fill: palette[i % palette.length] }));
      const mid = (startAngle + endAngle) / 2;
      const isRight = Math.cos(mid) >= 0;
      const lineStart = polarPoint(cx, cy, outerR + 2, mid);
      const bend = polarPoint(cx, cy, outerR + 16, mid);
      const textX = bend.x + (isRight ? 14 : -14);
      svg.appendChild(svgEl("polyline", { points: `${lineStart.x},${lineStart.y} ${bend.x},${bend.y} ${textX + (isRight ? -4 : 4)},${bend.y}`, fill: "none", stroke: "#999", "stroke-width": "1" }));
      const text = svgEl("text", { x: textX, y: bend.y, "text-anchor": isRight ? "start" : "end", "dominant-baseline": "middle", "font-size": "8", "font-family": PDF_CHART_FONT, fill: "#333" });
      text.textContent = `${label}: ${value.toLocaleString()} (${Math.round(frac * 100)}%)`;
      svg.appendChild(text);
    });
    return svg;
  }

  async function embedSvgChart(doc, svgElement, x, y, width, height, canvasId) {
    svgElement.style.position = "absolute"; svgElement.style.left = "-99999px"; svgElement.style.top = "0"; document.body.appendChild(svgElement);
    try {
      if (typeof window.svg2pdf === "function") await window.svg2pdf(svgElement, doc, { x, y, width, height });
      else throw new Error("svg2pdf not loaded");
      return true;
    } catch (e) {
      console.warn("SVG embed failed, skipping:", e);
      return false;
    } finally { document.body.removeChild(svgElement); }
  }

  async function addSvgWithHeading(doc, heading, svgElement, y, margin, pageWidth, pageHeight, targetWidth, explicitX, boxHeight) {
    const xPos = explicitX !== null ? explicitX : margin;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(26, 58, 92);
    const headingLines = doc.splitTextToSize(heading, targetWidth);
    if (y + boxHeight + (headingLines.length * 13) + 20 > pageHeight - margin) { doc.addPage(); y = margin + 15; }
    headingLines.forEach(line => { doc.text(line, xPos, y); y += 13; });
    await embedSvgChart(doc, svgElement, xPos, y, targetWidth, boxHeight);
    return y + boxHeight + 30;
  }

  function highlightSetFor(dimension, activeFilter) {
    return (activeFilter && activeFilter.dimension === dimension) ? new Set([activeFilter.value]) : null;
  }

  async function generateReport() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;
    let y = margin;
    const state = getReportState();
    const series = state.chartSeries || {};
    const chartWidth = pageWidth - (margin * 2);
    const SUMMARY_CHART_HEIGHT_PX = 220;

    // Timeline
    if (series.timeline && series.timeline.labels.length) {
        const svg = buildColumnChartSVG(series.timeline.labels, series.timeline.values, chartWidth, SUMMARY_CHART_HEIGHT_PX);
        y = await addSvgWithHeading(doc, IDS.charts.timeline.label, svg, y, margin, pageWidth, pageHeight, chartWidth, margin, SUMMARY_CHART_HEIGHT_PX);
    }
    // Top Raions
    if (series.topRaions && series.topRaions.labels.length) {
        const svg = buildHorizontalBarSVG(series.topRaions.labels, series.topRaions.values, chartWidth, SUMMARY_CHART_HEIGHT_PX, highlightSetFor("raion", state.activeFilter));
        y = await addSvgWithHeading(doc, IDS.charts.topRaions.label, svg, y, margin, pageWidth, pageHeight, chartWidth, margin, SUMMARY_CHART_HEIGHT_PX);
    }
    // Infra
    if (series.infra && series.infra.labels.length) {
        const svg = buildHorizontalBarSVG(series.infra.labels, series.infra.values, chartWidth, SUMMARY_CHART_HEIGHT_PX, highlightSetFor("infra", state.activeFilter));
        y = await addSvgWithHeading(doc, IDS.charts.infra.label, svg, y, margin, pageWidth, pageHeight, chartWidth, margin, SUMMARY_CHART_HEIGHT_PX);
    }
    // Extent
    if (series.extent && series.extent.labels.length) {
        const svg = buildDonutSVG(series.extent.labels, series.extent.values, chartWidth, SUMMARY_CHART_HEIGHT_PX, CHART_PALETTE);
        y = await addSvgWithHeading(doc, IDS.charts.extent.label, svg, y, margin, pageWidth, pageHeight, chartWidth, margin, SUMMARY_CHART_HEIGHT_PX);
    }

    doc.save("Report.pdf");
  }

  function injectButton() {
    const anchor = document.querySelector(BUTTON_INSERT_AFTER_SELECTOR);
    if (!anchor) return;
    const btn = document.createElement("button");
    btn.textContent = "Generate PDF Report";
    btn.style.cssText = "margin-top:12px;padding:10px;background:#1a3a5c;color:#fff;border:none;border-radius:6px;width:100%;cursor:pointer;";
    btn.addEventListener("click", generateReport);
    anchor.insertAdjacentElement("afterend", btn);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectButton);
  else injectButton();
})(); 