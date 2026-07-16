/* ============================================================================
   E-PACC UKRAINE - "Generate PDF Report" for raion_analysis.html
   ============================================================================

   INSTALL
   -------
   1. Add the hook in raion_analysis.js so window.__mapReportState is populated 
      with the real numbers behind the current view.

   2. Add these CDN libraries to raion_analysis.html, then this file, all
      AFTER the existing Leaflet / Chart.js / raion_analysis.js scripts.
      svg2pdf.js embeds the vector SVG charts built below directly into the
      PDF (no rasterization); html2canvas is still used only for the
      Leaflet basemap capture, which has no vector equivalent:

        <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js" defer></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js" defer></script>
        <script src="https://cdn.jsdelivr.net/npm/svg2pdf.js@2/dist/svg2pdf.umd.min.js" defer></script>
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

  // --------------------------------------------------------------------
  // 2. Vector chart builders
  // --------------------------------------------------------------------
  // The four summary charts are rebuilt here as real <svg> markup (not
  // captured off the on-screen <canvas>), then embedded into the PDF as
  // vector graphics via svg2pdf.js. This keeps the report crisp at any
  // zoom level, consistent with the vector text/lines jsPDF already draws
  // elsewhere in the document, instead of dropping in a rasterized PNG
  // snapshot of each chart.
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

  // Horizontal bar chart (Top Raions / Infra Type): category label on the
  // left, bar, and its value just past the bar end - no value axis.
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

      const catText = svgEl("text", {
        x: labelColW - 8, y: cy, "text-anchor": "end", "dominant-baseline": "middle",
        "font-size": "10.5", "font-family": PDF_CHART_FONT, fill: "#444"
      });
      catText.textContent = label;
      svg.appendChild(catText);

      svg.appendChild(svgEl("rect", {
        x: labelColW, y: cy - barH / 2, width: barW, height: barH, rx: 4, ry: 4,
        fill: isHighlighted ? "#d94801" : "#1a3a5c"
      }));

      const valText = svgEl("text", {
        x: labelColW + barW + 8, y: cy, "text-anchor": "start", "dominant-baseline": "middle",
        "font-size": "10.5", "font-family": PDF_CHART_FONT, "font-weight": "600", fill: "#1a3a5c"
      });
      valText.textContent = values[i].toLocaleString();
      svg.appendChild(valText);
    });

    return svg;
  }

  // Vertical column chart (Timeline): value label above each column,
  // period label below - no value axis.
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
        svg.appendChild(svgEl("rect", {
          x: cx - barW / 2, y: barY, width: barW, height: barH, rx: 3, ry: 3, fill: "#1a3a5c"
        }));

        const valText = svgEl("text", {
          x: cx, y: barY - 6, "text-anchor": "middle",
          "font-size": "8.5", "font-family": PDF_CHART_FONT, "font-weight": "600", fill: "#1a3a5c"
        });
        valText.textContent = value.toLocaleString();
        svg.appendChild(valText);
      }

      const lblY = height - bottomPad + 14;
      const lbl = svgEl("text", {
        x: cx, y: lblY, "text-anchor": rotateLabels ? "end" : "middle",
        "font-size": "8", "font-family": PDF_CHART_FONT, fill: "#666",
        transform: rotateLabels ? `rotate(-40 ${cx} ${lblY})` : undefined
      });
      lbl.textContent = label;
      svg.appendChild(lbl);
    });

    return svg;
  }

  function polarPoint(cx, cy, r, angle) {
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  }

  function donutSlicePath(cx, cy, innerR, outerR, startAngle, endAngle) {
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    const p1 = polarPoint(cx, cy, outerR, startAngle);
    const p2 = polarPoint(cx, cy, outerR, endAngle);
    const p3 = polarPoint(cx, cy, innerR, endAngle);
    const p4 = polarPoint(cx, cy, innerR, startAngle);
    return `M ${p1.x} ${p1.y} A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x} ${p2.y} ` +
      `L ${p3.x} ${p3.y} A ${innerR} ${innerR} 0 ${largeArc} 0 ${p4.x} ${p4.y} Z`;
  }

  // Doughnut chart (Level of Damage): slices with outside labels + leader
  // lines, mirroring the on-page chart's outsideDoughnutLabels plugin.
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

      svg.appendChild(svgEl("path", {
        d: donutSlicePath(cx, cy, innerR, outerR, startAngle, endAngle),
        fill: palette[i % palette.length]
      }));

      const mid = (startAngle + endAngle) / 2;
      const isRight = Math.cos(mid) >= 0;
      const lineStart = polarPoint(cx, cy, outerR + 2, mid);
      const bend = polarPoint(cx, cy, outerR + 16, mid);
      const textX = bend.x + (isRight ? 14 : -14);

      svg.appendChild(svgEl("polyline", {
        points: `${lineStart.x},${lineStart.y} ${bend.x},${bend.y} ${textX + (isRight ? -4 : 4)},${bend.y}`,
        fill: "none", stroke: "#999", "stroke-width": "1"
      }));

      const pct = Math.round(frac * 100);
      const text = svgEl("text", {
        x: textX, y: bend.y, "text-anchor": isRight ? "start" : "end", "dominant-baseline": "middle",
        "font-size": "9.5", "font-family": PDF_CHART_FONT, fill: "#333"
      });
      text.textContent = `${label}: ${value.toLocaleString()} (${pct}%)`;
      svg.appendChild(text);
    });

    return svg;
  }

  // Rasterizes an <svg> element as a fallback, only used if svg2pdf.js
  // failed to load - keeps report generation working end-to-end even
  // without the vector-embedding library, at the cost of that one chart
  // no longer being vector in the output.
  function svgToPngDataUrl(svgElement, width, height, scale = 3) {
    return new Promise((resolve, reject) => {
      const svgString = new XMLSerializer().serializeToString(svgElement);
      const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext("2d");
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/png", 1.0));
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
      img.src = url;
    });
  }

  // Embeds an SVG chart into the PDF as vector paths via svg2pdf.js v2
  // (doc.svg). Falls back to a rasterized SVG snapshot, then to the live
  // on-page Chart.js canvas when provided, so a CDN hiccup degrades the
  // output rather than leaving the report blank.
  async function embedSvgChart(doc, svgElement, x, y, width, height, canvasId) {
    svgElement.style.position = "absolute";
    svgElement.style.left = "-99999px";
    svgElement.style.top = "0";
    document.body.appendChild(svgElement);

    try {
      // svg2pdf.js v2 extends jsPDF with doc.svg(); v1 exposed window.svg2pdf().
      if (typeof doc.svg === "function") {
        try {
          await doc.svg(svgElement, { x, y, width, height });
          return true;
        } catch (e) {
          console.warn("doc.svg embed failed, falling back to a rasterized snapshot:", e);
        }
      } else if (typeof window.svg2pdf === "function") {
        try {
          await window.svg2pdf(svgElement, doc, { x, y, width, height });
          return true;
        } catch (e) {
          console.warn("svg2pdf embed failed, falling back to a rasterized snapshot:", e);
        }
      } else {
        console.warn("svg2pdf.js not loaded - falling back to a rasterized snapshot of the chart.");
      }

      const dataUrl = await svgToPngDataUrl(svgElement, width, height);
      doc.addImage(dataUrl, "PNG", x, y, width, height);
      return true;
    } catch (e) {
      console.warn("SVG chart embed failed, trying on-page canvas fallback:", e);
      if (canvasId) {
        const canvas = document.getElementById(canvasId);
        if (canvas && typeof canvas.toDataURL === "function") {
          try {
            doc.addImage(canvas.toDataURL("image/png", 1.0), "PNG", x, y, width, height);
            return true;
          } catch (canvasErr) {
            console.error("Canvas fallback also failed:", canvasErr);
          }
        }
      }
      console.error("Chart embed failed entirely.");
      return false;
    } finally {
      document.body.removeChild(svgElement);
    }
  }

  // Draws a heading, paginating if needed, then embeds the SVG chart in a
  // fixed-size box beneath it. Mirrors addImageWithHeading's layout logic
  // (see below) but for vector SVG content instead of a raster image.
  async function addSvgWithHeading(doc, heading, svgElement, y, margin, pageWidth, pageHeight, targetWidth, explicitX, boxHeight, canvasId) {
    const xPos = explicitX !== null && explicitX !== undefined ? explicitX : margin;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(26, 58, 92);
    const headingLines = doc.splitTextToSize(heading, targetWidth);
    const headingHeight = headingLines.length * 13;

    if (y + boxHeight + headingHeight + 20 > pageHeight - margin) {
      doc.addPage();
      y = margin + 15;
    }

    headingLines.forEach(line => {
      doc.text(line, xPos, y);
      y += 13;
    });
    y += 6;

    await embedSvgChart(doc, svgElement, xPos, y, targetWidth, boxHeight, canvasId);
    return y + boxHeight + 30;
  }

  // A raion/infra/period value highlighted on-screen via the cross-filter
  // should read the same way in the PDF's bar charts.
  function highlightSetFor(dimension, activeFilter) {
    if (!activeFilter || activeFilter.dimension !== dimension) return null;
    return new Set([activeFilter.value]);
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

      // --- GRID CHARTS ATTACHMENT (all rebuilt as vector SVG) ---
      doc.addPage();
      y = margin + 15;

      const series = state.chartSeries || {};

      // 1. Timeline (Full Width)
      if (series.timeline && series.timeline.labels.length) {
        const timelineWidth = pageWidth - margin * 2;
        const timelineHeight = 170;
        const timelineSvg = buildColumnChartSVG(
          series.timeline.labels, series.timeline.values, timelineWidth, timelineHeight
        );
        y = await addSvgWithHeading(
          doc, IDS.charts.timeline.label, timelineSvg, y, margin, pageWidth, pageHeight,
          timelineWidth, margin, timelineHeight, IDS.charts.timeline.id
        );
      }

      const gridGap = 16;
      const colChartWidth = (pageWidth - margin * 2 - gridGap) / 2;

      // Top Raions, Infra Type, and Level of Damage all read as the same
      // "summary chart" size in the PDF, matching how they appear on the
      // page as a uniform row of chart cards.
      const SUMMARY_CHART_HEIGHT_PX = 220;

      let rowYStart = y;
      let maxRowHeight = 0;

      // 2. Top Raions
      if (series.topRaions && series.topRaions.labels.length) {
        const topRaionsSvg = buildHorizontalBarSVG(
          series.topRaions.labels, series.topRaions.values, colChartWidth, SUMMARY_CHART_HEIGHT_PX,
          highlightSetFor("raion", state.activeFilter)
        );
        const nextY = await addSvgWithHeading(
          doc, IDS.charts.topRaions.label, topRaionsSvg, rowYStart, margin, pageWidth, pageHeight,
          colChartWidth, margin, SUMMARY_CHART_HEIGHT_PX, IDS.charts.topRaions.id
        );
        maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
      }

      // 3. Infra Type
      if (series.infra && series.infra.labels.length) {
        const infraSvg = buildHorizontalBarSVG(
          series.infra.labels, series.infra.values, colChartWidth, SUMMARY_CHART_HEIGHT_PX,
          highlightSetFor("infra", state.activeFilter)
        );
        const nextY = await addSvgWithHeading(
          doc, IDS.charts.infra.label, infraSvg, rowYStart, margin, pageWidth, pageHeight,
          colChartWidth, margin + colChartWidth + gridGap, SUMMARY_CHART_HEIGHT_PX, IDS.charts.infra.id
        );
        maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
      }

      y = rowYStart + (maxRowHeight > 0 ? maxRowHeight : 0);

      // 4. Level of Damage (Centered, same box size as the row above)
      if (series.extent && series.extent.labels.length) {
        const extentSvg = buildDonutSVG(
          series.extent.labels, series.extent.values, colChartWidth, SUMMARY_CHART_HEIGHT_PX, CHART_PALETTE
        );
        const centerX = (pageWidth - colChartWidth) / 2;
        y = await addSvgWithHeading(
          doc, IDS.charts.extent.label, extentSvg, y, margin, pageWidth, pageHeight,
          colChartWidth, centerX, SUMMARY_CHART_HEIGHT_PX, IDS.charts.extent.id
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

  // `maxHeight` (optional) locks the image into a shared box of size
  // targetWidth x maxHeight using contain-fit scaling: the image is
  // scaled to fit fully inside that box, preserving its own aspect
  // ratio (never stretched/distorted), and centered horizontally. This
  // is what keeps the Top Raions / Infra Type / Level of Damage charts
  // at one consistent visual size in the PDF even though their source
  // canvases may have different native aspect ratios. Without
  // maxHeight, the image is simply sized to targetWidth and its height
  // follows its own natural aspect ratio (used for the full-width
  // timeline chart).
  function addImageWithHeading(doc, heading, imgDataUrl, y, margin, pageWidth, pageHeight, targetWidth, explicitX = null, maxHeight = null) {
    const xPos = explicitX !== null ? explicitX : margin;
    const props = doc.getImageProperties(imgDataUrl);
    const naturalAspect = props.width / props.height;

    let imgWidth = targetWidth;
    let imgHeight = targetWidth / naturalAspect;

    if (maxHeight) {
      const boxAspect = targetWidth / maxHeight;
      if (naturalAspect > boxAspect) {
        // Relatively wider than the box: width is the limiting dimension.
        imgWidth = targetWidth;
        imgHeight = targetWidth / naturalAspect;
      } else {
        // Relatively taller than the box: height is the limiting dimension.
        imgHeight = maxHeight;
        imgWidth = maxHeight * naturalAspect;
      }
    }

    const drawX = xPos + (targetWidth - imgWidth) / 2;
    const boxHeight = maxHeight || imgHeight;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(26, 58, 92);

    const headingLines = doc.splitTextToSize(heading, targetWidth);
    const headingHeight = headingLines.length * 13;

    if (y + boxHeight + headingHeight + 20 > pageHeight - margin) {
      doc.addPage();
      y = margin + 15;
    }

    headingLines.forEach((line) => {
      doc.text(line, xPos, y);
      y += 13;
    });
    y += 6;

    doc.addImage(imgDataUrl, "PNG", drawX, y, imgWidth, imgHeight);
    return y + boxHeight + 30;
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