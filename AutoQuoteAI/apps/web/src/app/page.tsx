import Link from "next/link";

export default function HomePage() {
  return (
    <main className="hero">
      <p className="muted" style={{ letterSpacing: "0.08em", textTransform: "uppercase", fontSize: "0.75rem" }}>
        AutoQuoteAI
      </p>
      <h1>
        The sales agent OS
        <br />
        for WhatsApp commerce
      </h1>
      <p>
        Quote-first AI agents that identify products, check stock and price from
        your catalog, and send formal quotes — starting with automotive parts,
        built as plugins for every product industry.
      </p>
      <div className="cta-row">
        <Link className="btn btn-primary" href="/signup">
          Start free trial
        </Link>
        <Link className="btn btn-ghost" href="/login">
          Sign in
        </Link>
        <Link className="btn btn-ghost" href="/dashboard">
          Dashboard
        </Link>
      </div>
    </main>
  );
}
