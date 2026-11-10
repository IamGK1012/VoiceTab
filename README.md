# VoiceTab

VoiceTab is a festival till that turns spoken orders and corrections into itemized bills. The customer scans a QR code and pays from their phone. After payment, the stall can review and confirm a voice-requested partial refund.

## Try VoiceTab as a judge

[Watch the 90-second demo](https://youtu.be/bkx2N983crI) or run the same order, checkout, and refund flow locally. The local walkthrough uses simulated payments and needs no account, API key, microphone, or second device.

Install Node.js 22.13 or newer and run:

```sh
git clone https://github.com/IamGK1012/VoiceTab.git
cd VoiceTab
npm ci
npm start
```

Open [the till](http://localhost:3000) and leave the terminal running.

| Step | What to click | What you should see |
| --- | --- | --- |
| 1. Take the order | **Try sample order** | The correction replaces two lemonades with three. The printed bill shows three lemonades and one sandwich for **$10.00**. |
| 2. Pay as the customer | **Show customer QR** → **Open customer bill** → **Looks right — pay** → **Approve simulated payment** | The customer tab shows a paid receipt and a pickup number. |
| 3. Refund one item | Return to the till and choose **Try sample refund**, then confirm the refund. | The sandwich refund is **$4.00**. The receipt shows **Partially refunded** and **$6.00** net paid. |

To try the live microphone and actual test transactions, follow [Run with Gemini and PayPal Sandbox](#run-with-gemini-and-paypal-sandbox) below.

### Try your own order

Record for up to 30 seconds or type an order and select **Create bill**. With browser speech recognition, **Live bill** updates locally as words arrive. When a clear order is followed by about a second of quiet, VoiceTab saves and prints the final bill. **Something’s wrong** flags the bill at the till and invalidates that QR. Use a fresh QR after checking the order.

While recording, the stall shows the live transcript and animates changes to item quantities and prices. Use **Edit transcript** to stop listening and correct the text before submitting. Say **charge** or **bill it** to open the customer QR for a complete order. The customer still approves payment on their own screen.

For a phone in local simulation, set `HOST=0.0.0.0`, `PUBLIC_BASE_URL=http://YOUR_COMPUTER_LAN_IP:3000`, and a private random `STALL_KEY` of at least 16 characters in `.env`. Restart and use the same Wi-Fi. Keep the stall on the computer at `http://localhost:3000`; only the customer link needs to open on the phone. Keep a no-key demo on localhost and out of public proxies. Draft QR codes expire after ten minutes and are replaced when the bill changes. Select **Refresh QR** if a draft code has expired. A link used to start payment stays valid for the PayPal return and receipt.

## Run with Gemini and PayPal Sandbox

1. Copy `.env.example` to `.env`. Set `VOICETAB_MODE=sandbox` and set a random `STALL_KEY` of at least 16 characters. Enter that key at the till.
2. Add the client ID and secret from a PayPal **Sandbox** app. Use a separate personal Sandbox account when PayPal asks the customer to sign in.
3. For the Gemini recording fallback and free-form interpretation, set `GEMINI_API_KEY` in your private `.env`. `GEMINI_MODEL` defaults to `gemini-3.1-flash-lite`. Typed checkout and common commands work without Gemini.
4. Run `npm start`. Localhost works for the till and a second tab on the same computer. For a second device in Sandbox mode, set `PUBLIC_BASE_URL` to the HTTPS origin of your deployment or reverse proxy. Set `HOST=0.0.0.0` when your hosting setup needs it.
5. Tap **Record command** once and say the order. After a pause of about two seconds, VoiceTab finishes listening and prints the draft bill automatically. A recording can last up to 30 seconds. Check the bill before sharing the QR. Refunds still require separate confirmation.

### PayPal Sandbox smoke test

1. On the till, choose **Try sample order** and check the total is $10. Open its QR on a phone if using HTTPS, or open **Open customer bill** in a second tab on localhost.
2. Select **Looks right — pay**. Sign in with the separate personal Sandbox buyer and approve $10. Back in VoiceTab, confirm both screens show paid and save the PayPal capture ID.
3. At the stall, select **Try sample refund**, review the $4 sandwich refund, and confirm it. Check that the receipt shows **Partially refunded**, a refund ID, and **$6 net paid**. Compare the purchase and refund with the business Sandbox account’s activity.

Sandbox mode uses browser speech recognition for live bill updates when the browser supports it. With a Gemini key configured, **Record audio instead** records from the microphone and sends the clip to Gemini after you pause. This path can also be chosen when the browser’s speech service is unavailable. Both paths require the browser’s microphone permission. Open the stall directly in a supported browser for microphone testing. The order engine handles common English, Tanglish, and Hinglish commands locally and asks Gemini for structured operations when a transcript needs more interpretation. If Gemini is unavailable, typed commands that the local parser recognizes still work. VoiceTab does not store recordings.

To test the pickup queue, create two bills and open their customer links in separate tabs. Pay the second bill first. Its receipt shows a large pickup number, and the stall lists it under **Ready for pickup** while the first bill stays **In progress**. Select **Mark served** to move it to **Recent history** and update the customer receipt. You can still open that order and refund the sandwich.

Open **Branding studio** from the unlocked till to set the stall name, accent, font pairing, and logo. Choose a monogram or upload a PNG, JPEG, or WebP. The preview updates before saving. The saved settings apply to the till and appear on the customer bill and receipt the next time they load.

Open **Sales dashboard** from the unlocked till to review a date in your browser’s local time zone. Gross sales and average order value use completed payments. Net sales subtract completed refunds posted on the selected date. The hourly chart and best sellers use gross sales and quantities before refunds. Older orders without payment or refund timestamps use the recorded order date or payment date as a fallback. In local simulation, **Show sample sales** displays example figures separately from your own orders.

To test the expanded menu, say or type: “One chai, one samosa, one iced coffee, one vegetable puff, and one mango lassi. Actually, make that two samosas. Bill it.” The bill should show five items and **$15.50**, with two samosas. Pay it and then enter “Refund one samosa”. Confirm the **$2.00** refund and check **$13.50 net paid**. The dashboard should show the same sale and refund amounts if this is your only paid order on the selected date.

The server validates every operation and calculates totals in cents using the SQLite menu. Corrections replace quantities. Explicit additions like “one more” increase them. An unknown item leaves the cart unchanged. Paid orders keep their original prices for refunds. PayPal Orders v2 handles the buyer approval and capture. PayPal Payments v2 sends the partial refund against the captured payment. Pending actions remain pending until PayPal confirms them.

This version runs as one Node process with a writable disk. Each order supports one partial refund. The public link opens only that order, and staff controls require the stall key in Sandbox mode. Keep the `.env` file private. If a payment or refund action has an uncertain result, retry the same action from its screen. The app reuses the original PayPal request ID within its retry window.

```sh
npm test
npm run check:apis
```

The suite covers the order engine, provider fallback, payment and refund retries, branding, pickup, and daily sales. The API smoke check verifies configured PayPal Sandbox credentials and sends a synthetic order to the configured Gemini model. It skips missing credentials. Use `npm run check:apis -- --require-all` to require both providers to pass. It does not create a PayPal order.

### Postman API smoke test

Import [the collection](postman/VoiceTab.postman_collection.json) into Postman and run the whole collection against a local **simulation** server. Its default address is `http://127.0.0.1:3010`. In a clean terminal, start the no-key server with `PORT=3010 node server.mjs` on macOS/Linux, or `$env:PORT='3010'; node server.mjs` in PowerShell. Leave it running and run the collection from Postman or Newman:

```sh
npx --yes --package newman@6 newman run postman/VoiceTab.postman_collection.json --bail
```

The collection checks the corrected $10 bill, QR, simulated capture, pickup, $4 partial refund, and sales report. Use an isolated demo database when testing because the collection creates simulated order records.

## Interface assets

The [Paper Wave brand board](http://localhost:3000/logos) shows the final logo and provides downloads for the wordmark, standalone mark, single-color logo, and app icons. The design tokens are in `public/css/tokens.css`. Geist Sans and Geist Mono are served locally under the SIL Open Font License in `public/fonts/OFL.txt`. The Lucide icons are bundled in `public/icons.svg`, with attribution and license in `public/lucide-LICENSE.txt`.
