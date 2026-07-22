export default function BillingSuccessPage() {
  return (
    <main className="hero">
      <h1 style={{ fontSize: "2rem" }}>Billing updated</h1>
      <p className="muted">
        If you used the Stripe stub, this confirms the checkout redirect path works.
        Connect real Stripe keys in `.env` for production charges.
      </p>
      <a className="btn btn-primary" href="/dashboard/billing">
        Back to billing
      </a>
    </main>
  );
}
