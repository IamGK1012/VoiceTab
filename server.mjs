import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { defaultBrand, validateBrand } from './lib/branding.mjs';
import { applyOperations, dollars, hasPickup, orderClarification, refundLines, RequestError, total } from './lib/menu.mjs';
import { makePayPal } from './lib/paypal.mjs';
import { openStore } from './lib/store.mjs';
import { parseOrder } from './lib/order-parser.mjs';
import { salesReport, sampleSales } from './lib/sales.mjs';
import { makeVoice } from './lib/voice.mjs';

const assets = new Map([
  ['/', ['./public/index.html', 'text/html']],
  ['/style.css', ['./public/style.css', 'text/css']],
  ['/css/tokens.css', ['./public/css/tokens.css', 'text/css']],
  ['/fonts/geist-sans.woff2', ['./public/fonts/geist-sans.woff2', 'font/woff2']],
  ['/fonts/geist-mono.woff2', ['./public/fonts/geist-mono.woff2', 'font/woff2']],
  ['/icons.svg', ['./public/icons.svg', 'image/svg+xml']],
  ['/theme.js', ['./public/theme.js', 'text/javascript']],
  ['/order-motion.js', ['./public/order-motion.js', 'text/javascript']],
  ['/sales.js', ['./public/sales.js', 'text/javascript']],
  ['/logos', ['./public/logos.html', 'text/html']],
  ['/brand/paper-wave.svg', ['./public/brand/paper-wave.svg', 'image/svg+xml']],
  ['/brand/voicetab.svg', ['./public/brand/voicetab.svg', 'image/svg+xml']],
  ['/brand/voicetab-mono.svg', ['./public/brand/voicetab-mono.svg', 'image/svg+xml']],
  ['/brand/icon.svg', ['./public/brand/icon.svg', 'image/svg+xml']],
  ['/brand/icon-192.png', ['./public/brand/icon-192.png', 'image/png']],
  ['/brand/icon-512.png', ['./public/brand/icon-512.png', 'image/png']],
  ['/manifest.webmanifest', ['./public/manifest.webmanifest', 'application/manifest+json']],
  ['/app.js', ['./public/app.js', 'text/javascript']],
  ['/lib/order-parser.mjs', ['./lib/order-parser.mjs', 'text/javascript']],
  ['/lib/menu.mjs', ['./lib/menu.mjs', 'text/javascript']],
]);
const orderRoute = /^\/api\/(stall|customer)\/orders\/([\da-f-]{36})(?:\/(preview|items|qr|checkout|capture|refund|issue|serve))?$/;
const customerPage = /^\/pay\/[\da-f-]{36}$/;
const maxBody = 5_000_000;
const retryWindow = 60 * 60 * 1000;
const checkoutLinkLifetime = 10 * 60 * 1000;

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new RequestError(415, 'Send a JSON request.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) {
      // Drain the remaining input so the browser can receive the error response.
      req.resume();
      throw new RequestError(413, 'That recording is too large. Use a shorter command.');
    }
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
    return result;
  } catch {
    throw new RequestError(400, 'That request is missing valid JSON.');
  }
}

function send(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function requireVersion(order, version) {
  if (order.version !== version) throw new RequestError(409, 'The order changed. Refresh it and review the current bill.');
}

function operation() {
  return { requestId: randomUUID(), startedAt: Date.now() };
}

function requireRetryWindow(op) {
  if (Date.now() - op.startedAt > retryWindow) {
    throw new RequestError(409, 'Check this action in the PayPal Sandbox dashboard before retrying.');
  }
}

function publicOrder(order) {
  const { id, number, version, status, lines, lastItemId, createdAt, capture, refund, issue, servedAt } = order;
  return {
    id, number, version, status, lines, lastItemId, createdAt, total: total(lines), issue, servedAt,
    capture: capture && { id: capture.id, status: capture.status },
    refund: refund && { id: refund.id, status: refund.status, lines: refund.lines, cents: refund.cents },
  };
}

function verifyPayment(result, cents) {
  if (!result?.id || result.amount?.currency_code !== 'USD' || result.amount?.value !== dollars(cents)) {
    throw new RequestError(502, 'PayPal returned an unexpected amount or reference. Check the Sandbox dashboard.');
  }
}

export function createApp({ demo, stallKey, baseUrl, dbPath, paypal, voice, hasGemini = !demo, now = Date.now }) {
  const store = openStore(dbPath);
  const customerUrl = id => `${baseUrl}/pay/${id}`;

  function requireCustomerLink(order, token, link) {
    if (order.status !== 'draft') {
      if (order.checkoutTicket === token || (!order.checkoutTicket && order.id === token)) return;
    } else if (link?.version === order.version && link.expires_at > now()) {
      return;
    }
    throw new RequestError(410, 'This checkout link expired or the bill changed. Ask the stall for a fresh QR.');
  }

  function saveDraft(id, version, operations) {
    return store.run(id, order => {
      requireVersion(order, version);
      if (order.status !== 'draft') throw new RequestError(409, 'Checkout has started. This bill is locked.');
      order.lines = applyOperations(order.lines, operations, store.menu());
      order.lastItemId = operations.at(-1).item_id;
      delete order.issue;
      return publicOrder(store.save(order));
    });
  }

  function requireStall(req) {
    if (!stallKey && demo && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return;
    const actual = Buffer.from(req.headers['x-stall-key'] ?? '');
    if (!stallKey) throw new RequestError(401, 'Open the stall on this computer or configure a stall access key.');
    const expected = Buffer.from(stallKey);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new RequestError(401, 'Enter the stall access key to continue.');
    }
  }

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const { pathname: path, searchParams } = new URL(req.url, 'http://localhost');
      const method = req.method;
      const asset = assets.get(path) ?? (customerPage.test(path) ? assets.get('/') : null);
      if (method === 'GET' && asset) {
        const data = await readFile(new URL(asset[0], import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1] });
        return res.end(data);
      }
      if (method === 'GET' && path === '/api/config') return send(res, { demo, hasGemini, menu: store.menu(), branding: store.brand() ?? defaultBrand });
      if (path.startsWith('/api/stall/')) requireStall(req);
      if (method === 'GET' && path === '/api/stall/sales') {
        const date = searchParams.get('date');
        const sample = demo && searchParams.get('sample') === '1';
        const report = salesReport(sample ? sampleSales(date) : store.paid(), {
          date, timeZone: sample ? 'UTC' : searchParams.get('timeZone'),
        });
        return send(res, { ...report, sample });
      }
      if (method === 'POST' && path === '/api/stall/branding') {
        return send(res, store.saveBrand(validateBrand(await readJson(req))));
      }
      if (method === 'POST' && path === '/api/stall/live-bill') {
        const { id, version, text } = await readJson(req);
        if (typeof text !== 'string' || !text.trim() || text.length > 600) {
          throw new RequestError(400, 'Send a short transcript.');
        }
        const order = id ? store.get(id) : null;
        if (order) {
          requireVersion(order, version);
          if (order.status !== 'draft') throw new RequestError(409, 'This bill is locked.');
        }
        const menu = store.menu();
        const lines = order?.lines ?? [];
        const operations = parseOrder(text, { menu, lines, mode: 'items', lastItemId: order?.lastItemId });
        if (!operations || orderClarification(operations)) return send(res, { lines: null });
        const provisional = applyOperations(lines, operations, menu);
        return send(res, { lines: provisional, cents: total(provisional) });
      }
      if (path === '/api/stall/orders') {
        if (method === 'GET') return send(res, store.list().map(publicOrder));
        if (method === 'POST') return send(res, publicOrder(store.create()), 201);
      }
      const match = path.match(orderRoute);
      if (!match) throw new RequestError(404, 'Page or action not found.');
      const [, role, token, action] = match;
      const link = role === 'customer' ? store.findLink(token) : null;
      const id = link?.order_id ?? token;
      if (role === 'customer') requireCustomerLink(store.get(id), token, link);
      if (method === 'GET' && !action) {
        const order = store.get(id);
        return send(res, { ...publicOrder(order), ...(link && order.status === 'draft' ? { expiresAt: link.expires_at } : {}) });
      }
      if (method === 'GET' && role === 'stall' && action === 'qr') {
        const order = store.get(id);
        if (!order.lines.length || !['draft', 'checkout'].includes(order.status)) {
          throw new RequestError(409, 'Open a bill with items before showing its QR.');
        }
        const ticket = order.status === 'draft' || order.checkoutTicket
          ? store.linkFor(order, now(), checkoutLinkLifetime) : { token: id };
        const url = customerUrl(ticket.token);
        return send(res, { url, expiresAt: order.status === 'draft' ? ticket.expires_at : null,
          image: await QRCode.toDataURL(url, { margin: 4, width: 360 }) });
      }
      if (method !== 'POST') throw new RequestError(405, 'That action requires a POST request.');
      const body = await readJson(req);

      if (role === 'stall' && action === 'preview') {
        const order = store.get(id);
        requireVersion(order, body.version);
        if (!['draft', 'paid'].includes(order.status) || order.refund) {
          throw new RequestError(409, 'This order is not available for voice changes.');
        }
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const audio = body.audio;
        const validAudio = audio && /^audio\/(webm|ogg|mp4|wav|mpeg|aac)$/.test(audio.mime) &&
          typeof audio.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(audio.data);
        if (text.length > 600 || (!text && !validAudio)) throw new RequestError(400, 'Enter a short command or record a voice note.');
        const mode = order.status === 'paid' ? 'refund' : 'items';
        const menu = store.menu();
        const result = await voice({
          text, audio, mode, menu, lines: order.lines, number: order.number, lastItemId: order.lastItemId,
        });
        const clarification = orderClarification(result.operations);
        if (clarification) return send(res, { ...result, clarification, version: order.version });
        if (result.showQr && mode === 'items' && !result.operations.length) {
          const current = store.get(id);
          requireVersion(current, body.version);
          return send(res, { transcript: result.transcript, showQr: true, order: publicOrder(current) });
        }
        if (body.commit === true && mode === 'items') {
          const saved = await saveDraft(id, body.version, result.operations);
          return send(res, { transcript: result.transcript, source: result.source, order: saved, showQr: Boolean(result.showQr && saved.lines.length) });
        }
        const lines = mode === 'refund' ? refundLines(order.lines, result.operations) : applyOperations(order.lines, result.operations, menu);
        return send(res, { ...result, version: order.version, lines, cents: total(lines), mode });
      }

      if (role === 'stall' && action === 'items') {
        return send(res, await saveDraft(id, body.version, body.operations));
      }

      if (role === 'customer' && action === 'checkout') {
        return send(res, await store.run(id, async order => {
          requireCustomerLink(order, token, link);
          if (order.status === 'checkout' && order.paypal) return order.paypal;
          if (order.status === 'draft') {
            requireVersion(order, body.version);
            if (!order.lines.length) throw new RequestError(409, 'The stall has not added any items yet.');
            order.status = 'checkout';
            order.checkoutTicket = token;
            delete order.issue;
            order.createPayment = operation();
            store.save(order);
          }
          if (order.status !== 'checkout') throw new RequestError(409, 'This order cannot start another payment.');
          requireRetryWindow(order.createPayment);
          order.paypal = await paypal.create(order, customerUrl(token), order.createPayment.requestId);
          store.save(order);
          return order.paypal;
        }));
      }

      if (role === 'customer' && action === 'issue') {
        return send(res, await store.run(id, order => {
          requireCustomerLink(order, token, link);
          requireVersion(order, body.version);
          if (order.status !== 'draft') throw new RequestError(409, 'Checkout already started. Ask the stall for help.');
          order.issue = true;
          store.save(order);
          return { reported: true };
        }));
      }

      if (role === 'customer' && action === 'capture') {
        return send(res, await store.run(id, async order => {
          if (!order.paypal || body.token !== order.paypal.id) throw new RequestError(409, 'This approval does not match the bill.');
          if (order.status === 'paid' || order.status === 'payment_failed') return publicOrder(order);
          if (!order.capturePayment) {
            order.capturePayment = operation();
            store.save(order);
          }
          if (!order.capture) requireRetryWindow(order.capturePayment);
          const result = await paypal.capture(order, order.capturePayment.requestId);
          verifyPayment(result, total(order.lines));
          order.capture = { id: result.id, status: result.status };
          if (result.status === 'COMPLETED') order.paidAt = result.update_time ?? result.create_time ?? new Date(now()).toISOString();
          order.status = result.status === 'COMPLETED' ? 'paid' : result.status === 'PENDING' ? 'payment_pending' : 'payment_failed';
          return publicOrder(store.save(order));
        }));
      }

      if (role === 'stall' && action === 'serve') {
        return send(res, await store.run(id, order => {
          if (order.servedAt) return publicOrder(order);
          requireVersion(order, body.version);
          if (!hasPickup(order)) throw new RequestError(409, 'Only paid orders with items to collect can be marked served.');
          order.servedAt = new Date(now()).toISOString();
          return publicOrder(store.save(order));
        }));
      }

      if (role === 'stall' && action === 'refund') {
        return send(res, await store.run(id, async order => {
          if (order.status !== 'paid') throw new RequestError(409, 'PayPal must confirm payment before you can refund it.');
          if (order.refund?.status === 'COMPLETED') return publicOrder(order);
          if (!order.refund) {
            requireVersion(order, body.version);
            const lines = refundLines(order.lines, body.operations);
            order.refund = { ...operation(), lines, cents: total(lines), status: 'SUBMITTING' };
            store.save(order);
          }
          if (!order.refund.id) requireRetryWindow(order.refund);
          const result = await paypal.refund(order, order.refund);
          verifyPayment(result, order.refund.cents);
          order.refund.id = result.id;
          order.refund.status = result.status;
          if (result.status === 'COMPLETED') order.refund.completedAt = result.update_time ?? result.create_time ?? new Date(now()).toISOString();
          return publicOrder(store.save(order));
        }));
      }
      throw new RequestError(404, 'Action not found.');
    } catch (error) {
      if (!(error instanceof RequestError)) console.error(error);
      if (!res.headersSent) send(res, { error: error instanceof RequestError ? error.message : 'Something went wrong. Try again.' }, error.status ?? 500);
    }
  });
}

function start() {
  const mode = process.env.VOICETAB_MODE || 'demo';
  if (!['demo', 'sandbox'].includes(mode)) throw new Error('VOICETAB_MODE must be demo or sandbox.');
  const demo = mode === 'demo';
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const base = new URL(process.env.PUBLIC_BASE_URL || `http://localhost:${port}`);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('PUBLIC_BASE_URL must be an HTTP or HTTPS origin without a path.');
  }
  const stallKey = process.env.STALL_KEY || '';
  const key = process.env.GEMINI_API_KEY;
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'];
  const remoteAccess = !loopback.includes(host) || !loopback.includes(base.hostname);
  if (!demo && (!clientId || !clientSecret || stallKey.length < 16)) {
    throw new Error('Sandbox mode requires both PayPal credentials and a STALL_KEY of at least 16 characters.');
  }
  if (remoteAccess && (stallKey.length < 16 || stallKey === 'replace_with_a_random_key_at_least_16_characters')) {
    throw new Error('Remote access requires a private random STALL_KEY of at least 16 characters.');
  }
  if (!demo && base.protocol !== 'https:' && !loopback.includes(base.hostname)) {
    throw new Error('Use an HTTPS PUBLIC_BASE_URL for Sandbox access from a second device.');
  }
  const server = createApp({
    demo, stallKey, baseUrl: base.origin, dbPath: resolve('data', `${mode}.sqlite`), hasGemini: Boolean(key),
    paypal: makePayPal({ demo, clientId, clientSecret }),
    voice: makeVoice({ demo, key, model: process.env.GEMINI_MODEL || undefined }),
  });
  server.listen(port, host, () => console.log(`VoiceTab ${mode} listening at ${base.origin} (bound to ${host}:${port})`));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) start();
