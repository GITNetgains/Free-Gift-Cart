import { Link } from "react-router";

export type SectionLink = { id: string; label: string; href: string };

export default function SectionNavigation({ label, current, items }: { label: string; current: string; items: SectionLink[] }) {
  return <nav aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
    {items.map((item) => <Link key={item.id} to={item.href} aria-current={current === item.id ? "page" : undefined}
      style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #c9cccf", textDecoration: "none", fontWeight: 600,
        color: current === item.id ? "#fff" : "#303030", background: current === item.id ? "#303030" : "#fff" }}>
      {item.label}
    </Link>)}
  </nav>;
}
