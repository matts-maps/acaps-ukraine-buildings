let rawCSVData = [];
let chartInstance = null;
let uniqueYearsList = [];

const calendarMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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
      initializeDashboardOptions();
    },
    error: () => showError('Unable to route repository CSV payload array map.')
  });
});

function showError(msg) {
  const el = document.getElementById('error-msg');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
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

  const baseSel = document.getElementById('base-year-select');
  const compSel = document.getElementById('comp-year-select');
  
  if (!baseSel || !compSel) return;
  
  baseSel.innerHTML = '';
  compSel.innerHTML = '';

  uniqueYearsList.forEach(yr => {
    baseSel.appendChild(new Option(yr, yr));
    compSel.appendChild(new Option(yr, yr));
  });

  if (uniqueYearsList.length >= 2) {
    baseSel.value = uniqueYearsList[uniqueYearsList.length - 2];
    compSel.value = uniqueYearsList[uniqueYearsList.length - 1];
  } else {
    baseSel.value = uniqueYearsList[0];
    compSel.value = uniqueYearsList[0];
  }

  buildPeriodDropdowns();
  
  const controls = document.getElementById('controls');
  if (controls) controls.style.display = 'flex';
}

function getPeriodLabels(daysInStep) {
  if (daysInStep === 30) return calendarMonths;

  const labels = [];
  const totalPeriods = Math.ceil(365 / daysInStep);
  const prefix = daysInStep === 7 ? 'Week' : 'Fortnight';
  
  for (let i = 0; i < totalPeriods; i++) {
    const startDay = i * daysInStep + 1;
    let endDay = startDay + daysInStep - 1;
    if (endDay > 365) endDay = 365;

    const dStart = new Date(2025, 0, startDay);
    const dEnd = new Date(2025, 0, endDay);
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

function buildPeriodDropdowns() {
  const periodTypeEl = document.getElementById('period-type');
  const startSel = document.getElementById('highlight-start');
  const endSel = document.getElementById('highlight-end');
  
  if (!periodTypeEl || !startSel || !endSel) return;

  const stepDays = parseInt(periodTypeEl.value);
  const labels = getPeriodLabels(stepDays);
  
  startSel.innerHTML = '';
  endSel.innerHTML = '';

  labels.forEach((label, index) => {
    startSel.appendChild(new Option(label, index));
    endSel.appendChild(new Option(label, index));
  });
  
  startSel.value = 0;
  endSel.value = stepDays === 30 ? 2 : (stepDays === 14 ? 5 : 11); 

  updateChartAndStats();
}

function updateChartAndStats() {
  const periodTypeEl = document.getElementById('period-type');
  const baseYearEl = document.getElementById('base-year-select');
  const compYearEl = document.getElementById('comp-year-select');
  const startSel = document.getElementById('highlight-start');
  const endSel = document.getElementById('highlight-end');
  
  if (!periodTypeEl || !baseYearEl || !compYearEl || !startSel || !endSel) return;

  const stepDays = parseInt(periodTypeEl.value);
  const baseYear = parseInt(baseYearEl.value);
  const compYear = parseInt(compYearEl.value);
  
  let idxStart = parseInt(startSel.value);
  let idxEnd = parseInt(endSel.value);

  if (idxStart > idxEnd) {
    const temp = idxStart;
    idxStart = idxEnd;
    idxEnd = temp;
  }

  const periodLabels = getPeriodLabels(stepDays);
  const totalPeriods = periodLabels.length;
  
  const basePoints = [];
  const compPoints = [];
  
  const baseCounts = new Array(totalPeriods).fill(0);
  const compCounts = new Array(totalPeriods).fill(0);
  let maxDate = null;

  rawCSVData.forEach(row => {
    const dateStr = (row.date_of_event || '').trim();
    if (!dateStr) return;
    
    const d = new Date(dateStr);
    if (isNaN(d)) return;

    if (!maxDate || d > maxDate) maxDate = d;
    
    const year = d.getFullYear();
    let pIdx = 0;

    if (stepDays === 30) {
      pIdx = d.getMonth();
    } else {
      const dayNum = calculateDayOfYear(d);
      pIdx = Math.floor((dayNum - 1) / stepDays);
      if (pIdx >= totalPeriods) pIdx = totalPeriods - 1;
      if (pIdx < 0) pIdx = 0;
    }

    if (year === baseYear) baseCounts[pIdx]++;
    if (year === compYear) compCounts[pIdx]++;
  });

  // Whichever year holds the most recent recorded event is still "in
  // progress" - periods after that point haven't happened yet, so the line
  // should stop there instead of dropping to a misleading 0.
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

  for (let i = 0; i < totalPeriods; i++) {
    let decimalX = 0;
    if (stepDays === 30) {
      decimalX = i;
    } else {
      const centerDay = (i * stepDays) + (stepDays / 2);
      decimalX = (centerDay / 365) * 12; 
    }
    const baseBeyondData = baseYear === maxDataYear && i > maxDataPeriodIdx;
    const compBeyondData = compYear === maxDataYear && i > maxDataPeriodIdx;
    basePoints.push({ x: decimalX, y: baseBeyondData ? null : baseCounts[i] });
    compPoints.push({ x: decimalX, y: compBeyondData ? null : compCounts[i] });
  }

  const highlightPlugin = {
    id: 'dynamicHighlightBand',
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const xScale = scales.x;

      let xStartVal = 0;
      let xEndVal = 0;

      if (stepDays === 30) {
        xStartVal = idxStart;
        xEndVal = idxEnd;
      } else {
        xStartVal = ((idxStart * stepDays) / 365) * 12;
        xEndVal = (((idxEnd + 1) * stepDays) / 365) * 12;
      }

      const x0 = xScale.getPixelForValue(xStartVal);
      const x1 = xScale.getPixelForValue(xEndVal);

      ctx.save();
      ctx.fillStyle = 'rgba(230, 126, 34, 0.18)'; 
      ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
      ctx.restore();
    }
  };

  const canvas = document.getElementById('myChart');
  if (!canvas) return;
  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: `Baseline Year: ${baseYear}`,
          data: basePoints,
          borderColor: '#1a3a5c',
          backgroundColor: 'transparent',
          borderWidth: 2.5,
          tension: 0.25,
          pointRadius: 0,
          pointHitRadius: 10
        },
        {
          label: `Comparison Year: ${compYear}`,
          data: compPoints,
          borderColor: '#e07b39',
          backgroundColor: 'transparent',
          borderWidth: 2.5,
          tension: 0.25,
          pointRadius: 0,
          pointHitRadius: 10
        }
      ]
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
            label: item => ` Year ${item.dataset.label.slice(-4)}: ${item.raw.y.toLocaleString()} incidents`
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
            callback: function(val) {
              return calendarMonths[val] || '';
            }
          },
          grid: { display: false }
        },
        y: { beginAtZero: true, title: { display: true, text: 'Recorded Structural Damages' } }
      }
    },
    plugins: [highlightPlugin]
  });

  let totalBaseInWindow = 0;
  let totalCompInWindow = 0;

  for (let i = idxStart; i <= idxEnd; i++) {
    totalBaseInWindow += baseCounts[i] || 0;
    totalCompInWindow += compCounts[i] || 0;
  }

  document.getElementById('chart-card').style.display = 'block';
  document.getElementById('chart-title').textContent = `Damaged Buildings Profile Breakdown — ${baseYear} vs ${compYear}`;
  
  const cleanStartStr = periodLabels[idxStart].split(' (')[0];
  const cleanEndStr = periodLabels[idxEnd].split(' (')[0];
  const rangeDisplay = cleanStartStr === cleanEndStr ? cleanStartStr : `${cleanStartStr} – ${cleanEndStr}`;
  
  document.getElementById('chart-subtitle').textContent = `Highlighted Interval Window: ${rangeDisplay}`;

  document.getElementById('lbl-base').textContent = `${baseYear} — Selected Frame`;
  document.getElementById('lbl-comp').textContent = `${compYear} — Selected Frame`;

  document.getElementById('v-base').textContent = totalBaseInWindow.toLocaleString();
  document.getElementById('sub-base').textContent = `Totaled over custom frame (${rangeDisplay})`;
  
  document.getElementById('v-comp').textContent = totalCompInWindow.toLocaleString();
  document.getElementById('sub-comp').textContent = `Totaled over custom frame (${rangeDisplay})`;

  const changeEl = document.getElementById('v-change');
  if (totalBaseInWindow === 0) {
    changeEl.textContent = 'N/A (Zero Base)';
    changeEl.className = 'value change neutral';
  } else {
    const pct = Math.round((totalCompInWindow - totalBaseInWindow) / totalBaseInWindow * 100);
    const sign = pct > 0 ? '+' : '';
    changeEl.textContent = `${sign}${pct}%`;
    changeEl.className = 'value change ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'neutral');
  }

  document.getElementById('stats').style.display = 'flex';
}