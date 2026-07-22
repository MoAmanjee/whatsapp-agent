"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    try {
      await api("/v1/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          email: fd.get("email"),
          password: fd.get("password"),
          name: fd.get("name"),
          businessName: fd.get("businessName"),
          industryKey: "automotive",
        }),
      });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="hero">
      <h1 style={{ fontSize: "2rem" }}>Create your workspace</h1>
      <p className="muted">Automotive module enabled by default. More industries plug in later.</p>
      <form className="form panel" onSubmit={onSubmit} style={{ marginTop: "1.5rem" }}>
        <label>
          Your name
          <input name="name" required />
        </label>
        <label>
          Business name
          <input name="businessName" required />
        </label>
        <label>
          Work email
          <input name="email" type="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" minLength={8} required />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create account"}
        </button>
        <p className="muted">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
