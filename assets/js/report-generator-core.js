/* ============================================================================
   E-PACC UKRAINE - Shared "Generate PDF Report" engine
   ============================================================================

   Common PDF/report-building logic for oblast_analysis.html and
   raion_analysis.html. Each page loads this file first, then a thin
   per-page config file (oblast-report-generator.js / report-generator.js)
   that calls window.EPACCReportGenerator.init({...}) with the handful of
   labels/keys/hooks that actually differ between the two views.

   INSTALL
   -------
   1. Add the hook in the page's analysis script so window.__mapReportState
      is populated with the real numbers behind the current view.

   2. Add these CDN libraries to the page, then this file, then the page's
      config file, all AFTER the existing Leaflet / Chart.js / analysis
      scripts. svg2pdf.js embeds the vector SVG charts built below directly
      into the PDF (no rasterization); html2canvas is still used only for
      the Leaflet basemap capture, which has no vector equivalent:

        <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js" defer></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js" defer></script>
        <script src="https://cdn.jsdelivr.net/npm/svg2pdf.js@2/dist/svg2pdf.umd.min.js" defer></script>
        <script src="{{ '/assets/js/report-generator-core.js' | relative_url }}" defer></script>
        <script src="{{ '/assets/js/oblast-report-generator.js' | relative_url }}" defer></script>

   3. The button is injected automatically into #map-controls, right after
      the ".map-hint" paragraph. No HTML edits required.
   ========================================================================== */

(function () {
  "use strict";

  const IDS_BASE = {
    // The whole map card (Leaflet map + the two-column legend/"areas of
    // control" panel directly beneath it), so the PDF capture includes the
    // legend rather than just the bare map.
    mapContainer: "map-wrapper-card",
    yearSelect: "map-year-select",
    aggSelect: "map-aggregation-select",
    startSelect: "map-period-start-select",
    endSelect: "map-period-end-select",
    totalValue: "map-total-value",
    activeFilterGroup: "map-active-filter-group",
    activeFilterLabel: "map-active-filter-label",
  };

  const BUTTON_INSERT_AFTER_SELECTOR = ".map-hint";

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
  // Vector chart builders
  // --------------------------------------------------------------------
  // The four summary charts are rebuilt here as real <svg> markup (not
  // captured off the on-screen <canvas>), then embedded into the PDF as
  // vector graphics via svg2pdf.js.
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

  // Measures how wide a label would render at a given font size/weight,
  // using an offscreen canvas - used to decide when a label needs to be
  // wrapped, skipped, or thinned so it never overlaps a neighbour.
  let _measureCanvas = null;
  function measureTextWidth(text, fontSizePx, fontWeight = "400") {
    if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
    const ctx = _measureCanvas.getContext("2d");
    ctx.font = `${fontWeight} ${fontSizePx}px ${PDF_CHART_FONT}`;
    return ctx.measureText(text).width;
  }

  // Splits a label into wrappable tokens: breaks on whitespace (discarding
  // it) and also right after a "/" (keeping the slash attached, no space
  // inserted afterwards) - so long slash-joined phrases like
  // "Industrial/Business/Enterprise facilities" can wrap at the slashes,
  // not just at the one space in the whole string.
  function tokenizeLabel(text) {
    const tokens = [];
    let current = "";
    for (const ch of text) {
      if (/\s/.test(ch)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
      } else {
        current += ch;
        if (ch === "/") {
          tokens.push(current);
          current = "";
        }
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }

  // Joins already-wrapped line fragments back together, respecting the
  // same no-space-after-slash rule tokenizeLabel/wrapLabelText use.
  function joinLineFragments(fragments) {
    return fragments.reduce((acc, line) => {
      if (!acc) return line;
      const sep = acc.endsWith("/") ? "" : " ";
      return `${acc}${sep}${line}`;
    }, "");
  }

  // Trims text to the longest prefix that fits maxWidth with a trailing
  // "…" appended.
  function truncateWithEllipsis(text, maxWidth, fontSizePx) {
    if (measureTextWidth(text, fontSizePx) <= maxWidth) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = `${text.slice(0, mid).trimEnd()}…`;
      if (measureTextWidth(candidate, fontSizePx) <= maxWidth) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return `${text.slice(0, low).trimEnd()}…`;
  }

  // Greedily wraps a label into the fewest lines that each fit maxWidth,
  // capped at maxLines - any remainder beyond that is merged into the
  // final line and truncated with an ellipsis rather than adding more lines.
  function wrapLabelText(text, maxWidth, fontSizePx, maxLines = 2) {
    const tokens = tokenizeLabel(String(text));
    if (!tokens.length) return [String(text)];

    const lines = [];
    let current = "";
    tokens.forEach((token) => {
      // No space is inserted between a token and the next if the token
      // already ends in "/" (e.g. "Industrial/" followed by "Business/").
      const sep = current && !current.endsWith("/") ? " " : "";
      const candidate = current ? `${current}${sep}${token}` : token;
      if (current && measureTextWidth(candidate, fontSizePx) > maxWidth) {
        lines.push(current);
        current = token;
      } else {
        current = candidate;
      }
    });
    if (current) lines.push(current);

    if (lines.length <= maxLines) return lines;

    const kept = lines.slice(0, maxLines - 1);
    const overflowText = joinLineFragments(lines.slice(maxLines - 1));
    kept.push(truncateWithEllipsis(overflowText, maxWidth, fontSizePx));
    return kept;
  }

  function newSvgRoot(width, height) {
    return svgEl("svg", { xmlns: SVG_NS, width, height, viewBox: `0 0 ${width} ${height}` });
  }

  // Horizontal bar chart (Top Oblasts/Raions / Infra Type)
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

      // Wrap the category label onto as many lines as it needs to fit the
      // label column, rather than letting long labels (e.g. infrastructure
      // type names) overflow or run into the bar.
      const maxLabelWidth = labelColW - 8;
      const fontSize = 8;
      const lineHeight = fontSize + 2.5;
      const lines = wrapLabelText(label, maxLabelWidth, fontSize);
      const firstLineY = cy - ((lines.length - 1) * lineHeight) / 2;

      lines.forEach((line, li) => {
        const catText = svgEl("text", {
          x: labelColW - 8, y: firstLineY + li * lineHeight, "text-anchor": "end", "dominant-baseline": "middle",
          "font-size": String(fontSize), "font-family": PDF_CHART_FONT, fill: "#444"
        });
        catText.textContent = line;
        svg.appendChild(catText);
      });

      svg.appendChild(svgEl("rect", {
        x: labelColW, y: cy - barH / 2, width: barW, height: barH, rx: 4, ry: 4,
        fill: isHighlighted ? "#d94801" : "#1a3a5c"
      }));

      const valText = svgEl("text", {
        x: labelColW + barW + 8, y: cy, "text-anchor": "start", "dominant-baseline": "middle",
        "font-size": "8", "font-family": PDF_CHART_FONT, "font-weight": "600", fill: "#1a3a5c"
      });
      valText.textContent = values[i].toLocaleString();
      svg.appendChild(valText);
    });

    return svg;
  }

  // Vertical column chart (Timeline)
  function buildColumnChartSVG(labels, values, width, height) {
    const svg = newSvgRoot(width, height);
    if (!labels.length) return svg;

    const max = Math.max(1, ...values);
    const topPad = 22;
    const bottomPad = 34;
    const plotH = height - topPad - bottomPad;
    const colW = width / labels.length;
    const barW = Math.min(26, colW * 0.6);
    const fontSize = 8;

    // Keep axis labels horizontal at all times (matching the webpage's
    // Chart.js timeline) by thinning them out - showing only every Nth
    // label - rather than rotating them when there are too many to fit.
    // This mirrors Chart.js's own autoSkip behaviour for category axes.
    let step = 1;
    while (step < labels.length) {
      let widest = 0;
      for (let i = 0; i < labels.length; i += step) {
        widest = Math.max(widest, measureTextWidth(labels[i], fontSize));
      }
      if (widest <= colW * step * 0.85) break;
      step++;
    }

    labels.forEach((label, i) => {
      const cx = colW * i + colW / 2;
      const value = values[i];

      if (value > 0) {
        const barH = Math.max((value / max) * plotH, 1);
        const barY = topPad + (plotH - barH);
        svg.appendChild(svgEl("rect", {
          x: cx - barW / 2, y: barY, width: barW, height: barH, rx: 3, ry: 3, fill: "#1a3a5c"
        }));

        // Updated to match web: size 8, weight 600. Skipped if the column
        // is too narrow to fit the label without touching its neighbours
        // (matches the webpage's Chart.js timeline behaviour).
        const valueText = value.toLocaleString();
        if (measureTextWidth(valueText, 8, "600") <= colW * 0.85) {
          const valText = svgEl("text", {
            x: cx, y: barY - 6, "text-anchor": "middle",
            "font-size": "8", "font-family": PDF_CHART_FONT, "font-weight": "600", fill: "#1a3a5c"
          });
          valText.textContent = valueText;
          svg.appendChild(valText);
        }
      }

      if (i % step !== 0) return;

      const lblY = height - bottomPad + 14;
      const lbl = svgEl("text", {
        x: cx, y: lblY, "text-anchor": "middle",
        "font-size": String(fontSize), "font-family": PDF_CHART_FONT, fill: "#666"
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

  // Doughnut chart (Level of Damage)
  function buildDonutSVG(labels, values, width, height, palette) {
    const svg = newSvgRoot(width, height);
    const total = values.reduce((a, b) => a + b, 0);
    if (!total) return svg;

    const cx = width / 2;
    const cy = height / 2;
    const outerR = Math.max(30, Math.min(width, height) / 2 - 62);
    const innerR = outerR * 0.55;

    // Minimum vertical gap enforced between two label lines on the same
    // side of the ring, so neighbouring slices with similar angles never
    // draw text on top of each other.
    const LINE_HEIGHT = 13;
    const leftLabels = [];
    const rightLabels = [];

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
      const pct = Math.round(frac * 100);
      const text = `${label}: ${value.toLocaleString()} (${pct}%)`;

      const entry = { lineStart, bend, textX, textY: bend.y, text, isRight };
      (isRight ? rightLabels : leftLabels).push(entry);
    });

    // Within each side, walk top-to-bottom pushing any label too close to
    // the one above it further down; if that runs the stack past the
    // bottom of the chart, compress gaps upward from the bottom instead so
    // the whole stack stays on screen.
    function declutter(list) {
      list.sort((a, b) => a.textY - b.textY);
      for (let i = 1; i < list.length; i++) {
        if (list[i].textY - list[i - 1].textY < LINE_HEIGHT) {
          list[i].textY = list[i - 1].textY + LINE_HEIGHT;
        }
      }
      const maxY = height - 4;
      if (list.length && list[list.length - 1].textY > maxY) {
        list[list.length - 1].textY = maxY;
        for (let i = list.length - 2; i >= 0; i--) {
          if (list[i + 1].textY - list[i].textY < LINE_HEIGHT) {
            list[i].textY = list[i + 1].textY - LINE_HEIGHT;
          }
        }
      }
    }

    declutter(leftLabels);
    declutter(rightLabels);

    [...leftLabels, ...rightLabels].forEach(({ lineStart, bend, textX, textY, text, isRight }) => {
      svg.appendChild(svgEl("polyline", {
        // Elbow at the slice's natural angle first, then a vertical run to
        // the label's (possibly decluttered) final height.
        points: `${lineStart.x},${lineStart.y} ${bend.x},${bend.y} ${bend.x},${textY} ${textX + (isRight ? -4 : 4)},${textY}`,
        fill: "none", stroke: "#999", "stroke-width": "1"
      }));

      const textEl = svgEl("text", {
        x: textX, y: textY, "text-anchor": isRight ? "start" : "end", "dominant-baseline": "middle",
        "font-size": "8", "font-family": PDF_CHART_FONT, fill: "#333"
      });
      textEl.textContent = text;
      svg.appendChild(textEl);
    });

    return svg;
  }

  // Rasterizes an <svg> element as a fallback
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

  async function embedSvgChart(doc, svgElement, x, y, width, height, canvasId) {
    svgElement.style.position = "absolute";
    svgElement.style.left = "-99999px";
    svgElement.style.top = "0";
    document.body.appendChild(svgElement);

    try {
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

  function measureHeadingHeight(doc, heading, targetWidth) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    return doc.splitTextToSize(heading, targetWidth).length * 13;
  }

  async function addSvgWithHeading(doc, heading, svgElement, y, margin, pageWidth, pageHeight, targetWidth, explicitX, boxHeight, canvasId) {
    const xPos = explicitX !== null && explicitX !== undefined ? explicitX : margin;
    const headingHeight = measureHeadingHeight(doc, heading, targetWidth);
    doc.setTextColor(26, 58, 92);
    const headingLines = doc.splitTextToSize(heading, targetWidth);
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

  function highlightSetFor(dimension, activeFilter) {
    if (!activeFilter || activeFilter.dimension !== dimension) return null;
    return new Set([activeFilter.value]);
  }

  function neutralizeLeafletSvgOffsets(mapEl) {
    const svgs = mapEl.querySelectorAll(".leaflet-overlay-pane svg");
    const restoreFns = [];
    svgs.forEach((svg) => {
      const viewBoxAttr = svg.getAttribute("viewBox");
      if (!viewBoxAttr) return;
      const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number);
      if (parts.length !== 4 || parts.some(Number.isNaN)) return;
      const [vx, vy, vw, vh] = parts;
      if (!vx && !vy) return;
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
        await new Promise((resolve) => {
          mapInstance.once("moveend", () => {
            setTimeout(resolve, 500);
          });
          mapInstance.fitBounds(targetBounds, { padding: [20, 20], animate: false });
        });
      }
    }
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
            ".leaflet-control-attribution",
            // The page's own <h2> title is skipped since the PDF already
            // writes its own heading (config.mapImageHeading) above this
            // captured image via addImageWithHeading.
            "#map-view-title"
          ];
          selectorsToHide.forEach(selector => {
            const element = clonedDoc.querySelector(selector);
            if (element) {
              element.style.setProperty("display", "none", "important");
            }
          });
        }
      });
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
      restoreSvgOffsets();
    }
  }

  function addImageWithHeading(doc, heading, imgDataUrl, y, margin, pageWidth, pageHeight, targetWidth, explicitX = null, maxHeight = null) {
    const xPos = explicitX !== null ? explicitX : margin;
    const props = doc.getImageProperties(imgDataUrl);
    const naturalAspect = props.width / props.height;
    let imgWidth = targetWidth;
    let imgHeight = targetWidth / naturalAspect;
    if (maxHeight) {
      const boxAspect = targetWidth / maxHeight;
      if (naturalAspect > boxAspect) {
        imgWidth = targetWidth;
        imgHeight = targetWidth / naturalAspect;
      } else {
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
  // Per-page wiring - everything above is identical for every view;
  // `config` supplies the handful of things that genuinely differ between
  // the Oblast and Raion reports.
  // --------------------------------------------------------------------
  function init(config) {
    const IDS = {
      ...IDS_BASE,
      charts: {
        timeline: { id: "map-timeline-chart", label: "Timeline of damaged buildings" },
        [config.entitySeriesKey]: { id: "map-top-oblasts-chart", label: config.entityChartLabel },
        infra: { id: "map-infra-type-chart", label: "Damage by infrastructure type" },
        extent: { id: "map-extent-chart", label: "Level of damage" }
      },
    };
    const entityChart = IDS.charts[config.entitySeriesKey];

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
          [config.entityCountsKey]: state[config.entityCountsKey] || {},
          infraCounts: state.infraCounts || {},
          extentCounts: state.extentCounts || {},
          chartSeries: state.chartSeries || null,
          activeFilter: state.activeFilter || null,
          ...config.getExtraStateFromHook(state),
        };
      }

      return {
        year: yearEl ? yearEl.value : "N/A",
        aggregationLabel: aggEl ? aggEl.options[aggEl.selectedIndex]?.text : "N/A",
        startLabel: startEl ? startEl.options[startEl.selectedIndex]?.text : "N/A",
        endLabel: endEl ? endEl.options[endEl.selectedIndex]?.text : "N/A",
        nationalTotal: totalEl ? totalEl.textContent.trim() : "0",
        activeFilterText,
        [config.entityCountsKey]: {},
        infraCounts: {},
        extentCounts: {},
        chartSeries: null,
        activeFilter: null,
        ...config.getExtraStateFallback(),
      };
    }

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

        doc.setFillColor(26, 58, 92);
        doc.rect(0, 0, pageWidth, 8, "F");
        y += 15;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(22);
        doc.setTextColor(26, 58, 92);
        doc.text("E-PACC Ukraine", margin, y);
        y += 22;
        doc.setFontSize(14);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(102, 102, 102);
        doc.text(config.reportSubtitle, margin, y);
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
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.setTextColor(26, 58, 92);
        doc.text("Summary Statistics", margin, y);
        y += 12;
        const topEntity = topEntry(state[config.entityCountsKey]);
        const topInfra = topEntry(state.infraCounts);
        const topExtent = topEntry(state.extentCounts);
        const colWidth = (pageWidth - (margin * 2) - 40) / 2;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9.5);
        const leftRaw = config.buildSummaryLeftLines(state);
        const rightRaw = [
          topEntity ? `Most affected: ${topEntity[0]} (${topEntity[1].toLocaleString()})` : "Most affected: N/A",
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
        const mapEl = document.getElementById(IDS.mapContainer);
        const mapImg = await captureMap(mapEl);
        if (mapImg) {
          // The captured image now includes the legend below the map, so
          // it's taller than the map alone - explicitly cap it to whatever
          // vertical space is left on this page, rather than letting
          // addImageWithHeading's own overflow check push it to page 2.
          // The map (and its legend) must stay on the report's first page.
          const mapTargetWidth = pageWidth - margin * 2;
          const mapHeadingHeight = measureHeadingHeight(doc, config.mapImageHeading, mapTargetWidth);
          const availableMapHeight = Math.max(150, pageHeight - margin - y - mapHeadingHeight - 20);
          y = addImageWithHeading(doc, config.mapImageHeading, mapImg, y, margin, pageWidth, pageHeight, mapTargetWidth, null, availableMapHeight);
        } else {
          doc.setFont("helvetica", "italic");
          doc.setFontSize(10);
          doc.setTextColor(192, 57, 43);
          doc.text("(Map image unavailable)", margin, y);
          y += 25;
        }
        doc.addPage();
        y = margin + 15;
        const series = state.chartSeries || {};
        if (series.timeline && series.timeline.labels.length) {
          const timelineWidth = pageWidth - margin * 2;
          const timelineHeight = 170;
          const timelineSvg = buildColumnChartSVG(series.timeline.labels, series.timeline.values, timelineWidth, timelineHeight);
          y = await addSvgWithHeading(doc, IDS.charts.timeline.label, timelineSvg, y, margin, pageWidth, pageHeight, timelineWidth, margin, timelineHeight, IDS.charts.timeline.id);
        }
        const gridGap = 16;
        const colChartWidth = (pageWidth - margin * 2 - gridGap) / 2;
        const SUMMARY_CHART_HEIGHT_PX = 220;
        let rowYStart = y;
        let maxRowHeight = 0;
        const entitySeries = series[config.entitySeriesKey];
        const rowHeadingHeight = Math.max(
          entitySeries && entitySeries.labels.length ? measureHeadingHeight(doc, entityChart.label, colChartWidth) : 0,
          series.infra && series.infra.labels.length ? measureHeadingHeight(doc, IDS.charts.infra.label, colChartWidth) : 0
        );
        if (rowYStart + SUMMARY_CHART_HEIGHT_PX + rowHeadingHeight + 20 > pageHeight - margin) {
          doc.addPage();
          rowYStart = margin + 15;
        }
        if (entitySeries && entitySeries.labels.length) {
          const entitySvg = buildHorizontalBarSVG(entitySeries.labels, entitySeries.values, colChartWidth, SUMMARY_CHART_HEIGHT_PX, highlightSetFor(config.entityDimension, state.activeFilter));
          const nextY = await addSvgWithHeading(doc, entityChart.label, entitySvg, rowYStart, margin, pageWidth, pageHeight, colChartWidth, margin, SUMMARY_CHART_HEIGHT_PX, entityChart.id);
          maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
        }
        if (series.infra && series.infra.labels.length) {
          const infraSvg = buildHorizontalBarSVG(series.infra.labels, series.infra.values, colChartWidth, SUMMARY_CHART_HEIGHT_PX, highlightSetFor("infra", state.activeFilter));
          const nextY = await addSvgWithHeading(doc, IDS.charts.infra.label, infraSvg, rowYStart, margin, pageWidth, pageHeight, colChartWidth, margin + colChartWidth + gridGap, SUMMARY_CHART_HEIGHT_PX, IDS.charts.infra.id);
          maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
        }
        y = rowYStart + (maxRowHeight > 0 ? maxRowHeight : 0);
        if (series.extent && series.extent.labels.length) {
          const extentSvg = buildDonutSVG(series.extent.labels, series.extent.values, colChartWidth, SUMMARY_CHART_HEIGHT_PX, CHART_PALETTE);
          const centerX = (pageWidth - colChartWidth) / 2;
          y = await addSvgWithHeading(doc, IDS.charts.extent.label, extentSvg, y, margin, pageWidth, pageHeight, colChartWidth, centerX, SUMMARY_CHART_HEIGHT_PX, IDS.charts.extent.id);
        }
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
          doc.setPage(i);
          doc.setFontSize(8);
          doc.setTextColor(136, 136, 136);
          doc.text("E-PACC Ukraine Project - Created by MapAction and ACAPS. Data sourced from ACAPS.", margin, pageHeight - 20);
          doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin - 45, pageHeight - 20);
        }
        const safeYear = String(state.year || "report").replace(/\s+/g, "_");
        doc.save(`${config.filenamePrefix}_${safeYear}.pdf`);
      } catch (err) {
        console.error("Report generation failed:", err);
        alert("Something went wrong generating the report.");
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      }
    }

    function injectButton() {
      if (document.getElementById("generate-report-btn")) return;
      const anchor = document.querySelector(BUTTON_INSERT_AFTER_SELECTOR);
      if (!anchor) return;
      const btn = document.createElement("button");
      btn.id = "generate-report-btn";
      btn.type = "button";
      btn.textContent = "Generate PDF Report";
      // Styling (including :hover) lives in .map-report-btn in the page's
      // CSS file, so it always matches the other buttons in #map-controls
      // instead of drifting via an inline style override.
      btn.className = "map-report-btn";
      btn.addEventListener("click", generateReport);
      anchor.insertAdjacentElement("afterend", btn);
    }

    function initPage() {
      injectButton();
      if (!document.getElementById("generate-report-btn")) {
        console.warn("report-generator-core.js: could not find '.map-hint' to attach the button near.");
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initPage);
    } else {
      initPage();
    }
  }

  window.EPACCReportGenerator = { init };
})();
