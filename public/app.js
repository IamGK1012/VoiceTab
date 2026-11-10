import { applyOperations, hasPickup, orderClarification, total } from '/lib/menu.mjs';
import { parseOrder, saysOrderIsDone, splitCheckoutCue } from '/lib/order-parser.mjs';
import { createOrderMotion } from '/order-motion.js';

const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const menuIcons = new Set(['cup-soda', 'sandwich', 'cookie']);
const legacyMenuIcons = { lemonade: 'cup-soda', sandwich: 'sandwich', cookie: 'cookie' };
const defaultBrand = { name: 'Lemon Club', color: '#2f5bff', font: 'modern', mark: 'tile', logo: '' };
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const cash = cents => currency.format(cents / 100);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const query = new URLSearchParams(location.search);
const checkoutCancelled = query.has('cancel');
const customerId = location.pathname.startsWith('/pay/') ? location.pathname.split('/').at(-1) : null;
const stall = '/api/stall/orders';
const buyer = `/api/customer/orders/${customerId}`;
const recordingLimit = 30_000;
const openingSilence = 8_000;
const finishPause = 1_900;
const readyPause = 900;
const microphoneHint = 'Stops when you pause · up to 30 seconds';
let config;
let branding = defaultBrand;
let draftLogo = '';
let readingLogo = false;
let stallKey = sessionStorage.getItem('voicetab-stall') ?? '';
let active;
let orders = [];
let preview;
let share;
let qrOpen = false;
let popQr = false;
let printTicket = false;
let renderedTicket;
let renderedCheckout;
let renderedQueue;
let captureToken = checkoutCancelled ? null : query.get('token');
let customerMessage;
let paidFlash = false;
let paymentAudio;
let cancelListening;
let transcriptDraft = '';
let editingTranscript = false;
let useRecordedAudio = false;
let voicePhase = 'idle';
let busy = false;
let pollBusy = false;

async function api(path, body) {
  const headers = {};
  if (path.startsWith('/api/stall/')) headers['x-stall-key'] = stallKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new Error('Couldn’t reach VoiceTab. Check your connection and retry the same action.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || 'VoiceTab is temporarily unavailable. Try again.'), { status: response.status });
  return payload;
}

function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

async function action(fn) {
  if (busy) return;
  busy = true;
  notice();
  try {
    await fn();
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
  }
}

const rgb = hex => hex.slice(1).match(/../g).map(pair => Number.parseInt(pair, 16));
const mix = (from, to, amount) => from.map((channel, i) => Math.round(channel + (to[i] - channel) * amount));
const cssColor = color => `rgb(${color.join(' ')})`;
function luminance(color) {
  const [r, g, b] = color.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function palette(color, dark) {
  const toward = rgb(dark ? '#ffffff' : '#000000');
  const surfaces = (dark ? ['#14171c', '#0b0d10', '#1b2028'] : ['#ffffff', '#fafaf7', '#f3f4f8']).map(rgb);
  const soft = mix(surfaces[0], color, 0.15);
  const adjust = (backgrounds, minimum) => {
    let step = 0;
    let tone = color;
    while (step < 20 && backgrounds.some(background => contrast(tone, background) < minimum)) {
      tone = mix(color, toward, ++step / 20);
    }
    return tone;
  };
  const black = rgb('#000000');
  const white = rgb('#ffffff');
  const onAccent = contrast(color, black) > contrast(color, white) ? black : white;
  return { accent: color, 'accent-stroke': adjust([...surfaces, soft], 3),
    'accent-ink': adjust([...surfaces, soft], 4.5), 'accent-soft': soft, 'on-accent': onAccent };
}

function setBrandTheme(element, brand) {
  const color = rgb(brand.color);
  const light = palette(color, false);
  const dark = palette(color, true);
  for (const [name, value] of Object.entries(light)) {
    element.style.setProperty(`--${name}`, `light-dark(${cssColor(value)}, ${cssColor(dark[name])})`);
  }
  element.dataset.brandFont = brand.font;
}

function logoMark(brand) {
  if (brand.mark === 'upload' && brand.logo) return `<span class="stall-mark stall-mark-upload"><img src="${esc(brand.logo)}" alt=""></span>`;
  const initials = (brand.name.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 2).map(word => [...word][0]).join('').toUpperCase() || 'VT';
  const shape = ['round', 'stamp'].includes(brand.mark) ? brand.mark : 'tile';
  return `<span class="stall-mark stall-mark-${shape}" aria-hidden="true">${esc(initials)}</span>`;
}

function applyBrand(brand) {
  branding = brand;
  setBrandTheme(document.documentElement, brand);
  $('stall-label').textContent = brand.name;
  $('counter-name').textContent = brand.name;
  $('counter-mark').innerHTML = logoMark(brand);
  $('menu-heading').textContent = `Today at ${brand.name}`;
  $('stall-footer').textContent = `VoiceTab · ${brand.name} festival counter`;
  renderedTicket = undefined;
}

function brandDraft() {
  const fields = $('branding-form').elements;
  return { name: fields.name.value.trim() || defaultBrand.name, color: fields.color.value,
    font: fields.font.value, mark: fields.mark.value, logo: draftLogo };
}

function brandError(message = '') {
  $('branding-error').textContent = message;
  $('branding-error').hidden = !message;
}

function renderBrandPreview() {
  const draft = brandDraft();
  setBrandTheme($('branding-dialog'), draft);
  $('brand-color-code').textContent = draft.color.toUpperCase();
  $('brand-preview-heading').textContent = draft.name;
  $('brand-preview-mark').innerHTML = logoMark(draft);
  for (const choice of $('branding-form').querySelectorAll('[data-preview-mark]')) {
    choice.innerHTML = logoMark({ ...draft, mark: choice.dataset.previewMark });
  }
}

function fillBrandForm(brand) {
  const fields = $('branding-form').elements;
  for (const field of ['name', 'color', 'font', 'mark']) fields[field].value = brand[field];
  $('brand-file').value = '';
  draftLogo = brand.logo;
  brandError();
  renderBrandPreview();
}

async function resizeLogo(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5_000_000) {
    throw new Error('Choose a PNG, JPEG, or WebP image up to 5 MB.');
  }
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 192;
    const scale = 192 / Math.max(image.width, image.height);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, (192 - width) / 2, (192 - height) / 2, width, height);
    return canvas.toDataURL('image/png');
  } finally {
    image.close();
  }
}

function badge(order) {
  const status = order.refund?.status;
  const labels = {
    draft: ['Open bill', 'wait'], checkout: ['Checkout started', 'wait'],
    paid: ['Paid', ''], payment_pending: ['Payment pending', 'wait'], payment_failed: ['Payment failed', 'fail'],
  };
  const [label, style] = status === 'COMPLETED' ? ['Partially refunded', '']
    : status === 'FAILED' || status === 'CANCELLED' ? ['Refund failed', 'fail']
      : status ? ['Refund pending', 'wait'] : labels[order.status];
  return `<span class="badge ${style}">${label}</span>`;
}

function rows(lines) {
  return lines.map(line => `<div class="row"><span>${line.quantity} × ${esc(line.name)}</span><strong>${cash(line.cents * line.quantity)}</strong></div>`).join('');
}

function bill(order) {
  if (!order.lines.length) return '<p class="empty">Items appear here after the stall confirms an order.</p>';
  const refunded = order.refund?.status === 'COMPLETED' ? order.refund.cents : 0;
  return `${rows(order.lines)}
    ${refunded ? `<div class="row refund-line"><span>Refund · ${esc(order.refund.lines.map(line => `${line.quantity} × ${line.name}`).join(', '))}</span><strong>−${cash(refunded)}</strong></div>` : ''}
    <div class="total"><span>${refunded ? 'Net paid' : 'Total'}</span><strong>${cash(order.total - refunded)}</strong></div>
    ${order.capture ? `<small class="order-meta">${config.demo ? 'Demo capture' : 'PayPal capture'} · ${esc(order.capture.id)}</small>` : ''}
    ${order.refund?.id ? `<small class="order-meta">Refund · ${esc(order.refund.id)}</small>` : ''}`;
}

function printer(order, animate) {
  return `<div class="printer${animate ? ' printing' : ''}">
    <div class="printer-housing" aria-hidden="true">
      <div class="printer-panel"><span class="printer-light"></span><span>VT / 01</span><span class="printer-vents"></span></div>
      <div class="printer-slot"></div>
    </div>
    <div class="paper-feed">
      <div class="receipt-paper">
        <div class="paper-heading"><span class="paper-brand">${logoMark(branding)}<span>${esc(branding.name)}</span></span><span>ORDER #${order.number}</span></div>
        ${order.status === 'paid' ? '' : '<p class="paper-label">ORDER BILL · PAYMENT DUE</p>'}
        ${bill(order)}
      </div>
    </div>
    <button class="text-button replay-print" type="button">Replay print animation</button>
  </div>`;
}

function shouldPrint(previous, order) {
  if (previous?.id !== order.id) return false;
  if (order.status === 'draft') return order.lines.length > 0 && order.version > previous.version;
  return order.status === 'paid' && (previous.status !== 'paid' ||
    (previous.refund?.status !== 'COMPLETED' && order.refund?.status === 'COMPLETED'));
}

const justPaid = (previous, order) => previous?.id === order.id && previous.status !== 'paid' && order.status === 'paid';

function paidMoment(number, animate) {
  return `<div class="paid-moment${animate ? ' celebrating' : ''}" role="status">
    <svg class="paid-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" pathLength="1"/></svg>
    <div><strong>Payment confirmed</strong><span>Pickup order #${number}</span></div>
    ${animate ? '<span class="paid-burst" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' : ''}
  </div>`;
}

function pickupToken(order, animate) {
  return `<div class="pickup-token${animate ? ' celebrating' : ''}" role="status">
    <svg class="paid-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" pathLength="1"/></svg>
    <span class="eyebrow">${order.servedAt ? 'ORDER SERVED' : 'YOUR PICKUP NUMBER'}</span>
    <strong>#${order.number}</strong>
    <span>${order.servedAt ? 'The stall marked this order as collected.' : 'Show this number at the counter to collect your order.'}</span>
  </div>`;
}

function armPaymentSound() {
  if (!navigator.userActivation?.isActive || !window.AudioContext) return;
  try {
    paymentAudio ??= new AudioContext();
    void paymentAudio.resume().catch(() => {});
  } catch { /* Audio is optional on this device. */ }
}

function playPaidFeedback() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(35);
  if (paymentAudio?.state !== 'running') return;
  const at = paymentAudio.currentTime;
  const tone = paymentAudio.createOscillator();
  const gain = paymentAudio.createGain();
  tone.frequency.setValueAtTime(660, at);
  tone.frequency.setValueAtTime(880, at + 0.09);
  gain.gain.setValueAtTime(0.04, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.24);
  tone.connect(gain).connect(paymentAudio.destination);
  tone.start(at);
  tone.stop(at + 0.24);
}

function qrPanel() {
  return `<div class="share${popQr ? ' popping' : ''}" id="customer-qr" role="region" aria-label="Customer checkout QR">
    <div class="qr-frame"><img src="${esc(share.image)}" width="156" height="156" alt="Scan to open the customer bill"></div>
    <div class="qr-copy">
      <p class="eyebrow">CUSTOMER HANDOFF</p>
      <strong>Scan to pay</strong>
      <p>Open the camera on your phone and point it at the code.</p>
      ${share.expiresAt && active.status === 'draft' ? `<p>Use within 10 minutes or request a new code.</p><button class="text-button" id="refresh-qr" type="button">Refresh QR</button>` : ''}
      <a href="${esc(share.url)}" target="_blank" rel="noopener">Open customer bill ${icon('arrow-up-right')}</a>
    </div>
  </div>`;
}

function renderVoiceControls() {
  const enabled = !active || (['draft', 'paid'].includes(active.status) && !active.refund);
  const idle = voicePhase === 'idle';
  $('record').disabled = voicePhase === 'processing' || (!enabled && idle);
  const recordAudio = $('record-audio');
  if (recordAudio) {
    recordAudio.hidden = !config?.hasGemini || config.demo;
    recordAudio.disabled = !enabled || !idle;
  }
  $('command').disabled = !enabled || !idle;
  $('sample').disabled = !enabled || !idle;
  $('preview-button').disabled = !enabled || !idle;
  $('new-order').disabled = !idle;
  $('open-branding').disabled = !idle;
  $('open-sales').disabled = !idle;
  if ($('show-qr')) $('show-qr').disabled = !idle;
}

function renderStaff() {
  const refund = active?.status === 'paid';
  $('voice-heading').textContent = active?.refund ? 'Adjustment recorded' : refund ? 'Adjust a paid order' : 'Speak the order';
  $('voice-copy').textContent = active?.refund ? 'See the adjustment on the receipt.'
    : refund ? 'Say which item to remove, then confirm the refund amount.'
      : active && active.status !== 'draft' ? 'This bill is locked while the customer checks out.'
        : 'Tap once, speak naturally, then pause to print.';
  $('sample').textContent = refund ? 'Try sample refund' : 'Try sample order';
  $('preview-button').textContent = refund ? 'Prepare refund →' : active?.lines.length ? 'Update bill →' : 'Create bill →';
  $('command-label').textContent = refund ? 'Or type the adjustment' : 'Or type the order';
  $('command').placeholder = refund ? 'Remove the sandwich. Keep the drinks.' : 'Two lemonades, one sandwich…';
  const stage = refund ? 2 : (active?.lines.length ? 1 : 0);
  for (const [index, step] of [...$('flow').children].entries()) {
    step.classList.toggle('done', index < stage);
    if (index === stage) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }
  const ticketKey = `${active?.id}:${active?.version}`;
  if (renderedTicket !== ticketKey) {
    renderedTicket = ticketKey;
    $('ticket').innerHTML = active ? `
      <div class="ticket-head"><h2 id="ticket-heading">Order #${active.number}</h2>${badge(active)}</div>
      ${active.issue ? '<p class="checkout-alert" role="status">Customer flagged this bill. Check the items before sharing a new QR.</p>' : ''}
      ${refund && !active.refund && !active.servedAt ? paidMoment(active.number, paidFlash) : ''}
      ${active.servedAt ? '<p class="served-note">Pickup served</p>' : ''}
      ${active.lines.length ? printer(active, printTicket) : bill(active)}
    ` : '<h2 id="ticket-heading">No order open</h2><p class="empty">Record an order to see the bill print here.</p>';
    printTicket = false;
    paidFlash = false;
  }
  const checkoutKey = `${ticketKey}:${qrOpen}:${share?.url}`;
  if (renderedCheckout !== checkoutKey) {
    renderedCheckout = checkoutKey;
    $('checkout-actions').innerHTML = active ? `
      ${active.lines.length && ['draft', 'checkout'].includes(active.status) ? `
        <button id="show-qr" type="button" class="primary qr-toggle" aria-expanded="${qrOpen}" aria-controls="customer-qr">${icon('qr-code')}${qrOpen ? 'Hide customer QR' : 'Show customer QR'}</button>
        ${qrOpen ? qrPanel() : '<div id="customer-qr" hidden></div>'}
      ` : ''}
      ${['SUBMITTING', 'PENDING'].includes(active.refund?.status) ? '<button id="retry-refund" class="secondary" type="button">Check refund</button>' : ''}
    ` : '';
    popQr = false;
  }
  renderVoiceControls();
  renderQueue();
  renderPreview();
}

function isOpenOrder(order) {
  return ['draft', 'checkout', 'payment_pending'].includes(order.status);
}

function isAwaitingPickup(order) {
  return hasPickup(order) && !order.servedAt;
}

function renderQueue() {
  const key = JSON.stringify([active?.id, orders.map(({ id, version }) => [id, version])]);
  if (renderedQueue === key) return;
  renderedQueue = key;
  const queue = $('history');
  const focused = document.activeElement?.dataset;
  const focusId = queue.contains(document.activeElement) ? focused?.order ?? focused?.serve : undefined;
  const ready = orders.filter(isAwaitingPickup).reverse();
  const open = orders.filter(isOpenOrder).reverse();
  const history = orders.filter(order => !isOpenOrder(order) && !isAwaitingPickup(order)).slice(0, 30);
  const group = (label, items, empty, canServe = false) => `<section class="queue-group" aria-label="${label}">
    <h3>${label} <span>${items.length}</span></h3>
    ${items.length ? `<ul class="queue-list">${items.map(order => `<li class="queue-item">
      <button class="history-row" type="button" data-order="${order.id}" aria-current="${active?.id === order.id}">
        <span class="queue-order"><strong>#${order.number}</strong><span>${cash(order.total)}</span></span>
        <span class="queue-status">${order.servedAt ? '<span class="badge">Served</span>' : ''}
          ${order.issue ? '<span class="badge wait">Check bill</span>' : badge(order)}</span>
      </button>
      ${canServe ? `<button class="secondary serve-button" type="button" data-serve="${order.id}" aria-label="Mark order #${order.number} served">Mark served</button>` : ''}
    </li>`).join('')}</ul>` : `<p class="empty">${empty}</p>`}
  </section>`;
  queue.innerHTML = group('Ready for pickup', ready, 'Paid orders will appear here.', true) +
    group('In progress', open, 'No open bills.') +
    (history.length ? group('Recent history', history, '') : '');
  if (focusId) {
    const attribute = focused.serve && ready.some(order => order.id === focusId) ? 'serve' : 'order';
    queue.querySelector(`[data-${attribute}="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
  }
}

function renderPreview() {
  const panel = $('preview');
  panel.hidden = !preview;
  if (!preview) return;
  panel.classList.toggle('command-saved', Boolean(preview.saved || preview.cleared));
  const unknown = preview.operations?.find(operation => operation.type === 'unknown_item');
  const aiLabel = new Map([
    ['gemini-audio', 'Transcribed with Gemini'],
    ['gemini-interpretation', 'Interpreted with Gemini'],
    ['gemini-audio-and-interpretation', 'Transcribed and interpreted with Gemini'],
  ]).get(preview.source);
  panel.innerHTML = `
    <p class="eyebrow">${preview.cleared ? 'ORDER CLEARED' : preview.saved ? 'BILL PRINTED' : preview.clarification ? 'CHECK COMMAND' : 'REFUND PREVIEW'}</p>
    <blockquote>${esc(preview.transcript)}</blockquote>
    ${aiLabel ? `<p><span class="badge">${aiLabel}</span></p>` : ''}
    ${preview.cleared ? '<p>Say or type the next items when you’re ready.</p>' : preview.saved ? '<p>Check the items on the bill, then share the QR.</p>' : preview.clarification ? `${unknown ? `<p><span class="unknown-chip">${esc(preview.clarification)}</span></p>` : `<p>${esc(preview.clarification)}</p>`}<button id="edit-rejected-transcript" class="text-button" type="button">Edit transcript</button>` : `
      ${rows(preview.lines)}
      <div class="total"><span>Refund amount</span><strong>${cash(preview.cents)}</strong></div>
      <button class="primary" id="apply-preview" type="button">Confirm ${cash(preview.cents)} refund</button>
    `}`;
}

async function showCustomerQr(refresh = false) {
  armPaymentSound();
  const previousUrl = share?.url;
  if (!share || refresh || (share.expiresAt && share.expiresAt <= Date.now())) share = await api(`${stall}/${active.id}/qr`);
  popQr = !qrOpen || previousUrl !== share.url;
  qrOpen = true;
  renderStaff();
}

function rememberOrder(order) {
  orders = [order, ...orders.filter(previous => previous.id !== order.id)].sort((a, b) => b.number - a.number);
}

function setActive(order) {
  printTicket = shouldPrint(active, order);
  paidFlash = justPaid(active, order);
  if (paidFlash) playPaidFeedback();
  if (active?.id !== order.id || !order.lines.length || !['draft', 'checkout'].includes(order.status) ||
    (order.status === 'draft' && active.version !== order.version)) {
    share = undefined;
    qrOpen = false;
  }
  active = order;
  preview = undefined;
  rememberOrder(order);
  renderStaff();
}

async function loadStall() {
  try {
    orders = await api(stall);
    $('login').hidden = true;
    $('staff').hidden = false;
    $('menu').innerHTML = config.menu.map(item => `
      <div class="menu-item">${icon(menuIcons.has(item.icon) ? item.icon : legacyMenuIcons[item.id] ?? 'receipt-text')}<strong>${esc(item.name)}</strong><small>${esc(item.description)}</small><span class="menu-price">${cash(item.cents)}</span></div>`).join('');
    active = orders.find(isOpenOrder);
    renderStaff();
  } catch (error) {
    if (error.status !== 401) throw error;
    $('staff').hidden = true;
    $('login').hidden = false;
    if (stallKey) notice(error.message);
  }
}

async function submitCommand(input) {
  if (input.text !== undefined && !input.text.trim()) throw new Error('Type an order or record a command.');
  setVoicePhase('processing', active?.status === 'paid' ? 'Preparing refund…' : 'Printing your bill…');
  try {
    const order = active ?? await api(stall, {});
    if (!active) setActive(order);
    preview = undefined;
    renderPreview();
    const result = await api(`${stall}/${order.id}/preview`, { ...input, version: order.version, commit: true });
    if (result.clarification || result.mode === 'refund') {
      preview = result;
      $('command').value = result.transcript;
    } else {
      $('live-bill').hidden = true;
      setActive(result.order);
      $('command').value = '';
      if (result.order.version !== order.version) {
        preview = { saved: active.lines.length > 0, cleared: !active.lines.length, transcript: result.transcript, source: result.source };
      }
      if (result.showQr) await showCustomerQr();
    }
    renderPreview();
    if (preview?.saved) {
      const housing = $('ticket').querySelector('.printer-housing');
      if (housing && housing.getBoundingClientRect().bottom > innerHeight - 110) {
        document.querySelector('.ticket').scrollIntoView({
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
          block: 'start',
        });
      }
    }
  } finally {
    setVoicePhase('idle', microphoneHint);
  }
}

function setVoicePhase(phase, message) {
  voicePhase = phase;
  $('staff').dataset.voicePhase = phase;
  $('record').setAttribute('aria-pressed', phase === 'recording');
  $('record-label').textContent = phase === 'recording' ? 'Cancel listening' : phase === 'processing' ? 'Processing…' : 'Record command';
  $('mic-status').textContent = message;
  $('record-countdown').hidden = phase !== 'recording';
  $('voice-level').hidden = phase !== 'recording';
  if (phase !== 'recording') $('voice-level').value = 0;
  if (phase === 'recording') {
    $('live-transcript').hidden = false;
    $('transcript-words').textContent = 'Words appear here as you speak.';
    $('edit-live-transcript').hidden = true;
  }
  $('edit-live-transcript').disabled = phase !== 'recording';
  if (phase === 'idle') {
    $('live-bill').hidden = true;
    $('live-transcript').hidden = true;
  }
  renderVoiceControls();
}

function showTranscript(results) {
  const words = $('transcript-words');
  words.replaceChildren();
  for (const result of results) {
    const alternative = result[0];
    const segment = document.createElement('span');
    segment.textContent = alternative.transcript.trim();
    if (!result.isFinal) segment.className = 'transcript-interim';
    else if (alternative.confidence > 0 && alternative.confidence < 0.6) segment.className = 'transcript-uncertain';
    if (words.hasChildNodes()) words.append(' ');
    words.append(segment);
  }
  $('edit-live-transcript').hidden = !transcriptDraft;
}

function liveBillPreview(order) {
  const panel = $('live-bill');
  panel.innerHTML = '<p class="eyebrow">LIVE BILL · DRAFT</p><div class="live-lines"></div><p class="muted live-status" role="status"></p><div class="total" hidden><span>Estimated total</span><strong></strong></div><span class="sr-only" role="status"></span>';
  const list = panel.querySelector('.live-lines');
  const status = panel.querySelector('.live-status');
  const totalRow = panel.querySelector('.total');
  const amount = totalRow.querySelector('strong');
  const announcement = panel.lastElementChild;
  const rendered = new Map();
  const motion = createOrderMotion(panel, cash);
  return text => {
    if (order?.status === 'paid' || !text || voicePhase !== 'recording') return false;
    panel.hidden = false;
    const menu = config.menu;
    const lines = order?.lines ?? [];
    const { orderText, showQr } = splitCheckoutCue(text);
    if (showQr && !orderText) return lines.length > 0;
    const context = { menu, lines, mode: 'items', lastItemId: order?.lastItemId };
    const parsed = parseOrder(orderText, context);
    const complete = parsed && !orderClarification(parsed);
    const operations = complete ? parsed : parseOrder(orderText, { ...context, partial: true });
    if (!operations || orderClarification(operations)) {
      const unknown = operations?.find(operation => operation.type === 'unknown_item');
      status.classList.toggle('unknown-chip', Boolean(unknown));
      status.textContent = unknown ? orderClarification(operations) : 'Listening for the rest of your order…';
      return false;
    }
    const next = applyOperations(lines, operations, menu);
    for (const [id, row] of rendered) {
      if (next.some(line => line.id === id)) continue;
      motion.remove(row);
      rendered.delete(id);
    }
    for (const { id, name, cents, quantity } of next) {
      let row = rendered.get(id);
      const isNew = !row;
      if (isNew) {
        row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = '<span class="live-item"><span class="live-quantity"></span><span></span></span><strong></strong>';
        list.append(row);
        rendered.set(id, row);
      }
      const previous = row.dataset.quantity;
      if (previous !== String(quantity)) {
        motion.quantity(row.querySelector('.live-quantity'), previous, quantity);
        row.querySelector('.live-item').lastElementChild.textContent = ` × ${name}`;
        row.dataset.quantity = quantity;
      }
      motion.money(row.lastElementChild, cents * quantity);
      if (isNew) motion.enter(row);
    }
    const cents = total(next);
    motion.money(amount, cents);
    const summary = `Estimated total ${cash(cents)}`;
    if (announcement.textContent !== summary) announcement.textContent = summary;
    totalRow.hidden = false;
    status.textContent = complete ? '' : 'Listening for the rest of your order…';
    status.classList.remove('unknown-chip');
    return Boolean(complete);
  };
}

function listen({ stop, sample, pause = () => finishPause }) {
  const started = performance.now();
  let lastSpeech = null;
  let speaking = false;
  let reason;
  const voice = (active, level = active ? 0.65 : 0) => {
    if (reason) return;
    $('voice-level').value = level;
    if (active || speaking) lastSpeech = performance.now();
    if (active !== speaking) {
      $('mic-status').textContent = active ? 'Hearing your order…' : 'Pause to finish, or keep talking';
      speaking = active;
    }
  };
  const end = why => {
    if (reason) return;
    reason = why;
    clearInterval(interval);
    cancelListening = undefined;
    setVoicePhase('processing', why === 'complete' ? 'Got it. Processing…' : 'Closing microphone…');
    stop(why);
  };
  const tick = () => {
    if (sample) {
      const reading = sample();
      voice(reading.active, reading.level);
    }
    const now = performance.now();
    const seconds = Math.max(0, Math.ceil((recordingLimit - (now - started)) / 1000));
    $('record-countdown').textContent = `0:${String(seconds).padStart(2, '0')}`;
    if (lastSpeech === null && now - started >= openingSilence) end('silent');
    else if (now - started >= recordingLimit || (!speaking && lastSpeech !== null && now - lastSpeech >= pause())) {
      end('complete');
    }
  };
  const interval = setInterval(tick, 50);
  cancelListening = () => end('cancelled');
  setVoicePhase('recording', 'Listening. Speak your order.');
  tick();
  return {
    voice,
    finish: () => end('complete'),
    complete() {
      clearInterval(interval);
      cancelListening = undefined;
      setVoicePhase('idle', microphoneHint);
      if (reason === 'silent') notice('I didn’t hear an order. Tap to try again or type it below.');
      return reason ?? (lastSpeech === null ? 'silent' : 'complete');
    },
  };
}

function audioActivity(context, stream) {
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let noise = 0.004;
  let streak = 0;
  return () => {
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const value of samples) energy += value * value;
    const rms = Math.sqrt(energy / samples.length);
    if (rms >= Math.max(0.012, noise * 2.6)) streak += 1;
    else {
      streak = 0;
      noise = noise * 0.94 + rms * 0.06;
    }
    return { active: streak >= 3, level: Math.min(1, rms * 10) };
  };
}

async function wavData(blob) {
  const rate = 16_000;
  const decoder = new OfflineAudioContext(1, 1, rate);
  const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
  const samples = audio.getChannelData(0);
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const label = (offset, value) => Array.from(value).forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  label(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  }
  const pcm = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < pcm.length; i += 8192) {
    binary += String.fromCharCode(...pcm.subarray(i, i + 8192));
  }
  return { mime: 'audio/wav', data: btoa(binary) };
}

function showMicHelp(reason) {
  const panel = $('mic-help');
  const blocked = reason === 'permission';
  panel.querySelector('strong').textContent = blocked ? 'Microphone access is blocked' : 'Speech recognition is unavailable';
  panel.querySelector('p').textContent = blocked
    ? 'Open the till directly in Chrome on Android or Safari on iPhone. In the browser’s site settings, allow the microphone for this page, then tap Record command again.'
    : 'Try Chrome on Android or Safari on iPhone. On iPhone, enable Siri if speech recognition is unavailable. You can still type an order below.';
  panel.hidden = false;
}

async function mic({ recordAudio = false } = {}) {
  if (cancelListening) {
    cancelListening();
    return;
  }
  transcriptDraft = '';
  $('mic-help').hidden = true;
  editingTranscript = false;
  const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (SpeechRecognition && !recordAudio && !useRecordedAudio) {
    const speech = new SpeechRecognition();
    speech.lang = 'en-US';
    speech.continuous = true;
    speech.interimResults = true;
    let latest = '';
    let finished = false;
    let billReady = false;
    let speechEnded = false;
    const showLive = liveBillPreview(active);
    speech.onspeechstart = () => {
      if (finished) return;
      speechEnded = false;
      listening.voice(true);
    };
    speech.onspeechend = () => {
      if (finished) return;
      speechEnded = true;
      listening.voice(false);
    };
    speech.onresult = event => {
      if (finished) return;
      const results = Array.from(event.results);
      latest = results.map(result => result[0].transcript).join(' ').trim();
      transcriptDraft = latest;
      if (voicePhase === 'recording') showTranscript(results);
      billReady = showLive(latest);
      if (results.length) {
        listening.voice(true);
        const finalized = results.at(-1).isFinal;
        if (finalized && billReady && (saysOrderIsDone(latest) || splitCheckoutCue(latest).showQr)) listening.finish();
        else if (speechEnded || finalized) listening.voice(false);
      }
    };
    speech.onerror = event => {
      if (finished || event.error === 'aborted') return;
      finished = true;
      listening.complete();
      if (event.error === 'no-speech') {
        notice('No speech detected. Try speaking closer to the microphone.');
      } else if (event.error === 'not-allowed') {
        showMicHelp('permission');
      } else if (config.hasGemini) {
        useRecordedAudio = true;
        notice('Live transcription is unavailable. Tap Record command again to use Gemini recording, or type the order.');
      } else {
        showMicHelp('unavailable');
      }
    };
    speech.onend = () => {
      if (finished) return;
      finished = true;
      const reason = listening.complete();
      if (editingTranscript) {
        editingTranscript = false;
        $('command').value = latest;
        $('command').focus();
        return;
      }
      if (reason === 'cancelled') return;
      if (latest) action(() => submitCommand({ text: latest }));
      else notice('No speech detected. Try again or type the order.');
    };
    const listening = listen({
      pause: () => billReady ? readyPause : finishPause,
      stop: reason => reason === 'complete' ? speech.stop() : speech.abort(),
    });
    try {
      speech.start();
    } catch (error) {
      finished = true;
      listening.complete();
      if (['NotAllowedError', 'SecurityError'].includes(error.name)) showMicHelp('permission');
      else throw error;
    }
    return;
  }
  if (!config.hasGemini) {
    showMicHelp('unavailable');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error('Microphone recording needs HTTPS or localhost. You can still type a command.');
  }
  const context = new AudioContext();
  let stream;
  try {
    setVoicePhase('processing', 'Opening microphone…');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, autoGainControl: false } });
    await context.resume();
    const sample = audioActivity(context, stream);
    const mimeType = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      const reason = listening.complete();
      stream.getTracks().forEach(track => track.stop());
      void context.close();
      if (reason !== 'complete') return;
      if (!chunks.length) return notice('No audio was captured. Try again or type the order.');
      action(async () => {
        setVoicePhase('processing', 'Reading the recording…');
        const audio = await wavData(new Blob(chunks, { type: recorder.mimeType }))
          .catch(() => {
            setVoicePhase('idle', microphoneHint);
            throw new Error('Could not read that recording. Try again or type the order.');
          });
        await submitCommand({ audio });
      });
    };
    recorder.start();
    const listening = listen({ sample, stop: () => { if (recorder.state === 'recording') recorder.stop(); } });
    $('mic-status').textContent = 'Gemini recording. The bill appears after you pause.';
    $('transcript-words').textContent = 'The transcript will appear after Gemini processes the recording.';
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    void context.close();
    setVoicePhase('idle', microphoneHint);
    if (['NotAllowedError', 'SecurityError'].includes(error.name)) {
      showMicHelp('permission');
      return;
    }
    throw error;
  }
}

function renderBuyer(animate = false, celebrate = false) {
  if (customerMessage) {
    const reported = customerMessage === 'reported';
    $('customer').innerHTML = `<div class="card buyer-shell">
      <p class="eyebrow">${esc(branding.name)} · CHECKOUT</p><h1>${reported ? 'The stall has been notified.' : 'Get a fresh QR.'}</h1>
      <p class="muted">${reported ? 'Ask the stall to check your items and share an updated bill.' : 'This link expired or the bill changed. Ask the stall to share the latest bill.'}</p>
    </div>`;
    return;
  }
  const refund = active.refund;
  const paid = active.status === 'paid';
  const canPay = active.lines.length && ['draft', 'checkout'].includes(active.status);
  const demoApproval = config.demo && query.has('demo');
  const captureNeeded = (captureToken || demoApproval) && !paid && active.status !== 'payment_failed';
  const heading = paid ? 'Your receipt.' : 'Your order.';
  $('customer').innerHTML = `<div class="card buyer-shell">
    <div class="buyer-merchant">${logoMark(branding)}<div><strong>${esc(branding.name)}</strong><p class="muted">Festival counter · Order #${active.number}</p></div></div>
    <div class="ticket-head"><h1>${heading}</h1>${badge(active)}</div>
    ${active.status === 'draft' ? '<p class="muted">Check the items and total before you pay.</p>' : ''}
    ${checkoutCancelled && !paid ? '<p class="muted">This PayPal checkout didn’t complete. You can resume below or ask the stall for a fresh bill.</p>' : ''}
    ${active.status === 'payment_pending' ? '<p class="connection-note">PayPal is still reviewing this payment. Keep this receipt open and check the status before trying to pay again.</p>' : ''}
    ${(hasPickup(active) || active.servedAt) ? pickupToken(active, celebrate) : ''}
    ${paid ? printer(active, animate) : `<div class="buyer-breakdown">${bill(active)}</div>`}
    ${['SUBMITTING', 'PENDING'].includes(refund?.status) ? '<p class="empty">The stall is processing an adjustment. This receipt updates automatically.</p>' : ''}
    ${captureNeeded ? `<button class="pay-button" type="button" id="buyer-capture">${demoApproval ? 'Approve simulated payment' : 'Check PayPal payment'}</button>` : ''}
    ${canPay && !demoApproval ? `<button class="${captureNeeded ? 'secondary' : 'pay-button'}" type="button" id="buyer-pay">${active.status === 'draft' ? 'Looks right — pay' : 'Resume checkout'}</button><p class="buyer-payment-note">${config.demo ? 'Simulated checkout · No money moves' : 'Continue to PayPal Sandbox · Test funds'}</p>` : ''}
    ${active.status === 'draft' ? '<button class="secondary buyer-issue" type="button" id="buyer-issue">Something’s wrong</button>' : ''}
  </div>`;
}

async function capture() {
  const token = captureToken || (config.demo && query.has('demo') ? `DEMO-${active.number}` : '');
  const previous = active;
  active = await api(`${buyer}/capture`, { token });
  if (active.status === 'paid') {
    history.replaceState(null, '', location.pathname);
    captureToken = null;
  }
  const celebrate = justPaid(previous, active);
  if (celebrate) playPaidFeedback();
  renderBuyer(shouldPrint(previous, active), celebrate);
}

async function poll() {
  if (pollBusy || busy || document.hidden || customerMessage) return;
  pollBusy = true;
  try {
    if (customerId && active) {
      const current = await api(buyer);
      if (!busy && current.version > active.version) {
        const animate = shouldPrint(active, current);
        const celebrate = justPaid(active, current);
        active = current;
        if (celebrate) playPaidFeedback();
        renderBuyer(animate, celebrate);
      }
    } else if (!$('staff').hidden) {
      const recent = await api(stall);
      if (busy) return;
      const latest = recent.find(order => order.id === active?.id);
      const changed = JSON.stringify(recent.map(({ id, version }) => [id, version])) !== JSON.stringify(orders.map(({ id, version }) => [id, version]));
      if (!changed) return;
      orders = recent;
      if (latest && latest.version > active.version) setActive(latest);
      else renderStaff();
    }
  } catch (error) {
    if (customerId && [404, 410].includes(error.status)) {
      customerMessage = 'expired';
      renderBuyer();
    }
    // Explicit actions report errors. A temporary polling failure can retry quietly.
  } finally {
    pollBusy = false;
  }
}

$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    stallKey = $('stall-key').value;
    await loadStall();
    if ($('login').hidden) sessionStorage.setItem('voicetab-stall', stallKey);
  });
});
$('new-order').addEventListener('click', () => action(async () => {
  $('command').value = '';
  setActive(await api(stall, {}));
}));
$('open-branding').addEventListener('click', () => {
  if (busy || readingLogo || voicePhase !== 'idle') return;
  fillBrandForm(branding);
  $('branding-dialog').showModal();
  $('brand-name').focus();
});
$('close-branding').addEventListener('click', () => {
  if (!busy && !readingLogo) $('branding-dialog').close();
});
$('branding-dialog').addEventListener('cancel', event => {
  if (busy || readingLogo) event.preventDefault();
});
$('reset-branding').addEventListener('click', () => {
  if (!busy && !readingLogo) fillBrandForm(defaultBrand);
});
$('branding-form').addEventListener('input', renderBrandPreview);
$('brand-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  readingLogo = true;
  $('brand-file').disabled = $('save-branding').disabled = true;
  brandError();
  try {
    draftLogo = await resizeLogo(file);
    $('branding-form').elements.mark.value = 'upload';
    renderBrandPreview();
  } catch {
    brandError('Choose a readable PNG, JPEG, or WebP image up to 5 MB.');
  } finally {
    readingLogo = false;
    $('brand-file').disabled = $('save-branding').disabled = false;
  }
});
$('branding-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || readingLogo) return;
  action(async () => {
    const draft = brandDraft();
    draft.name = $('brand-name').value;
    $('save-branding').disabled = true;
    brandError();
    try {
      applyBrand(await api('/api/stall/branding', draft));
      renderStaff();
      $('branding-dialog').close();
    } catch (error) {
      brandError(error.message);
    } finally {
      $('save-branding').disabled = false;
    }
  });
});
$('sample').addEventListener('click', () => {
  const text = active?.status === 'paid' ? `Remove the sandwich from order ${active.number}. Keep the drinks.`
    : 'Two lemonades, one sandwich. Actually, make that three lemonades.';
  action(() => submitCommand({ text }));
});
$('command-form').addEventListener('submit', event => {
  event.preventDefault();
  action(() => submitCommand({ text: $('command').value }));
});
$('record').addEventListener('click', () => action(mic));
$('record-audio')?.addEventListener('click', () => action(() => mic({ recordAudio: true })));
$('mic-type').addEventListener('click', () => $('command').focus());
$('open-sales').addEventListener('click', () => action(async () => {
  const { openSales } = await import('/sales.js');
  openSales({ api, demo: config.demo, cash, esc });
}));
$('edit-live-transcript').addEventListener('click', () => {
  if (!cancelListening || !transcriptDraft) return;
  editingTranscript = true;
  cancelListening();
});
$('history').addEventListener('click', event => {
  if (voicePhase !== 'idle') return;
  const serveId = event.target.closest('[data-serve]')?.dataset.serve;
  if (serveId) {
    const selected = orders.find(order => order.id === serveId);
    if (!selected || !isAwaitingPickup(selected)) return;
    action(async () => {
      const order = await api(`${stall}/${serveId}/serve`, { version: selected.version });
      if (active?.id === serveId) setActive(order);
      else {
        rememberOrder(order);
        renderQueue();
      }
    });
    return;
  }
  const id = event.target.closest('[data-order]')?.dataset.order;
  if (!id || active?.id === id) return;
  action(async () => {
    const order = await api(`${stall}/${id}`);
    $('command').value = '';
    setActive(order);
  });
});
$('preview').addEventListener('click', event => {
  if (event.target.id === 'edit-rejected-transcript') {
    $('command').focus();
    return;
  }
  if (event.target.id !== 'apply-preview' || preview?.mode !== 'refund' || !active || voicePhase !== 'idle') return;
  action(async () => {
    const order = await api(`${stall}/${active.id}/refund`, { version: preview.version, operations: preview.operations });
    $('command').value = '';
    setActive(order);
  });
});
$('checkout-actions').addEventListener('click', event => {
  if (!active || voicePhase !== 'idle') return;
  if (event.target.closest('#show-qr')) action(async () => {
    if (qrOpen) {
      qrOpen = false;
      renderStaff();
    } else await showCustomerQr();
    $('show-qr')?.focus({ preventScroll: true });
  });
  if (event.target.id === 'retry-refund') action(async () => setActive(await api(`${stall}/${active.id}/refund`, {})));
  if (event.target.id === 'refresh-qr') action(() => showCustomerQr(true));
});
$('customer').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'buyer-pay') action(async () => {
    button.disabled = true;
    try {
      const checkout = await api(`${buyer}/checkout`, { version: active.version });
      location.assign(checkout.approvalUrl);
    } catch (error) {
      button.disabled = false;
      throw error;
    }
  });
  if (button.id === 'buyer-capture') {
    armPaymentSound();
    action(capture);
  }
  if (button.id === 'buyer-issue') action(async () => {
    await api(`${buyer}/issue`, { version: active.version });
    customerMessage = 'reported';
    renderBuyer();
  });
});

$('main').addEventListener('click', event => {
  const printer = event.target.closest('.replay-print')?.closest('.printer');
  if (!printer) return;
  printer.classList.remove('printing');
  // Restart the feed animation even if its previous run has already completed.
  void printer.offsetWidth;
  printer.classList.add('printing');
});

async function start() {
  $('initial-loading').hidden = false;
  $('initial-error').hidden = true;
  try {
    await loadPage();
    setInterval(poll, 950);
  } catch (error) {
    $('initial-error').hidden = false;
    notice(error.message);
  } finally {
    $('initial-loading').hidden = true;
  }
}

async function loadPage() {
  config = await api('/api/config');
  applyBrand(config.branding ?? defaultBrand);
  $('environment').textContent = config.demo ? 'Local simulation' : 'PayPal Sandbox';
  if (customerId) {
    $('customer').hidden = false;
    try {
      active = await api(buyer);
    } catch (error) {
      if (![404, 410].includes(error.status)) throw error;
      customerMessage = 'expired';
    }
    renderBuyer();
    if (captureToken && active && active.status !== 'paid') {
      try { await capture(); } catch (error) { notice(error.message); }
    }
  } else {
    await loadStall();
  }
}

function showConnectionState() {
  $('connection-note').hidden = navigator.onLine;
}
window.addEventListener('online', showConnectionState);
window.addEventListener('offline', showConnectionState);
$('retry-start').addEventListener('click', () => action(start));
showConnectionState();
void action(start);

