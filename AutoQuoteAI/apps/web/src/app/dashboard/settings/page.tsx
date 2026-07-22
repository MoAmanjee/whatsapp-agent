"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { DashboardShell } from "../shell";

type MeResponse = {
  memberships: Array<{ tenant: { id: string; name: string } }>;
};

type Tenant = {
  id: string;
  name: string;
  industryKey: string;
  currency: string;
  timezone: string;
  settings: { requireQuoteApproval?: boolean };
};

export default function SettingsPage() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<MeResponse>("/v1/me")
      .then(async (me) => {
        const t = me.memberships[0]?.tenant;
        if (!t) {
          router.replace("/login");
          return;
        }
        setTenantId(t.id);
        setTenant(await api<Tenant>(`/v1/tenants/${t.id}`));
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!tenantId) return;
    const fd = new FormData(e.currentTarget);
    try {
      const updated = await api<Tenant>(`/v1/tenants/${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: fd.get("name"),
          currency: fd.get("currency"),
          timezone: fd.get("timezone"),
          requireQuoteApproval: fd.get("requireQuoteApproval") === "on",
        }),
      });
      setTenant(updated);
      setMessage("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function seedDemo() {
    if (!tenantId) return;
    try {
      const res = await api<{ seeded: boolean; reason?: string }>(
        `/v1/tenants/${tenantId}/seed-demo`,
        { method: "POST" },
      );
      setMessage(
        res.seeded
          ? "Demo automotive catalog seeded (oil filter + brake pads)."
          : `Skipped: ${res.reason}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Seed failed");
    }
  }

  return (
    <DashboardShell businessName={tenant?.name}>
      <h1 style={{ marginTop: 0 }}>Settings</h1>
      {!tenant ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <form className="form panel" onSubmit={onSave}>
            <label>
              Business name
              <input name="name" defaultValue={tenant.name} required />
            </label>
            <label>
              Currency
              <input name="currency" defaultValue={tenant.currency} maxLength={3} required />
            </label>
            <label>
              Timezone
              <input name="timezone" defaultValue={tenant.timezone} required />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                name="requireQuoteApproval"
                type="checkbox"
                defaultChecked={Boolean(tenant.settings?.requireQuoteApproval)}
              />
              Require human approval before sending quotes
            </label>
            <p className="muted">Industry plugin: {tenant.industryKey}</p>
            <button className="btn btn-primary" type="submit">
              Save
            </button>
          </form>

          <div className="panel" style={{ marginTop: "1rem" }}>
            <h2>Demo data</h2>
            <p className="muted">
              Loads sample Toyota oil filter (OEM 90915-YZZD2) + brake pads so the
              WhatsApp demo can quote immediately.
            </p>
            <button className="btn btn-ghost" type="button" onClick={seedDemo}>
              Seed automotive demo catalog
            </button>
          </div>
          {message ? <p className="muted">{message}</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </>
      )}
    </DashboardShell>
  );
}
