const $ = id => document.getElementById(id);
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const number = new Intl.NumberFormat('en-US');
const hourLabel = hour => `${String(hour).padStart(2, '0')}:00`;
let controller;

function salesChart(hours, cash, sample) {
  const max = Math.max(1, ...hours);
  const peak = hours.indexOf(Math.max(...hours));
  const ticks = [0, 6, 12, 18, 23];
  const bars = hours.map((cents, hour) => {
    if (!cents) return '';
    const height = 112 * cents / max;
    return `<rect x="${22 + hour * 23}" y="${126 - height}" width="15" height="${height}" rx="3"><title>${hourLabel(hour)} · ${cash(cents)}</title></rect>`;
  }).join('');
  return `<section class="sales-card" aria-labelledby="sales-chart-title">
    <div class="sales-section-heading"><div><h3 id="sales-chart-title">Sales by hour</h3><p class="muted">Gross sales by ${sample ? 'sample' : 'local'} time</p></div><span class="badge">${hours[peak] ? `Peak ${hourLabel(peak)} · ${cash(hours[peak])}` : 'No paid sales'}</span></div>
    <svg class="sales-chart" viewBox="0 0 580 132" role="img" aria-labelledby="sales-chart-svg-title">
      <title id="sales-chart-svg-title">${hours[peak] ? `Peak sales were ${cash(hours[peak])} at ${hourLabel(peak)}.` : 'No gross sales recorded this day.'}</title>
      <path d="M16 126H574 M16 70H574 M16 14H574" />
      ${bars}
    </svg>
    <div class="sales-chart-labels" aria-hidden="true">${ticks.map(hour => `<span>${hourLabel(hour)}</span>`).join('')}</div>
    <details class="sales-hour-details"><summary>View hourly amounts</summary><table><thead><tr><th scope="col">Hour</th><th scope="col">Gross sales</th></tr></thead><tbody>
      ${hours.map((cents, hour) => `<tr><th scope="row">${hourLabel(hour)}</th><td>${cash(cents)}</td></tr>`).join('')}
    </tbody></table></details>
  </section>`;
}

function countUp(element, value, format) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches || !value) return;
  const duration = Number.parseFloat(getComputedStyle(element).getPropertyValue('--dur-slow'));
  const started = performance.now();
  function tick(now) {
    if (!element.isConnected) return;
    const progress = reduced.matches ? 1 : Math.min(1, (now - started) / duration);
    element.textContent = format(Math.round(value * (1 - (1 - progress) ** 3)));
    if (progress < 1) requestAnimationFrame(tick);
  }
  element.textContent = format(0);
  requestAnimationFrame(tick);
}

function renderReport(report, { cash, esc }) {
  const metrics = [
    ['Net sales', report.net, cash, 'Gross sales minus completed refunds'],
    ['Paid orders', report.paidOrders, value => number.format(value), 'Completed payments'],
    ['Average order', report.average, cash, 'Gross sales per paid order'],
    ['Refunds', report.refundTotal, cash, `${report.refundCount} completed`],
  ];
  const content = $('sales-content');
  content.innerHTML = `<div class="sales-metrics">${metrics.map(([label, value, format, note], index) =>
    `<article class="sales-card sales-metric"><h3>${label}</h3><strong id="sales-metric-${index}" aria-hidden="true">${format(value)}</strong><span class="sr-only">${format(value)}</span><p class="muted">${note}</p></article>`).join('')}</div>
    <p class="sales-gross">Gross sales <strong>${cash(report.gross)}</strong></p>
    ${salesChart(report.hours, cash, report.sample)}
    <div class="sales-breakdown">
      <section class="sales-card" aria-labelledby="best-sellers"><h3 id="best-sellers">Best sellers</h3><p class="muted">By quantity sold before refunds</p>
        ${report.bestSellers.length ? `<ol class="sales-list">${report.bestSellers.map(item => `<li><strong>${esc(item.name)}</strong><span>${number.format(item.quantity)} sold</span><span>${cash(item.cents)}</span></li>`).join('')}</ol>` : '<p class="empty">Items will appear after the first paid order.</p>'}
      </section>
      <section class="sales-card" aria-labelledby="sales-refunds"><h3 id="sales-refunds">Completed refunds</h3><p class="muted">Latest refunds on the selected date</p>
        ${report.refunds.length ? `<ul class="sales-list">${report.refunds.map(refund => `<li><strong>Order #${refund.number}</strong><span>−${cash(refund.cents)}</span></li>`).join('')}</ul>` : '<p class="empty">No refunds completed on this date.</p>'}
      </section>
    </div>`;
  for (const [index, [, value, format]] of metrics.entries()) countUp($(`sales-metric-${index}`), value, format);
}

export function openSales(options) {
  if (!controller) {
    const dialog = $('sales-dialog');
    const date = $('sales-date');
    const content = $('sales-content');
    const sampleButton = $('sample-sales');
    let request = 0;
    let sample = false;

    async function load() {
      const id = ++request;
      $('sample-sales-note').hidden = !sample;
      sampleButton.textContent = sample ? 'Show my orders' : 'Show sample sales';
      $('sales-timezone').textContent = sample ? 'Illustrative festival day' : `Reporting time zone: ${timeZone}`;
      if (!date.value) {
        content.innerHTML = '<p class="empty">Choose a date to see its sales.</p>';
        return;
      }
      content.setAttribute('aria-busy', 'true');
      content.innerHTML = '<div class="sales-card" role="status">Loading sales…<div class="skeleton" aria-hidden="true"></div></div>';
      try {
        const query = new URLSearchParams({ date: date.value, timeZone, sample: sample ? '1' : '0' });
        const report = await options.api(`/api/stall/sales?${query}`);
        if (id === request && dialog.open) renderReport(report, options);
      } catch (error) {
        if (id === request && dialog.open) content.innerHTML = `<div class="sales-card" role="status"><strong>Couldn’t load sales.</strong><p class="muted">${options.esc(error.message)}</p><p>Select Refresh to try again.</p></div>`;
      } finally {
        if (id === request) content.removeAttribute('aria-busy');
      }
    }

    $('close-sales').addEventListener('click', () => dialog.close());
    $('refresh-sales').addEventListener('click', load);
    date.addEventListener('change', load);
    sampleButton.hidden = !options.demo;
    sampleButton.addEventListener('click', () => { sample = !sample; void load(); });
    const today = new Date();
    date.value = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
    controller = () => { if (!dialog.open) dialog.showModal(); void load(); };
  }
  controller();
}
