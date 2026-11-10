import { makePayPal } from '../lib/paypal.mjs';
import { makeVoice } from '../lib/voice.mjs';
import { applyOperations, seedMenu, total } from '../lib/menu.mjs';

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, GEMINI_API_KEY, GEMINI_MODEL } = process.env;
const strict = process.argv.includes('--require-all');

async function check(label, configured, run) {
  if (!configured) {
    console.log(`SKIP ${label}: credentials are missing.`);
    if (strict) process.exitCode = 1;
    return;
  }
  try {
    await run();
    console.log(`PASS ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}: ${error.message}`);
    process.exitCode = 1;
  }
}

await Promise.all([
  check('PayPal Sandbox OAuth', PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET, async () => {
    await makePayPal({ demo: false, clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET }).checkConnection();
  }),
  check('Gemini structured order interpretation', GEMINI_API_KEY, async () => {
    let status;
    const voice = makeVoice({
      demo: false, key: GEMINI_API_KEY, model: GEMINI_MODEL || undefined,
      fetcher: async (...args) => {
        const response = await fetch(...args);
        status = response.status;
        return response;
      },
    });
    const result = await voice({ text: 'For table seven, I would like two cups of lemonade.', lines: [], mode: 'items', number: 1, menu: seedMenu });
    if (!status) throw new Error('No response from Google. Check connectivity and the model setting.');
    if (status !== 200) throw new Error(`Google returned HTTP ${status}. Check your key, quota, and model.`);
    const lines = applyOperations([], result.operations, seedMenu);
    if (lines.length !== 1 || lines[0].id !== 'lemonade' || lines[0].quantity !== 2 || total(lines) !== 400) {
      throw new Error('The provider response did not produce the expected two lemonades.');
    }
  }),
]);
