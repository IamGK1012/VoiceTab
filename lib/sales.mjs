import { RequestError, seedMenu, total } from './menu.mjs';

export function salesReport(orders, { date, timeZone }) {
  const day = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isFinite(+day) || day.toISOString().slice(0, 10) !== date) {
    throw new RequestError(400, 'Choose a valid sales date.');
  }
  let clock;
  try {
    clock = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    });
  } catch {
    throw new RequestError(400, 'Choose a valid time zone.');
  }
  function hourOnDate(timestamp) {
    const instant = new Date(timestamp);
    if (!Number.isFinite(+instant)) return null;
    const { year, month, day, hour } = Object.fromEntries(clock.formatToParts(instant).map(part => [part.type, part.value]));
    return `${year}-${month}-${day}` === date ? Number(hour) : null;
  }

  const hours = Array(24).fill(0);
  const items = new Map();
  const refunds = [];
  let gross = 0;
  let paidOrders = 0;
  let refundTotal = 0;
  for (const order of orders) {
    if (order.status !== 'paid') continue;
    const paidAt = order.paidAt ?? order.createdAt;
    const hour = hourOnDate(paidAt);
    if (hour !== null) {
      const cents = total(order.lines);
      gross += cents;
      paidOrders++;
      hours[hour] += cents;
      for (const line of order.lines) {
        const item = items.get(line.id) ?? { name: line.name, quantity: 0, cents: 0 };
        item.quantity += line.quantity;
        item.cents += line.quantity * line.cents;
        items.set(line.id, item);
      }
    }
    if (order.refund?.status !== 'COMPLETED') continue;
    const at = order.refund.completedAt ?? paidAt;
    if (hourOnDate(at) === null) continue;
    refundTotal += order.refund.cents;
    refunds.push({ number: order.number, cents: order.refund.cents, at });
  }
  return {
    date, timeZone: clock.resolvedOptions().timeZone, gross, paidOrders, refundTotal, net: gross - refundTotal,
    average: paidOrders ? Math.round(gross / paidOrders) : 0,
    hours, bestSellers: [...items.values()].sort((a, b) => b.quantity - a.quantity || b.cents - a.cents || a.name.localeCompare(b.name)),
    refundCount: refunds.length, refunds: refunds.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
  };
}

export function sampleSales(date) {
  const baskets = [[1, 3], [0, 4, 4], [3, 4], [4, 6, 7], [5, 5, 2], [1, 0, 2], [3, 4, 7], [6, 6], [4, 5], [7, 7, 4], [3, 4], [0, 1]];
  const hours = [10, 10, 11, 12, 12, 12, 13, 14, 15, 15, 16, 17];
  return baskets.map((basket, index) => {
    const lines = [...new Set(basket)].map(itemIndex => {
      const { id, name, cents } = seedMenu[itemIndex];
      return { id, name, cents, quantity: basket.filter(value => value === itemIndex).length };
    });
    const at = `${date}T${hours[index]}:15:00Z`;
    const refund = index === 5 ? { status: 'COMPLETED', cents: 400, completedAt: at } : undefined;
    return { number: index + 1, status: 'paid', paidAt: at, lines, refund };
  });
}
