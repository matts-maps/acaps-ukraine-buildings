/* ============================================================================
   ChartSVGBuilders — shared vector chart drawing, used by both the PDF report
   generator (report-generator-core.js) and the on-page "Export SVG" buttons
   (map-export-buttons.js). Extracted out of report-generator-core.js so both
   callers draw from the exact same functions against the exact same
   chartSeries data (window.__mapReportState.chartSeries) — the downloaded
   SVG and the PDF's embedded chart are guaranteed identical, rather than
   two independent implementations of the same chart drifting apart.

   INSTALL: include after Chart.js, before map-analysis-core.js (no
   dependency on either — this file is pure SVG/canvas-measurement code).
   ========================================================================== */

(function () {
  "use strict";

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

  // Vertical column chart (Timeline). `labels` entries are either a plain
  // string, or a 2-element [primaryLine, yearLine] array (the date-range
  // bucket labels built by MapCore.buildDateBuckets always use the latter,
  // so the year renders on its own row under the date/month) - both are
  // handled here via primaryLineOf/yearLineOf.
  function primaryLineOf(label) {
    return Array.isArray(label) ? label[0] : label;
  }
  function yearLineOf(label) {
    return Array.isArray(label) ? label[1] : null;
  }

  function buildColumnChartSVG(labels, values, width, height) {
    const svg = newSvgRoot(width, height);
    if (!labels.length) return svg;

    const max = Math.max(1, ...values);
    const topPad = 22;
    const bottomPad = 40; // extra room for the two-line (date + year) axis labels
    const plotH = height - topPad - bottomPad;
    const colW = width / labels.length;
    const barW = Math.min(26, colW * 0.6);
    const fontSize = 8;
    const yearFontSize = 7;
    const labelLineGap = 10;

    // Keep axis labels horizontal at all times (matching the webpage's
    // Chart.js timeline) by thinning them out - showing only every Nth
    // label - rather than rotating them when there are too many to fit.
    // This mirrors Chart.js's own autoSkip behaviour for category axes.
    // Monthly-granularity primary labels are single letters (J F M A M J
    // J A S O N D), narrow enough to always show in full, so thinning
    // only ever applies to the longer date-range labels the other
    // granularities use.
    const allSingleChar = labels.every(l => primaryLineOf(l).length <= 2);
    let step = 1;
    if (!allSingleChar) {
      while (step < labels.length) {
        let widest = 0;
        for (let i = 0; i < labels.length; i += step) {
          widest = Math.max(widest, measureTextWidth(primaryLineOf(labels[i]), fontSize));
        }
        if (widest <= colW * step * 0.85) break;
        step++;
      }
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

      const lblY = height - bottomPad + 14;

      // The primary (date/month) label respects the thinning step - but
      // the year row does not: it's drawn independently at every bucket
      // that carries a year (exactly one per calendar year, see
      // MapCore.buildDateBuckets), regardless of whether this particular
      // index's primary label was thinned out. Tying the year to the same
      // "i % step" gate as the primary label meant a year could silently
      // never render at all, whenever its bucket's index didn't happen to
      // land on a step boundary.
      if (i % step === 0) {
        const lbl = svgEl("text", {
          x: cx, y: lblY, "text-anchor": "middle",
          "font-size": String(fontSize), "font-family": PDF_CHART_FONT, fill: "#666"
        });
        lbl.textContent = primaryLineOf(label);
        svg.appendChild(lbl);
      }

      const yearText = yearLineOf(label);
      if (yearText) {
        const yearLbl = svgEl("text", {
          x: cx, y: lblY + labelLineGap, "text-anchor": "middle",
          "font-size": String(yearFontSize), "font-family": PDF_CHART_FONT, fill: "#999"
        });
        yearLbl.textContent = yearText;
        svg.appendChild(yearLbl);
      }
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
    // draw text on top of each other. Generous on purpose - this is the
    // main defence against a cluttered-looking label stack.
    const LINE_HEIGHT = 22;
    // Slices whose mid-angles are this close together (e.g. several tiny
    // slivers bunched at the seam where the ring wraps back to its start)
    // keep whichever side the previous one landed on, rather than being
    // independently split left/right by a hair's-width angle difference -
    // that's what previously sent their leader lines criss-crossing each
    // other and the ring itself.
    const SAME_SIDE_ANGLE_THRESHOLD = 8 * (Math.PI / 180);
    // Each subsequent label stacked on the same side reaches out this much
    // further before turning toward its text than the previous one -
    // fanning the elbows out instead of bunching them at a single point
    // right off the ring, which is what made tightly-clustered slivers'
    // leader lines look tangled even when they didn't literally cross.
    const BEND_RADIUS_STEP = 10;

    const leftEntries = [];
    const rightEntries = [];
    let lastMid = null;
    let lastIsRight = null;

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
      let isRight = Math.cos(mid) >= 0;
      if (lastMid !== null && Math.abs(mid - lastMid) < SAME_SIDE_ANGLE_THRESHOLD) {
        isRight = lastIsRight;
      }
      lastMid = mid;
      lastIsRight = isRight;

      const text = `${label}: ${value.toLocaleString()}`;
      (isRight ? rightEntries : leftEntries).push({ mid, text });
    });

    // Builds each side's label geometry after grouping, so the elbow
    // (bend) radius can be staggered by position within the stack -
    // fanning same-side leader lines out from the ring instead of routing
    // them all to the same distance before turning.
    function buildSideLabels(entries, isRight) {
      return entries.map((e, idx) => {
        const bendRadius = outerR + 22 + idx * BEND_RADIUS_STEP;
        const lineStart = polarPoint(cx, cy, outerR + 4, e.mid);
        const bend = polarPoint(cx, cy, bendRadius, e.mid);
        const textX = bend.x + (isRight ? 16 : -16);
        return { lineStart, bend, textX, textY: bend.y, text: e.text, isRight };
      });
    }

    const leftLabels = buildSideLabels(leftEntries, false);
    const rightLabels = buildSideLabels(rightEntries, true);

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

  window.ChartSVGBuilders = {
    PDF_CHART_FONT,
    CHART_PALETTE,
    svgEl,
    measureTextWidth,
    wrapLabelText,
    newSvgRoot,
    buildHorizontalBarSVG,
    buildColumnChartSVG,
    buildDonutSVG
  };
})();
