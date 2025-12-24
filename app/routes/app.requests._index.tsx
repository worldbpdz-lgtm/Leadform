// app/routes/app.requests._index.tsx
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useSearchParams, useSubmit, useNavigation } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

type LoaderData = {
  q: string;
  status: "all" | "received" | "confirmed" | "cancelled";
  range: string;
  page: number;
  pageSize: number;
  total: number;
  rows: Array<{
    id: string;
    status: "received" | "confirmed" | "cancelled";
    roleType: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    wilaya: { code: number; nameFr: string; nameAr: string } | null;
    itemsCount: number;
    createdAt: string;
  }>;
};

function parseIntSafe(v: string | null, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function computeDateRange(range: string) {
  const now = new Date();
  if (range === "today") {
    const start = startOfDay(now);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }
  if (range === "7d") {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    return { start, end: now };
  }
  if (range === "30d") {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    return { start, end: now };
  }
  return { start: null as Date | null, end: null as Date | null };
}

function statusLabel(s: string) {
  if (s === "received") return "New";
  if (s === "confirmed") return "Confirmed";
  if (s === "cancelled") return "Cancelled";
  return s;
}

function statusBadgeClass(s: string) {
  if (s === "confirmed") return "lf-badge lf-badge--approved";
  if (s === "cancelled") return "lf-badge lf-badge--rejected";
  return "lf-badge lf-badge--pending";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const rawStatus = (url.searchParams.get("status") || "all").trim();
  const status: LoaderData["status"] =
    rawStatus === "received" || rawStatus === "confirmed" || rawStatus === "cancelled" ? rawStatus : "all";

  const range = (url.searchParams.get("range") || "30d").trim();
  const page = parseIntSafe(url.searchParams.get("page"), 1);

  const pageSize = 20;
  const skip = (page - 1) * pageSize;

  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!shopRow) {
    const data: LoaderData = { q, status, range, page, pageSize, total: 0, rows: [] };
    return data;
  }

  const { start, end } = computeDateRange(range);

  // IMPORTANT: never show basket items in Requests list
  const where: any = {
    shopId: shopRow.id,
    status: { not: "archived" },
    ...(status !== "all" ? { status } : {}),
    ...(start && end ? { createdAt: { gte: start, lt: end } } : {}),
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
            { id: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.request.count({ where }),
    prisma.request.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
      select: {
        id: true,
        status: true,
        roleType: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        createdAt: true,
        wilaya: { select: { code: true, nameFr: true, nameAr: true } },
        _count: { select: { items: true } },
      },
    }),
  ]);

  const data: LoaderData = {
    q,
    status,
    range,
    page,
    pageSize,
    total,
    rows: items.map((r) => ({
      id: r.id,
      status: (r.status as any) as LoaderData["rows"][number]["status"],
      roleType: String(r.roleType),
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      wilaya: r.wilaya ? { ...r.wilaya } : null,
      itemsCount: r._count.items,
      createdAt: r.createdAt.toISOString(),
    })),
  };

  return data;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shopRow) return { ok: false };

  if (intent === "bulkToBasket") {
    const ids = formData.getAll("selected").map(String).filter(Boolean);
    if (!ids.length) return { ok: true, moved: 0 };

    const res = await prisma.request.updateMany({
      where: { shopId: shopRow.id, id: { in: ids } },
      data: { status: "archived" as any },
    });
    return { ok: true, moved: res.count };
  }

  return { ok: false };
};

export default function RequestsIndex() {
  const data = useLoaderData() as LoaderData;
  const [params] = useSearchParams();
  const submit = useSubmit();
  const nav = useNavigation();

  const [selected, setSelected] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const isLoading = nav.state !== "idle";

  const formRef = useRef<HTMLFormElement | null>(null);
  const debounceRef = useRef<number | null>(null);

  const onFilterChange = () => {
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    fd.set("page", "1");
    submit(fd, { method: "get" });
  };

  const onSearchInput = () => {
    if (!formRef.current) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const fd = new FormData(formRef.current!);
      fd.set("page", "1");
      submit(fd, { method: "get" });
    }, 260);
  };

  const pageLink = (p: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(p));
    return `?${next.toString()}`;
  };

  const customerLabel = (r: LoaderData["rows"][number]) => {
    const n = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
    return n || r.email || r.phone || "—";
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAllVisible = () => {
    const visibleIds = data.rows.map((r) => r.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
    if (allSelected) {
      setSelected((prev) => prev.filter((id) => !visibleIds.includes(id)));
    } else {
      setSelected((prev) => Array.from(new Set([...prev, ...visibleIds])));
    }
  };

  useEffect(() => {
    setSelected([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.q, data.status, data.range, data.page]);

  return (
    <div className="lf-card lf-enter">
      <div
        className="lf-card-heading"
        style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
      >
        <div>
          <div style={{ fontWeight: 800 }}>All requests</div>
          <div className="lf-muted">Showing {data.rows.length} of {data.total} request(s).</div>
        </div>
        <div className="lf-muted">{isLoading ? "Updating…" : `Page ${data.page} / ${totalPages}`}</div>
      </div>

      <Form method="get" ref={formRef} className="lf-toolbar" style={{ marginTop: 12 }}>
        <input type="hidden" name="page" value={String(data.page)} />

        <div className="lf-search">
          <span className="lf-search-icon">⌕</span>
          <input
            className="lf-input lf-input--search"
            name="q"
            defaultValue={data.q}
            placeholder="Search customer, email, phone, ID…"
            onInput={onSearchInput}
          />
        </div>

        <div className="lf-selects">
          <select className="lf-input lf-input--select" name="status" defaultValue={data.status} onChange={onFilterChange}>
            <option value="all">All statuses</option>
            <option value="received">New</option>
            <option value="confirmed">Confirmed</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <select className="lf-input lf-input--select" name="range" defaultValue={data.range} onChange={onFilterChange}>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </div>
      </Form>

      {selected.length > 0 ? (
        <Form method="post" className="lf-bulkbar" style={{ marginTop: 12 }}>
          <input type="hidden" name="intent" value="bulkToBasket" />
          {selected.map((id) => (
            <input key={id} type="hidden" name="selected" value={id} />
          ))}
          <div className="lf-muted">{selected.length} selected</div>
          <div className="lf-btn-row">
            <button className="lf-pill lf-pill--danger" type="submit">
              Delete
            </button>
            <button className="lf-pill" type="button" onClick={() => setSelected([])}>
              Clear
            </button>
          </div>
        </Form>
      ) : null}

      <div style={{ overflowX: "auto", marginTop: 12 }}>
        <table className="lf-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: 44 }}>
                <input
                  type="checkbox"
                  onChange={toggleAllVisible}
                  checked={data.rows.length > 0 && data.rows.every((r) => selectedSet.has(r.id))}
                />
              </th>
              <th>ID</th>
              <th>Status</th>
              <th>Role</th>
              <th>Customer</th>
              <th>Wilaya</th>
              <th>Items</th>
              <th>Created</th>
              <th style={{ textAlign: "right" }}>Open</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id} className="lf-row-hover">
                <td>
                  <input type="checkbox" checked={selectedSet.has(r.id)} onChange={() => toggleOne(r.id)} />
                </td>
                <td title={r.id}>{r.id.slice(0, 10)}…</td>
                <td>
                  <span className={statusBadgeClass(r.status)}>
                    <span className="lf-dot" />
                    {statusLabel(r.status)}
                  </span>
                </td>
                <td>{r.roleType}</td>
                <td>{customerLabel(r)}</td>
                <td>{r.wilaya ? `${r.wilaya.code} — ${r.wilaya.nameFr}` : "—"}</td>
                <td>{r.itemsCount}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td style={{ textAlign: "right" }}>
                  <Link to={`/app/requests/${r.id}`} className="lf-pill lf-pill--primary" style={{ textDecoration: "none" }}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="lf-muted" style={{ padding: 14 }}>
                  No requests match your filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
        <Link to={pageLink(Math.max(1, data.page - 1))} className="lf-pill" style={{ textDecoration: "none" }}>
          <span aria-hidden="true">←</span>&nbsp;Prev
        </Link>
        <div className="lf-muted" style={{ alignSelf: "center" }}>
          Page {data.page} / {totalPages}
        </div>
        <Link to={pageLink(Math.min(totalPages, data.page + 1))} className="lf-pill" style={{ textDecoration: "none" }}>
          Next&nbsp;<span aria-hidden="true">→</span>
        </Link>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
