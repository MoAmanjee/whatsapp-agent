"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { DashboardShell } from "../shell";

type MeResponse = {
  memberships: Array<{ tenant: { id: string; name: string } }>;
};

type Quote = {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  currency: string;
  contact: { profileName: string | null; waId: string };
};

export default function QuotesPage() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function load(tid: string) {
    setQuotes(await api<Quote[]>(`/v1/tenants/${tid}/quotes`));
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
        await load(t.id);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  async function approve(id: string) {
    if (!tenantId) return;
    await api(`/v1/tenants/${tenantId}/quotes/${id}/approve`, { method: "POST" });
    setMessage("Quote approved (ready to send).");
    await load(tenantId);
  }

  async function send(id: string) {
    if (!tenantId) return;
    await api(`/v1/tenants/${tenantId}/quotes/${id}/send`, { method: "POST" });
    setMessage("Quote send queued — worker will deliver via WhatsApp stub/API.");
    await load(tenantId);
  }

  async function openDoc(id: string) {
    if (!tenantId) return;
    const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    const res = await fetch(
      `${base}/v1/tenants/${tenantId}/quotes/${id}/document`,
      { credentials: "include" },
    );
    const html = await res.text();
    const blob = new Blob([html], { type: "text/html" });
    window.open(URL.createObjectURL(blob), "_blank");
  }

  return (
    <DashboardShell businessName={businessName}>
      <h1 style={{ marginTop: 0 }}>Quotes</h1>
      {message ? <p className="muted">{message}</p> : null}
      <div className="panel">
        {quotes.length === 0 ? (
          <p className="muted">No quotes yet. Run a demo WhatsApp message after seeding catalog.</p>
        ) : (
          <ul>
            {quotes.map((q) => (
              <li key={q.id} style={{ marginBottom: "1rem" }}>
                <strong>{q.number}</strong> · {q.status} ·{" "}
                {(q.totalCents / 100).toFixed(2)} {q.currency} ·{" "}
                {q.contact.profileName ?? q.contact.waId}
                <div className="cta-row" style={{ marginTop: "0.35rem" }}>
                  {(q.status === "PENDING_APPROVAL" || q.status === "DRAFT") && (
                    <button className="btn btn-ghost" type="button" onClick={() => approve(q.id)}>
                      Approve
                    </button>
                  )}
                  {q.status !== "SENT" && (
                    <button className="btn btn-primary" type="button" onClick={() => send(q.id)}>
                      Send on WhatsApp
                    </button>
                  )}
                  <button className="btn btn-ghost" type="button" onClick={() => openDoc(q.id)}>
                    View document
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DashboardShell>
  );
}
