"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { DashboardShell } from "../shell";

type MeResponse = {
  memberships: Array<{ tenant: { id: string; name: string } }>;
};

type Conversation = {
  id: string;
  status: string;
  contact: { profileName: string | null; waId: string };
  messages: Array<{ bodyText: string | null; direction: string }>;
};

export default function InboxPage() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>();
  const [rows, setRows] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [reply, setReply] = useState("");

  async function load(tid: string) {
    setRows(await api<Conversation[]>(`/v1/tenants/${tid}/conversations`));
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

  async function takeover(id: string) {
    if (!tenantId) return;
    await api(`/v1/tenants/${tenantId}/conversations/${id}/takeover`, {
      method: "POST",
    });
    await load(tenantId);
  }

  async function release(id: string) {
    if (!tenantId) return;
    await api(`/v1/tenants/${tenantId}/conversations/${id}/release`, {
      method: "POST",
    });
    await load(tenantId);
  }

  async function sendReply(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !activeId || !reply.trim()) return;
    await api(`/v1/tenants/${tenantId}/conversations/${activeId}/reply`, {
      method: "POST",
      body: JSON.stringify({ text: reply }),
    });
    setReply("");
    await load(tenantId);
  }

  return (
    <DashboardShell businessName={businessName}>
      <h1 style={{ marginTop: 0 }}>Inbox</h1>
      <div className="panel">
        {rows.length === 0 ? (
          <p className="muted">
            No conversations yet. Use WhatsApp → Demo inbound after seeding catalog.
          </p>
        ) : (
          <ul>
            {rows.map((c) => (
              <li key={c.id} style={{ marginBottom: "1rem" }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setActiveId(c.id)}
                >
                  <strong>{c.contact.profileName ?? c.contact.waId}</strong> · {c.status}
                </button>
                <div className="muted">{c.messages[0]?.bodyText ?? "(no text)"}</div>
                <div className="cta-row" style={{ marginTop: "0.35rem" }}>
                  {c.status !== "HUMAN_TAKEOVER" ? (
                    <button className="btn btn-ghost" type="button" onClick={() => takeover(c.id)}>
                      Take over
                    </button>
                  ) : (
                    <button className="btn btn-ghost" type="button" onClick={() => release(c.id)}>
                      Release to AI
                    </button>
                  )}
                </div>
                {activeId === c.id ? (
                  <form className="form" onSubmit={sendReply} style={{ marginTop: "0.75rem" }}>
                    <label>
                      Human reply
                      <input
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        placeholder="Type a reply…"
                      />
                    </label>
                    <button className="btn btn-primary" type="submit">
                      Send reply
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </DashboardShell>
  );
}
