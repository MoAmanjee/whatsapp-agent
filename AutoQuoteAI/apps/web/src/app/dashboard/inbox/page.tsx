"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { DashboardShell } from "../shell";

type MeResponse = {
  memberships: Array<{ tenant: { id: string; name: string } }>;
};

type Message = {
  id: string;
  bodyText: string | null;
  direction: string;
  createdAt: string;
  status: string;
};

type Conversation = {
  id: string;
  status: string;
  contact: { profileName: string | null; waId: string };
  messages: Message[];
};

type ConversationDetail = Conversation & {
  messages: Message[];
};

export default function InboxPage() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>();
  const [rows, setRows] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<ConversationDetail | null>(null);
  const [reply, setReply] = useState("");

  const loadList = useCallback(async (tid: string) => {
    setRows(await api<Conversation[]>(`/v1/tenants/${tid}/conversations`));
  }, []);

  const loadThread = useCallback(async (tid: string, id: string) => {
    const detail = await api<ConversationDetail>(
      `/v1/tenants/${tid}/conversations/${id}`,
    );
    setThread(detail);
  }, []);

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
        await loadList(t.id);
      })
      .catch(() => router.replace("/login"));
  }, [router, loadList]);

  useEffect(() => {
    if (!tenantId || !activeId) return;
    void loadThread(tenantId, activeId);
    const timer = setInterval(() => {
      void loadList(tenantId);
      void loadThread(tenantId, activeId);
    }, 2500);
    return () => clearInterval(timer);
  }, [tenantId, activeId, loadList, loadThread]);

  async function takeover(id: string) {
    if (!tenantId) return;
    await api(`/v1/tenants/${tenantId}/conversations/${id}/takeover`, {
      method: "POST",
    });
    await loadList(tenantId);
    if (activeId === id) await loadThread(tenantId, id);
  }

  async function release(id: string) {
    if (!tenantId) return;
    await api(`/v1/tenants/${tenantId}/conversations/${id}/release`, {
      method: "POST",
    });
    await loadList(tenantId);
    if (activeId === id) await loadThread(tenantId, id);
  }

  async function sendReply(e: FormEvent) {
    e.preventDefault();
    if (!tenantId || !activeId || !reply.trim()) return;
    await api(`/v1/tenants/${tenantId}/conversations/${activeId}/reply`, {
      method: "POST",
      body: JSON.stringify({ text: reply }),
    });
    setReply("");
    await loadThread(tenantId, activeId);
    await loadList(tenantId);
  }

  return (
    <DashboardShell businessName={businessName}>
      <h1 style={{ marginTop: 0 }}>Inbox</h1>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(220px, 1fr) minmax(280px, 2fr)",
          gap: "1rem",
        }}
      >
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Conversations</h2>
          {rows.length === 0 ? (
            <p className="muted">
              No conversations yet. Use WhatsApp → Demo inbound after seeding catalog.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {rows.map((c) => (
                <li key={c.id} style={{ marginBottom: "0.75rem" }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{
                      width: "100%",
                      textAlign: "left",
                      border:
                        activeId === c.id
                          ? "1px solid var(--accent, #1a6)"
                          : undefined,
                    }}
                    onClick={() => setActiveId(c.id)}
                  >
                    <strong>{c.contact.profileName ?? c.contact.waId}</strong>
                    <div className="muted">{c.status}</div>
                    <div className="muted" style={{ fontSize: "0.85rem" }}>
                      {c.messages[0]?.bodyText ?? "(no text)"}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel">
          {!activeId || !thread ? (
            <p className="muted">Select a conversation to view the full thread.</p>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <h2 style={{ marginTop: 0, marginBottom: 0 }}>
                  {thread.contact.profileName ?? thread.contact.waId}
                </h2>
                <div className="cta-row">
                  {thread.status !== "HUMAN_TAKEOVER" ? (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => takeover(thread.id)}
                    >
                      Take over
                    </button>
                  ) : (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => release(thread.id)}
                    >
                      Release to AI
                    </button>
                  )}
                </div>
              </div>
              <p className="muted">Status: {thread.status} · auto-refreshes</p>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.65rem",
                  maxHeight: "55vh",
                  overflowY: "auto",
                  marginBottom: "1rem",
                  paddingRight: "0.25rem",
                }}
              >
                {thread.messages.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      alignSelf:
                        m.direction === "OUTBOUND" ? "flex-end" : "flex-start",
                      maxWidth: "85%",
                      padding: "0.65rem 0.85rem",
                      borderRadius: "10px",
                      background:
                        m.direction === "OUTBOUND"
                          ? "rgba(26, 120, 80, 0.12)"
                          : "rgba(0,0,0,0.05)",
                    }}
                  >
                    <div style={{ fontSize: "0.75rem", opacity: 0.7 }}>
                      {m.direction === "OUTBOUND" ? "Agent" : "Customer"} ·{" "}
                      {new Date(m.createdAt).toLocaleTimeString()}
                    </div>
                    <div>{m.bodyText ?? "(media / empty)"}</div>
                  </div>
                ))}
              </div>
              <form className="form" onSubmit={sendReply}>
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
            </>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
