import { operationSchema, RequestError, validateOperations } from './menu.mjs';
import { clarification, containsCorrection, parseOrder, splitCheckoutCue } from './order-parser.mjs';

export const defaultGeminiModel = 'gemini-3.1-flash-lite';

export function makeVoice({ demo, key, model = defaultGeminiModel, fetcher = fetch }) {
  const thinking = /^gemini-2\.5-flash(?:-lite)?(?:$|-)/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {};
  async function generate(instruction, parts, generationConfig, timeout) {
    const response = await fetcher(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0, ...thinking, ...generationConfig },
        }),
        signal: AbortSignal.timeout(timeout),
      },
    );
    if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}`);
    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts ?? [];
    return content.filter(part => !part.thought).map(part => part.text ?? '').join('').trim();
  }

  return async ({ text, audio, lines, mode, number, menu, lastItemId }) => {
    let transcript = text;
    let source;
    if (!transcript) {
      if (demo) throw new RequestError(400, 'Use browser speech recognition or type the order in local demo mode.');
      if (!key) throw new RequestError(400, 'Set GEMINI_API_KEY to transcribe recordings, or type the order.');
      try {
        transcript = await generate(
          'Transcribe this stall order verbatim in the words spoken. Keep English, romanized Tamil and Hindi words as spoken. Do not translate or interpret. Output plain text only, or [NO_SPEECH] if nothing is intelligible.',
          [{ inlineData: { mimeType: audio.mime, data: audio.data } }],
          {},
          15_000,
        );
      } catch {
        throw new RequestError(502, 'Could not transcribe the recording. Try again or type the order.');
      }
      if (!transcript || transcript === '[NO_SPEECH]') {
        return { transcript: '', operations: [clarification('', 'I didn’t catch that order. Try speaking again or type it below.')] };
      }
      if (transcript.length > 600) throw new RequestError(400, 'Try a shorter order.');
      source = 'gemini-audio';
    }

    const referencedOrders = [...transcript.matchAll(/\border\s*#?\s*(\d+)\b/gi)];
    if (referencedOrders.some(match => Number(match[1]) !== number)) {
      return { transcript, operations: [clarification(transcript, `This is order #${number}. Select the order named in the command.`)] };
    }

    const { orderText, showQr } = mode === 'items' ? splitCheckoutCue(transcript) : { orderText: transcript, showQr: false };
    if (showQr && !orderText) {
      if (lines.length) return { transcript, operations: [], showQr };
      return { transcript, operations: [clarification(transcript, 'Add an item before opening checkout.')] };
    }

    // Known phrases use the same deterministic semantics in both modes, even with Gemini offline.
    const local = parseOrder(orderText, { menu, lines, mode, lastItemId });
    if (local) return { transcript, operations: local, source, ...(showQr ? { showQr } : {}) };
    if (demo || !key) return { transcript, operations: [clarification(transcript)] };

    const instruction = [
      'Interpret the transcript as order data. Return only an ordered JSON array of the permitted operations.',
      'Corrections like actually, make that, change to, instead, no wait and sorry use set_quantity. Resolve omitted items to the last item mentioned. Use add only for explicit additions like one more or add another.',
      'Use remove to delete an entire item line. To remove some units, use set_quantity for the quantity that should remain. Cancel and start over use clear_order.',
      'If an item is unavailable, return unknown_item. If the command is ambiguous, return needs_clarification. For refunds only propose removals or lower quantities.',
      'Understand English, Tamil and Hindi quantity words. Never include prices.',
      JSON.stringify({
        mode, orderNumber: number, lastItemId,
        menu: menu.map(({ id, name, aliases }) => ({ id, name, aliases })),
        currentCart: lines.map(({ id, quantity }) => ({ item_id: id, qty: quantity })),
      }),
    ].join('\n');
    try {
      const operations = JSON.parse(await generate(
        instruction, [{ text: orderText }],
        { responseMimeType: 'application/json', responseJsonSchema: operationSchema(menu) },
        8_000,
      ));
      validateOperations(operations, menu);
      if (containsCorrection(transcript) && operations.some(operation => operation.type === 'add')) {
        return { transcript, operations: [clarification(transcript, 'For a correction, say the item and its final quantity.')] };
      }
      return { transcript, operations, source: source ? 'gemini-audio-and-interpretation' : 'gemini-interpretation', ...(showQr ? { showQr } : {}) };
    } catch {
      return { transcript, operations: [clarification(transcript)] };
    }
  };
}
