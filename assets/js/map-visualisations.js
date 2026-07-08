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
        buildMapFilterOptions();
    });
});

function initMapElement() {
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

    // UI: Legend
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = function() {
        const div = L.DomUtil.create('div', 'map-legend');
        const grades = [0, 50, 200, 500, 1000, 1500];
        div.innerHTML = '<strong>Damage Scale</strong><br>';
        for (let i = 0; i < grades.length; i++) {
            div.innerHTML += '<i style="background:' + getThematicColor(grades[i] + 1) + '"></i> ' +
                grades[i] + (grades[i + 1] ? '&ndash;' + grades[i + 1] + '<br>' : '+');
        }
        return div;
    };
    legend.addTo(mapInstance);
}

function getThematicColor(val) {
    return val > 1500 ? '#d94801' : val > 1000 ? '#f16913' : val > 500 ? '#fdae6b' : val > 200 ? '#fdd0a2' : val > 50 ? '#fee6ce' : '#fff5eb';
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
    const periodSel = document.getElementById('map-period-select');
    if (!periodSel) return;
    periodSel.innerHTML = aggType === '30' 
        ? monthsList.map((m, i) => `<option value="${i}">${m}</option>`).join('')
        : Array.from({length: Math.ceil(365/aggType)}, (_, i) => `<option value="${i}">${aggType==7?'Week':'Fortnight'} ${i+1}</option>`).join('');
    processMapVisualisations();
}

function processMapVisualisations() {
    if (!geoJSONData || !rawDamageCSV) return;

    const yearEl = document.getElementById('map-year-select');
    const periodEl = document.getElementById('map-period-select');
    const aggEl = document.getElementById('map-aggregation-select');
    const totalEl = document.getElementById('map-total-value');
    
    if (!yearEl || !periodEl || !aggEl) return;

    const targetYear = parseInt(yearEl.value);
    const targetPeriod = parseInt(periodEl.value);
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
            
            if (p === targetPeriod) {
                // Normalize names to match GeoJSON properties
                const name = nameMap[rawOblast] || rawOblast.replace('ska', '');
                counts[name] = (counts[name] || 0) + 1;
            }
        }
    });

    if (totalEl) totalEl.textContent = Object.values(counts).reduce((a, b) => a + b, 0).toLocaleString();

    if (leafletGeoLayer) mapInstance.removeLayer(leafletGeoLayer);
    
    leafletGeoLayer = L.geoJSON(geoJSONData, {
        style: f => {
            const rawGeoName = (f.properties.adm1_name || f.properties.ADM1_EN || '');
            const geoName = nameMap[rawGeoName] || rawGeoName.replace('ska', '');
            return {
                fillColor: getThematicColor(counts[geoName] || 0),
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