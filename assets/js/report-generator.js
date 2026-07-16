/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" for raion_analysis.html
   Charts are rendered as native SVG (vector) and embedded into the PDF via
   svg2pdf.js, so shapes, gridlines, and text all stay crisp/vector and the
   layout mirrors the live Chart.js charts on the page.
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
  const SVG2PDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/svg2pdf.js/2.2.3/svg2pdf.umd.min.js";

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

  function escapeXML(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  // ------------------------------------------------------------------
  // SVG Chart Engine: reads the live Chart.js instance behind a canvas
  // (same data, same colors as the webpage) and re-draws it as a plain
  // SVG string, so the PDF gets true vector shapes + vector text instead
  // of a rasterized screenshot.
  // ------------------------------------------------------------------
  function getChartInstance(canvasEl) {
    if (!canvasEl) return null;
    if (typeof Chart === "undefined" || typeof Chart.getChart !== "function") return null;
    return Chart.getChart(canvasEl);
  }

  function extractChartModel(chart) {
    if (!chart) return null;
    const type = chart.config.type;
    const labels = (chart.data.labels || []).map((l) =>
      Array.isArray(l) ? l.join(" ") : l !== undefined && l !== null ? String(l) : ""
    );

    const datasets = (chart.data.datasets || []).map((ds) => {
      const bg = ds.backgroundColor;
      const border = ds.borderColor;
      const colorFor = (i) => {
        if (Array.isArray(bg) && bg.length) return bg[i % bg.length] || "#4a90d9";
        if (bg) return bg;
        if (Array.isArray(border) && border.length) return border[i % border.length] || "#4a90d9";
        return border || "#4a90d9";
      };
      const data = (ds.data || []).map((v) => {
        if (v && typeof v === "object") return Number(v.y ?? v.value ?? 0) || 0;
        return Number(v) || 0;
      });
      return {
        label: ds.label || "",
        data,
        colorFor,
        borderColor: Array.isArray(border) ? border[0] : border || colorFor(0),
      };
    });

    return { type, labels, datasets };
  }

  function niceTicks(maxVal) {
    if (!maxVal || maxVal <= 0) return [0, 1];
    const rough = maxVal / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if (norm < 1.5) step = 1 * mag;
    else if (norm < 3) step = 2 * mag;
    else if (norm < 7) step = 5 * mag;
    else step = 10 * mag;
    const ticks = [];
    let t = 0;
    while (t < maxVal + step) {
      ticks.push(Math.round(t * 100) / 100);
      t += step;
    }
    return ticks;
  }

  const AXIS_FONT = `font-size="8" font-family="Helvetica, Arial, sans-serif" fill="#6e6e6e"`;
  const LEGEND_FONT = `font-size="8" font-family="Helvetica, Arial, sans-serif" fill="#444444"`;

  function buildBarChartSVG(model, width, height) {
    const padTop = 10, padBottom = 32, padLeft = 42, padRight = 10;
    const plotW = Math.max(1, width - padLeft - padRight);
    const plotH = Math.max(1, height - padTop - padBottom);

    const allValues = model.datasets.flatMap((ds) => ds.data);
    const maxVal = Math.max(1, ...allValues, 0);
    const ticks = niceTicks(maxVal);
    const scaleMax = ticks[ticks.length - 1] || 1;

    const n = model.labels.length || 1;
    const groupW = plotW / n;
    const dsCount = model.datasets.length || 1;
    const barGap = 3;
    const barW = Math.max(3, (groupW - barGap * 2) / dsCount);

    let grid = "", yLabels = "";
    ticks.forEach((t) => {
      const yy = padTop + plotH - (t / scaleMax) * plotH;
      grid += `<line x1="${padLeft}" y1="${yy.toFixed(1)}" x2="${width - padRight}" y2="${yy.toFixed(1)}" stroke="#e6e6e6" stroke-width="1"/>`;
      yLabels += `<text x="${(padLeft - 6).toFixed(1)}" y="${(yy + 3).toFixed(1)}" text-anchor="end" ${AXIS_FONT}>${t}</text>`;
    });

    let bars = "", xLabels = "";
    model.labels.forEach((label, i) => {
      const groupX = padLeft + i * groupW;
      model.datasets.forEach((ds, dsIdx) => {
        const val = ds.data[i] || 0;
        const barH = (val / scaleMax) * plotH;
        const bx = groupX + barGap + dsIdx * barW;
        const by = padTop + plotH - barH;
        bars += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${ds.colorFor(i)}"/>`;
      });
      const labelX = groupX + groupW / 2;
      const truncated = label.length > 14 ? label.slice(0, 13) + "\u2026" : label;
      xLabels += `<text x="${labelX.toFixed(1)}" y="${(padTop + plotH + 13).toFixed(1)}" text-anchor="middle" ${AXIS_FONT}>${escapeXML(truncated)}</text>`;
    });

    const axes =
      `<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="#c9c9c9" stroke-width="1"/>` +
      `<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="#c9c9c9" stroke-width="1"/>`;

    return grid + axes + bars + xLabels + yLabels;
  }

  function buildLineChartSVG(model, width, height) {
    const padTop = 10, padBottom = 26, padLeft = 42, padRight = 14;
    const plotW = Math.max(1, width - padLeft - padRight);
    const plotH = Math.max(1, height - padTop - padBottom);

    const allValues = model.datasets.flatMap((ds) => ds.data);
    const maxVal = Math.max(1, ...allValues, 0);
    const ticks = niceTicks(maxVal);
    const scaleMax = ticks[ticks.length - 1] || 1;

    const n = model.labels.length || 1;
    const stepX = n > 1 ? plotW / (n - 1) : plotW;

    let grid = "", yLabels = "";
    ticks.forEach((t) => {
      const yy = padTop + plotH - (t / scaleMax) * plotH;
      grid += `<line x1="${padLeft}" y1="${yy.toFixed(1)}" x2="${width - padRight}" y2="${yy.toFixed(1)}" stroke="#e6e6e6" stroke-width="1"/>`;
      yLabels += `<text x="${(padLeft - 6).toFixed(1)}" y="${(yy + 3).toFixed(1)}" text-anchor="end" ${AXIS_FONT}>${t}</text>`;
    });

    let xLabels = "";
    const xLabelEvery = Math.max(1, Math.ceil(n / 8));
    model.labels.forEach((label, i) => {
      if (i % xLabelEvery !== 0 && i !== n - 1) return;
      const x = padLeft + i * stepX;
      xLabels += `<text x="${x.toFixed(1)}" y="${(padTop + plotH + 13).toFixed(1)}" text-anchor="middle" ${AXIS_FONT}>${escapeXML(label)}</text>`;
    });

    let lines = "";
    model.datasets.forEach((ds) => {
      const color = ds.borderColor || ds.colorFor(0);
      const pts = ds.data
        .map((v, i) => {
          const x = padLeft + i * stepX;
          const y = padTop + plotH - (v / scaleMax) * plotH;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
      lines += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`;
      ds.data.forEach((v, i) => {
        const x = padLeft + i * stepX;
        const y = padTop + plotH - (v / scaleMax) * plotH;
        lines += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="${color}"/>`;
      });
    });

    const axes =
      `<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="#c9c9c9" stroke-width="1"/>` +
      `<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="#c9c9c9" stroke-width="1"/>`;

    return grid + axes + lines + xLabels + yLabels;
  }

  function buildDoughnutChartSVG(model, width, height) {
    const ds = model.datasets[0] || { data: [], colorFor: () => "#888888" };
    const total = ds.data.reduce((a, b) => a + b, 0) || 1;

    const cx = width * 0.32;
    const cy = height / 2;
    const r = Math.max(10, Math.min(cx, height / 2) - 8);
    const rInner = r * 0.55;

    let angle = -Math.PI / 2;
    let slices = "";
    const legendItems = [];

    model.labels.forEach((label, i) => {
      const val = ds.data[i] || 0;
      const frac = val / total;
      const sweep = frac * Math.PI * 2;
      const startAngle = angle;
      const endAngle = angle + sweep;
      const color = ds.colorFor(i);

      if (val > 0) {
        const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
        const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
        const xi1 = cx + rInner * Math.cos(endAngle), yi1 = cy + rInner * Math.sin(endAngle);
        const xi2 = cx + rInner * Math.cos(startAngle), yi2 = cy + rInner * Math.sin(startAngle);
        const largeArc = sweep > Math.PI ? 1 : 0;
        slices += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${xi1.toFixed(1)} ${yi1.toFixed(1)} A ${rInner.toFixed(1)} ${rInner.toFixed(1)} 0 ${largeArc} 0 ${xi2.toFixed(1)} ${yi2.toFixed(1)} Z" fill="${color}"/>`;
      }
      legendItems.push({ label, color, pct: (frac * 100).toFixed(1) });
      angle = endAngle;
    });

    let legend = "";
    const legendX = width * 0.6;
    let legendY = cy - (legendItems.length * 14) / 2 + 4;
    legendItems.forEach((item) => {
      legend += `<rect x="${legendX.toFixed(1)}" y="${(legendY - 8).toFixed(1)}" width="9" height="9" fill="${item.color}"/>`;
      legend += `<text x="${(legendX + 13).toFixed(1)}" y="${legendY.toFixed(1)}" ${LEGEND_FONT}>${escapeXML(item.label)} (${item.pct}%)</text>`;
      legendY += 14;
    });

    return slices + legend;
  }

  function buildLegendSVG(model, width, yCenter) {
    if (model.datasets.length < 2) return "";
    const items = model.datasets.map((ds, i) => ({
      label: ds.label || `Series ${i + 1}`,
      color: ds.borderColor || ds.colorFor(0),
    }));
    const totalWidth = items.reduce((acc, it) => acc + 20 + it.label.length * 5, 0);
    let x = Math.max(0, (width - totalWidth) / 2);
    let out = "";
    items.forEach((it) => {
      out += `<rect x="${x.toFixed(1)}" y="${(yCenter - 7).toFixed(1)}" width="9" height="9" fill="${it.color}"/>`;
      out += `<text x="${(x + 13).toFixed(1)}" y="${(yCenter + 1).toFixed(1)}" ${LEGEND_FONT}>${escapeXML(it.label)}</text>`;
      x += 20 + it.label.length * 5;
    });
    return out;
  }

  // Reads a live Chart.js canvas and produces an SVG string that mirrors it.
  function buildChartSVG(canvasEl, width, height) {
    const chart = getChartInstance(canvasEl);
    if (!chart) return null;
    const model = extractChartModel(chart);
    if (!model) return null;

    const isPie = model.type === "doughnut" || model.type === "pie";
    const needsLegend = !isPie && model.datasets.length > 1;
    const legendHeight = needsLegend ? 16 : 0;
    const plotHeight = height - legendHeight;

    let body;
    if (isPie) {
      body = buildDoughnutChartSVG(model, width, height);
    } else if (model.type === "line") {
      body = buildLineChartSVG(model, width, plotHeight);
    } else {
      body = buildBarChartSVG(model, width, plotHeight);
    }

    if (needsLegend) {
      body += buildLegendSVG(model, width, height - 5);
    }

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>` +
      body +
      `</svg>`
    );
  }

  // --------------------------------------------------------------------
  // Capture Map (html2canvas) - unchanged; the map is a Leaflet tile
  // layer, not a chart, so it's still captured as an image.
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
          hidden.forEach((s) => {
            const el = clonedDoc.querySelector(s);
            if (el) el.style.setProperty("display", "none", "important");
          });
        },
      });

      if (mapInstance && originalCenter) mapInstance.setView(originalCenter, originalZoom, { animate: false });
      return canvas.toDataURL("image/png", 1.0);
    } catch (e) {
      if (mapInstance && originalCenter) mapInstance.setView(originalCenter, originalZoom, { animate: false });
      return null;
    }
  }

  // --------------------------------------------------------------------
  // svg2pdf.js loader - needed so jsPDF gets a doc.svg() method that
  // draws SVG content as true vector paths/text in the PDF.
  // --------------------------------------------------------------------
  function ensureSvg2pdfLoaded() {
    return new Promise((resolve, reject) => {
      const hasSvgMethod =
        window.jspdf && window.jspdf.jsPDF && typeof window.jspdf.jsPDF.API.svg === "function";
      if (hasSvgMethod) {
        resolve();
        return;
      }
      const existing = document.querySelector('script[data-svg2pdf-loader="true"]');
      if (existing) {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("svg2pdf.js failed to load")));
        return;
      }
      const script = document.createElement("script");
      script.src = SVG2PDF_URL;
      script.dataset.svg2pdfLoader = "true";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("svg2pdf.js failed to load"));
      document.head.appendChild(script);
    });
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
      const colWidth = (pageWidth - margin * 2 - 40) / 2;

      doc.setFont(font, "normal");
      doc.setFontSize(9.5);

      const leftRaw = [
        `Oblast coverage: ${state.oblastLabel}`,
        `Raion coverage: ${state.raionLabel}`,
        `Affected Raions: ${Object.keys(state.raionCounts).length || "N/A"}`,
      ];
      const rightRaw = [
        topRaion ? `Most affected: ${topRaion[0]} (${topRaion[1].toLocaleString()})` : "Most affected: N/A",
        topInfra
          ? `Most damaged infrastructure: ${topInfra[0]} (${topInfra[1].toLocaleString()})`
          : "Most damaged infrastructure: N/A",
        topExtent
          ? `Most common level of damage: ${topExtent[0]} (${topExtent[1].toLocaleString()})`
          : "Most common level of damage: N/A",
      ];

      const leftWrapped = leftRaw.map((str) => doc.splitTextToSize(str, colWidth));
      const rightWrapped = rightRaw.map((str) => doc.splitTextToSize(str, colWidth));
      const leftColHeight = leftWrapped.reduce((acc, lines) => acc + lines.length * 13 + 6, 0);
      const rightColHeight = rightWrapped.reduce((acc, lines) => acc + lines.length * 13 + 6, 0);
      const statBoxHeight = Math.max(leftColHeight, rightColHeight) + 45;

      // Draw Box Layout
      doc.setFillColor(240, 244, 248);
      doc.roundedRect(margin, y, pageWidth - margin * 2, statBoxHeight, 6, 6, "F");
      doc.setFillColor(26, 58, 92);
      doc.rect(margin, y, 4, statBoxHeight, "F");

      doc.setTextColor(68, 68, 68);
      let currentLeftY = y + 20;
      leftWrapped.forEach((lines) => {
        lines.forEach((line) => {
          doc.text(line, margin + 20, currentLeftY);
          currentLeftY += 13;
        });
        currentLeftY += 6;
      });

      let currentRightY = y + 20;
      const rightColX = pageWidth / 2 + 10;
      rightWrapped.forEach((lines) => {
        lines.forEach((line) => {
          doc.text(line, rightColX, currentRightY);
          currentRightY += 13;
        });
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

      // --- PAGE 2: CHARTS AS NATIVE VECTOR SVG, SAME LAYOUT AS THE WEBPAGE ---
      doc.addPage();
      y = margin + 15;

      let svg2pdfReady = true;
      try {
        await ensureSvg2pdfLoaded();
      } catch (e) {
        console.warn(e);
        svg2pdfReady = false;
      }

      if (!svg2pdfReady) {
        doc.setFont(font, "italic");
        doc.setFontSize(9);
        doc.setTextColor(192, 57, 43);
        doc.text("(Charts unavailable - SVG rendering library failed to load)", margin, y);
        y += 20;
      }

      // 1. Timeline Chart (full width, matches the page's top chart)
      const timelineCanvas = document.getElementById(IDS.charts.timeline.id);
      const timelineSVG = svg2pdfReady ? buildChartSVG(timelineCanvas, pageWidth - margin * 2, 200) : null;
      if (timelineSVG) {
        y = await addSVGChart(
          doc, font, IDS.charts.timeline.label, timelineSVG,
          y, margin, pageWidth, pageHeight, pageWidth - margin * 2, 200
        );
      }

      // Bottom grid: two charts side by side, third one centered below -
      // same 2-then-1 grid used on the webpage's chart panel.
      const gridGap = 20;
      const colChartWidth = (pageWidth - margin * 2 - gridGap) / 2;
      const smallChartHeight = 220;

      const topRaionsCanvas = document.getElementById(IDS.charts.topRaions.id);
      const infraCanvas = document.getElementById(IDS.charts.infra.id);
      const extentCanvas = document.getElementById(IDS.charts.extent.id);

      const topRaionsSVG = svg2pdfReady ? buildChartSVG(topRaionsCanvas, colChartWidth, smallChartHeight) : null;
      const infraSVG = svg2pdfReady ? buildChartSVG(infraCanvas, colChartWidth, smallChartHeight) : null;
      const extentSVG = svg2pdfReady ? buildChartSVG(extentCanvas, colChartWidth, smallChartHeight) : null;

      // Make sure the row's two charts land on the same page together.
      if (topRaionsSVG || infraSVG) {
        if (y + smallChartHeight + 40 > pageHeight - margin) {
          doc.addPage();
          y = margin + 15;
        }
      }

      let rowYStart = y;
      let maxRowHeight = 0;

      if (topRaionsSVG) {
        const nextY = await addSVGChart(
          doc, font, IDS.charts.topRaions.label, topRaionsSVG,
          rowYStart, margin, pageWidth, pageHeight, colChartWidth, smallChartHeight, margin
        );
        maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
      }

      if (infraSVG) {
        const nextY = await addSVGChart(
          doc, font, IDS.charts.infra.label, infraSVG,
          rowYStart, margin, pageWidth, pageHeight, colChartWidth, smallChartHeight, margin + colChartWidth + gridGap
        );
        maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
      }

      y = rowYStart + (maxRowHeight > 0 ? maxRowHeight : 0);

      if (extentSVG) {
        const centerX = (pageWidth - colChartWidth) / 2;
        y = await addSVGChart(
          doc, font, IDS.charts.extent.label, extentSVG,
          y, margin, pageWidth, pageHeight, colChartWidth, smallChartHeight, centerX
        );
      }

      // Footer stamp
      const pageCount = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFont(font, "normal");
        doc.setFontSize(8);
        doc.setTextColor(136, 136, 136);
        doc.text("E-PACC Ukraine Project - Sourced from ACAPS. Charts rendered as vector SVG.", margin, pageHeight - 20);
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
  // Embeds a built SVG chart string into the PDF at (xPos, y) as true
  // vector content via svg2pdf.js (doc.svg()).
  // ------------------------------------------------------------------
  async function addSVGChart(doc, font, heading, svgString, y, margin, pageWidth, pageHeight, targetWidth, targetHeight, explicitX = null) {
    const xPos = explicitX !== null ? explicitX : margin;
    const requiredHeight = targetHeight + 40;

    if (y + requiredHeight > pageHeight - margin) {
      doc.addPage();
      y = margin + 15;
    }

    doc.setFont(font, "bold");
    doc.setFontSize(10);
    doc.setTextColor(26, 58, 92);
    doc.text(heading, xPos, y);
    y += 14;

    try {
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svgString, "image/svg+xml");
      const svgEl = svgDoc.documentElement;
      await doc.svg(svgEl, { x: xPos, y: y, width: targetWidth, height: targetHeight });
    } catch (e) {
      console.warn("SVG chart embed failed:", e);
      doc.setFont(font, "italic");
      doc.setFontSize(9);
      doc.setTextColor(192, 57, 43);
      doc.text("(Chart unavailable)", xPos, y + 10);
    }

    return y + targetHeight + 30;
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