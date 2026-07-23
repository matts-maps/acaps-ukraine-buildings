/* ============================================================================
   MapPdfRenderer — redraws the map for the PDF export directly from the
   same data the live Leaflet map already holds (loaded tile images,
   esri-leaflet GeoJSON geometry, damage-circle data), instead of
   screenshotting the live DOM.
   ============================================================================
   Why this exists: the previous approach (html2canvas screenshotting
   #map-wrapper-card, then manually patching over what didn't survive the
   screenshot) kept breaking in new ways because it fought the same set of
   html2canvas limitations - SVG <pattern> fills don't render, CSS
   gradient/SVG-data-URI backgrounds don't rasterize reliably, and basemap
   tile seams appear because html2canvas re-lays-out each DOM element rather
   than copying pixels. This module sidesteps all of that: it draws the
   basemap tiles, the three ISW "areas of control" layers, and the damage
   circles onto its own offscreen canvas, in explicit bottom-to-top order, so
   stacking and positioning are the direct result of draw-call order and
   latLngToContainerPoint() math rather than emergent DOM/CSS behaviour.

   Every layer here is reprojected via map.latLngToContainerPoint(), which
   returns coordinates already relative to the map container's own top-left
   corner (0,0) - the same origin this module's export canvas uses - so no
   separate offset bookkeeping between "captured element" and "wrapper it
   sits inside" is needed (that bookkeeping was the source of more than one
   of the earlier PDF layer-offset bugs).

   INSTALL: include after map-analysis-core.js and the page's own analysis
   script (oblast_analysis.js / raion_analysis.js), before
   report-generator-core.js.
   ========================================================================== */

(function () {
  "use strict";

  const EXPORT_TILE_SELECTOR = "#map-container .leaflet-tile-pane img.leaflet-tile-loaded";

  // --------------------------------------------------------------------
  // Basemap tiles
  // --------------------------------------------------------------------
  // Draws each currently-loaded tile image at its live on-screen position,
  // computed relative to #map-container itself (which is what this export
  // canvas represents). A small overdraw on width/height (rather than
  // resizing the source <img> elements themselves, which is what caused a
  // previous, worse offset bug) papers over the hairline gaps that show up
  // between tiles at fractional CSS pixel widths (Leaflet's zoomSnap: 0.5
  // allows non-integer zoom levels, and therefore non-256px tile sizes).
  function renderBasemapTiles(ctx, mapContainerRect, exportScale) {
    const tiles = document.querySelectorAll(EXPORT_TILE_SELECTOR);
    tiles.forEach((img) => {
      const r = img.getBoundingClientRect();
      const dx = (r.left - mapContainerRect.left) * exportScale;
      const dy = (r.top - mapContainerRect.top) * exportScale;
      const dw = r.width * exportScale;
      const dh = r.height * exportScale;
      try {
        ctx.drawImage(img, Math.round(dx), Math.round(dy), Math.ceil(dw) + 1, Math.ceil(dh) + 1);
      } catch (e) {
        // A single tile failing to draw (e.g. a transient CORS/paint glitch)
        // shouldn't abort the whole export.
        console.warn("MapPdfRenderer: failed to draw a basemap tile", e);
      }
    });
  }

  // --------------------------------------------------------------------
  // ISW "areas of control" layers
  // --------------------------------------------------------------------
  // Repeating Canvas pattern fill for the "before 24 Feb 2022" layer's
  // diagonal hatch - the raster equivalent of the live map's SVG <pattern>
  // fill, which Canvas 2D (unlike html2canvas) supports natively.
  //
  // The tile itself is a single *vertical* line (unrotated), exactly like
  // the live map's SVG pattern (an unrotated vertical line, rotated as a
  // whole via patternTransform="rotate(45)") - not a diagonal baked
  // directly into the tile's own square bounds. Baking the angle into the
  // tile geometry means the line gets clipped at the tile's edges before
  // it repeats, so adjacent tiles' segments don't line up and the hatch
  // reads as short staggered dashes instead of continuous diagonal lines.
  // Rotating the whole repeat lattice via CanvasPattern.setTransform(),
  // the same way SVG's patternTransform does it, keeps every line
  // perfectly continuous across tile boundaries because the periodic
  // lattice itself carries the rotation, not each tile's clipped content.
  function buildHatchPattern(ctx, exportScale) {
    const tileSize = 8 * exportScale;
    const tile = document.createElement("canvas");
    tile.width = tileSize;
    tile.height = tileSize;
    const tctx = tile.getContext("2d");
    tctx.strokeStyle = "#EF0000";
    tctx.lineWidth = 3 * exportScale;
    tctx.beginPath();
    tctx.moveTo(tileSize / 2, 0);
    tctx.lineTo(tileSize / 2, tileSize);
    tctx.stroke();

    const pattern = ctx.createPattern(tile, "repeat");
    pattern.setTransform(new DOMMatrix().rotate(45));
    return pattern;
  }

  // Draws one FRONTLINE_LAYERS entry from its already-loaded
  // L.esri.featureLayer instance's raw GeoJSON geometry. Uses the
  // "evenodd" fill rule (rather than the canvas default "nonzero") so
  // interior rings (holes) punch through correctly regardless of each
  // ring's winding direction, which esri-leaflet's Esri-JSON -> GeoJSON
  // conversion doesn't guarantee follows the RFC 7946 convention.
  function renderFrontlineLayer(ctx, layerConfig, exportScale) {
    const map = window.__leafletMap;
    const instance = window.MapCore && window.MapCore.frontlineLayerInstances[layerConfig.key];
    if (!map || !instance) return; // toggled off - PDF mirrors what's on screen

    ctx.save();
    ctx.beginPath();
    Object.values(instance._layers).forEach((sublayer) => {
      const geometry = sublayer.feature && sublayer.feature.geometry;
      if (!geometry) return;
      const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
      polygons.forEach((rings) => {
        rings.forEach((ring) => {
          ring.forEach(([lng, lat], i) => {
            const pt = map.latLngToContainerPoint([lat, lng]);
            const x = pt.x * exportScale;
            const y = pt.y * exportScale;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.closePath();
        });
      });
    });

    if (layerConfig.key === "pre2022") {
      ctx.fillStyle = buildHatchPattern(ctx, exportScale);
    } else {
      ctx.fillStyle = layerConfig.style.fillColor;
      ctx.globalAlpha = layerConfig.style.fillOpacity;
    }
    ctx.fill("evenodd");
    ctx.restore();
  }

  // --------------------------------------------------------------------
  // Damage-building circles
  // --------------------------------------------------------------------
  // Reads MapCore.damageCircleData (populated by oblast_analysis.js /
  // raion_analysis.js alongside the real L.circleMarker layer) rather than
  // reaching into the live circleMarker layer group, since a plain-data
  // record is simpler to redraw than re-deriving style from Leaflet layer
  // instances. Radius is in CSS px (as L.circleMarker's radius option
  // already is, independent of zoom), so scaling by exportScale alone
  // reproduces the same visual size as the live map.
  function renderDamageCircles(ctx, exportScale) {
    const map = window.__leafletMap;
    const data = (window.MapCore && window.MapCore.damageCircleData) || [];
    data.forEach((d) => {
      const pt = map.latLngToContainerPoint([d.lat, d.lng]);
      const x = pt.x * exportScale;
      const y = pt.y * exportScale;
      const r = d.radius * exportScale;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.globalAlpha = d.fillOpacity;
      ctx.fillStyle = d.fillColor;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = d.strokeWeight * exportScale;
      ctx.strokeStyle = d.strokeColor;
      ctx.stroke();
    });
  }

  // --------------------------------------------------------------------
  // Orchestration
  // --------------------------------------------------------------------
  // fitBounds() re-centres/re-zooms the map to whatever's currently loaded,
  // which sends the ISW L.esri.featureLayers off to re-query their grid
  // cells for the new view over the network - wait on each layer's own
  // request count (the actual completion signal) rather than a fixed delay,
  // so renderFrontlineLayer never reads stale/partial geometry.
  async function waitForFrontlineLayers() {
    if (!window.MapCore || !window.MapCore.frontlineLayerInstances) return;
    const layers = Object.values(window.MapCore.frontlineLayerInstances);
    const start = Date.now();
    while (layers.some((l) => l._activeRequests > 0) && Date.now() - start < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  // Frames the export on the combined bounds of whatever data layers are
  // currently on the map (ISW polygon features + damage circles), matching
  // the previous captureMap()'s behaviour of zooming out to fit everything
  // being reported on, rather than whatever the user happened to be panned
  // to when they clicked "Generate PDF Report".
  async function fitToReportBounds(map) {
    let targetBounds = null;
    map.eachLayer((layer) => {
      if (layer.getBounds && typeof layer.getBounds === "function" && layer.feature) {
        if (!targetBounds) targetBounds = layer.getBounds();
        else targetBounds.extend(layer.getBounds());
      }
    });
    if (targetBounds && targetBounds.isValid()) {
      await new Promise((resolve) => {
        map.once("moveend", () => setTimeout(resolve, 500));
        map.fitBounds(targetBounds, { padding: [20, 20], animate: false });
      });
    }
  }

  // Renders the map (basemap + ISW layers + damage circles, bottom-to-top,
  // in the order required) onto a fresh offscreen canvas and returns
  // { dataUrl, cssWidth, cssHeight } - cssWidth/cssHeight (the *unscaled*
  // #map-container dimensions the circles/geometry were drawn against, not
  // the canvas's own exportScale-multiplied pixel size) let the caller work
  // out exactly how much the map got scaled down when it was placed into
  // the PDF, so the "Damaged Buildings" legend's reference circles - built
  // from those same CSS-pixel radii - can be drawn at the identical scale
  // and actually match the map's own circle sizes, instead of being fit
  // into an unrelated legend-box size independently.
  async function renderMapCanvas(exportScale = 2) {
    const map = window.__leafletMap;
    if (!map) return null;

    const originalCenter = map.getCenter();
    const originalZoom = map.getZoom();

    try {
      await fitToReportBounds(map);
      await waitForFrontlineLayers();

      const mapContainerEl = document.getElementById("map-container");
      if (!mapContainerEl) return null;
      const rect = mapContainerEl.getBoundingClientRect();

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(rect.width * exportScale);
      canvas.height = Math.round(rect.height * exportScale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      renderBasemapTiles(ctx, rect, exportScale);

      // Bottom-to-top: advances (410) -> occupied (420) -> pre2022 (430),
      // i.e. the reverse of FRONTLINE_LAYERS' own top-to-bottom pane order.
      const layers = (window.MapCore && window.MapCore.FRONTLINE_LAYERS) || [];
      [...layers].reverse().forEach((cfg) => renderFrontlineLayer(ctx, cfg, exportScale));

      renderDamageCircles(ctx, exportScale);

      return { dataUrl: canvas.toDataURL("image/png", 1.0), cssWidth: rect.width, cssHeight: rect.height };
    } catch (e) {
      console.error("MapPdfRenderer: failed to render map canvas", e);
      return null;
    } finally {
      map.setView(originalCenter, originalZoom, { animate: false });
    }
  }

  // --------------------------------------------------------------------
  // Areas-of-control legend (vector, for direct svg2pdf.js embedding)
  // --------------------------------------------------------------------
  const HATCH_SWATCH_PATTERN_ID = "pdf-legend-hatch-pattern";
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }

  // Builds a standalone <svg> (its own self-contained hatch <pattern> def,
  // not a reference into the page's hidden pattern <svg>, since svg2pdf.js
  // may not resolve a url(#id) reference across document/embed boundaries)
  // with one swatch + label row per areas-of-control layer that's currently
  // visible on the map (mirroring on-screen checkbox state).
  function buildAreasOfControlLegendSvg() {
    const layers = (window.MapCore && window.MapCore.FRONTLINE_LAYERS) || [];
    const instances = (window.MapCore && window.MapCore.frontlineLayerInstances) || {};
    const visibleLayers = layers.filter((l) => instances[l.key]);

    const swatchSize = 14;
    const rowHeight = 22;
    const width = 300;
    const height = Math.max(rowHeight, visibleLayers.length * rowHeight) + 8;

    const svg = svgEl("svg", { xmlns: SVG_NS, width, height, viewBox: `0 0 ${width} ${height}` });

    const defs = svgEl("defs", {});
    const pattern = svgEl("pattern", {
      id: HATCH_SWATCH_PATTERN_ID, width: 6, height: 6,
      patternTransform: "rotate(45)", patternUnits: "userSpaceOnUse"
    });
    pattern.appendChild(svgEl("rect", { width: 6, height: 6, fill: "#ffffff", "fill-opacity": 0 }));
    pattern.appendChild(svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "#EF0000", "stroke-width": 2.5 }));
    defs.appendChild(pattern);
    svg.appendChild(defs);

    visibleLayers.forEach((l, i) => {
      const y = 4 + i * rowHeight;
      const rectAttrs = { x: 0, y, width: swatchSize, height: swatchSize, rx: 2 };
      if (l.key === "pre2022") {
        rectAttrs.fill = `url(#${HATCH_SWATCH_PATTERN_ID})`;
        rectAttrs.stroke = "#EF0000";
        rectAttrs["stroke-width"] = 1;
      } else {
        rectAttrs.fill = l.style.fillColor;
        rectAttrs["fill-opacity"] = l.style.fillOpacity;
      }
      svg.appendChild(svgEl("rect", rectAttrs));

      const text = svgEl("text", {
        x: swatchSize + 8, y: y + swatchSize - 3, "font-size": 10,
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", fill: "#333"
      });
      text.textContent = l.label;
      svg.appendChild(text);
    });

    return svg;
  }

  window.MapPdfRenderer = { renderMapCanvas, buildAreasOfControlLegendSvg };
})();
