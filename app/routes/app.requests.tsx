import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { AdminPage } from "~/ui/AdminPage";

function labelForStatus(s: string) {
  switch (s) {
    case "received":
      return { text: "Received", cls: "lf-badge--pending" };
    case "in_review":
      return { text: "In review", cls: "lf-badge--pending" };
    case "contacted":
      return { text: "Contacted", cls: "lf-badge--success" };
    case "confirmed":
      return { text: "Confirmed", cls: "lf-badge--success" };
    case "cancelled":
      return { text: "Cancelled", cls: "lf-badge" };
    case "spam":
      return { text: "Spam", cls: "lf-badge" };
    case "archived":
      return { text: "Archived", cls: "lf-badge" };
    default:
      return { text: s, cls: "lf-badge" };
  }
}

function fmtDate(d: string | Date) {
  const dt = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("fr-DZ", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(dt);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Ensure Shop row exists (so Requests can be scoped correctly)
  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: { uninstalledAt: null },
    create: { shopDomain: session.shop, installedAt: new Date() },
    select: { id: true, shopDomain: true },
  });

  const requests = await prisma.request.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      wilaya: { select: { code: true, nameFr: true } },
      commune: { select: { id: true, nameFr: true } },
      _count: { select: { items: true, attachments: true } },
    },
  });

  return { shopDomain: shop.shopDomain, requests };
};

export default function Requests() {
  const { requests } = useLoaderData<typeof loader>();

  return (
    <AdminPage title="Requests">
      <div className="lf-grid">
        <div className="lf-col-12">
          <div className="lf-card">
            <div className="lf-card-heading">All requests</div>
            <div className="lf-muted lf-mt-2">
              Showing latest {requests.length} request(s).
            </div>

            <div className="lf-mt-4">
              <table className="lf-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Status</th>
                    <th>Role</th>
                    <th>Customer</th>
                    <th>Wilaya</th>
                    <th>Items</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>

                <tbody>
                  {requests.length === 0 ? (
                    <tr>
                      <td className="lf-muted" colSpan={8}>
                        No requests yet.
                      </td>
                    </tr>
                  ) : (
                    requests.map((r) => {
                      const customer =
                        [r.firstName, r.lastName].filter(Boolean).join(" ") ||
                        r.email ||
                        r.phone ||
                        "—";

                      const status = labelForStatus(r.status);

                      return (
                        <tr key={r.id} className="lf-row-hover">
                          <td className="lf-muted">{r.id.slice(0, 10)}…</td>
                          <td>
                            <span className={`lf-badge ${status.cls}`}>
                              <span className="lf-dot" />
                              {status.text}
                            </span>
                          </td>
                          <td className="lf-muted">{r.roleType}</td>
                          <td>{customer}</td>
                          <td className="lf-muted">
                            {r.wilaya
                              ? `${r.wilaya.code} - ${r.wilaya.nameFr}`
                              : r.wilayaCode ?? "—"}
                          </td>
                          <td className="lf-muted">{r._count.items}</td>
                          <td className="lf-muted">{fmtDate(r.createdAt)}</td>
                          <td style={{ textAlign: "right" }}>
                            <Link to={`/app/requests/${r.id}`}>Open</Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="lf-mt-4 lf-muted">
              Next: filters (status, roleType) + pagination.
            </div>
          </div>
        </div>
      </div>
    </AdminPage>
  );
}
