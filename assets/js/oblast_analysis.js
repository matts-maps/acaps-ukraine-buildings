let rawDamageCSV = [];
let geoJSONData = null;
let leafletGeoLayer = null;
let mapInstance = null;

let topOblastsChartInstance = null;
let infraTypeChartInstance = null;
let extentChartInstance = null;
let timelineChartInstance = null; // Added timeline chart instance

// The single cross-filter selection currently active, set by clicking an
// oblast on the map, a bar/segment in one of the charts, or a timeline bar. 
// When set, every visual (map + all charts + total) is recomputed against 
// only the rows matching this selection, on top of the year/range filters.
let activeFilter = null; // { dimension: 'oblast' | 'infra' | 'extent' | 'period', value: string }

const CHART_PALETTE = ['#1a3a5c', '#2c5f8a', '#4a90c4', '#7cb4dd', '#a8d0e8', '#d94801', '#f16913', '#fdae6b', '#fdd0a2', '#999999'];
const FILTER_HIGHLIGHT_COLOR = '#d94801';

const monthsList = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Changed to 'load' to ensure stylesheets are ready, resolving the layout/reflow warning
window.addEventListener('load', () => {
    const csvPath = window.MAP_CSV_PATH || '/data/ukraine-damages.csv';
    const geojsonPath = window.MAP_GEOJSON_PATH || '/data/ukr_admn_ad1_py_s0_fieldmaps_pp_oblast.json';

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
            mapInstance.fitBounds(bounds, { padding: [15, 15] });
        }

        buildMapFilterOptions();
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
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 20
    }).addTo(mapInstance);
    
    // UI: Info Panel
    window.mapInfoPanel = L.control({ position: 'topright' });
    window.mapInfoPanel.onAdd = function() {
        this._div = L.DomUtil.create('div', 'map-info-panel');
        this._div.innerHTML = '<h4>Oblast Metric Profile</h4>Hover over an administrative region';
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
            oblast: 'Oblast', 
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

    startSel.selectedIndex = 0;
    endSel.selectedIndex = 0;

    processMapVisualisations();
}

function processMapVisualisations() {
    if (!geoJSONData || !rawDamageCSV) return;

    const yearEl = document.getElementById('map-year-select');
    const startEl = document.getElementById('map-period-start-select');
    const endEl = document.getElementById('map-period-end-select');
    const aggEl = document.getElementById('map-aggregation-select');
    const totalEl = document.getElementById('map-total-value');
    
    if (!yearEl || !startEl || !endEl || !aggEl) return;

    const targetYear = parseInt(yearEl.value);
    let startPeriod = parseInt(startEl.value);
    let endPeriod = parseInt(endEl.value);
    if (startPeriod > endPeriod) [startPeriod, endPeriod] = [endPeriod, startPeriod];
    const step = parseInt(aggEl.value);

    const nameMap = {};

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
        const rawOblast = r.oblast?.trim();
        if (!rawOblast) return; 

        const d = new Date(r.date_of_event);
        if (isNaN(d) || d.getFullYear() !== targetYear) return;

        const day = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
        const p = step === 30 ? d.getMonth() : Math.floor((day - 1) / step);
        if (p < startPeriod || p > endPeriod) return;

        const name = nameMap[rawOblast] || rawOblast.replace('ska', '');
        const infraType = r.type_of_infrastructure?.trim() || 'Unspecified';
        const extent = r.extent_of_damage?.trim() || 'Unspecified';

        const timeLabel = step === 30 ? monthsList[p] : `${step === 7 ? 'Week' : 'Fortnight'} ${p + 1}`;

        // Cross-filter evaluation:
        if (activeFilter) {
            if (activeFilter.dimension === 'oblast' && name !== activeFilter.value) return;
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

    updateSummaryCharts(counts, infraCounts, extentCounts, timeCounts, labelsList);

    if (leafletGeoLayer) mapInstance.removeLayer(leafletGeoLayer);
    
    leafletGeoLayer = L.geoJSON(geoJSONData, {
        style: f => {
            const rawGeoName = (f.properties.adm1_name || f.properties.ADM1_EN || '');
            const geoName = nameMap[rawGeoName] || rawGeoName.replace('ska', '');
            const isSelected = activeFilter && activeFilter.dimension === 'oblast' && activeFilter.value === geoName;
            return {
                fillColor: getThematicColor(counts[geoName] || 0, breaks),
                weight: isSelected ? 3 : 1,
                color: isSelected ? '#1a3a5c' : '#666',
                fillOpacity: 0.7
            };
        },
        onEachFeature: (f, l) => {
            const rawGeoName = (f.properties.adm1_name || f.properties.ADM1_EN || '');
            const geoName = nameMap[rawGeoName] || rawGeoName.replace('ska', '');

            l.on('mouseover', e => {
                window.mapInfoPanel._div.innerHTML = `<h4>${f.properties.adm1_name}</h4><b>Damages:</b> ${(counts[geoName] || 0).toLocaleString()}`;
            });
            l.on('click', e => {
                setActiveFilter('oblast', geoName);
            });
        }
    }).addTo(mapInstance);
}

function updateSummaryCharts(oblastCounts, infraCounts, extentCounts, timeCounts, labelsList) {
    if (typeof Chart === 'undefined') return;

    const topOblasts = Object.entries(oblastCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
    topOblastsChartInstance = renderBarChart(
        'map-top-oblasts-chart', topOblastsChartInstance,
        topOblasts.map(e => e[0]), topOblasts.map(e => e[1]), 'oblast'
    );

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

    const extentEntries = Object.entries(extentCounts).sort((a, b) => b[1] - a[1]);
    extentChartInstance = renderDoughnutChart(
        'map-extent-chart', extentChartInstance,
        extentEntries.map(e => e[0]), extentEntries.map(e => e[1]), 'extent'
    );

    // 4. Timeline Gridless Bar Chart
    const timelineValues = labelsList.map(lbl => timeCounts[lbl] || 0);
    timelineChartInstance = renderTimelineBarChart(
        'map-timeline-chart', timelineChartInstance, 
        labelsList, timelineValues, 'period'
    );
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
            plugins: { legend: { display: false } },
            scales: { 
                x: { 
                    beginAtZero: true, 
                    ticks: { precision: 0 },
                    grid: { drawOnChartArea: false, drawTicks: true }
                },
                y: {
                    grid: { drawOnChartArea: false, drawTicks: true }
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
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
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

// Timeline Gridless Bar Chart
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
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    grid: { 
                        drawOnChartArea: false, // Removes background vertical grid lines
                        drawTicks: true         // Keeps x-axis tick marks
                    }
                },
                y: {
                    beginAtZero: true,
                    ticks: { precision: 0 },
                    grid: { 
                        drawOnChartArea: false, // Removes background horizontal grid lines
                        drawTicks: true         // Keeps y-axis tick marks
                    }
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