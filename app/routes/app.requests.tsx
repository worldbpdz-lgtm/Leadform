import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import { AdminPage } from "~/ui/AdminPage";

type LoaderData = {
  q: string;
  status: string;
  range: string;
  page: number;
  pageSize: number;
  total: number;
  rows: Array<{
    id: string;
    status: string;
    roleType: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    wilayaCode: number | null;
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
  const end = now;
  if (range === "7d") {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    return { start, end };
  }
  if (range === "30d") {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    return { start, end };
  }
  if (range === "today") {
    const start = startOfDay(now);
    const end2 = new Date(start);
    end2.setDate(end2.getDate() + 1);
    return { start, end: end2 };
  }
  // "all"
  return { start: null as Date | null, end: null as Date | null };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = (url.searchParams.get("status") || "all").trim();
  const range = (url.searchParams.get("range") || "30d").trim();
  const page = parseIntSafe(url.searchParams.get("page"), 1);
  const pageSize = 20;
  const skip = (page - 1) * pageSize;

  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!shopRow) {
    const data: LoaderData = {
      q, status, range, page, pageSize, total: 0, rows: [],
    };
    return data;
  }

  const { start, end } = computeDateRange(range);

  const where: any = {
    shopId: shopRow.id,
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
        wilayaCode: true,
        createdAt: true,
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
      status: r.status,
      roleType: r.roleType,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      wilayaCode: r.wilayaCode,
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

  if (intent === "bulkArchive") {
    const ids = formData.getAll("selected").map(String).filter(Boolean);
    if (ids.length === 0) return { ok: true, archived: 0 };

    const res = await prisma.request.updateMany({
      where: { shopId: shopRow.id, id: { in: ids } },
      data: { status: "archived" },
    });
    return { ok: true, archived: res.count };
  }

  return { ok: false };
};

export default function Requests() {
  const data = useLoaderData() as LoaderData;
  const nav = useNavigation();
  const [params] = useSearchParams();

  const isLoading = nav.state !== "idle";

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const canPrev = data.page > 1;
  const canNext = data.page < totalPages;

  const baseParams = new URLSearchParams(params);
  const pageLink = (p: number) => {
    const next = new URLSearchParams(baseParams);
    next.set("page", String(p));
    return `?${next.toString()}`;
  };

  const statusLabel = (s: string) => {
    if (s === "received") return "Received";
    if (s === "in_review") return "In review";
    if (s === "contacted") return "Contacted";
    if (s === "confirmed") return "Confirmed";
    if (s === "cancelled") return "Cancelled";
    if (s === "spam") return "Spam";
    if (s === "archived") return "Archived";
    return s;
  };

  const customerLabel = (r: LoaderData["rows"][number]) => {
    const n = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
    return n || r.email || r.phone || "—";
  };

  return (
    <AdminPage title="Requests">
      <div className="lf-card">
        <div className="lf-card-heading" style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 650 }}>All requests</div>
            <div className="lf-muted">Showing {Math.min(data.total, data.pageSize)} of {data.total} request(s).</div>
          </div>
          <div className="lf-muted">{isLoading ? "Loading…" : ""}</div>
        </div>

        {/* Filters */}
        <Form method="get" style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          <input
            name="q"
            defaultValue={data.q}
            placeholder="Search customer, email, phone, ID…"
            className="lf-input"
            style={{ minWidth: 280 }}
          />

          <select name="status" defaultValue={data.status} className="lf-input">
            <option value="all">All statuses</option>
            <option value="received">Received</option>
            <option value="in_review">In review</option>
            <option value="contacted">Contacted</option>
            <option value="confirmed">Confirmed</option>
            <option value="cancelled">Cancelled</option>
            <option value="spam">Spam</option>
            <option value="archived">Archived</option>
          </select>

          <select name="range" defaultValue={data.range} className="lf-input">
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>

          <input type="hidden" name="page" value="1" />
          <button className="lf-btn">Apply</button>
        </Form>

        {/* Bulk actions + table */}
        <Form method="post" style={{ marginTop: 14 }}>
          <input type="hidden" name="intent" value="bulkArchive" />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
            <div className="lf-muted">Select requests then Archive (can be restored later).</div>
            <button className="lf-btn" type="submit">
              Archive selected
            </button>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="lf-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ width: 36 }}></th>
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
                  <tr key={r.id}>
                    <td>
                      <input type="checkbox" name="selected" value={r.id} />
                    </td>
                    <td title={r.id}>{r.id.slice(0, 10)}…</td>
                    <td>
                      <span className="lf-badge">{statusLabel(r.status)}</span>
                    </td>
                    <td>{r.roleType}</td>
                    <td>{customerLabel(r)}</td>
                    <td>{r.wilayaCode ?? "—"}</td>
                    <td>{r.itemsCount}</td>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td style={{ textAlign: "right" }}>
                      <Link to={`/app/requests/${r.id}`}>
                        <button type="button" className="lf-btn lf-btn-secondary">
                          Open
                        </button>
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

          {/* Pagination */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
            <Link to={pageLink(canPrev ? data.page - 1 : data.page)} aria-disabled={!canPrev}>
              <button type="button" className="lf-btn lf-btn-secondary" disabled={!canPrev}>
                Prev
              </button>
            </Link>
            <div className="lf-muted" style={{ alignSelf: "center" }}>
              Page {data.page} / {totalPages}
            </div>
            <Link to={pageLink(canNext ? data.page + 1 : data.page)} aria-disabled={!canNext}>
              <button type="button" className="lf-btn lf-btn-secondary" disabled={!canNext}>
                Next
              </button>
            </Link>
          </div>
        </Form>
      </div>
    </AdminPage>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
