let rawDamageCSV = [];
let geoJSONData = null;
let leafletGeoLayer = null;
let mapInstance = null;

const monthsList = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

window.addEventListener('DOMContentLoaded', () => {
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

const THEMATIC_COLORS = ['#fff5eb', '#fee6ce', '#fdd0a2', '#fdae6b', '#f16913', '#d94801'];

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
    window.mapLegend = L.control({ position: 'bottomright' });
    window.mapLegend.onAdd = function() {
        this._div = L.DomUtil.create('div', 'map-legend');
        this._div.innerHTML = '<strong>Damage Scale</strong><br>Loading&hellip;';
        return this._div;
    };
    window.mapLegend.addTo(mapInstance);
}

// Computes 6 ascending thematic breakpoints from whatever data is currently
// on screen, so the legend/colour scale adapts to the selected period
// instead of using a single fixed scale for every view.
function computeDynamicBreaks(counts) {
    const values = Object.values(counts).filter(v => v > 0);
    const max = values.length ? Math.max(...values) : 0;

    if (max <= 5) {
        // Small counts: keep the scale simple and integer-based.
        return [0, 1, 2, 3, 4, 5];
    }

    const proportions = [0.05, 0.15, 0.35, 0.65, 1];
    const breaks = [0];
    proportions.forEach(p => {
        let v = roundNice(max * p);
        if (v <= breaks[breaks.length - 1]) v = breaks[breaks.length - 1] + 1;
        breaks.push(v);
    });
    return breaks; // e.g. [0, b1, b2, b3, b4, b5]
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
    const grades = breaks || [0, 50, 200, 500, 1000, 1500];
    return val > grades[5] ? THEMATIC_COLORS[5]
        : val > grades[4] ? THEMATIC_COLORS[4]
        : val > grades[3] ? THEMATIC_COLORS[3]
        : val > grades[2] ? THEMATIC_COLORS[2]
        : val > grades[1] ? THEMATIC_COLORS[1]
        : THEMATIC_COLORS[0];
}

function updateLegend(breaks) {
    if (!window.mapLegend || !window.mapLegend._div) return;
    let html = '<strong>Damage Scale</strong><br>';
    for (let i = 0; i < breaks.length; i++) {
        html += '<i style="background:' + THEMATIC_COLORS[i] + '"></i> ' +
            breaks[i] + (breaks[i + 1] !== undefined ? '&ndash;' + breaks[i + 1] + '<br>' : '+');
    }
    window.mapLegend._div.innerHTML = html;
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

    // Default to a single-window range (behaves like a normal single-period
    // selection until the user widens the "to" side).
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

    // Add specific name overrides here if auto-normalization isn't enough
    const nameMap = {};

    const counts = {};
    rawDamageCSV.forEach(r => {
        const rawOblast = r.oblast?.trim();
        if (!rawOblast) return; 

        const d = new Date(r.date_of_event);
        if (!isNaN(d) && d.getFullYear() === targetYear) {
            const day = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
            const p = step === 30 ? d.getMonth() : Math.floor((day - 1) / step);
            
            if (p >= startPeriod && p <= endPeriod) {
                // Normalize names to match GeoJSON properties
                const name = nameMap[rawOblast] || rawOblast.replace('ska', '');
                counts[name] = (counts[name] || 0) + 1;
            }
        }
    });

    if (totalEl) totalEl.textContent = Object.values(counts).reduce((a, b) => a + b, 0).toLocaleString();

    // Recompute the colour scale from the data actually shown in this
    // period, rather than a scale fixed for every view.
    const breaks = computeDynamicBreaks(counts);
    updateLegend(breaks);

    if (leafletGeoLayer) mapInstance.removeLayer(leafletGeoLayer);
    
    leafletGeoLayer = L.geoJSON(geoJSONData, {
        style: f => {
            const rawGeoName = (f.properties.adm1_name || f.properties.ADM1_EN || '');
            const geoName = nameMap[rawGeoName] || rawGeoName.replace('ska', '');
            return {
                fillColor: getThematicColor(counts[geoName] || 0, breaks),
                weight: 1, 
                color: '#666', 
                fillOpacity: 0.7
            };
        },
        onEachFeature: (f, l) => {
            l.on('mouseover', e => {
                const rawGeoName = (f.properties.adm1_name || f.properties.ADM1_EN || '');
                const name = nameMap[rawGeoName] || rawGeoName.replace('ska', '');
                window.mapInfoPanel._div.innerHTML = `<h4>${f.properties.adm1_name}</h4><b>Damages:</b> ${(counts[name] || 0).toLocaleString()}`;
            });
        }
    }).addTo(mapInstance);
}