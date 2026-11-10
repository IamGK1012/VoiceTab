import { clampQuantity, maxOperations } from './menu.mjs';

const numbers = new Map([
  ...['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].map((word, qty) => [word, qty]),
  ...['eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'].map((word, index) => [word, index + 11]),
  ['a', 1], ['an', 1], ['another', 1],
  ['oru', 1], ['onnu', 1], ['rendu', 2], ['moonu', 3], ['naalu', 4], ['anju', 5],
  ['ek', 1], ['do', 2], ['teen', 3], ['char', 4], ['chaar', 4], ['paanch', 5],
]);
const separator = /^(?:[\s,.;!?]+|(?:and|then|plus|also)\b)+/u;
const correctionWords = '(?:actually|make (?:that|it)|change (?:that )?to|instead|no wait|sorry|i mean)';
const correction = new RegExp(`\\b${correctionWords}\\b`, 'iu');
const correctionPrefix = new RegExp(`^(?:${correctionWords}\\b[\\s,]*)+`, 'u');
const politePrefix = /^(?:(?:please|(?:can|could|may) i (?:(?:also|please) )?(?:get|have|order)|i'd like(?: to order)?|i'll (?:take|have|get|go with)|i (?:want|need)|(?:give|get) me|(?:can|could|would) you (?:please )?(?=make|change|add|remove|give|get))\b[\s,]*)+/u;
const opener = /^(?:(?:hey|hi|hello|okay|ok|yeah|yep|so|here(?: you go| are)?)\b[\s,.;!?]*)+/u;
const closer = /(?:\b(?:thank you(?: so much)?|thanks(?: a lot)?|that'?s (?:it|all)|that is (?:it|all)|nothing else|all done|as well|please|okay|ok|yeah|yep)[\s,.;!?]*)+$/u;
const endOfToken = /^(?=$|[\s,.;!?])/u;
const nextWord = /^(-?\d+|[\p{L}\p{M}]+)(?=$|[\s,.;!?])/u;

export function clarification(spokenText, reason = 'I couldn’t match that to the menu. Try naming the item and quantity.') {
  return { type: 'needs_clarification', spoken_text: spokenText || '(no speech)', reason };
}

export const containsCorrection = text => correction.test(text);
export const saysOrderIsDone = text => /\b(?:that['’]?s (?:it|all)|that is (?:it|all)|nothing else|all done)(?:[\s,.!?]+(?:thanks|thank you|please))*[\s,.!?]*$/iu.test(text);
const checkoutCue = /(?:^|[\s,.!?])(?:charge|bill it)(?:[\s,.!?]+(?:please|thanks|thank you))?[\s,.!?]*$/iu;

export function splitCheckoutCue(text) {
  const cue = text.match(checkoutCue);
  const orderText = cue ? text.slice(0, cue.index).replace(/(?:\b(?:and|then)\b|[\s,.!?])+$/iu, '') : text;
  if (!cue || /\b(?:no|don't|do not|without)$/iu.test(orderText)) return { orderText: text, showQr: false };
  return { orderText, showQr: true };
}

export function parseOrder(text, { menu, lines, mode, lastItemId, partial = false }) {
  let input = text.normalize('NFKC').toLowerCase().trim()
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .replace(/\b(?:from )?order\s*#?\s*\d+\b/gu, '')
    .replace(opener, '')
    .replace(/\b(?:i know|no)[\s,]+(?=make (?:it|that)\b)/gu, '')
    .replace(/\bno[\s,]+wait\b/gu, 'no wait')
    .replace(/\b(?:uh+|um+|erm|hmm+|yeah|yep|you know|let me think)\b[\s,]*/gu, '')
    .replace(/\bsand[ -]+which(es)?\b/gu, 'sandwich$1')
    .replace(/\blemon[ -]+(?:aid|ade)(s)?\b/gu, 'lemonade$1')
    .replace(closer, '')
    .trim();
  if (mode === 'refund') input = input.replace(/(?:[.,;]|\band\b)\s*keep\b.*$/u, '');
  const aliases = menu.flatMap(item => [item.id, item.name, ...(item.aliases ?? [])]
    .map(alias => ({ id: item.id, alias: alias.normalize('NFKC').toLowerCase() })))
    .sort((a, b) => b.alias.length - a.alias.length);
  const quantities = new Map(lines.map(line => [line.id, line.quantity]));
  let lastItem = menu.some(item => item.id === lastItemId) ? lastItemId : lines.length === 1 ? lines[0].id : undefined;
  const operations = [];

  function take(pattern) {
    const match = input.match(pattern);
    if (match) input = input.slice(match[0].length).trimStart();
    return match;
  }

  function takeQuantity() {
    if (take(/^(?:a couple of|a pair of)\b/u)) return 2;
    const word = input.match(nextWord)?.[1];
    if (!word) return undefined;
    const qty = /^-?\d+$/u.test(word) ? clampQuantity(Number(word)) : numbers.get(word);
    if (qty !== undefined) input = input.slice(word.length).trimStart();
    return qty;
  }

  while (input && operations.length < maxOperations) {
    take(separator);
    if (!input) break;
    if (/^or\b/u.test(input)) return [clarification(text, 'I heard two options. Which one should go on the bill?')];
    take(politePrefix);
    if (take(/^(?:start over|clear (?:the )?order|cancel(?: the order)?)(?=$|[,.;!?])/u)) {
      operations.push({ type: 'clear_order' });
      quantities.clear();
      lastItem = undefined;
      continue;
    }
    const replacing = Boolean(take(correctionPrefix));
    take(politePrefix);
    if (replacing) take(correctionPrefix);
    const removing = Boolean(take(/^(?:remove|drop|refund|cancel|without|no)\b\s*(?:the\b\s*)?/u));
    const adding = Boolean(take(/^add\b\s*/u));
    if (!removing && !adding) take(/^make\s+(?:me\s+)?(?!that\b|it\b)/u);
    let qty = takeQuantity();
    if (qty !== undefined) {
      const repeated = input.match(/^[,\s]*(-?\d+|[\p{L}\p{M}]+)(?=$|[\s,.;!?])/u);
      if (repeated && (numbers.get(repeated[1]) ?? Number(repeated[1])) === qty) {
        input = input.slice(repeated[0].length).trimStart();
      }
      const beforeCorrection = input;
      if (take(/^[,\s]*(?:no|actually|sorry|i mean)\b[\s,]*/u)) {
        const corrected = takeQuantity();
        if (corrected === undefined) input = beforeCorrection;
        else qty = corrected;
      }
    }
    const more = Boolean(take(/^more\b\s*/u));
    if (qty !== undefined) {
      if (/^or\b/u.test(input)) return [clarification(text, 'I heard two quantities. Which one should go on the bill?')];
      take(/^of\b\s*(?:the\b\s*)?/u);
    }
    const item = aliases.find(({ alias }) => input.startsWith(alias) && endOfToken.test(input.slice(alias.length)));
    const implicitItem = (replacing || more) && qty !== undefined && (!input || separator.test(input));
    const id = item?.id ?? (implicitItem ? lastItem : undefined);
    if (!id) {
      if (partial && operations.length && (!input || aliases.some(({ alias }) => alias.startsWith(input)))) {
        return operations;
      }
      if (implicitItem) return [clarification(text, 'Which item should I change?')];
      const unknown = qty !== undefined && input.match(nextWord)?.[1];
      return unknown ? [...operations, { type: 'unknown_item', spoken_text: unknown }] : null;
    }
    if (item) input = input.slice(item.alias.length).trimStart();
    const previous = quantities.get(id) ?? 0;
    const op = removing && qty === undefined ? { type: 'remove', item_id: id }
      : removing ? { type: 'set_quantity', item_id: id, qty: clampQuantity(previous - qty) }
        : !replacing && (adding || more) ? { type: 'add', item_id: id, qty: qty ?? 1 }
          : { type: 'set_quantity', item_id: id, qty: qty ?? 1 };
    if (mode === 'refund' && !removing && (!replacing || op.qty >= previous)) return null;
    quantities.set(id, op.type === 'remove' ? 0 : op.type === 'add' ? clampQuantity(previous + op.qty) : op.qty);
    lastItem = id;
    operations.push(op);
    take(/^(?:instead|please)(?=$|[\s,.;!?])/u);
  }
  return !input && operations.length ? operations : null;
}
