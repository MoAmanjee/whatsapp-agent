"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { DashboardShell } from "../shell";

type MeResponse = {
  memberships: Array<{ tenant: { id: string; name: string } }>;
};

type Product = {
  id: string;
  sku: string;
  name: string;
  variants: Array<{ priceCents: number; stockQty: number; currency: string }>;
};

export default function CatalogPage() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>();
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(tid: string) {
    const list = await api<Product[]>(`/v1/tenants/${tid}/products`);
    setProducts(list);
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

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!tenantId) return;
    setError(null);
    const fd = new FormData(e.currentTarget);
    try {
      await api(`/v1/tenants/${tenantId}/products`, {
        method: "POST",
        body: JSON.stringify({
          sku: fd.get("sku"),
          name: fd.get("name"),
          priceCents: Math.round(Number(fd.get("price")) * 100),
          stockQty: Number(fd.get("stock")),
          currency: "ZAR",
        }),
      });
      e.currentTarget.reset();
      await load(tenantId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add product");
    }
  }

  return (
    <DashboardShell businessName={businessName}>
      <h1 style={{ marginTop: 0 }}>Catalog</h1>
      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h2>Add product</h2>
        <form className="form" onSubmit={onSubmit}>
          <label>
            SKU
            <input name="sku" required />
          </label>
          <label>
            Name
            <input name="name" required />
          </label>
          <label>
            Price (ZAR)
            <input name="price" type="number" step="0.01" min="0" required />
          </label>
          <label>
            Stock
            <input name="stock" type="number" min="0" defaultValue={10} required />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button className="btn btn-primary" type="submit">
            Add to catalog
          </button>
        </form>
      </div>
      <div className="panel">
        <h2>Products</h2>
        {products.length === 0 ? (
          <p className="muted">No products yet.</p>
        ) : (
          <ul>
            {products.map((p) => (
              <li key={p.id}>
                <strong>{p.name}</strong> · {p.sku} ·{" "}
                {((p.variants[0]?.priceCents ?? 0) / 100).toFixed(2)}{" "}
                {p.variants[0]?.currency ?? "ZAR"} · stock{" "}
                {p.variants[0]?.stockQty ?? 0}
              </li>
            ))}
          </ul>
        )}
      </div>
    </DashboardShell>
  );
}
