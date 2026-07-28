let rawCSVData = [];
let chartInstance = null;
let uniqueYearsList = [];
let lastChartSVG = '';

// Store selected baseline years for each target year in a global map
// e.g., comparisonBaselineOverrides.get(2024) = 2022
const comparisonBaselineOverrides = new Map();

// Date range tracking for real dates in dropdowns
let minDataDate = null;
let maxDataDate = null;

const calendarMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const YEAR_COLORS = ['#1a3a5c', '#e07b39', '#2c8f7a', '#c0392b', '#8e44ad', '#2c5f8a', '#d4a017', '#555555'];

// Kept in sync with the identical table in map-analysis-core.js so building
// type labels read the same on the national, oblast, and raion pages.
const INFRA_LABEL_MAP = {
  "Industrial/Business/Enterprise facilities": "Industrial/Business/Enterprise",
  "Education facility (school, etc.)": "Education",
  "Government facilities": "Government",
  "Cultural facilities (museum, theater etc.)": "Cultural",
  "Health facility (hospital, health clinic)": "Health",
  "Agricultural facilities": "Agricultural",
  "Religious facilities": "Religious"
};
const BLANK_INFRA_LABEL = "(blank/missing)";

function normalizeInfraLabel(raw) {
  const trimmed = raw ? raw.trim() : "";
  if (!trimmed) return BLANK_INFRA_LABEL;
  return INFRA_LABEL_MAP[trimmed] || trimmed;
}

function getSelectedInfraType() {
  const el = document.getElementById('infra-type-select');
  return el ? el.value : '';
}

window.addEventListener('DOMContentLoaded', () => {
  const csvPath = window.DASHBOARD_CSV_PATH || '/data/ukraine-damages.csv'; 
  
  if (typeof Papa === 'undefined') {
    console.error('PapaParse library missing.');
    return;
  }

  Papa.parse(csvPath, {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: function(results) {
      if (!results.data || results.data.length === 0) {
        showError('Empty target database context parsed.');
        return;
      }
      rawCSVData = results.data;
      calculateDataDateRange();
      initializeDashboardOptions();
    },
    error: () => showError('Unable to route repository CSV payload array map.')
  });
});

// Calculate min and max dates from the CSV data
function calculateDataDateRange() {
  if (rawCSVData.length === 0) return;
  
  let minDate = null;
  let maxDate = null;
  
  rawCSVData.forEach(row => {
    const dateStr = (row.date_of_event || '').trim();
    if (!dateStr) return;
    
    const d = new Date(dateStr);
    if (isNaN(d)) return;
    
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  });
  
  minDataDate = minDate;
  maxDataDate = maxDate;
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

function colorForYear(year) {
  const idx = uniqueYearsList.indexOf(year);
  return YEAR_COLORS[idx % YEAR_COLORS.length];
}

function getSelectedYears() {
  return Array.from(document.querySelectorAll('#year-checkboxes input[type="checkbox"]:checked'))
    .map(cb => parseInt(cb.value))
    .sort((a, b) => a - b);
}

function initializeDashboardOptions() {
  const detectedYears = new Set();
  
  rawCSVData.forEach(row => {
    const dateStr = (row.date_of_event || '').trim();
    if (dateStr.length >= 4) {
      const yr = parseInt(dateStr.slice(0, 4));
      if (!isNaN(yr)) detectedYears.add(yr);
    }
  });

  uniqueYearsList = Array.from(detectedYears).sort((a, b) => a - b);
  
  if (uniqueYearsList.length < 1) {
    showError("Could not extract any historical timeline metadata rows.");
    return;
  }

  const checkboxContainer = document.getElementById('year-checkboxes');
  if (!checkboxContainer) return;

  checkboxContainer.innerHTML = '';

  const defaultCheckedYears = new Set(uniqueYearsList.slice(-2));

  uniqueYearsList.forEach(yr => {
    const id = `year-cb-${yr}`;
    const wrapper = document.createElement('label');
    wrapper.setAttribute('for', id);
    wrapper.style.color = colorForYear(yr);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.value = yr;
    cb.checked = defaultCheckedYears.has(yr);
    cb.addEventListener('change', updateChartAndStats);

    wrapper.appendChild(cb);
    wrapper.appendChild(document.createTextNode(yr));
    checkboxContainer.appendChild(wrapper);
  });

  populateInfraTypeOptions();
  initializeHighlightDateInputs();

  const controls = document.getElementById('controls');
  if (controls) controls.style.display = 'flex';

  updateChartAndStats();
}

function formatDateInput(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Defaults the From/To pickers to the trailing 7 calendar days ending today,
// so the current week is highlighted on first load.
function initializeHighlightDateInputs() {
  const startEl = document.getElementById('highlight-start');
  const endEl = document.getElementById('highlight-end');
  if (!startEl || !endEl) return;

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 6);

  startEl.value = formatDateInput(start);
  endEl.value = formatDateInput(end);
}

// Reads the From/To date pickers and converts them to day-of-year bounds,
// so the highlighted window compares the same calendar dates across every
// selected year regardless of which one the pickers themselves show.
function getHighlightRange() {
  const startEl = document.getElementById('highlight-start');
  const endEl = document.getElementById('highlight-end');
  if (!startEl || !endEl || !startEl.value || !endEl.value) return null;

  let startDate = new Date(startEl.value);
  let endDate = new Date(endEl.value);
  if (isNaN(startDate) || isNaN(endDate)) return null;

  if (startDate > endDate) {
    const temp = startDate;
    startDate = endDate;
    endDate = temp;
  }

  return {
    startDate,
    endDate,
    startDoy: calculateDayOfYear(startDate),
    endDoy: calculateDayOfYear(endDate)
  };
}

function populateInfraTypeOptions() {
  const sel = document.getElementById('infra-type-select');
  if (!sel) return;

  const types = new Set();
  rawCSVData.forEach(row => types.add(normalizeInfraLabel(row.type_of_infrastructure)));

  const sorted = Array.from(types).sort();
  sel.innerHTML = '<option value="">All building types</option>' +
    sorted.map(t => `<option value="${t}">${t}</option>`).join('');
}

// UPDATED: Generate period labels with real dates from data
function getPeriodLabels(daysInStep) {
  if (daysInStep === 30) return calendarMonths;

  // Calculate date range if not already done
  if (!minDataDate || !maxDataDate) {
    calculateDataDateRange();
  }

  // Use actual data year, fallback to current year if no data
  const referenceYear = maxDataDate ? maxDataDate.getFullYear() : new Date().getFullYear();
  
  const labels = [];
  const totalPeriods = Math.ceil(365 / daysInStep);
  const prefix = daysInStep === 7 ? 'Week' : 'Fortnight';
  
  for (let i = 0; i < totalPeriods; i++) {
    const startDay = i * daysInStep + 1;
    let endDay = startDay + daysInStep - 1;
    if (endDay > 365) endDay = 365;

    // Use actual data year instead of hardcoded 2025
    const dStart = new Date(referenceYear, 0, startDay);
    const dEnd = new Date(referenceYear, 0, endDay);
    
    // Format dates nicely (e.g., "24 Feb" instead of "Feb 24")
    const fmt = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    
    labels.push(`${prefix} ${i + 1} (${fmt(dStart)} – ${fmt(dEnd)})`);
  }
  return labels;
}

function calculateDayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / 86400000);
}

function updateChartAndStats() {
  const periodTypeEl = document.getElementById('period-type');
  if (!periodTypeEl) return;

  const selectedYears = getSelectedYears();
  const chartCard = document.getElementById('chart-card');
  const statsEl = document.getElementById('stats');

  if (selectedYears.length === 0) {
    if (chartCard) chartCard.style.display = 'none';
    if (statsEl) { statsEl.style.display = 'none'; statsEl.innerHTML = ''; }
    showError('Select at least one year to display the timeline.');
    return;
  }

  const range = getHighlightRange();
  if (!range) {
    if (chartCard) chartCard.style.display = 'none';
    if (statsEl) { statsEl.style.display = 'none'; statsEl.innerHTML = ''; }
    showError('Select a From and To date for the highlighted period.');
    return;
  }
  document.getElementById('error-msg').style.display = 'none';

  const stepDays = parseInt(periodTypeEl.value);

  const periodLabels = getPeriodLabels(stepDays);
  const totalPeriods = periodLabels.length;

  const infraFilter = getSelectedInfraType();

  const countsByYear = new Map(selectedYears.map(yr => [yr, new Array(totalPeriods).fill(0)]));
  let maxDate = null;

  rawCSVData.forEach(row => {
    if (infraFilter && normalizeInfraLabel(row.type_of_infrastructure) !== infraFilter) return;
    const dateStr = (row.date_of_event || '').trim();
    if (!dateStr) return;
    const d = new Date(dateStr);
    if (isNaN(d)) return;
    if (!maxDate || d > maxDate) maxDate = d;
    const year = d.getFullYear();
    const yearCounts = countsByYear.get(year);
    if (!yearCounts) return;

    let pIdx = 0;
    if (stepDays === 30) {
      pIdx = d.getMonth();
    } else {
      const dayNum = calculateDayOfYear(d);
      pIdx = Math.floor((dayNum - 1) / stepDays);
      if (pIdx >= totalPeriods) pIdx = totalPeriods - 1;
      if (pIdx < 0) pIdx = 0;
    }
    yearCounts[pIdx]++;
  });

  const maxDataYear = maxDate ? maxDate.getFullYear() : null;
  let maxDataPeriodIdx = null;
  if (maxDate) {
    if (stepDays === 30) {
      maxDataPeriodIdx = maxDate.getMonth();
    } else {
      const dayNum = calculateDayOfYear(maxDate);
      maxDataPeriodIdx = Math.floor((dayNum - 1) / stepDays);
      if (maxDataPeriodIdx >= totalPeriods) maxDataPeriodIdx = totalPeriods - 1;
      if (maxDataPeriodIdx < 0) maxDataPeriodIdx = 0;
    }
  }

  const pointsByYear = new Map();
  selectedYears.forEach(yr => {
    const yearCounts = countsByYear.get(yr);
    const beyondData = yr === maxDataYear;
    const pts = [];
    for (let i = 0; i < totalPeriods; i++) {
      let decimalX = 0;
      if (stepDays === 30) {
        decimalX = i;
      } else {
        const centerDay = (i * stepDays) + (stepDays / 2);
        decimalX = (centerDay / 365) * 12;
      }
      const isBeyond = beyondData && i > maxDataPeriodIdx;
      pts.push({ x: decimalX, y: isBeyond ? null : yearCounts[i] });
    }
    pointsByYear.set(yr, pts);
  });

  const highlightXStart = (range.startDoy / 365) * 12;
  const highlightXEnd = ((range.endDoy + 1) / 365) * 12;

  const highlightPlugin = {
    id: 'dynamicHighlightBand',
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const xScale = scales.x;
      const x0 = xScale.getPixelForValue(highlightXStart);
      const x1 = xScale.getPixelForValue(highlightXEnd);
      ctx.save();
      ctx.fillStyle = 'rgba(230, 126, 34, 0.18)'; 
      ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
      ctx.restore();
    }
  };

  const canvas = document.getElementById('myChart');
  if (!canvas) return;
  if (chartInstance) chartInstance.destroy();

  const infraSuffix = infraFilter ? ` (${infraFilter})` : '';
  const titleText = (selectedYears.length === 1
    ? `Damaged buildings timeline comparison - ${selectedYears[0]}`
    : `Damaged buildings timeline comparison - ${selectedYears.join(' vs ')}`) + infraSuffix;

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: selectedYears.map(yr => ({
        label: `${yr}`,
        data: pointsByYear.get(yr),
        borderColor: colorForYear(yr),
        backgroundColor: 'transparent',
        borderWidth: 2.5,
        tension: 0.25,
        pointRadius: 0,
        pointHitRadius: 10
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true } },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (!items.length) return '';
              const itemIdx = items[0].dataIndex;
              return periodLabels[itemIdx].split(' (')[0];
            },
            label: item => ` Year ${item.dataset.label}: ${item.raw.y.toLocaleString()} incidents`
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: 12,
          ticks: {
            stepSize: 1,
            maxRotation: 0,
            callback: function(val) { return calendarMonths[val] || ''; }
          },
          grid: { 
            display: true,
            drawOnChartArea: false,
            drawTicks: true
          }
        },
        y: { 
          beginAtZero: true, 
          title: { display: true, text: 'Recorded Structural Damages' },
          grid: { 
            drawOnChartArea: false,
            drawTicks: true
          }
        }
      }
    },
    plugins: [highlightPlugin]
  });

  // Totals are summed directly from the raw rows against the picked calendar
  // dates (day-of-year, so the same window is compared across every year)
  // rather than from the chart's aggregation buckets - this works for every
  // year in the dataset regardless of whether it's currently plotted.
  const totalsByYear = new Map();
  uniqueYearsList.forEach(yr => {
    let total = 0;
    rawCSVData.forEach(row => {
      if (infraFilter && normalizeInfraLabel(row.type_of_infrastructure) !== infraFilter) return;
      const dateStr = (row.date_of_event || '').trim();
      if (!dateStr) return;
      const d = new Date(dateStr);
      if (isNaN(d) || d.getFullYear() !== yr) return;
      const doy = calculateDayOfYear(d);
      if (doy >= range.startDoy && doy <= range.endDoy) total++;
    });
    totalsByYear.set(yr, total);
  });

  const dateFmt = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const rangeDisplay = dateFmt(range.startDate) === dateFmt(range.endDate)
    ? dateFmt(range.startDate)
    : `${dateFmt(range.startDate)} – ${dateFmt(range.endDate)}`;

  document.getElementById('chart-card').style.display = 'block';
  document.getElementById('chart-title').textContent = titleText;
  document.getElementById('chart-subtitle').textContent = `Highlighted Interval Window: ${rangeDisplay}`;

  renderStatsBoxes(selectedYears, totalsByYear, rangeDisplay);
  lastChartSVG = buildChartSVG({ selectedYears, pointsByYear, periodLabels, highlightXStart, highlightXEnd, titleText, subtitleText: `Highlighted Interval Window: ${rangeDisplay}` });
}

function renderStatsBoxes(selectedYears, totalsByYear, rangeDisplay) {
  const statsEl = document.getElementById('stats');
  if (!statsEl) return;

  const sortedYears = [...selectedYears].sort((a, b) => a - b);

  statsEl.innerHTML = sortedYears.map(yr => {
    const total = totalsByYear.get(yr);
    const color = colorForYear(yr);
    
    // Get all years that are chronological ancestors of the target year
    const historicalYears = uniqueYearsList.filter(y => y < yr);

    // Retrieve the active override selection, otherwise default to the
    // closest prior year that actually has data. (yr - 1 isn't safe to
    // assume here - if there's a gap in the dataset, e.g. no records for
    // one calendar year, yr - 1 may not be a real option, which used to
    // leave the <select> showing one year while the percentage was
    // silently computed against a different one.)
    const closestHistoricalYear = historicalYears.length
      ? historicalYears.reduce((a, b) => (b > a ? b : a))
      : null;
    let selectedBaseline = comparisonBaselineOverrides.get(yr);
    if (!historicalYears.includes(selectedBaseline)) {
      selectedBaseline = closestHistoricalYear;
    }

    let deltaHTML = '';

    if (historicalYears.length > 0) {
      // Build interactive selector options
      const dropdownOptions = historicalYears.map(histYr => {
        const isSel = histYr === selectedBaseline ? 'selected' : '';
        return `<option value="${histYr}" ${isSel}>vs ${histYr}</option>`;
      }).join('');

      const baseTotal = totalsByYear.get(selectedBaseline) || 0;
      let pctHTML = '';

      if (totalsByYear.has(selectedBaseline)) {
        if (baseTotal === 0) {
          pctHTML = `<span class="neutral">N/A (zero base)</span>`;
        } else {
          const pct = Math.round((total - baseTotal) / baseTotal * 100);
          const sign = pct > 0 ? '+' : '';
          const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'neutral';
          pctHTML = `<span class="${cls}">${sign}${pct}%</span>`;
        }
      } else {
        pctHTML = `<span class="neutral">No Data</span>`;
      }

      deltaHTML = `
        <div class="change compact-row">
          ${pctHTML}
          <select class="baseline-select" data-target-year="${yr}">
            ${dropdownOptions}
          </select>
        </div>`;
    } else {
      deltaHTML = `<div class="change neutral">No historical years to compare</div>`;
    }

    return `
      <div class="stat-box stat-box-with-selector" style="border-left-color:${color};">
        <div>
          <div class="label">${yr}</div>
          <div class="value" style="color:${color};">${total.toLocaleString()}</div>
          <div class="sub">Totaled over custom frame (${rangeDisplay})</div>
        </div>
        ${deltaHTML}
      </div>`;
  }).join('');

  // Attach dynamic event listeners to update the specific baseline override and trigger re-render
  statsEl.querySelectorAll('.baseline-select').forEach(selectEl => {
    selectEl.addEventListener('change', (e) => {
      const targetYear = parseInt(e.target.dataset.targetYear);
      const chosenBaseline = parseInt(e.target.value);
      comparisonBaselineOverrides.set(targetYear, chosenBaseline);
      
      // Instantly refresh calculations/views
      updateChartAndStats();
    });
  });

  statsEl.style.display = 'flex';
}

function exportChart(format) {
  if (!chartInstance) return;
  const filenameBase = 'damage-timeline-' + new Date().toISOString().slice(0, 10);
  if (format === 'png') {
    downloadUrl(chartInstance.toBase64Image('image/png', 1.0), `${filenameBase}.png`);
    return;
  }
  if (format === 'jpg') {
    const srcCanvas = chartInstance.canvas;
    const tmp = document.createElement('canvas');
    tmp.width = srcCanvas.width;
    tmp.height = srcCanvas.height;
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(srcCanvas, 0, 0);
    downloadUrl(tmp.toDataURL('image/jpeg', 0.95), `${filenameBase}.jpg`);
    return;
  }
  if (format === 'svg') {
    if (!lastChartSVG) return;
    const blob = new Blob([lastChartSVG], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    downloadUrl(url, `${filenameBase}.svg`, true);
  }
}
window.exportChart = exportChart;

function downloadUrl(url, filename, revoke) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeXML(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function roundNiceUp(n) {
  if (n <= 10) return Math.ceil(n);
  const magnitude = Math.pow(10, Math.floor(Math.log10(n)));
  const normalized = n / magnitude;
  let nice;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else nice = 10;
  return nice * magnitude;
}

function buildChartSVG({ selectedYears, pointsByYear, periodLabels, highlightXStart, highlightXEnd, titleText, subtitleText }) {
  const width = 960, height = 560;
  const marginLeft = 65, marginRight = 30, marginTop = 60, marginBottom = 90;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  let yMax = 0;
  selectedYears.forEach(yr => {
    (pointsByYear.get(yr) || []).forEach(p => {
      if (p.y !== null && p.y !== undefined && p.y > yMax) yMax = p.y;
    });
  });
  yMax = roundNiceUp(Math.max(yMax, 1) * 1.15);

  const xToPx = x => marginLeft + (x / 12) * plotWidth;
  const yToPx = y => marginTop + plotHeight - (y / yMax) * plotHeight;

  const bandSVG = `<rect x="${xToPx(highlightXStart).toFixed(1)}" y="${marginTop}" width="${(xToPx(highlightXEnd) - xToPx(highlightXStart)).toFixed(1)}" height="${plotHeight}" fill="rgba(230,126,34,0.18)" />`;

  const tickCount = 5;
  let gridSVG = '';
  gridSVG += `<line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + plotHeight}" stroke="#999" stroke-width="1" />`;
  
  for (let i = 0; i <= tickCount; i++) {
    const val = (yMax / tickCount) * i;
    const py = yToPx(val).toFixed(1);
    gridSVG += `<line x1="${marginLeft - 5}" y1="${py}" x2="${marginLeft}" y2="${py}" stroke="#999" stroke-width="1" />`;
    gridSVG += `<text x="${marginLeft - 10}" y="${parseFloat(py) + 4}" font-size="11" fill="#666" text-anchor="end" font-family="Arial, sans-serif">${Math.round(val).toLocaleString()}</text>`;
  }

  const monthAbbrev = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let xAxisSVG = `<line x1="${marginLeft}" y1="${marginTop + plotHeight}" x2="${marginLeft + plotWidth}" y2="${marginTop + plotHeight}" stroke="#999" stroke-width="1" />`;
  for (let m = 0; m < 12; m++) {
    const px = xToPx(m + 0.5).toFixed(1);
    xAxisSVG += `<line x1="${px}" y1="${marginTop + plotHeight}" x2="${px}" y2="${marginTop + plotHeight + 5}" stroke="#999" stroke-width="1" />`;
    xAxisSVG += `<text x="${px}" y="${marginTop + plotHeight + 18}" font-size="11" fill="#666" text-anchor="middle" font-family="Arial, sans-serif">${monthAbbrev[m]}</text>`;
  }

  let linesSVG = '';
  selectedYears.forEach(yr => {
    const color = colorForYear(yr);
    const pts = pointsByYear.get(yr) || [];
    let segment = [];
    const flush = () => {
      if (segment.length > 1) {
        const attr = segment.map(p => `${xToPx(p.x).toFixed(1)},${yToPx(p.y).toFixed(1)}`).join(' ');
        linesSVG += `<polyline points="${attr}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
      }
      segment = [];
    };
    pts.forEach(p => {
      if (p.y === null || p.y === undefined) flush();
      else segment.push(p);
    });
    flush();
  });

  const legendY = height - 30;
  const legendItemWidth = Math.min(140, plotWidth / selectedYears.length);
  const legendTotalWidth = legendItemWidth * selectedYears.length;
  const legendStartX = marginLeft + (plotWidth - legendTotalWidth) / 2;
  let legendSVG = '';
  selectedYears.forEach((yr, i) => {
    const color = colorForYear(yr);
    const cx = legendStartX + legendItemWidth * i;
    legendSVG += `<line x1="${cx}" y1="${legendY}" x2="${cx + 20}" y2="${legendY}" stroke="${color}" stroke-width="3" />`;
    legendSVG += `<text x="${cx + 26}" y="${legendY + 4}" font-size="12" fill="#333" font-family="Arial, sans-serif">${yr}</text>`;
  });

  const titleSVG = `<text x="${marginLeft}" y="26" font-size="16" font-weight="700" fill="#1a3a5c" font-family="Arial, sans-serif">${escapeXML(titleText)}</text>`;
  const subtitleSVG = subtitleText ? `<text x="${marginLeft}" y="44" font-size="12" fill="#888" font-family="Arial, sans-serif">${escapeXML(subtitleText)}</text>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  ${titleSVG}
  ${subtitleSVG}
  ${bandSVG}
  ${gridSVG}
  ${xAxisSVG}
  ${linesSVG}
  ${legendSVG}
</svg>`;
}