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

   2. Add these CDN libraries to the page, then map-pdf-renderer.js, then
      this file, then the page's config file, all AFTER the existing
      Leaflet / Chart.js / analysis scripts. svg2pdf.js embeds every piece
      of vector content built below - the four summary charts, and (via
      map-pdf-renderer.js) the map's legends - directly into the PDF, no
      rasterization; the map image itself is composited onto a canvas by
      map-pdf-renderer.js from source data, not screenshotted, so no DOM
      screenshotting library is needed at all:

        <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js" defer></script>
        <script src="https://cdn.jsdelivr.net/npm/svg2pdf.js@2/dist/svg2pdf.umd.min.js" defer></script>
        <script src="{{ '/assets/js/map-pdf-renderer.js' | relative_url }}" defer></script>
        <script src="{{ '/assets/js/report-generator-core.js' | relative_url }}" defer></script>
        <script src="{{ '/assets/js/oblast-report-generator.js' | relative_url }}" defer></script>

   3. The button is injected automatically into #map-controls, right after
      the ".map-hint" paragraph. No HTML edits required.
   ========================================================================== */

(function () {
  "use strict";

  const IDS_BASE = {
    aggSelect: "map-aggregation-select",
    dateFromInput: "map-date-from",
    dateToInput: "map-date-to",
    infraSelect: "map-infra-select",
    extentSelect: "map-extent-select",
    totalValue: "map-total-value",
    activeFilterGroup: "map-active-filter-group",
    activeFilterLabel: "map-active-filter-label",
  };

  function formatDateLabel(iso) {
    return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }

  const BUTTON_INSERT_AFTER_SELECTOR = ".map-hint";

  // Vector chart drawing (buildHorizontalBarSVG/buildColumnChartSVG/
  // buildDonutSVG + CHART_PALETTE etc.) lives in the shared
  // chart-svg-builders.js (window.ChartSVGBuilders), loaded before this
  // file, so the PDF's charts and the on-page "Export SVG" buttons
  // (map-export-buttons.js) draw from the exact same functions.
  const { buildHorizontalBarSVG, buildColumnChartSVG, buildDonutSVG, CHART_PALETTE } = window.ChartSVGBuilders;

  function formatPeriod(state) {
    return `${state.granularityLabel} • ${state.dateFromLabel} – ${state.dateToLabel}`;
  }

  function topEntry(counts) {
    const entries = Object.entries(counts || {});
    if (!entries.length) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0];
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

  function highlightSetFor(value) {
    return value ? new Set([value]) : null;
  }

  // Delegates to MapPdfRenderer (map-pdf-renderer.js), which redraws the
  // map directly from source data (loaded tile images, esri-leaflet GeoJSON
  // geometry, damage-circle data) in explicit bottom-to-top order, rather
  // than screenshotting the live DOM with html2canvas - see that file for
  // why. Returns { dataUrl, cssWidth, cssHeight } (or null on failure) -
  // cssWidth is needed below to scale the damage-circle legend to match.
  async function captureMapImage() {
    if (!window.MapPdfRenderer) {
      console.error("map-pdf-renderer.js is not loaded.");
      return null;
    }
    return MapPdfRenderer.renderMapCanvas(2);
  }

  // Renders an svg2pdf.js-embeddable legend SVG at its own natural aspect
  // ratio inside a (maxWidth, maxHeight) box, rather than stretching it to
  // fill the box outright the way addSvgWithHeading's chart callers do
  // (those charts are built with a matching aspect ratio already; these
  // legend SVGs carry their own fixed proportions and would distort -
  // circles into ellipses, swatches into rectangles - if stretched).
  async function addFittedSvgWithHeading(doc, heading, svgElement, y, margin, pageWidth, pageHeight, maxWidth, maxHeight, explicitX) {
    const naturalWidth = parseFloat(svgElement.getAttribute("width")) || maxWidth;
    const naturalHeight = parseFloat(svgElement.getAttribute("height")) || maxHeight;
    const aspect = naturalWidth / naturalHeight;
    let boxWidth = maxWidth;
    let boxHeight = maxWidth / aspect;
    if (boxHeight > maxHeight) {
      boxHeight = maxHeight;
      boxWidth = maxHeight * aspect;
    }
    return addSvgWithHeading(doc, heading, svgElement, y, margin, pageWidth, pageHeight, boxWidth, explicitX, boxHeight, null);
  }

  // Returns { y, imgWidth, imgHeight } rather than a bare y - the caller
  // needs the actual placed imgWidth to work out how much this image got
  // scaled down relative to its source (see the mapCssToPtScale use below),
  // not just where to continue drawing next.
  //
  // Always draws at the full targetWidth (imgHeight follows from the
  // image's own aspect ratio) - the map must render edge-to-edge on the
  // page rather than being shrunk-and-centered to squeeze under a height
  // budget, which is what a maxHeight cap here previously did. If that
  // means the map + legends no longer fit page 1, the overflow check just
  // below (and the legend row's own, separate overflow check right after
  // this function's caller) push the overflow onto page 2 instead.
  function addImageWithHeading(doc, heading, imgDataUrl, y, margin, pageWidth, pageHeight, targetWidth, explicitX = null) {
    const xPos = explicitX !== null ? explicitX : margin;
    const props = doc.getImageProperties(imgDataUrl);
    const naturalAspect = props.width / props.height;
    const imgWidth = targetWidth;
    const imgHeight = targetWidth / naturalAspect;
    const boxHeight = imgHeight;
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
    doc.addImage(imgDataUrl, "PNG", xPos, y, imgWidth, imgHeight);
    return { y: y + boxHeight + 30, imgWidth, imgHeight };
  }

  // Draws the area x damage-level summary table (the same data/shape as
  // the on-page table and its CSV/XLSX export) as its own PDF page, using
  // the same hand-rolled doc.rect/doc.text primitives as the rest of this
  // file rather than a jspdf-autotable dependency - paginating if the row
  // count (up to ~136 raions) overflows a single page.
  function addSummaryTablePage(doc, state, margin, pageWidth, pageHeight) {
    const t = state.summaryTable;
    if (!t || !t.rows.length) return;

    doc.addPage();
    let y = margin + 15;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(26, 58, 92);
    doc.text(`Damage Summary by ${t.areaLabel}`, margin, y);
    y += 20;

    const cols = [t.areaLabel, ...t.columns, "Total"];
    const colWidth = (pageWidth - margin * 2) / cols.length;
    const cellPadding = 6;
    const baseRowHeight = 16;
    const wrappedLineHeight = 11;
    // The area/raion-name column wraps onto multiple lines rather than
    // overflowing into the next column when a name is too long for its
    // column width (e.g. "Autonomous Republic of Crimea").
    const areaColTextWidth = colWidth - cellPadding * 2;

    function drawHeaderRow(yy) {
      doc.setFillColor(26, 58, 92);
      doc.rect(margin, yy, pageWidth - margin * 2, baseRowHeight, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(255, 255, 255);
      cols.forEach((c, i) => {
        const x = margin + i * colWidth;
        // First column (area/raion name) is left-aligned; every numeric
        // column (each damage level + Total) is right-aligned, matching
        // the on-page table and the numbers it holds.
        if (i === 0) {
          doc.text(String(c), x + cellPadding, yy + baseRowHeight - 5);
        } else {
          doc.text(String(c), x + colWidth - cellPadding, yy + baseRowHeight - 5, { align: "right" });
        }
      });
      return yy + baseRowHeight;
    }

    y = drawHeaderRow(y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    t.rows.forEach((r, i) => {
      const areaLines = doc.splitTextToSize(r.area, areaColTextWidth);
      const rowHeight = Math.max(baseRowHeight, areaLines.length * wrappedLineHeight + 5);

      if (y + rowHeight > pageHeight - margin) {
        doc.addPage();
        y = margin + 15;
        y = drawHeaderRow(y);
      }
      if (i % 2 === 1) {
        doc.setFillColor(240, 244, 248);
        doc.rect(margin, y, pageWidth - margin * 2, rowHeight, "F");
      }

      doc.setFont("helvetica", "normal");
      doc.setTextColor(51, 51, 51);
      areaLines.forEach((line, li) => {
        doc.text(line, margin + cellPadding, y + 11 + li * wrappedLineHeight);
      });

      const numericValues = [...t.columns.map(c => (r.cols[c] || 0).toLocaleString()), r.total.toLocaleString()];
      const numericY = y + rowHeight / 2 + 3; // vertically centred within the (possibly taller, wrapped) row
      numericValues.forEach((v, ci) => {
        const isTotal = ci === numericValues.length - 1;
        const colIndex = ci + 1; // +1 to skip the area-name column
        const x = margin + colIndex * colWidth + colWidth - cellPadding;
        doc.setFont("helvetica", isTotal ? "bold" : "normal");
        doc.text(String(v), x, numericY, { align: "right" });
      });

      y += rowHeight;
    });
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
      const dateFromEl = document.getElementById(IDS.dateFromInput);
      const dateToEl = document.getElementById(IDS.dateToInput);
      const aggEl = document.getElementById(IDS.aggSelect);
      const infraEl = document.getElementById(IDS.infraSelect);
      const extentEl = document.getElementById(IDS.extentSelect);
      const totalEl = document.getElementById(IDS.totalValue);
      const filterGroup = document.getElementById(IDS.activeFilterGroup);
      const filterLabel = document.getElementById(IDS.activeFilterLabel);

      const activeFilterText =
        filterGroup && filterGroup.style.display !== "none" && filterLabel
          ? filterLabel.textContent.trim()
          : "None (national view)";

      if (state) {
        return {
          dateFromLabel: state.dateFromLabel,
          dateToLabel: state.dateToLabel,
          granularityLabel: state.granularityLabel,
          infraFilter: state.infraFilter || null,
          extentFilter: state.extentFilter || null,
          nationalTotal: state.nationalTotal.toLocaleString(),
          activeFilterText,
          entityFilterValue: state[config.entityFilterKey] || null,
          [config.entityCountsKey]: state[config.entityCountsKey] || {},
          infraCounts: state.infraCounts || {},
          extentCounts: state.extentCounts || {},
          chartSeries: state.chartSeries || null,
          summaryTable: state.summaryTable || null,
          safeFilenameDate: `${state.dateFrom}_to_${state.dateTo}`,
          ...config.getExtraStateFromHook(state),
        };
      }

      return {
        dateFromLabel: dateFromEl && dateFromEl.value ? formatDateLabel(dateFromEl.value) : "N/A",
        dateToLabel: dateToEl && dateToEl.value ? formatDateLabel(dateToEl.value) : "N/A",
        granularityLabel: aggEl ? aggEl.options[aggEl.selectedIndex]?.text : "N/A",
        infraFilter: infraEl && infraEl.value ? infraEl.value : null,
        extentFilter: extentEl && extentEl.value ? extentEl.value : null,
        nationalTotal: totalEl ? totalEl.textContent.trim() : "0",
        activeFilterText,
        entityFilterValue: (() => {
          const el = document.getElementById(config.entitySelectId);
          return el && el.value ? el.value : null;
        })(),
        [config.entityCountsKey]: {},
        infraCounts: {},
        extentCounts: {},
        chartSeries: null,
        summaryTable: null,
        safeFilenameDate: "report",
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
        // Vector legend: the "Damaged Buildings" bubble legend (already a
        // real <svg>, built by MapCore.updateProportionalLegend) plus the
        // "Areas of control" swatches (built fresh by MapPdfRenderer, since
        // the live version's swatches are plain CSS backgrounds, not SVG),
        // embedded directly as vector graphics rather than screenshotted
        // along with the map - this is what previously produced the blank
        // legend swatch / gradient-background bugs. Sized and reserved
        // *before* the map image below, so the map is deliberately left
        // smaller than "all remaining space on the page" and both legends
        // land on the same page as the map, not pushed off onto their own.
        const damageLegendSvg = document.querySelector("#map-legend-panel svg");
        const legendGap = 16;
        const legendRowWidth = pageWidth - margin * 2 - legendGap;
        // Damaged Buildings gets 1/3 of the row, Areas of control gets 2/3 -
        // the latter needs the extra room since its labels are full
        // sentences ("Russian controlled Ukrainian territory before 24
        // February 2022") that must wrap within their column instead of
        // running off the page as a single un-wrapped line.
        const legendCol1Width = legendRowWidth / 3;
        const legendCol2Width = legendRowWidth - legendCol1Width;
        // Built here (rather than with a fixed internal width) so its
        // label-wrapping is computed against the actual column width it
        // will be embedded at.
        const areasLegendSvg = window.MapPdfRenderer ? MapPdfRenderer.buildAreasOfControlLegendSvg(legendCol2Width) : null;
        // Driven by the areas-of-control SVG's own real (wrapped) content
        // height rather than a fixed guess, since how many lines each
        // label wraps to - and therefore how tall the legend row needs to
        // be - depends on the actual label text. The damage-circle legend
        // (sized separately below, to match the map's own circle scale)
        // is essentially always shorter than this, so it's a safe shared
        // row height for both.
        const LEGEND_MAX_HEIGHT = areasLegendSvg ? parseFloat(areasLegendSvg.getAttribute("height")) : 100;
        // Matches the "heading-to-content gap (6) + trailing gap (30)"
        // that addImageWithHeading/addSvgWithHeading actually advance y by
        // around their content box (their own internal overflow checks use
        // a smaller "+20", which only guards against the box itself running
        // off the page - not the full heading+gap+box+trailing-gap total
        // that's actually consumed - so a reservation based on "+20" alone
        // undershoots by 16pt and the legend row ends up rolling onto its
        // own page anyway).
        const BLOCK_OVERHEAD = 36;
        const legendHeadingHeight = Math.max(
          damageLegendSvg ? measureHeadingHeight(doc, "Damaged Buildings", legendCol1Width) : 0,
          areasLegendSvg ? measureHeadingHeight(doc, "Areas of control", legendCol2Width) : 0
        );

        // Set once the map image is placed below, to whatever factor its
        // source CSS pixels ended up scaled by in the PDF (PDF points per
        // CSS pixel) - the damage-circle legend's reference circles are
        // built from those same CSS-pixel radii, so drawing them at this
        // identical scale is what makes them actually match the size of
        // the circles seen on the map image, instead of each being sized
        // independently to fill its own box.
        let mapCssToPtScale = null;

        const mapResult = await captureMapImage();
        if (mapResult) {
          // Always full page width (see addImageWithHeading) - if that,
          // combined with the legend row reserved above, doesn't fit page
          // 1, the legend row's own overflow check (below) pushes it to
          // page 2 rather than the map being shrunk to squeeze both in.
          const mapTargetWidth = pageWidth - margin * 2;
          const placed = addImageWithHeading(doc, config.mapImageHeading, mapResult.dataUrl, y, margin, pageWidth, pageHeight, mapTargetWidth);
          y = placed.y;
          mapCssToPtScale = placed.imgWidth / mapResult.cssWidth;
        } else {
          doc.setFont("helvetica", "italic");
          doc.setFontSize(10);
          doc.setTextColor(192, 57, 43);
          doc.text("(Map image unavailable)", margin, y);
          y += 25;
        }

        if (damageLegendSvg || areasLegendSvg) {
          // Check overflow once, using both legends' worst case, and
          // advance the page (if truly needed) once - rather than letting
          // each addFittedSvgWithHeading call independently decide to
          // addPage(), which is what previously split the two legends onto
          // two separate pages of their own (each call's overflow check ran
          // against the same stale y in turn, so the first call's addPage()
          // left the second call still positioned as if nothing had moved).
          let legendRowY = y;
          if (legendRowY + LEGEND_MAX_HEIGHT + legendHeadingHeight + BLOCK_OVERHEAD > pageHeight - margin) {
            doc.addPage();
            legendRowY = margin + 15;
          }
          let legendRowHeight = 0;
          if (damageLegendSvg) {
            // Must clone: addSvgWithHeading/embedSvgChart appends the node
            // it's given to document.body then removes it again once done -
            // passing the live node would permanently rip the on-page
            // legend out from under the user.
            const clone = damageLegendSvg.cloneNode(true);
            // Drawn at mapCssToPtScale - the exact factor the map image
            // itself got scaled by - rather than independently fit to the
            // legend column's box, so a reference circle here is the same
            // physical size in the PDF as the same-value circle on the
            // map. (Falls back to fitting the column width if the map
            // capture failed, so the legend still renders at some
            // reasonable size rather than not at all.)
            const naturalWidth = parseFloat(clone.getAttribute("width")) || legendCol1Width;
            const naturalHeight = parseFloat(clone.getAttribute("height")) || LEGEND_MAX_HEIGHT;
            const scale = mapCssToPtScale || (legendCol1Width / naturalWidth);
            const nextY = await addSvgWithHeading(
              doc, "Damaged Buildings", clone,
              legendRowY, margin, pageWidth, pageHeight, naturalWidth * scale, margin, naturalHeight * scale, null
            );
            legendRowHeight = Math.max(legendRowHeight, nextY - legendRowY);
          }
          if (areasLegendSvg) {
            const nextY = await addFittedSvgWithHeading(
              doc, "Areas of control", areasLegendSvg,
              legendRowY, margin, pageWidth, pageHeight, legendCol2Width, LEGEND_MAX_HEIGHT, margin + legendCol1Width + legendGap
            );
            legendRowHeight = Math.max(legendRowHeight, nextY - legendRowY);
          }
          y = legendRowY + legendRowHeight;
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
          const entitySvg = buildHorizontalBarSVG(entitySeries.labels, entitySeries.values, colChartWidth, SUMMARY_CHART_HEIGHT_PX, highlightSetFor(state.entityFilterValue));
          const nextY = await addSvgWithHeading(doc, entityChart.label, entitySvg, rowYStart, margin, pageWidth, pageHeight, colChartWidth, margin, SUMMARY_CHART_HEIGHT_PX, entityChart.id);
          maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
        }
        if (series.infra && series.infra.labels.length) {
          const infraSvg = buildHorizontalBarSVG(series.infra.labels, series.infra.values, colChartWidth, SUMMARY_CHART_HEIGHT_PX, highlightSetFor(state.infraFilter));
          const nextY = await addSvgWithHeading(doc, IDS.charts.infra.label, infraSvg, rowYStart, margin, pageWidth, pageHeight, colChartWidth, margin + colChartWidth + gridGap, SUMMARY_CHART_HEIGHT_PX, IDS.charts.infra.id);
          maxRowHeight = Math.max(maxRowHeight, nextY - rowYStart);
        }
        y = rowYStart + (maxRowHeight > 0 ? maxRowHeight : 0);
        if (series.extent && series.extent.labels.length) {
          const extentSvg = buildDonutSVG(series.extent.labels, series.extent.values, colChartWidth, SUMMARY_CHART_HEIGHT_PX, CHART_PALETTE);
          const centerX = (pageWidth - colChartWidth) / 2;
          y = await addSvgWithHeading(doc, IDS.charts.extent.label, extentSvg, y, margin, pageWidth, pageHeight, colChartWidth, centerX, SUMMARY_CHART_HEIGHT_PX, IDS.charts.extent.id);
        }

        addSummaryTablePage(doc, state, margin, pageWidth, pageHeight);

        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
          doc.setPage(i);
          doc.setFontSize(8);
          doc.setTextColor(136, 136, 136);
          doc.text("E-PACC Ukraine Project - Created by MapAction and ACAPS. Data sourced from ACAPS.", margin, pageHeight - 20);
          doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin - 45, pageHeight - 20);
        }
        const safeDateRange = String(state.safeFilenameDate || "report").replace(/\s+/g, "_");
        doc.save(`${config.filenamePrefix}_${safeDateRange}.pdf`);
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
