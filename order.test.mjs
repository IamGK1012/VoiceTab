import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOperations, orderClarification, refundLines, seedMenu, total } from './lib/menu.mjs';
import { salesReport } from './lib/sales.mjs';
import { openStore } from './lib/store.mjs';
import { parseOrder, saysOrderIsDone } from './lib/order-parser.mjs';
import { makeVoice } from './lib/voice.mjs';

const set = (item_id, qty) => ({ type: 'set_quantity', item_id, qty });
const add = (item_id, qty) => ({ type: 'add', item_id, qty });
const remove = item_id => ({ type: 'remove', item_id });
const clear = { type: 'clear_order' };
const demoVoice = makeVoice({ demo: true });
const understand = (text, lines = [], voice = demoVoice) => voice({
  text, lines, mode: 'items', number: 1, menu: seedMenu,
});
const cart = (...operations) => applyOperations([], operations, seedMenu);
const quantities = lines => Object.fromEntries(lines.map(line => [line.id, line.quantity]));

test('the five new items accept spoken aliases, live corrections and item refunds', async () => {
  const opening = 'Oru chai, ek samosa, one iced coffee, one vegetable puff and one mango lassy';
  const spoken = `${opening}. Actually, make that two samosas.`;
  const context = { menu: seedMenu, lines: [], mode: 'items' };
  assert.equal(total(cart(...parseOrder(opening, context))), 1350);
  const interim = parseOrder(`${opening}. Actually, make that two sam`, { ...context, partial: true });
  assert.equal(total(cart(...interim)), 1350);
  const { operations } = await understand(spoken);
  const lines = cart(...operations);
  assert.deepEqual(quantities(lines), { 'masala-chai': 1, samosa: 2, 'cold-coffee': 1, 'veg-puff': 1, 'mango-lassi': 1 });
  assert.equal(total(lines), 1550);
  const refund = parseOrder('Refund one samoza', { ...context, lines, mode: 'refund' });
  assert.equal(total(refundLines(lines, refund)), 200);
});

test('sales use local payment dates and count completed refunds on the refund date', () => {
  const lines = cart(set('samosa', 2), set('masala-chai', 1));
  const orders = [
    { number: 1, status: 'paid', lines, paidAt: '2026-11-10T18:10:00Z',
      refund: { status: 'COMPLETED', cents: 200, completedAt: '2026-11-10T18:40:00Z' } },
    { number: 2, status: 'paid', lines, paidAt: '2026-11-10T18:50:00Z',
      refund: { status: 'PENDING', cents: 200 } },
    { number: 3, status: 'payment_pending', lines, createdAt: '2026-11-10T18:50:00Z' },
  ];
  const report = salesReport(orders, { date: '2026-11-11', timeZone: 'Asia/Kolkata' });
  assert.equal(report.gross, 650);
  assert.equal(report.paidOrders, 1);
  assert.equal(report.average, 650);
  assert.equal(report.hours[0], 650);
  assert.equal(report.refundTotal, 200);
  assert.equal(report.net, 450);
  assert.equal(report.bestSellers[0].name, 'Samosa');
  assert.deepEqual(report.refunds.map(item => item.number), [1]);
  assert.throws(() => salesReport(orders, { date: '2026-02-31', timeZone: 'UTC' }), /valid sales date/);
});

const cases = [
  ['replaces the first quantity in the demo phrase', 'Two lemonades, one sandwich. Actually, make that three lemonades.',
    [set('lemonade', 2), set('sandwich', 1), set('lemonade', 3)], { lemonade: 3, sandwich: 1 }],
  ['replaces the last named item when the correction omits it', 'Two lemonades. Make that three.',
    [set('lemonade', 2), set('lemonade', 3)], { lemonade: 3 }],
  ['adds a unit only when asked for one more', 'One sandwich. One more sandwich.',
    [set('sandwich', 1), add('sandwich', 1)], { sandwich: 2 }],
  ['removes the named line', 'Two lemonades, one sandwich. Remove the sandwich.',
    [set('lemonade', 2), set('sandwich', 1), remove('sandwich')], { lemonade: 2 }],
  ['recognizes Tanglish quantities', 'Rendu lemonade, oru sandwich',
    [set('lemonade', 2), set('sandwich', 1)], { lemonade: 2, sandwich: 1 }],
  ['recognizes Hinglish quantities', 'Do lemonade, ek sandwich',
    [set('lemonade', 2), set('sandwich', 1)], { lemonade: 2, sandwich: 1 }],
];

for (const [name, text, expected, result] of cases) {
  test(name, async () => {
    const { operations } = await understand(text);
    assert.deepEqual(operations, expected);
    const lines = cart(...operations);
    assert.deepEqual(quantities(lines), result);
    if (name.includes('demo phrase')) assert.equal(total(lines), 1000);
  });
}

test('reports an unknown item and leaves the entire cart unchanged', async () => {
  const before = cart(set('cookie', 2));
  const unknown = { type: 'unknown_item', spoken_text: 'pizza' };
  const { operations } = await understand('One pizza', before);
  assert.deepEqual(operations, [unknown]);
  assert.equal(orderClarification(operations), 'We don’t sell pizza.');
  const mixed = await understand('One lemonade and one pizza', before);
  assert.deepEqual(mixed.operations, [set('lemonade', 1), unknown]);
  assert.throws(() => applyOperations(before, mixed.operations, seedMenu), /don’t sell pizza/);
  assert.deepEqual(quantities(before), { cookie: 2 });
});

test('cancel and start over clear an existing order', async () => {
  const before = cart(set('lemonade', 2), set('sandwich', 1));
  for (const command of ['Cancel', 'Start over']) {
    const { operations } = await understand(command, before);
    assert.deepEqual(operations, [clear]);
    assert.deepEqual(applyOperations(before, operations, seedMenu), []);
  }
});

test('handles the reported microphone transcript and replaces the sandwich quantity', async () => {
  const text = 'Here two lemonades and one sandwich I know make it uh five sandwich thank you';
  const result = await understand(text);
  assert.deepEqual(result.operations, [set('lemonade', 2), set('sandwich', 1), set('sandwich', 5)]);
  assert.equal(result.transcript, text);
  assert.equal(total(cart(...result.operations)), 2400);
});

test('handles conversational greetings, requests, fillers and sign-offs', async () => {
  for (const text of [
    'Yeah can you make two lemonades and one sandwich',
    'Could you make me two lemonades and one sandwich, please?',
    "Hey two lemonades and one sandwich Yeah thank you that's it",
    'Hey, uh, could I have two lemonades, plus a sandwich? Thanks a lot, that’s all.',
    "Okay, I'll take a couple of lemonades and can I also get a sandwich please?",
    "I'd like to order two lemonades yeah and can I please get a sandwich.",
  ]) {
    const result = await understand(text);
    assert.deepEqual(result.operations, [set('lemonade', 2), set('sandwich', 1)], text);
  }
  assert.equal((await understand('Hi there')).operations[0].type, 'needs_clarification');
});

test('handles natural corrections and asks about alternatives', async () => {
  for (const text of [
    'Yeah can you make two lemonades and one sandwich, actually make that three lemonades?',
    "Two lemonades and one sandwich. No, wait, could you make that three lemonades? Thanks.",
    "I'll have two lemonades plus a sandwich. Actually, can you make it three lemonades? That's all.",
  ]) {
    const result = await understand(text);
    assert.deepEqual(result.operations, [set('lemonade', 2), set('sandwich', 1), set('lemonade', 3)], text);
  }
  const ambiguous = await understand('Could I have two or three lemonades?');
  assert.equal(orderClarification(ambiguous.operations), 'I heard two quantities. Which one should go on the bill?');
  const mixed = await understand("Hey I'll take two lemonades and a pizza thanks that's it");
  assert.equal(orderClarification(mixed.operations), 'We don’t sell pizza.');
});

test('validates IDs and operation shapes, clamps quantities, and uses the stored menu price', () => {
  const menu = openStore(':memory:').menu();
  assert.deepEqual(menu, seedMenu);
  assert.deepEqual(quantities(applyOperations([], [set('lemonade', 48), add('lemonade', 9)], menu)), { lemonade: 50 });
  assert.deepEqual(quantities(applyOperations([], [set('lemonade', -2)], menu)), {});
  assert.throws(() => applyOperations([], [set('pizza', 1)], menu), /not on the menu/);
  assert.throws(() => applyOperations([], [{ ...set('lemonade', 1), cents: 1 }], menu), /Invalid order operation/);
  assert.equal(total(applyOperations([], [set('lemonade', 3)], menu)), 600);
});

test('partial refunds use the captured price and only remove paid units', () => {
  const paid = [{ id: 'lemonade', name: 'Lemonade', cents: 225, quantity: 3 }];
  assert.equal(total(refundLines(paid, [set('lemonade', 2)])), 225);
  assert.throws(() => refundLines(paid, [clear]), /paid order/);
  assert.throws(() => refundLines(paid, [add('lemonade', 1)]), /paid order/);
});

test('recovers speech stumbles and keeps unfinished words provisional', async () => {
  for (const phrase of [
    'Can you make two, two lemon aids and one sand which, that’s it',
    'Make one no two lemonades, let me think, and one sandwich',
  ]) {
    const { operations } = await understand(phrase);
    assert.deepEqual(operations, [set('lemonade', 2), set('sandwich', 1)]);
  }
  const context = { menu: seedMenu, lines: [], mode: 'items' };
  assert.equal(parseOrder('Two lemonades and one sand', context)[1].type, 'unknown_item');
  assert.deepEqual(parseOrder('Two lemonades and one sand', { ...context, partial: true }), [set('lemonade', 2)]);
  assert.equal(saysOrderIsDone('One sandwich, that’s it, thanks.'), true);
  assert.equal(saysOrderIsDone('That’s it, actually add a cookie'), false);
});

test('known commands still work in Sandbox mode when Gemini is offline', async () => {
  const voice = makeVoice({ demo: false, fetcher: () => { throw new Error('offline'); } });
  const { operations } = await understand('Make that three', cart(set('lemonade', 2)), voice);
  assert.deepEqual(operations, [set('lemonade', 3)]);
  const unsupported = await understand('Could you sort out the drinks?', [], voice);
  assert.equal(unsupported.operations[0].type, 'needs_clarification');
});

test('Gemini receives the transcript and menu and cannot turn a correction into an addition', async () => {
  const responses = [[set('sandwich', 1)], [add('lemonade', 3)], [{ ...set('sandwich', 1), cents: 1 }]];
  const transcripts = ['Could you put a sandwich on my tab?', 'Would the kitchen be able to make that three of those?', 'Could you tuck a sandwich into my order?'];
  let index = 0;
  const voice = makeVoice({ demo: false, key: 'test-key', fetcher: async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.contents[0].parts[0].text, transcripts[index]);
    assert.match(payload.systemInstruction.parts[0].text, /"currentCart":\[\{"item_id":"lemonade","qty":2\}\]/);
    assert.match(payload.systemInstruction.parts[0].text, /"aliases":\["lemonades","lemon aid"\]/);
    assert.equal(payload.generationConfig.responseJsonSchema.type, 'array');
    return { ok: true, json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(responses[index++]) }] } }],
    }) };
  } });
  const before = cart(set('lemonade', 2));
  const interpreted = await understand(transcripts[0], before, voice);
  assert.deepEqual(interpreted.operations, [set('sandwich', 1)]);
  assert.equal(interpreted.source, 'gemini-interpretation');
  assert.equal((await understand(transcripts[1], before, voice)).operations[0].type, 'needs_clarification');
  assert.equal((await understand(transcripts[2], before, voice)).operations[0].type, 'needs_clarification');
  assert.equal(index, 3);
});

test('the Gemini audio fallback transcribes a recording and applies the correction once', async () => {
  const audio = { mime: 'audio/wav', data: 'UklGRg==' };
  let requests = 0;
  const voice = makeVoice({ demo: false, key: 'test-key', fetcher: async (url, options) => {
    requests++;
    assert.match(url, /gemini-3\.1-flash-lite:generateContent$/);
    assert.deepEqual(JSON.parse(options.body).contents[0].parts[0], {
      inlineData: { mimeType: audio.mime, data: audio.data },
    });
    return { ok: true, json: async () => ({
      candidates: [{ content: { parts: [{ text: 'Two lemonades and one sandwich. Actually, make that three lemonades. Bill it.' }] } }],
    }) };
  } });
  const result = await voice({ audio, lines: [], mode: 'items', number: 1, menu: seedMenu });
  assert.deepEqual(quantities(cart(...result.operations)), { lemonade: 3, sandwich: 1 });
  assert.equal(result.showQr, true);
  assert.equal(result.source, 'gemini-audio');
  assert.equal(requests, 1);
});
