let rawDamageCSV = [];
let geoJSONData = null;
let leafletGeoLayer = null;
let mapInstance = null;

// The full-country view, captured once the boundary geoJSON first loads, so
// we can zoom back out to it when the Oblast/Raion filters are cleared.
let nationalBounds = null;

// Tracks which oblast/raion scope the map is currently zoomed to, so we only
// re-fit the view when that scope actually changes (not on every re-render
// triggered by e.g. a time-window change).
let lastZoomScopeKey = '';

let topRaionsChartInstance = null;
let infraTypeChartInstance = null;
let extentChartInstance = null;
let timelineChartInstance = null; 

// The single cross-filter selection currently active, set by clicking a
// raion on the map, a bar/segment in one of the charts, or a timeline bar. 
// When set, every visual (map + all charts + total) is recomputed against 
// only the rows matching this selection, on top of the year/range filters.
let activeFilter = null; // { dimension: 'raion' | 'infra' | 'extent' | 'period', value: string | number }

const CHART_PALETTE = ['#1a3a5c', '#2c5f8a', '#4a90c4', '#7cb4dd', '#a8d0e8', '#d94801', '#f16913', '#fdae6b', '#fdd0a2', '#999999'];
const FILTER_HIGHLIGHT_COLOR = '#d94801';

// Registers the chartjs-plugin-datalabels plugin (loaded via CDN in the
// HTML) so the bar/column charts below can render their values as external
// labels at the end of each bar/column, rather than relying on a value axis.
if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') {
    Chart.register(ChartDataLabels);
}

// Renders labels for the "Extent of Damage" doughnut outside the ring, each
// with a short leader line back to its slice, so the ring doesn't need a
// value axis or an on-chart legend to be readable. Registered only on the
// doughnut chart instance (not globally) since it's specific to that shape.
const outsideDoughnutLabelsPlugin = {
    id: 'outsideDoughnutLabels',
    afterDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        const dataset = chart.data.datasets[0];
        if (!meta || !dataset) return;
        const total = dataset.data.reduce((a, b) => a + b, 0);
        if (!total) return;

        const { ctx } = chart;
        ctx.save();
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textBaseline = 'middle';

        meta.data.forEach((arc, i) => {
            const value = dataset.data[i];
            if (!value) return;

            const { x, y, startAngle, endAngle, outerRadius } =
                arc.getProps(['x', 'y', 'startAngle', 'endAngle', 'outerRadius'], true);
            const midAngle = (startAngle + endAngle) / 2;
            const cos = Math.cos(midAngle);
            const sin = Math.sin(midAngle);
            const isRight = cos >= 0;

            const lineStart = { x: x + cos * (outerRadius + 2), y: y + sin * (outerRadius + 2) };
            const bend = { x: x + cos * (outerRadius + 16), y: y + sin * (outerRadius + 16) };
            const textX = bend.x + (isRight ? 14 : -14);

            ctx.strokeStyle = '#999';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(lineStart.x, lineStart.y);
            ctx.lineTo(bend.x, bend.y);
            ctx.lineTo(textX + (isRight ? -4 : 4), bend.y);
            ctx.stroke();

            const pct = Math.round((value / total) * 100);
            ctx.fillStyle = '#333';
            ctx.textAlign = isRight ? 'left' : 'right';
            ctx.fillText(`${chart.data.labels[i]}: ${value.toLocaleString()} (${pct}%)`, textX, bend.y);
        });

        ctx.restore();
    }
};

const monthsList = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Column name for oblast in the CSV. ASSUMPTION: adjust this single value if
// your data uses a different column name (e.g. 'oblast_name', 'region').
const OBLAST_FIELD = 'oblast';

// Property name for oblast on the raion boundary geoJSON features. ASSUMPTION:
// adjust this if your geoJSON uses a different property (e.g. 'ADM1_EN',
// 'oblast_name'). Check `geoJSONData.features[0].properties` in devtools if
// the oblast zoom doesn't work.
const GEOJSON_OBLAST_PROPERTY = 'adm1_name';

// Corrects for a handful of raion boundary names that differ between the
// geoJSON source and the CSV's spelling. Used both for map styling/click
// handling and for computing zoom bounds.
const RAION_NAME_MAP = {
    'Kerchynskyi': 'Kerchenskyi',
    'Krasnoperekopskyi': 'Perekopskyi',
    'Chervonohradskyi': 'Sheptytskyi',
    'Sievierodonetskyi': 'Siverskodonetskyi'
};

window.addEventListener('DOMContentLoaded', () => {
    const csvPath = window.MAP_CSV_PATH || '/data/ukraine-damages.csv';
    const geojsonPath = window.MAP_GEOJSON_PATH || '/data/ukr_admn_ad2_py_s0_fieldmaps_pp_raions.json';

    if (typeof L === 'undefined' || typeof Papa === 'undefined') return;

    initMapElement();

    Promise.all([
        fetch(geojsonPath).then(res => res.json()),
        new Promise((resolve, reject) => {
            Papa.parse(csvPath, {
                download: true, header: true, skipEmptyLines: true,
                complete: results => resolve(results.data),
                error: err => reject(err)
            });
        })
    ])
    .then(([geoData, csvData]) => {
        geoJSONData = geoData;
        rawDamageCSV = csvData;

        // Fit the view to the full extent of the administrative boundaries
        // so the whole of Ukraine is visible, regardless of screen size.
        const bounds = L.geoJSON(geoData).getBounds();
        if (bounds.isValid()) {
            nationalBounds = bounds;
            mapInstance.fitBounds(bounds, { padding: [15, 15] });
        }

        buildMapFilterOptions();
        buildOblastRaionFilterOptions();
    });
});

// 5 colour groups for values of 1 and above. A value of exactly 0 is
// handled separately below and always renders as plain white.
const THEMATIC_COLORS = ['#fee6ce', '#fdd0a2', '#fdae6b', '#f16913', '#d94801'];
const ZERO_COLOR = '#ffffff';

function initMapElement() {
    // Start on a reasonable default view; this gets replaced by fitBounds()
    // once the Ukraine boundary geoJSON has loaded.
    mapInstance = L.map('map-container', { zoomSnap: 0.5 }).setView([48.3794, 31.1656], 6);
    window.__leafletMap = mapInstance;
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 20
    }).addTo(mapInstance);
    
    // UI: Info Panel
    window.mapInfoPanel = L.control({ position: 'topright' });
    window.mapInfoPanel.onAdd = function() {
        this._div = L.DomUtil.create('div', 'map-info-panel');
        this._div.innerHTML = '<h4>Raion Metric Profile</h4>Hover over an administrative region';
        return this._div;
    };
    window.mapInfoPanel.addTo(mapInstance);

    // UI: Legend (populated/refreshed dynamically by updateLegend())
    window.mapLegend = L.control({ position: 'bottomleft' });
    window.mapLegend.onAdd = function() {
        this._div = L.DomUtil.create('div', 'map-legend');
        this._div.innerHTML = '<strong>Damage Scale</strong><br>Loading&hellip;';
        return this._div;
    };
    window.mapLegend.addTo(mapInstance);
}

// Computes 5 ascending thematic breakpoints (covering values of 1 and
// above) from whatever data is currently on screen, so the legend/colour
// scale adapts to the selected period instead of using a fixed scale.
// A value of 0 is always white and isn't part of this scale.
function computeDynamicBreaks(counts) {
    const values = Object.values(counts).filter(v => v > 0);
    const max = values.length ? Math.max(...values) : 0;

    if (max <= 4) {
        // Small counts: keep the scale simple and integer-based.
        return [0, 1, 2, 3, 4];
    }

    const proportions = [0.15, 0.35, 0.65, 1];
    const breaks = [0];
    proportions.forEach(p => {
        let v = roundNice(max * p);
        if (v <= breaks[breaks.length - 1]) v = breaks[breaks.length - 1] + 1;
        breaks.push(v);
    });
    return breaks; // [0, g1, g2, g3, g4] - 5 elements, 5 colour groups
}

// Rounds a number to a "nice" value (1/2/5/10 x a power of ten) so legend
// labels read cleanly instead of showing arbitrary decimals.
function roundNice(n) {
    if (n < 10) return Math.round(n);
    const magnitude = Math.pow(10, Math.floor(Math.log10(n)));
    const normalized = n / magnitude;
    let niceNormalized;
    if (normalized <= 1) niceNormalized = 1;
    else if (normalized <= 2) niceNormalized = 2;
    else if (normalized <= 5) niceNormalized = 5;
    else niceNormalized = 10;
    return niceNormalized * magnitude;
}

function getThematicColor(val, breaks) {
    if (val <= 0) return ZERO_COLOR;
    const grades = breaks || [0, 50, 200, 500, 1000];
    return val > grades[4] ? THEMATIC_COLORS[4]
        : val > grades[3] ? THEMATIC_COLORS[3]
        : val > grades[2] ? THEMATIC_COLORS[2]
        : val > grades[1] ? THEMATIC_COLORS[1]
        : THEMATIC_COLORS[0];
}

function updateLegend(breaks) {
    if (!window.mapLegend || !window.mapLegend._div) return;
    let html = '<strong>Damage Scale</strong><br>';
    html += '<i style="background:' + ZERO_COLOR + '; border:1px solid #ccc;"></i> 0<br>';
    for (let i = 0; i < THEMATIC_COLORS.length; i++) {
        const lower = breaks[i] + 1;
        const upper = breaks[i + 1];
        html += '<i style="background:' + THEMATIC_COLORS[i] + '"></i> ' +
            lower + (upper !== undefined ? '&ndash;' + upper : '+') + '<br>';
    }
    window.mapLegend._div.innerHTML = html;
}

// Sets (or, if the same value is clicked again, clears) the active
// cross-filter selection, then re-renders everything to reflect it.
function setActiveFilter(dimension, value) {
    if (activeFilter && activeFilter.dimension === dimension && activeFilter.value === value) {
        activeFilter = null;
    } else {
        activeFilter = { dimension, value };
    }
    updateActiveFilterUI();
    processMapVisualisations();
}

function clearMapFilter() {
    activeFilter = null;
    updateActiveFilterUI();
    processMapVisualisations();
}
window.clearMapFilter = clearMapFilter;

function updateActiveFilterUI() {
    const group = document.getElementById('map-active-filter-group');
    const label = document.getElementById('map-active-filter-label');
    if (!group || !label) return;

    if (activeFilter) {
        const dimensionLabels = { 
            raion: 'Raion', 
            infra: 'Infrastructure Type', 
            extent: 'Extent of Damage',
            period: 'Time Period'
        };
        label.textContent = (dimensionLabels[activeFilter.dimension] || activeFilter.dimension) + ': ' + activeFilter.value;
        group.style.display = 'flex';
    } else {
        group.style.display = 'none';
    }
}

function buildMapFilterOptions() {
    const yearSel = document.getElementById('map-year-select');
    if (!yearSel) return;
    const years = [...new Set(rawDamageCSV.map(r => r.date_of_event?.slice(0, 4)).filter(y => y))].sort((a, b) => b - a);
    yearSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    buildMapPeriodDropdowns();
}

function buildMapPeriodDropdowns() {
    const aggType = document.getElementById('map-aggregation-select').value;
    const startSel = document.getElementById('map-period-start-select');
    const endSel = document.getElementById('map-period-end-select');
    if (!startSel || !endSel) return;

    const options = aggType === '30'
        ? monthsList.map((m, i) => `<option value="${i}">${m}</option>`).join('')
        : Array.from({length: Math.ceil(365/aggType)}, (_, i) => `<option value="${i}">${aggType==7?'Week':'Fortnight'} ${i+1}</option>`).join('');

    startSel.innerHTML = options;
    endSel.innerHTML = options;

    // Default to a single-window range
    startSel.selectedIndex = 0;
    endSel.selectedIndex = 0;

    processMapVisualisations();
}

// Builds the Oblast dropdown (all unique oblasts, alphabetical) and the
// initial Raion dropdown (all unique raions). Called once after the CSV
// loads. The Raion list is re-scoped to the selected oblast whenever the
// oblast dropdown changes (see onOblastFilterChange below).
function buildOblastRaionFilterOptions() {
    const oblastSel = document.getElementById('map-oblast-select');
    const raionSel = document.getElementById('map-raion-select');
    if (!oblastSel || !raionSel) return;

    const oblasts = [...new Set(
        rawDamageCSV.map(r => r[OBLAST_FIELD]?.trim()).filter(Boolean)
    )].sort();

    oblastSel.innerHTML = '<option value="">All Oblasts</option>' +
        oblasts.map(o => `<option value="${o}">${o}</option>`).join('');

    populateRaionOptions('');
}

// Rebuilds the Raion dropdown, scoped to the given oblast ('' = all raions).
function populateRaionOptions(oblastValue) {
    const raionSel = document.getElementById('map-raion-select');
    if (!raionSel) return;

    const rows = oblastValue
        ? rawDamageCSV.filter(r => r[OBLAST_FIELD]?.trim() === oblastValue)
        : rawDamageCSV;

    const raions = [...new Set(
        rows.map(r => r.rayon?.trim()).filter(Boolean)
    )].sort();

    raionSel.innerHTML = '<option value="">All Raions</option>' +
        raions.map(r => `<option value="${r}">${r}</option>`).join('');
}

// Called on Oblast dropdown change: rescope the Raion dropdown to the
// selected oblast, reset any specific raion selection, then re-render.
function onOblastFilterChange() {
    const oblastSel = document.getElementById('map-oblast-select');
    populateRaionOptions(oblastSel ? oblastSel.value : '');
    processMapVisualisations();
}
window.onOblastFilterChange = onOblastFilterChange;

function onRaionFilterChange() {
    processMapVisualisations();
}
window.onRaionFilterChange = onRaionFilterChange;

// Computes the Leaflet bounds covering the given oblast or raion selection.
// Precedence: a specific raion narrows furthest, then oblast, then null
// (meaning: no spatial narrowing, caller should fall back to nationalBounds).
function computeScopedBounds(oblastValue, raionValue) {
    if (!geoJSONData) return null;

    let matched;
    if (raionValue) {
        matched = geoJSONData.features.filter(f => {
            const raw = f.properties.adm2_name || '';
            const geoName = RAION_NAME_MAP[raw] || raw;
            return geoName === raionValue;
        });
    } else if (oblastValue) {
        matched = geoJSONData.features.filter(f =>
            (f.properties[GEOJSON_OBLAST_PROPERTY] || '').trim() === oblastValue
        );
    } else {
        return null;
    }

    if (!matched.length) return null;
    const bounds = L.geoJSON({ type: 'FeatureCollection', features: matched }).getBounds();
    return bounds.isValid() ? bounds : null;
}

function applyMapZoomForScope(oblastValue, raionValue) {
    const scopeKey = `${oblastValue || ''}|${raionValue || ''}`;
    if (scopeKey === lastZoomScopeKey) return; // scope hasn't changed, leave the user's current pan/zoom alone
    lastZoomScopeKey = scopeKey;

    const scopedBounds = computeScopedBounds(oblastValue, raionValue);
    if (scopedBounds) {
        mapInstance.fitBounds(scopedBounds, { padding: [30, 30], maxZoom: 10 });
    } else if (nationalBounds) {
        mapInstance.fitBounds(nationalBounds, { padding: [15, 15] });
    }
}

function processMapVisualisations() {
    if (!geoJSONData || !rawDamageCSV) return;

    const yearEl = document.getElementById('map-year-select');
    const startEl = document.getElementById('map-period-start-select');
    const endEl = document.getElementById('map-period-end-select');
    const aggEl = document.getElementById('map-aggregation-select');
    const totalEl = document.getElementById('map-total-value');
    const oblastEl = document.getElementById('map-oblast-select');
    const raionEl = document.getElementById('map-raion-select');

    if (!yearEl || !startEl || !endEl || !aggEl) return;

    const targetYear = parseInt(yearEl.value);
    let startPeriod = parseInt(startEl.value);
    let endPeriod = parseInt(endEl.value);
    if (startPeriod > endPeriod) [startPeriod, endPeriod] = [endPeriod, startPeriod];
    const step = parseInt(aggEl.value);
    const oblastFilter = oblastEl ? oblastEl.value : '';
    const raionFilter = raionEl ? raionEl.value : '';

    const counts = {};
    const infraCounts = {};
    const extentCounts = {};
    
    // Seed time series tracker keys within our active dashboard range
    const timeCounts = {};
    const labelsList = [];
    if (step === 30) {
        for (let i = startPeriod; i <= endPeriod; i++) {
            timeCounts[monthsList[i]] = 0;
            labelsList.push(monthsList[i]);
        }
    } else {
        const prefix = step === 7 ? 'Week' : 'Fortnight';
        for (let i = startPeriod; i <= endPeriod; i++) {
            const key = `${prefix} ${i + 1}`;
            timeCounts[key] = 0;
            labelsList.push(key);
        }
    }

    rawDamageCSV.forEach(r => {
        const rawRaion = r.rayon?.trim();
        if (!rawRaion) return;

        // Oblast / Raion filter panel selections
        if (oblastFilter && r[OBLAST_FIELD]?.trim() !== oblastFilter) return;
        if (raionFilter && rawRaion !== raionFilter) return;

        const d = new Date(r.date_of_event);
        if (isNaN(d) || d.getFullYear() !== targetYear) return;

        const day = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
        const p = step === 30 ? d.getMonth() : Math.floor((day - 1) / step);
        if (p < startPeriod || p > endPeriod) return;

        const name = rawRaion;
        const infraType = r.type_of_infrastructure?.trim() || 'Unspecified';
        const extent = r.extent_of_damage?.trim() || 'Unspecified';

        const timeLabel = step === 30 ? monthsList[p] : `${step === 7 ? 'Week' : 'Fortnight'} ${p + 1}`;

        // Cross-filter evaluation:
        if (activeFilter) {
            if (activeFilter.dimension === 'raion' && name !== activeFilter.value) return;
            if (activeFilter.dimension === 'infra' && infraType !== activeFilter.value) return;
            if (activeFilter.dimension === 'extent' && extent !== activeFilter.value) return;
            if (activeFilter.dimension === 'period' && timeLabel !== activeFilter.value) return;
        }

        counts[name] = (counts[name] || 0) + 1;
        infraCounts[infraType] = (infraCounts[infraType] || 0) + 1;
        extentCounts[extent] = (extentCounts[extent] || 0) + 1;
        
        if (timeCounts[timeLabel] !== undefined) {
            timeCounts[timeLabel] += 1;
        }
    });

    if (totalEl) totalEl.textContent = Object.values(counts).reduce((a, b) => a + b, 0).toLocaleString();

    const breaks = computeDynamicBreaks(counts);
    updateLegend(breaks);

    const chartSeries = updateSummaryCharts(counts, infraCounts, extentCounts, timeCounts, labelsList);

    // Zoom the map to the filtered area: a raion selected via the dropdown
    // takes precedence, then a raion selected by clicking the map/a chart,
    // then the oblast dropdown; otherwise zoom back out to all of Ukraine.
    const effectiveRaion = raionFilter || (activeFilter && activeFilter.dimension === 'raion' ? activeFilter.value : null);
    applyMapZoomForScope(oblastFilter, effectiveRaion);

    // Expose the current filter state + underlying numbers for anything
    // outside this module that needs them (e.g. the PDF report generator).
    window.__mapReportState = {
        year: targetYear,
        aggregationLabel: aggEl.options[aggEl.selectedIndex]?.text || '',
        startLabel: startEl.options[startEl.selectedIndex]?.text || '',
        endLabel: endEl.options[endEl.selectedIndex]?.text || '',
        oblastFilter: oblastFilter || null,
        raionFilter: raionFilter || null,
        activeFilter: activeFilter ? { ...activeFilter } : null,
        nationalTotal: Object.values(counts).reduce((a, b) => a + b, 0),
        raionCounts: { ...counts },
        infraCounts: { ...infraCounts },
        extentCounts: { ...extentCounts },
        timeCounts: { ...timeCounts },
        labelsList: [...labelsList],
        chartSeries
    };

    if (leafletGeoLayer) mapInstance.removeLayer(leafletGeoLayer);

    leafletGeoLayer = L.geoJSON(geoJSONData, {
        style: f => {
            const rawGeoName = f.properties.adm2_name || '';
            const geoName = RAION_NAME_MAP[rawGeoName] || rawGeoName;
            const isSelected = activeFilter && activeFilter.dimension === 'raion' && activeFilter.value === geoName;
            return {
                fillColor: getThematicColor(counts[geoName] || 0, breaks),
                weight: isSelected ? 3 : 1,
                color: isSelected ? '#1a3a5c' : '#666',
                fillOpacity: 0.7
            };
        },
        onEachFeature: (f, l) => {
            const rawGeoName = f.properties.adm2_name || '';
            const geoName = RAION_NAME_MAP[rawGeoName] || rawGeoName;

            l.on('mouseover', e => {
                window.mapInfoPanel._div.innerHTML = `<h4>${rawGeoName}</h4><b>Damages:</b> ${(counts[geoName] || 0).toLocaleString()}`;
            });
            l.on('click', e => {
                setActiveFilter('raion', geoName);
            });
        }
    }).addTo(mapInstance);
}

function updateSummaryCharts(raionCounts, infraCounts, extentCounts, timeCounts, labelsList) {
    if (typeof Chart === 'undefined') return null;

    // 1. Top Raions Bar Chart
    const topRaions = Object.entries(raionCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
    topRaionsChartInstance = renderBarChart(
        'map-top-oblasts-chart', topRaionsChartInstance,
        topRaions.map(e => e[0]), topRaions.map(e => e[1]), 'raion'
    );

    // 2. Infrastructure Breakdown Bar Chart
    const infraEntries = Object.entries(infraCounts).sort((a, b) => b[1] - a[1]);
    const topInfra = infraEntries.slice(0, 7);
    const otherInfraTotal = infraEntries.slice(7).reduce((sum, e) => sum + e[1], 0);
    const infraLabels = topInfra.map(e => e[0]);
    const infraValues = topInfra.map(e => e[1]);
    if (otherInfraTotal > 0) {
        infraLabels.push('Other');
        infraValues.push(otherInfraTotal);
    }
    infraTypeChartInstance = renderBarChart('map-infra-type-chart', infraTypeChartInstance, infraLabels, infraValues, 'infra');

    // 3. Extent Doughnut Chart
    const extentEntries = Object.entries(extentCounts).sort((a, b) => b[1] - a[1]);
    extentChartInstance = renderDoughnutChart(
        'map-extent-chart', extentChartInstance,
        extentEntries.map(e => e[0]), extentEntries.map(e => e[1]), 'extent'
    );

    // 4. Timeline Bar Chart (Configured without gridlines)
    const timelineValues = labelsList.map(lbl => timeCounts[lbl] || 0);
    timelineChartInstance = renderTimelineBarChart(
        'map-timeline-chart', timelineChartInstance, 
        labelsList, timelineValues, 'period'
    );

    // Expose the exact series each chart was drawn with, so the PDF report
    // can rebuild identical vector charts without re-deriving the Top-N /
    // "Other" bucketing / sort order logic a second time.
    return {
        topRaions: { labels: topRaions.map(e => e[0]), values: topRaions.map(e => e[1]) },
        infra: { labels: infraLabels, values: infraValues },
        extent: { labels: extentEntries.map(e => e[0]), values: extentEntries.map(e => e[1]) },
        timeline: { labels: labelsList, values: timelineValues }
    };
}

function isFilterableLabel(label) {
    return label !== 'Other';
}

function renderBarChart(canvasId, existingInstance, labels, data, dimension) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return existingInstance;

    const backgroundColor = labels.map(l =>
        (activeFilter && activeFilter.dimension === dimension && activeFilter.value === l)
            ? FILTER_HIGHLIGHT_COLOR : CHART_PALETTE[0]
    );

    if (existingInstance) {
        existingInstance.data.labels = labels;
        existingInstance.data.datasets[0].data = data;
        existingInstance.data.datasets[0].backgroundColor = backgroundColor;
        existingInstance.update();
        return existingInstance;
    }

    return new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ data, backgroundColor, borderRadius: 4 }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { right: 34 } },
            plugins: {
                legend: { display: false },
                // Value labels rendered just past the end of each bar, so
                // the value axis below is no longer needed to read amounts.
                datalabels: {
                    anchor: 'end',
                    align: 'end',
                    clip: false,
                    color: '#1a3a5c',
                    font: { size: 10, weight: '600' },
                    formatter: value => value.toLocaleString()
                }
            },
            scales: {
                // Value axis removed - each bar now carries its own label.
                x: {
                    display: false,
                    beginAtZero: true,
                    grace: '12%'
                },
                y: {
                    grid: { display: false }
                }
            },
            onClick: (evt, elements, chart) => {
                if (!elements.length) return;
                const label = chart.data.labels[elements[0].index];
                if (!isFilterableLabel(label)) return;
                setActiveFilter(dimension, label);
            },
            onHover: (evt, elements) => {
                evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
            }
        }
    });
}

function renderDoughnutChart(canvasId, existingInstance, labels, data, dimension) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return existingInstance;

    const borderWidth = labels.map(l =>
        (activeFilter && activeFilter.dimension === dimension && activeFilter.value === l) ? 4 : 0
    );

    if (existingInstance) {
        existingInstance.data.labels = labels;
        existingInstance.data.datasets[0].data = data;
        existingInstance.data.datasets[0].borderWidth = borderWidth;
        existingInstance.update();
        return existingInstance;
    }

    return new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data, backgroundColor: CHART_PALETTE, borderColor: '#1a3a5c', borderWidth }]
        },
        plugins: [outsideDoughnutLabelsPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            // Extra room on every side for the outside labels + leader
            // lines drawn by outsideDoughnutLabelsPlugin.
            layout: { padding: { top: 36, bottom: 36, left: 84, right: 84 } },
            // The legend is dropped in favour of the outside labels, which
            // already carry the category name, value, and percentage.
            plugins: { legend: { display: false }, datalabels: { display: false } },
            onClick: (evt, elements, chart) => {
                if (!elements.length) return;
                const label = chart.data.labels[elements[0].index];
                if (!isFilterableLabel(label)) return;
                setActiveFilter(dimension, label);
            },
            onHover: (evt, elements) => {
                evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
            }
        }
    });
}

// 5. Timeline Render Engine as a Gridless Bar Chart
function renderTimelineBarChart(canvasId, existingInstance, labels, data, dimension) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return existingInstance;

    const backgroundColor = labels.map(l =>
        (activeFilter && activeFilter.dimension === dimension && activeFilter.value === l)
            ? FILTER_HIGHLIGHT_COLOR : CHART_PALETTE[0]
    );

    if (existingInstance) {
        existingInstance.data.labels = labels;
        existingInstance.data.datasets[0].data = data;
        existingInstance.data.datasets[0].backgroundColor = backgroundColor;
        existingInstance.update();
        return existingInstance;
    }

    return new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 26 } },
            plugins: {
                legend: { display: false },
                // Value labels rendered just above each column, so the
                // value axis below is no longer needed to read amounts.
                datalabels: {
                    anchor: 'end',
                    align: 'end',
                    clip: false,
                    color: '#1a3a5c',
                    font: { size: 8, weight: '600' },
                    formatter: value => value.toLocaleString(),
                    // Skip empty periods entirely rather than stamping a
                    // "0" above every zero-value column.
                    display: context => context.dataset.data[context.dataIndex] > 0
                }
            },
            scales: {
                x: {
                    grid: {
                        drawOnChartArea: false, // Removes background vertical grid lines
                        drawTicks: true         // Keeps x-axis tick marks
                    }
                },
                // Value axis removed - each column now carries its own label.
                y: {
                    display: false,
                    beginAtZero: true,
                    grace: '18%'
                }
            },
            onClick: (evt, elements, chart) => {
                if (!elements.length) return;
                const index = elements[0].index;
                const label = chart.data.labels[index];
                setActiveFilter(dimension, label);
            },
            onHover: (evt, elements) => {
                evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
            }
        }
    });
}