import { dollars, RequestError, total } from './menu.mjs';

const sandbox = 'https://api-m.sandbox.paypal.com';
const money = cents => ({ currency_code: 'USD', value: dollars(cents) });

export function makePayPal({ demo, clientId, clientSecret }) {
  let token;
  let tokenExpires = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpires) return token;
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch(`${sandbox}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new RequestError(502, 'PayPal Sandbox sign-in failed. Check the app credentials.');
    const data = await response.json();
    token = data.access_token;
    tokenExpires = Date.now() + (data.expires_in - 60) * 1000;
    return token;
  }

  async function call(path, body, requestId) {
    let response;
    try {
      response = await fetch(`${sandbox}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
        },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(18_000),
      });
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(502, 'Could not reach PayPal Sandbox. Retry the same action to check its result.');
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (response.status === 401) tokenExpires = 0;
    const issue = data.details?.[0]?.issue;
    console.error('PayPal request returned', response.status, issue ?? data.name);
    if (issue === 'ORDER_ALREADY_CAPTURED') return { alreadyCaptured: true };
    if (issue === 'ORDER_NOT_APPROVED') throw new RequestError(409, 'Approve the payment on PayPal first.');
    if (issue === 'INSTRUMENT_DECLINED') throw new RequestError(409, 'PayPal declined this payment method. Return to PayPal and choose another.');
    throw new RequestError(502, 'PayPal Sandbox could not complete the action. Retry the same action to check its result.');
  }

  return {
    async checkConnection() {
      if (!demo) await accessToken();
    },
    async create(order, returnUrl, requestId) {
      if (demo) return { id: `DEMO-${order.number}`, approvalUrl: `${returnUrl}?demo=1` };
      const amount = money(total(order.lines));
      const data = await call('/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: order.id,
          custom_id: order.id,
          description: `VoiceTab order #${order.number}`,
          amount: { ...amount, breakdown: { item_total: amount } },
          items: order.lines.map(line => ({
            name: line.name, sku: line.id, unit_amount: money(line.cents), quantity: String(line.quantity),
          })),
        }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'VoiceTab',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: returnUrl,
              cancel_url: `${returnUrl}?cancel=1`,
            },
          },
        },
      }, requestId);
      const link = data.links?.find(item => ['payer-action', 'approve'].includes(item.rel));
      if (!data.id || !link?.href || new URL(link.href).origin !== 'https://www.sandbox.paypal.com') {
        throw new RequestError(502, 'PayPal did not return a Sandbox approval link.');
      }
      return { id: data.id, approvalUrl: link.href };
    },
    async capture(order, requestId) {
      if (demo) return { id: `DEMO-CAP-${order.number}`, status: 'COMPLETED', amount: money(total(order.lines)) };
      const path = `/v2/checkout/orders/${encodeURIComponent(order.paypal.id)}`;
      let data = order.capture ? await call(path) : await call(`${path}/capture`, {}, requestId);
      if (data.alreadyCaptured) data = await call(path);
      const unit = data.purchase_units?.find(item => item.reference_id === order.id);
      return unit?.payments?.captures?.[0];
    },
    async refund(order, operation) {
      if (demo) return { id: `DEMO-REF-${order.number}`, status: 'COMPLETED', amount: money(operation.cents) };
      if (operation.id) return call(`/v2/payments/refunds/${encodeURIComponent(operation.id)}`);
      return call(`/v2/payments/captures/${encodeURIComponent(order.capture.id)}/refund`, {
        amount: money(operation.cents),
        custom_id: order.id,
        note_to_payer: 'VoiceTab item adjustment',
      }, operation.requestId);
    },
  };
}
