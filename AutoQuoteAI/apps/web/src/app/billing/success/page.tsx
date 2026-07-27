"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function BillingSuccessPage() {
  const [status, setStatus] = useState("Confirming subscription…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tenantId = params.get("tenantId");
    const plan = (params.get("plan") ?? "starter") as
      | "starter"
      | "growth"
      | "scale";
    const stub = params.get("stub_checkout");

    if (!tenantId) {
      setStatus("Billing redirect received. Return to the dashboard to continue.");
      return;
    }

    if (stub === "1" || !process.env.NEXT_PUBLIC_STRIPE_LIVE) {
      api(`/v1/tenants/${tenantId}/billing/activate-stub`, {
        method: "POST",
        body: JSON.stringify({ planKey: plan }),
      })
        .then(() =>
          setStatus(`Stub plan activated: ${plan}. You can keep building offline.`),
        )
        .catch((err) =>
          setStatus(
            err instanceof Error
              ? err.message
              : "Could not activate stub subscription (are you signed in?)",
          ),
        );
    } else {
      setStatus("Stripe checkout completed. Your subscription will update shortly.");
    }
  }, []);

  return (
    <main className="hero">
      <h1 style={{ fontSize: "2rem" }}>Billing updated</h1>
      <p className="muted">{status}</p>
      <a className="btn btn-primary" href="/dashboard/billing">
        Back to billing
      </a>
    </main>
  );
}
