// Run with:  pnpm --filter @autoquoteai/whatsapp build && node --test
// Tests the pure parsing + signature logic (no network, no Meta account needed).
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseWebhookPayload, verifyMetaSignature } from "../dist/index.js";

test("parses an inbound text message", () => {
  const r = parseWebhookPayload({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "PN123" },
      contacts: [{ profile: { name: "Ayesha" }, wa_id: "27831234567" }],
      messages: [{ id: "wamid.text1", from: "27831234567", type: "text",
        timestamp: "1700000000", text: { body: "Need brake pads for 2018 Polo" } }],
    }}]}],
  });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].type, "text");
  assert.equal(r.messages[0].text, "Need brake pads for 2018 Polo");
  assert.equal(r.messages[0].profileName, "Ayesha");
  assert.equal(r.messages[0].phoneNumberId, "PN123");
});

test("parses an interactive button reply", () => {
  const r = parseWebhookPayload({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: "PN123" },
    messages: [{ id: "wamid.b1", from: "27831234567", type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "opt_2", title: "Front pads" } } }],
  }}]}]});
  assert.equal(r.messages[0].type, "interactive");
  assert.equal(r.messages[0].interactive.kind, "button_reply");
  assert.equal(r.messages[0].interactive.id, "opt_2");
  assert.equal(r.messages[0].text, "Front pads");
});

test("parses an image with caption and reply context", () => {
  const r = parseWebhookPayload({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: "PN123" },
    messages: [{ id: "wamid.i1", from: "27831234567", type: "image",
      context: { id: "wamid.parent" },
      image: { id: "MEDIA987", mime_type: "image/jpeg", sha256: "abc", caption: "this part" } }],
  }}]}]});
  assert.equal(r.messages[0].type, "image");
  assert.equal(r.messages[0].media.id, "MEDIA987");
  assert.equal(r.messages[0].media.mimeType, "image/jpeg");
  assert.equal(r.messages[0].text, "this part");
  assert.equal(r.messages[0].contextMessageId, "wamid.parent");
});

test("parses delivery and failure status receipts", () => {
  const r = parseWebhookPayload({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: "PN123" },
    statuses: [
      { id: "wamid.out1", status: "delivered", timestamp: "1700000100", recipient_id: "27831234567" },
      { id: "wamid.out2", status: "failed", recipient_id: "27831234567",
        errors: [{ code: 131047, title: "Re-engagement message" }] },
    ],
  }}]}]});
  assert.equal(r.statuses.length, 2);
  assert.equal(r.statuses[0].status, "delivered");
  assert.equal(r.statuses[1].status, "failed");
  assert.equal(r.statuses[1].errorCode, 131047);
});

test("parses a mixed message + status batch", () => {
  const r = parseWebhookPayload({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: "PN123" },
    messages: [{ id: "wamid.m", from: "27000", type: "text", text: { body: "hi" } }],
    statuses: [{ id: "wamid.s", status: "read" }],
  }}]}]});
  assert.equal(r.messages.length, 1);
  assert.equal(r.statuses.length, 1);
});

test("verifies webhook signatures (valid / invalid / missing)", () => {
  const secret = "test_app_secret";
  const body = JSON.stringify({ hello: "world" });
  const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyMetaSignature(body, good, secret), true);
  assert.equal(verifyMetaSignature(body, "sha256=deadbeef", secret), false);
  assert.equal(verifyMetaSignature(body, undefined, secret), false);
});
