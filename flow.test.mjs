import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from './server.mjs';
import { makePayPal } from './lib/paypal.mjs';
import { makeVoice } from './lib/voice.mjs';
import { RequestError } from './lib/menu.mjs';

test('two bills check out independently, and a served bill still supports a partial refund', async t => {
  const paypal = makePayPal({ demo: true });
  const originalRefund = paypal.refund;
  const attempts = [];
  paypal.refund = (order, operation) => {
    attempts.push(operation.requestId);
    if (attempts.length === 1) throw new RequestError(502, 'Simulated lost response');
    return originalRefund(order, operation);
  };
  const baseUrl = 'http://localhost:3000';
  let clock = Date.now();
  const server = createApp({
    demo: true, dbPath: ':memory:', baseUrl, stallKey: 'test-key', paypal, voice: makeVoice({ demo: true }), now: () => clock,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(ok => server.close(ok)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function request(path, body, expected = 200, staff = true) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(staff ? { 'x-stall-key': 'test-key' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }

  await request('/api/stall/orders', undefined, 401, false);
  const brandingPath = '/api/stall/branding';
  const brand = { name: 'Night Market', color: '#bdf7ff', font: 'editorial', mark: 'stamp', logo: '' };
  assert.equal((await request('/api/config', undefined, 200, false)).branding.name, 'Lemon Club');
  await request(brandingPath, brand, 401, false);
  await request(brandingPath, { ...brand, color: 'red' }, 400);
  await request(brandingPath, { ...brand, mark: 'upload', logo: 'data:image/svg+xml;base64,AA==' }, 400);
  assert.deepEqual(await request(brandingPath, brand), brand);
  assert.deepEqual((await request('/api/config', undefined, 200, false)).branding, brand);
  assert.equal((await request('/api/stall/live-bill', { text: 'Two lemonades and one sandwich' })).cents, 800);
  assert.equal((await request('/api/stall/live-bill', { text: "Hey two lemonades and one sandwich Yeah thank you that's it" })).cents, 800);
  assert.equal((await request('/api/stall/live-bill', {
    text: 'Here two lemonades and one sandwich I know make it uh five sandwich thank you',
  })).cents, 2400);
  assert.deepEqual(await request('/api/stall/orders'), []);
  const quickOrder = await request('/api/stall/orders', {}, 201);
  let order = await request('/api/stall/orders', {}, 201);
  const quickPath = `/api/stall/orders/${quickOrder.id}/preview`;
  const committed = await request(quickPath, { version: quickOrder.version, text: 'One lemonade', commit: true });
  assert.equal(committed.order.total, 200);
  await request(quickPath, { version: quickOrder.version, text: 'One more lemonade', commit: true }, 409);
  const cue = await request(quickPath, { version: committed.order.version, text: 'Bill it', commit: true });
  assert.equal(cue.showQr, true);
  assert.equal(cue.order.version, committed.order.version);
  const revised = await request(quickPath, { version: committed.order.version, text: 'Make that three and charge', commit: true });
  assert.equal(revised.showQr, true);
  assert.equal(revised.order.total, 600);
  assert.equal(revised.order.status, 'draft');
  const flaggedQr = await request(`/api/stall/orders/${quickOrder.id}/qr`);
  const buyerPath = qr => new URL(qr.url).pathname.replace('/pay/', '/api/customer/orders/');
  assert.deepEqual(await request(`${buyerPath(flaggedQr)}/issue`, { version: revised.order.version }, 200, false), { reported: true });
  assert.equal((await request(`/api/stall/orders/${quickOrder.id}`)).issue, true);
  await request(buyerPath(flaggedQr), undefined, 410, false);
  const expiringQr = await request(`/api/stall/orders/${quickOrder.id}/qr`);
  clock = expiringQr.expiresAt;
  await request(buyerPath(expiringQr), undefined, 410, false);
  const freshQr = await request(`/api/stall/orders/${quickOrder.id}/qr`);
  assert.notEqual(freshQr.url, expiringQr.url);
  const firstBuyer = buyerPath(freshQr);
  const firstBill = await request(firstBuyer, undefined, 200, false);
  await request(`${firstBuyer}/checkout`, { version: firstBill.version }, 200, false);
  await request(`/api/stall/orders/${quickOrder.id}/serve`, { version: firstBill.version + 1 }, 409);
  const stall = `/api/stall/orders/${order.id}`;
  const preview = await request(`${stall}/preview`, {
    version: order.version,
    text: 'two lemonades one sandwich actually make that three lemonades',
  });
  assert.equal(preview.cents, 1000);
  assert.deepEqual(preview.lines.map(line => line.quantity), [3, 1]);
  const oldVersion = order.version;
  order = await request(`${stall}/items`, { version: preview.version, operations: preview.operations });
  const implicit = await request(`${stall}/preview`, { version: order.version, text: 'Make that three' });
  assert.deepEqual(implicit.operations, [{ type: 'set_quantity', item_id: 'lemonade', qty: 3 }]);
  const unknown = await request(`${stall}/preview`, { version: order.version, text: 'One lemonade and one pizza' });
  assert.equal(unknown.clarification, 'We don’t sell pizza.');
  await request(`${stall}/items`, { version: order.version, operations: unknown.operations }, 400);
  assert.deepEqual(await request(stall), order);
  const qr = await request(`${stall}/qr`);
  assert.equal(new URL(qr.url).origin, baseUrl);
  assert.notEqual(new URL(qr.url).pathname, `/pay/${order.id}`);
  assert.match(qr.image, /^data:image\/png;base64,/);
  const buyer = buyerPath(qr);
  await request(`/api/customer/orders/${order.id}`, undefined, 410, false);

  await request(`${buyer}/checkout`, { version: oldVersion }, 409, false);
  const checkout = await request(`${buyer}/checkout`, { version: order.version }, 200, false);
  const locked = await request(buyer, undefined, 200, false);
  clock = qr.expiresAt + 1;
  await request(`${stall}/items`, { version: locked.version, operations: preview.operations }, 409);
  await request(`${buyer}/capture`, { token: 'wrong' }, 409, false);
  order = await request(`${buyer}/capture`, { token: checkout.id }, 200, false);
  assert.equal(order.status, 'paid');
  assert.deepEqual(await request(`${buyer}/capture`, { token: checkout.id }, 200, false), order);
  await request(`${stall}/serve`, { version: order.version }, 401, false);
  await request(`${buyer}/serve`, { version: order.version }, 404, false);
  await request(`${stall}/serve`, { version: oldVersion }, 409);
  const served = await request(`${stall}/serve`, { version: order.version });
  assert.equal(served.servedAt, new Date(clock).toISOString());
  assert.equal(served.status, 'paid');
  assert.deepEqual(served.capture, order.capture);
  assert.deepEqual(await request(`${stall}/serve`, { version: order.version }), served);
  assert.deepEqual(await request(buyer, undefined, 200, false), served);
  assert.equal((await request(firstBuyer, undefined, 200, false)).status, 'checkout');
  order = served;

  const wrongOrder = await request(`${stall}/preview`, { version: order.version, text: 'Remove the sandwich from order 99.' });
  assert.equal(wrongOrder.operations[0].type, 'needs_clarification');
  const adjustment = await request(`${stall}/preview`, {
    version: order.version,
    text: `Remove the sandwich from order ${order.number}. Keep the drinks.`,
    commit: true,
  });
  assert.equal(adjustment.cents, 400);
  assert.equal((await request(buyer)).refund, undefined);
  await request(`${stall}/refund`, { version: adjustment.version, operations: adjustment.operations }, 502);
  assert.equal((await request(buyer)).refund.status, 'SUBMITTING');
  const refunded = await request(`${stall}/refund`, {});
  assert.equal(refunded.refund.cents, 400);
  assert.equal(refunded.refund.status, 'COMPLETED');
  assert.equal(refunded.servedAt, served.servedAt);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(refunded.total - refunded.refund.cents, 600);
  assert.deepEqual(await request(`${stall}/refund`, {}), refunded);
  assert.equal(attempts.length, 2);
  const sales = `/api/stall/sales?date=${new Date(clock).toISOString().slice(0, 10)}&timeZone=UTC`;
  await request(sales, undefined, 401, false);
  const report = await request(sales);
  assert.equal(report.gross, 1000);
  assert.equal(report.net, 600);
  assert.equal(report.paidOrders, 1);
  assert.equal(report.refundTotal, 400);
  assert.equal(report.bestSellers[0].quantity, 3);
  assert.ok((await request(`${sales}&sample=1`)).paidOrders > 1);
  assert.deepEqual(await request(sales), report);

  for (let i = 0; i < 30; i++) await request('/api/stall/orders', {}, 201);
  const queue = await request('/api/stall/orders');
  assert.ok(queue.some(item => item.id === quickOrder.id && item.status === 'checkout'));
  assert.ok(!queue.some(item => item.id === order.id));
});
