"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { DashboardShell } from "../shell";

type MeResponse = {
  memberships: Array<{ tenant: { id: string; name: string } }>;
};

export default function BillingPage() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api<MeResponse>("/v1/me")
      .then((me) => {
        const t = me.memberships[0]?.tenant;
        if (!t) {
          router.replace("/login");
          return;
        }
        setTenantId(t.id);
        setBusinessName(t.name);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  async function checkout(planKey: "starter" | "growth" | "scale") {
    if (!tenantId) return;
    const res = await api<{ url: string }>(
      `/v1/tenants/${tenantId}/billing/checkout`,
      {
        method: "POST",
        body: JSON.stringify({ planKey }),
      },
    );
    setMessage(`Checkout URL ready (stub or Stripe): ${res.url}`);
    if (res.url.startsWith("http")) {
      window.location.href = res.url;
    }
  }

  return (
    <DashboardShell businessName={businessName}>
      <h1 style={{ marginTop: 0 }}>Billing</h1>
      <div className="panel">
        <h2>Plans</h2>
        <p className="muted">
          Stripe is the production billing provider. Without STRIPE_SECRET_KEY the
          stub returns a local success URL so you can develop offline.
        </p>
        <div className="cta-row">
          <button className="btn btn-primary" type="button" onClick={() => checkout("starter")}>
            Starter
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => checkout("growth")}>
            Growth
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => checkout("scale")}>
            Scale
          </button>
        </div>
        {message ? <p className="muted">{message}</p> : null}
      </div>
    </DashboardShell>
  );
}
