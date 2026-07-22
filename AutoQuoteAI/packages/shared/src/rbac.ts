export const PLANS = {
  starter: {
    key: "starter",
    name: "Starter",
    seats: 1,
    whatsappNumbers: 1,
    conversationsPerMonth: 500,
    features: ["quotes", "catalog", "ai_agent"],
  },
  growth: {
    key: "growth",
    name: "Growth",
    seats: 5,
    whatsappNumbers: 1,
    conversationsPerMonth: 3000,
    features: ["quotes", "catalog", "ai_agent", "approvals", "csv_import"],
  },
  scale: {
    key: "scale",
    name: "Scale",
    seats: 25,
    whatsappNumbers: 5,
    conversationsPerMonth: 20000,
    features: [
      "quotes",
      "catalog",
      "ai_agent",
      "approvals",
      "csv_import",
      "api_access",
    ],
  },
} as const;

export type PlanKey = keyof typeof PLANS;

export const MEMBERSHIP_PERMISSIONS = {
  OWNER: [
    "billing:manage",
    "tenant:delete",
    "users:manage",
    "whatsapp:connect",
    "catalog:write",
    "catalog:read",
    "quotes:approve",
    "quotes:read",
    "quotes:write",
    "inbox:takeover",
    "ai:configure",
    "tenant:read",
  ],
  ADMIN: [
    "users:manage",
    "whatsapp:connect",
    "catalog:write",
    "catalog:read",
    "quotes:approve",
    "quotes:read",
    "quotes:write",
    "inbox:takeover",
    "ai:configure",
    "tenant:read",
  ],
  SALES: [
    "catalog:read",
    "quotes:read",
    "quotes:write",
    "inbox:takeover",
    "tenant:read",
  ],
  VIEWER: ["catalog:read", "quotes:read", "tenant:read"],
} as const;

export type Permission =
  (typeof MEMBERSHIP_PERMISSIONS)[keyof typeof MEMBERSHIP_PERMISSIONS][number];
