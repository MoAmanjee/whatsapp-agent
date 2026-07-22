# Going live with WhatsApp (Meta Cloud API)

Everything runs **locally on stubs today**. The moment you have Meta credentials,
these steps flip it to a real WhatsApp number. No code changes required.

## 1. Get a WhatsApp Business Platform account
1. Create a Meta app at https://developers.facebook.com → **Business** type.
2. Add the **WhatsApp** product. Meta gives you a free **test number** immediately.
3. Note these values (WhatsApp → API Setup):
   - **Phone number ID**
   - **WABA ID** (WhatsApp Business Account ID)
   - A **temporary access token** (24h) for testing, or create a permanent
     **System User token** (Business Settings → System Users → generate token with
     `whatsapp_business_messaging` + `whatsapp_business_management`).
4. App Secret: **App → Settings → Basic → App Secret**.

## 2. Set environment variables
In your `.env`:
```
WHATSAPP_DEV_ACCESS_TOKEN=<any non-empty value flips code to the real Meta client>
WHATSAPP_VERIFY_TOKEN=<invent a string; you'll paste the same one into Meta>
WHATSAPP_APP_SECRET=<App Secret from step 1.4>
```
Then connect the tenant's number from the dashboard (**Dashboard → WhatsApp**), or
`POST /v1/tenants/:tenantId/whatsapp` with `{ phoneNumberId, accessToken, wabaId }`.
The token is encrypted at rest (AES-256-GCM) before it touches the database.

## 3. Expose your webhook publicly
Meta must reach your API over HTTPS. For local dev use a tunnel:
```
# either
npx localtunnel --port 4000
# or
ngrok http 4000
```
This gives you a public URL like `https://xxxx.ngrok-free.app`.

## 4. Register the webhook in Meta
WhatsApp → Configuration → Webhook:
- **Callback URL:** `https://<your-public-host>/v1/whatsapp/webhook`
- **Verify token:** the exact `WHATSAPP_VERIFY_TOKEN` you set
- Click **Verify and Save** — the `GET` handler answers Meta's challenge.
- **Subscribe** to the **`messages`** field (covers inbound messages *and* status
  receipts: sent / delivered / read / failed).

## 5. Test the round trip
1. From your phone, message the test number (or add your number as a recipient in
   the test-number panel).
2. Inbound message → stored → queued → worker runs the sales workflow → reply sent.
3. Watch `apps/api` and `apps/worker` logs; check the dashboard **Inbox**.
4. Delivery receipts update each message's status column automatically.

## 6. Production notes
- Signature verification is enforced automatically when `NODE_ENV=production`
  and `WHATSAPP_APP_SECRET` is set (verified over the raw request body).
- **24-hour window:** outside 24h since the customer's last message you may only
  send **approved templates**, not free text. Use `sendTemplate(...)` for
  re-engagement; `sendText(...)` works inside the window. Create/approve templates
  in Meta → WhatsApp Manager → Message Templates.
- **Media:** inbound media is stored as a `wa-media:<id>` reference; call
  `provider.downloadMedia(creds, id)` in the worker to pull bytes into object
  storage (MinIO/S3) rather than relying on Meta's short-lived URLs.
- **Rate/quality:** monitor the number's quality rating; Meta throttles low-quality
  senders. Per-tenant tokens mean one tenant can't bottleneck others.

## 7. Enable the AI (optional)
Set one of these in `.env` and restart the worker:
```
ANTHROPIC_API_KEY=sk-ant-...      # uses claude-sonnet-4-6 by default
# or
OPENAI_API_KEY=sk-...             # uses gpt-4o-mini by default
```
Without a key the agent still works using deterministic slot extraction.
The LLM only parses customer messages and phrases replies — **prices and products
always come from your catalog**, never the model.
