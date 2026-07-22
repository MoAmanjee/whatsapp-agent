"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { DashboardShell } from "./shell";

type MeResponse = {
  user: { id: string; email: string; name: string | null };
  memberships: Array<{
    role: string;
    tenant: { id: string; name: string; industryKey: string; slug: string };
  }>;
};

export default function DashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    api<MeResponse>("/v1/me")
      .then(setMe)
      .catch(() => router.replace("/login"));
  }, [router]);

  const tenant = me?.memberships[0]?.tenant;

  return (
    <DashboardShell businessName={tenant?.name}>
      <h1 style={{ marginTop: 0 }}>Overview</h1>
      {!me ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="grid-stats">
            <div className="stat">
              <div className="label">Industry plugin</div>
              <div className="value" style={{ fontSize: "1.1rem" }}>
                {tenant?.industryKey ?? "—"}
              </div>
            </div>
            <div className="stat">
              <div className="label">Role</div>
              <div className="value" style={{ fontSize: "1.1rem" }}>
                {me.memberships[0]?.role ?? "—"}
              </div>
            </div>
            <div className="stat">
              <div className="label">Workspace</div>
              <div className="value" style={{ fontSize: "1.1rem" }}>
                {tenant?.slug ?? "—"}
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>Home demo path</h2>
            <ol className="muted">
              <li>
                <Link href="/dashboard/settings">Settings</Link> → Seed automotive demo
                catalog
              </li>
              <li>
                <Link href="/dashboard/whatsapp">WhatsApp</Link> → Send demo inbound
                message
              </li>
              <li>
                <Link href="/dashboard/inbox">Inbox</Link> → read AI reply / take over
              </li>
              <li>
                <Link href="/dashboard/quotes">Quotes</Link> → approve, send, view
                document
              </li>
            </ol>
            <p className="muted">
              No Meta or Stripe keys required for the local demo. Stubs log outbound
              WhatsApp in the worker terminal.
            </p>
          </div>
        </>
      )}
    </DashboardShell>
  );
}
