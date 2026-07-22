import Stripe from "stripe";
import { AppError, PLANS, type PlanKey } from "@autoquoteai/shared";

export type CheckoutInput = {
  tenantId: string;
  planKey: PlanKey;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  stripeCustomerId?: string;
};

export type BillingProvider = {
  createCheckoutSession(input: CheckoutInput): Promise<{ url: string }>;
  createPortalSession(input: {
    stripeCustomerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event;
};

export class StripeBillingProvider implements BillingProvider {
  private stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey);
  }

  private priceIdForPlan(planKey: PlanKey): string {
    const map: Record<PlanKey, string | undefined> = {
      starter: process.env.STRIPE_PRICE_STARTER,
      growth: process.env.STRIPE_PRICE_GROWTH,
      scale: process.env.STRIPE_PRICE_SCALE,
    };
    const price = map[planKey];
    if (!price) {
      throw new AppError(
        "billing_misconfigured",
        `Missing Stripe price for plan ${planKey}`,
        500,
      );
    }
    return price;
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string }> {
    if (!PLANS[input.planKey]) {
      throw new AppError("invalid_plan", "Unknown plan", 400);
    }
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.stripeCustomerId,
      customer_email: input.stripeCustomerId ? undefined : input.customerEmail,
      line_items: [{ price: this.priceIdForPlan(input.planKey), quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: {
        tenantId: input.tenantId,
        planKey: input.planKey,
      },
      subscription_data: {
        metadata: {
          tenantId: input.tenantId,
          planKey: input.planKey,
        },
      },
    });
    if (!session.url) {
      throw new AppError("billing_checkout_failed", "No checkout URL", 502);
    }
    return { url: session.url };
  }

  async createPortalSession(input: {
    stripeCustomerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.stripeCustomerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new AppError("billing_misconfigured", "Missing webhook secret", 500);
    }
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }
}

/** Local/dev provider — no Stripe network calls */
export class StubBillingProvider implements BillingProvider {
  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string }> {
    return {
      url: `${input.successUrl}?stub_checkout=1&tenantId=${input.tenantId}&plan=${input.planKey}`,
    };
  }

  async createPortalSession(input: {
    stripeCustomerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    return { url: `${input.returnUrl}?stub_portal=1&customer=${input.stripeCustomerId}` };
  }

  constructWebhookEvent(_rawBody: Buffer, _signature: string): Stripe.Event {
    throw new AppError("billing_stub", "Stub does not verify webhooks", 501);
  }
}

export function createBillingProvider(): BillingProvider {
  if (process.env.STRIPE_SECRET_KEY) {
    return new StripeBillingProvider(process.env.STRIPE_SECRET_KEY);
  }
  return new StubBillingProvider();
}

export { PLANS };
