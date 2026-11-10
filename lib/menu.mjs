export const seedMenu = [
  { id: 'lemonade', name: 'Lemonade', aliases: ['lemonades', 'lemon aid'], description: 'Freshly squeezed', cents: 200, icon: '🍋' },
  { id: 'sandwich', name: 'Sandwich', aliases: ['sandwiches'], description: 'Grilled veggie', cents: 400, icon: '🥪' },
  { id: 'cookie', name: 'Cookie', aliases: ['cookies'], description: 'Chocolate chip', cents: 150, icon: '🍪' },
  { id: 'masala-chai', name: 'Masala Chai', aliases: ['masala tea', 'chai', 'chais', 'chai tea', 'masala chais'], description: 'Spiced milk tea', cents: 250, icon: 'cup-soda' },
  { id: 'samosa', name: 'Samosa', aliases: ['samosas', 'samosa pastry', 'samosa pastries', 'samoza', 'samose'], description: 'Crisp potato pastry', cents: 200, icon: 'sandwich' },
  { id: 'cold-coffee', name: 'Cold Coffee', aliases: ['cold coffees', 'iced coffee', 'iced coffees', 'ice coffee', 'chilled coffee'], description: 'Chilled coffee with milk', cents: 350, icon: 'cup-soda' },
  { id: 'veg-puff', name: 'Veg Puff', aliases: ['veg puffs', 'vegetable puff', 'vegetable puffs', 'veggie puff', 'veggie puffs'], description: 'Flaky vegetable pastry', cents: 250, icon: 'sandwich' },
  { id: 'mango-lassi', name: 'Mango Lassi', aliases: ['mango lassis', 'lassi', 'lassis', 'mango lassy', 'mango yogurt drink'], description: 'Mango and yogurt', cents: 300, icon: 'cup-soda' },
];

export const total = lines => lines.reduce((sum, line) => sum + line.quantity * line.cents, 0);
export const dollars = cents => (cents / 100).toFixed(2);

export function hasPickup(order) {
  return order.status === 'paid' &&
    (order.refund?.status !== 'COMPLETED' || order.refund.cents < total(order.lines));
}

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const maxOperations = 24;
export const clampQuantity = qty => Math.max(0, Math.min(50, qty));

const itemId = { type: 'string' };
const quantity = { type: 'integer' };
const message = { type: 'string' };
const fieldsByType = new Map([
  ['set_quantity', { item_id: itemId, qty: quantity }],
  ['add', { item_id: itemId, qty: quantity }],
  ['remove', { item_id: itemId }],
  ['clear_order', {}],
  ['unknown_item', { spoken_text: message }],
  ['needs_clarification', { spoken_text: message, reason: message }],
]);

export function operationSchema(menu) {
  return {
    // Gemini rejects array bounds with this union. validateOperations enforces them.
    type: 'array',
    items: {
      anyOf: [...fieldsByType].map(([type, fields]) => ({
        type: 'object',
        properties: {
          type: { type: 'string', enum: [type] },
          ...fields,
          ...('item_id' in fields ? { item_id: { type: 'string', enum: menu.map(item => item.id) } } : {}),
        },
        required: ['type', ...Object.keys(fields)],
        additionalProperties: false,
      })),
    },
  };
}

export function validateOperations(operations, menu) {
  if (!Array.isArray(operations) || !operations.length || operations.length > maxOperations) {
    throw new RequestError(400, `Provide between 1 and ${maxOperations} order operations.`);
  }
  for (const operation of operations) {
    const fields = fieldsByType.get(operation?.type);
    if (!fields || Object.keys(operation).length !== 1 + Object.keys(fields).length) {
      throw new RequestError(400, 'Invalid order operation.');
    }
    for (const [field, schema] of Object.entries(fields)) {
      const value = operation[field];
      const valid = schema.type === 'integer' ? Number.isSafeInteger(value)
        : typeof value === 'string' && Boolean(value.trim()) && value.length <= 600;
      if (!Object.hasOwn(operation, field) || !valid) throw new RequestError(400, `Invalid ${field} in order operation.`);
    }
    if ('item_id' in fields && !menu.some(item => item.id === operation.item_id)) {
      throw new RequestError(400, 'That item is not on the menu.');
    }
  }
}

export function orderClarification(operations) {
  const blocker = operations.find(operation => ['unknown_item', 'needs_clarification'].includes(operation.type));
  if (blocker?.type === 'unknown_item') return `We don’t sell ${blocker.spoken_text}.`;
  return blocker?.reason ?? '';
}

export function applyOperations(current, operations, menu) {
  validateOperations(operations, menu);
  const clarification = orderClarification(operations);
  if (clarification) throw new RequestError(400, clarification);
  const quantities = new Map(current.map(line => [line.id, line.quantity]));
  for (const { type, item_id: id, qty } of operations) {
    if (type === 'clear_order') quantities.clear();
    if (type === 'remove') quantities.delete(id);
    if (type === 'set_quantity') quantities.set(id, clampQuantity(qty));
    if (type === 'add') quantities.set(id, clampQuantity((quantities.get(id) ?? 0) + clampQuantity(qty)));
  }
  return menu.filter(item => quantities.get(item.id) > 0).map(({ id, name, cents }) => ({
    id, name, cents, quantity: quantities.get(id),
  }));
}

export function refundLines(lines, operations) {
  const remaining = applyOperations(lines, operations, lines);
  if (operations.some(operation => operation.type === 'add' || operation.type === 'clear_order') ||
    remaining.some(line => line.quantity > lines.find(paid => paid.id === line.id).quantity)) {
    throw new RequestError(400, 'For a paid order, choose only items to refund.');
  }
  const removed = lines.map(line => ({
    ...line, quantity: line.quantity - (remaining.find(item => item.id === line.id)?.quantity ?? 0),
  })).filter(line => line.quantity > 0);
  if (!removed.length || !remaining.length) {
    throw new RequestError(400, 'Select items for a partial refund and leave at least one paid item.');
  }
  return removed;
}
