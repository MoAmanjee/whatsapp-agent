"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/catalog", label: "Catalog" },
  { href: "/dashboard/inbox", label: "Inbox" },
  { href: "/dashboard/quotes", label: "Quotes" },
  { href: "/dashboard/whatsapp", label: "WhatsApp" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/billing", label: "Billing" },
];

export function DashboardShell({
  children,
  businessName,
}: {
  children: React.ReactNode;
  businessName?: string;
}) {
  const pathname = usePathname();
  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand">
          AutoQuote<span>AI</span>
        </div>
        {businessName ? <p className="muted" style={{ margin: 0 }}>{businessName}</p> : null}
        <nav>
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={pathname === l.href ? "active" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="main">{children}</div>
    </div>
  );
}
