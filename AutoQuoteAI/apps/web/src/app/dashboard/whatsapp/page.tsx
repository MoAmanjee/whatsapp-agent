"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { DashboardShell } from "../shell";

type MeResponse = {
  memberships: Array<{ tenant: { id: string; name: string } }>;
};

type WaAccount = {
  id: string;
  phoneNumberId: string;
  displayNumber: string | null;
  isActive: boolean;
};

export default function WhatsAppPage() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>();
  const [accounts, setAccounts] = useState<WaAccount[]>([]);
  const [demoText, setDemoText] = useState(
    "Need oil filter for 2012 Toyota Corolla OEM 90915-YZZD2",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(tid: string) {
    setAccounts(await api<WaAccount[]>(`/v1/tenants/${tid}/whatsapp`));
  }

  useEffect(() => {
    api<MeResponse>("/v1/me")
      .then(async (me) => {
        const t = me.memberships[0]?.tenant;
        if (!t) {
          router.replace("/login");
          return;
        }
        setTenantId(t.id);
        setBusinessName(t.name);
        await refresh(t.id);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  async function onConnect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!tenantId) return;
    setError(null);
    const fd = new FormData(e.currentTarget);
    try {
      await api(`/v1/tenants/${tenantId}/whatsapp`, {
        method: "POST",
        body: JSON.stringify({
          phoneNumberId: fd.get("phoneNumberId"),
          accessToken: fd.get("accessToken"),
          displayNumber: fd.get("displayNumber") || undefined,
          wabaId: fd.get("wabaId") || undefined,
        }),
      });
      e.currentTarget.reset();
      setMessage("WhatsApp account connected (token encrypted at rest).");
      await refresh(tenantId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
    }
  }

  async function runDemo() {
    if (!tenantId) return;
    setError(null);
    try {
      const res = await api<{ conversationId: string }>(
        `/v1/tenants/${tenantId}/demo/inbound`,
        {
          method: "POST",
          body: JSON.stringify({ text: demoText }),
        },
      );
      setMessage(
        `Demo message queued. Open Inbox — conversation ${res.conversationId.slice(0, 8)}…`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo failed");
    }
  }

  return (
    <DashboardShell businessName={businessName}>
      <h1 style={{ marginTop: 0 }}>WhatsApp</h1>
      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h2>Connect your WABA number</h2>
        <p className="muted">
          You own the number (Shopify model). Paste Meta Cloud API phone number ID
          + permanent token. At home you can skip this and use Demo inbound below.
        </p>
        <form className="form" onSubmit={onConnect}>
          <label>
            Phone number ID
            <input name="phoneNumberId" required />
          </label>
          <label>
            Access token
            <input name="accessToken" required />
          </label>
          <label>
            Display number
            <input name="displayNumber" placeholder="+27…" />
          </label>
          <label>
            WABA ID
            <input name="wabaId" />
          </label>
          <button className="btn btn-primary" type="submit">
            Save connection
          </button>
        </form>
      </div>

      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h2>Connected accounts</h2>
        {accounts.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul>
            {accounts.map((a) => (
              <li key={a.id}>
                {a.displayNumber ?? a.phoneNumberId} · {a.isActive ? "active" : "off"}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <h2>Demo inbound (no Meta needed)</h2>
        <p className="muted">
          Simulates a customer WhatsApp message and runs the AI quote workflow via
          the worker. Seed demo catalog first from Settings.
        </p>
        <label className="form">
          Customer message
          <input
            value={demoText}
            onChange={(e) => setDemoText(e.target.value)}
          />
        </label>
        <button
          className="btn btn-primary"
          type="button"
          onClick={runDemo}
          style={{ marginTop: "0.75rem" }}
        >
          Send demo message
        </button>
        {message ? <p className="muted">{message}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </div>
    </DashboardShell>
  );
}
