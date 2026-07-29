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

  // Shrinks "<category>: <count>" to fit maxWidth by trimming the category
  // from the end and appending an ellipsis, keeping ": <count>" intact
  // since the count is the number the label exists to show. Falls back to
  // "…: <count>" if even that overflows - callers clamp position
  // afterwards, so a few px of residual overflow there is never visible as
  // an overlap. Kept in sync with the equivalent helper in
  // map-analysis-core.js (outsideDoughnutLabelsPlugin) - same algorithm,
  // duplicated because this file has no dependency on that one.
  function fitLabelToWidth(category, countText, maxWidth, measure) {
    const full = `${category}: ${countText}`;
    if (measure(full) <= maxWidth) return { text: full, width: measure(full) };
    const suffix = `: ${countText}`;
    let cat = category;
    while (cat.length > 1) {
      cat = cat.slice(0, -1);
      const candidate = `${cat}…${suffix}`;
      const w = measure(candidate);
      if (w <= maxWidth) return { text: candidate, width: w };
    }
    const countOnly = `…${suffix}`;
    return { text: countOnly, width: measure(countOnly) };
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
    // Fixed vertical inset reserved for the ring (unaffected by this fix -
    // only the horizontal/left-right label budget is sized dynamically
    // below).
    const VERTICAL_INSET = 180;

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
    const SAME_SIDE_ANGLE_THRESHOLD = 10 * (Math.PI / 180);
    // How far outside the ring a label's line bends toward its text.
    const ELBOW_OFFSET = 30;
    // A slice whose mid-angle sits this close to due-up/due-down has
    // barely any geometric lean toward either side, so it's free to settle
    // on whichever side is less crowded rather than being stuck with
    // whatever the cosine's sign happens to be.
    const NEAR_POLE_COS = 0.05;
    // A 10px buffer keeps labels from ever touching the SVG edge itself.
    const EDGE_BUFFER = 10;
    // Gap between the elbow point and the text.
    const TEXT_GAP = 16;
    // Minimum gap a label's near edge must keep from the ring's own
    // vertical centerline - the hard stop that keeps a long label from
    // drifting across the ring into the opposite side's territory. Kept in
    // sync with DL_CENTER_GAP in map-analysis-core.js.
    const CENTER_GAP = 12;
    // Floor and ceiling for the reserved label band on each side of the
    // ring, sized below from the actual longest label.
    const MIN_SIDE_PADDING = 70;
    const MAX_SIDE_PADDING_FRACTION = 0.42;
    // Even in the tightest possible squeeze, a truncated label keeps at
    // least this much width so "…: <count>" always has room to draw.
    const MIN_LABEL_WIDTH = 30;
    // Floor for the elbow's distance beyond the ring (as an addition to
    // outerR) - the elbow radius shrinks toward this, from the default
    // ELBOW_OFFSET, whenever needed to keep the bend at the elbow no
    // sharper than a right angle (see the final draw loop). Kept in sync
    // with DL_MIN_ELBOW_OFFSET in map-analysis-core.js.
    const MIN_ELBOW_OFFSET = 10;

    const leftEntries = [];
    const rightEntries = [];
    const sliceEntries = [];
    let lastMid = null;
    let lastIsRight = null;

    // Pass A: walk the slices to assign left/right sides and measure each
    // label's natural (untruncated) width, WITHOUT drawing anything yet -
    // outerR (and therefore the slice paths and label geometry) can't be
    // finalized until the label-side widths are known, so the actual
    // <path>/<polyline>/<text> elements are appended later, in Pass C/D.
    let angle = -Math.PI / 2;
    labels.forEach((label, i) => {
      const value = values[i];
      const frac = value / total;
      const startAngle = angle;
      const endAngle = angle + frac * Math.PI * 2;
      angle = endAngle;
      if (!value) return;

      sliceEntries.push({ startAngle, endAngle, paletteIndex: i });

      const mid = (startAngle + endAngle) / 2;
      let isRight = Math.cos(mid) >= 0;
      if (lastMid !== null && Math.abs(mid - lastMid) < SAME_SIDE_ANGLE_THRESHOLD) {
        isRight = lastIsRight;
      }
      lastMid = mid;
      lastIsRight = isRight;

      const category = label;
      const countText = value.toLocaleString();
      const naturalWidth = measureTextWidth(`${category}: ${countText}`, 8);
      // The ring departure point always stays at the slice's own true
      // angle - nudging it toward a neighbour (as an earlier version did,
      // to fan out tightly clustered slivers) could flip which side of the
      // ring it geometrically sits on, sending its leader line back across
      // the chart to reach a label anchored on the opposite side.
      (isRight ? rightEntries : leftEntries).push({ mid, category, countText, naturalWidth, isRight });
    });

    // A near-pole entry can just as validly anchor its label on the other
    // side; move it there when that side has meaningfully fewer labels
    // stacked already, since that's what actually relieves crowding rather
    // than an angle nudge that only shifts where the line leaves the ring
    // by a pixel or two. Where several entries qualify, the one closest to
    // true up/down (smallest |cos|) moves first - it has the least
    // geometric preference for either side, so it's the one that should
    // give way.
    function rebalanceNearPole(from, to) {
      const candidates = from
        .filter(e => Math.abs(Math.cos(e.mid)) < NEAR_POLE_COS)
        .sort((a, b) => Math.abs(Math.cos(a.mid)) - Math.abs(Math.cos(b.mid)));
      for (const e of candidates) {
        if (to.length < from.length - 1) {
          from.splice(from.indexOf(e), 1);
          e.isRight = !e.isRight;
          to.push(e);
        }
      }
    }
    rebalanceNearPole(leftEntries, rightEntries);
    rebalanceNearPole(rightEntries, leftEntries);

    // Pass B: reserved label band per side, sized from the actual longest
    // label rather than a fixed guess - clamped so it never shrinks the
    // ring away entirely or eats the whole image on a narrow export. The
    // draw-time clamp in Pass D is still what guarantees no overlap if
    // this estimate turns out to be a little off. Kept in sync with
    // computeOutsideLabelPadding in map-analysis-core.js.
    const maxLeftWidth = leftEntries.reduce((m, e) => Math.max(m, e.naturalWidth), 0);
    const maxRightWidth = rightEntries.reduce((m, e) => Math.max(m, e.naturalWidth), 0);
    const desiredPadding = Math.max(maxLeftWidth, maxRightWidth) + ELBOW_OFFSET + TEXT_GAP + EDGE_BUFFER;
    const sidePadding = Math.min(Math.max(desiredPadding, MIN_SIDE_PADDING), width * MAX_SIDE_PADDING_FRACTION);
    const outerR = Math.max(30, Math.min(width / 2 - sidePadding, height / 2 - VERTICAL_INSET));
    const innerR = outerR * 0.55;

    // Pass C: now that outerR is final, draw the slice paths in their
    // original order.
    sliceEntries.forEach(({ startAngle, endAngle, paletteIndex }) => {
      svg.appendChild(svgEl("path", {
        d: donutSlicePath(cx, cy, innerR, outerR, startAngle, endAngle),
        fill: palette[paletteIndex % palette.length]
      }));
    });

    // Derives each label's line-start (on the ring) and elbow point (a
    // short way further out) from its true departure angle.
    // The elbow's height doubles as the label's natural, pre-declutter
    // textY.
    function computeGeometry(entries) {
      entries.forEach(e => {
        e.lineStart = polarPoint(cx, cy, outerR + 4, e.mid);
        const elbow = polarPoint(cx, cy, outerR + ELBOW_OFFSET, e.mid);
        e.elbowX = elbow.x;
        e.elbowY = elbow.y;
        e.textY = elbow.y;
      });
    }
    computeGeometry(leftEntries);
    computeGeometry(rightEntries);

    const leftLabels = leftEntries;
    const rightLabels = rightEntries;

    // Within each side, walk top-to-bottom pushing any label too close to
    // the one above it further down; if that runs the stack past the
    // bottom of the chart, compress gaps upward from the bottom instead so
    // the whole stack stays on screen. Mirrored at the top edge too - a
    // cluster of small slivers near 12 o'clock otherwise has nothing
    // pulling its topmost label back into frame. If the column still can't
    // fit after both clamps, distribute it evenly across the available
    // range instead of letting anything clip or overlap.
    function declutter(list, minY, maxY) {
      list.sort((a, b) => a.textY - b.textY);
      for (let i = 1; i < list.length; i++) {
        if (list[i].textY - list[i - 1].textY < LINE_HEIGHT) {
          list[i].textY = list[i - 1].textY + LINE_HEIGHT;
        }
      }
      if (list.length && list[list.length - 1].textY > maxY) {
        list[list.length - 1].textY = maxY;
        for (let i = list.length - 2; i >= 0; i--) {
          if (list[i + 1].textY - list[i].textY < LINE_HEIGHT) {
            list[i].textY = list[i + 1].textY - LINE_HEIGHT;
          }
        }
      }
      if (list.length && list[0].textY < minY) {
        list[0].textY = minY;
        for (let i = 1; i < list.length; i++) {
          if (list[i].textY - list[i - 1].textY < LINE_HEIGHT) {
            list[i].textY = list[i - 1].textY + LINE_HEIGHT;
          }
        }
      }
      if (list.length > 1 && list[list.length - 1].textY > maxY) {
        const step = (maxY - minY) / (list.length - 1);
        list.forEach((entry, i) => { entry.textY = minY + i * step; });
      }
    }

    const minY = EDGE_BUFFER;
    const maxY = height - EDGE_BUFFER;
    declutter(leftLabels, minY, maxY);
    declutter(rightLabels, minY, maxY);

    // Pass D: the ring's own vertical centerline - a label's near edge is
    // never allowed to cross past this (with CENTER_GAP of clearance), no
    // matter how long its text is or how little padding was reserved for
    // it in Pass B. This is what actually guarantees no overlap with the
    // ring or the opposite side's labels.
    const centerX = cx;

    [...leftLabels, ...rightLabels].forEach(({ lineStart, elbowX, elbowY, textY, category, countText, isRight, mid }) => {
      // Available width runs from the elbow's side of the centerline out
      // to the SVG edge - never past either bound, regardless of how wide
      // the raw label text would be.
      const availableWidth = isRight
        ? (width - EDGE_BUFFER) - (centerX + CENTER_GAP)
        : (centerX - CENTER_GAP) - EDGE_BUFFER;
      const fitted = fitLabelToWidth(
        category, countText, Math.max(availableWidth, MIN_LABEL_WIDTH),
        t => measureTextWidth(t, 8)
      );

      // Text normally reaches TEXT_GAP past the elbow and extends away
      // from the ring by its own width. If that would run past the SVG
      // edge OR back across the ring's centerline, pull the near edge back
      // in just enough to fit within both bounds.
      const nearEdge = isRight
        ? Math.min(Math.max(elbowX + TEXT_GAP, centerX + CENTER_GAP), width - EDGE_BUFFER - fitted.width)
        : Math.max(Math.min(elbowX - TEXT_GAP, centerX - CENTER_GAP), EDGE_BUFFER + fitted.width);
      const textX = nearEdge;
      // The point the leader line's second leg actually ends at - a few px
      // short of the text itself, for a small visual gap.
      const lineEndX = nearEdge + (isRight ? -4 : 4);
      const lineEndY = textY;

      // Places the elbow at the foot of the perpendicular dropped from the
      // FINAL line endpoint onto the slice's own departure ray (see the
      // equivalent comment in map-analysis-core.js) - the bend is exactly
      // 90 degrees, always, not just "at least", for any endpoint
      // position. Floored at MIN_ELBOW_OFFSET past the ring only so the
      // first leg keeps a visible length.
      const cos = Math.cos(mid);
      const sin = Math.sin(mid);
      const perpendicularRadius = cos * (lineEndX - cx) + sin * (lineEndY - cy);
      const elbowRadius = Math.max(outerR + MIN_ELBOW_OFFSET, perpendicularRadius);
      const finalElbowX = cx + cos * elbowRadius;
      const finalElbowY = cy + sin * elbowRadius;

      svg.appendChild(svgEl("polyline", {
        // First leg leaves the ring at the slice's own (possibly spread)
        // angle; second leg runs to the text. When nothing needed to move
        // this label, the second leg is a short, barely-there continuation
        // - no visible kink. Only labels that actually needed
        // repositioning show a real bend, and that bend is never acute.
        points: `${lineStart.x},${lineStart.y} ${finalElbowX},${finalElbowY} ${lineEndX},${lineEndY}`,
        fill: "none", stroke: "#999", "stroke-width": "1"
      }));

      const textEl = svgEl("text", {
        x: textX, y: textY, "text-anchor": isRight ? "start" : "end", "dominant-baseline": "middle",
        "font-size": "8", "font-family": PDF_CHART_FONT, fill: "#333"
      });
      textEl.textContent = fitted.text;
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
