import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { AdminPage } from "~/ui/AdminPage";

const STATUS_OPTIONS = [
  "received",
  "in_review",
  "contacted",
  "confirmed",
  "cancelled",
  "spam",
  "archived",
] as const;

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

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id || "";

  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: { uninstalledAt: null },
    create: { shopDomain: session.shop, installedAt: new Date() },
    select: { id: true },
  });

  const req = await prisma.request.findFirst({
    where: { id, shopId: shop.id },
    include: {
      wilaya: { select: { code: true, nameFr: true } },
      commune: { select: { id: true, nameFr: true } },
      items: { orderBy: { createdAt: "asc" } },
      attachments: {
        orderBy: { createdAt: "asc" },
        include: { upload: true },
      },
    },
  });

  if (!req) {
    throw new Response("Not found", { status: 404 });
  }

  return { request: req };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id || "";
  const form = await request.formData();

  const nextStatus = String(form.get("status") || "");
  if (!STATUS_OPTIONS.includes(nextStatus as any)) {
    return { ok: false, error: "Invalid status." };
  }

  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    update: { uninstalledAt: null },
    create: { shopDomain: session.shop, installedAt: new Date() },
    select: { id: true },
  });

  await prisma.request.updateMany({
    where: { id, shopId: shop.id },
    data: { status: nextStatus as any },
  });

  return { ok: true };
};

export default function RequestDetail() {
  const { request } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const customer =
    [request.firstName, request.lastName].filter(Boolean).join(" ") ||
    request.email ||
    request.phone ||
    "—";

  return (
    <AdminPage
      title={`Request ${request.id.slice(0, 10)}…`}
      primaryAction={<s-button href="/app/requests">Back to Requests</s-button>}
    >
      <div className="lf-grid">
        <div className="lf-col-8">
          <div className="lf-card">
            <div className="lf-card-heading">Request details</div>

            {actionData?.ok ? (
              <div className="lf-muted lf-mt-2">Status updated.</div>
            ) : actionData?.error ? (
              <div className="lf-muted lf-mt-2">{actionData.error}</div>
            ) : null}

            <div className="lf-mt-4">
              <div className="lf-card-title">Status</div>
              <div className="lf-muted lf-mt-2">{request.status}</div>
            </div>

            <div className="lf-mt-4">
              <div className="lf-card-title">Customer</div>
              <div>{customer}</div>
              <div className="lf-muted lf-mt-2">
                Role: {request.roleType} • Created: {fmtDate(request.createdAt)}
              </div>
            </div>

            <div className="lf-mt-4">
              <div className="lf-card-title">Location</div>
              <div className="lf-muted lf-mt-2">
                {request.wilaya
                  ? `${request.wilaya.code} - ${request.wilaya.nameFr}`
                  : request.wilayaCode ?? "—"}
                {request.commune ? ` • ${request.commune.nameFr}` : ""}
              </div>
            </div>

            <div className="lf-mt-4">
              <div className="lf-card-title">Items</div>
              {request.items.length === 0 ? (
                <div className="lf-muted lf-mt-2">No items.</div>
              ) : (
                <div className="lf-mt-2" style={{ overflowX: "auto" }}>
                  <table className="lf-table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Variant</th>
                        <th>Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {request.items.map((it) => (
                        <tr key={it.id}>
                          <td className="lf-muted">{it.productId}</td>
                          <td className="lf-muted">{it.variantId ?? "—"}</td>
                          <td>{it.qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="lf-mt-4">
              <div className="lf-card-title">Meta</div>
              <div className="lf-muted lf-mt-2">
                IP: {request.ip ?? "—"} • Referrer: {request.referrer ?? "—"}
              </div>
              <div className="lf-muted lf-mt-2">
                Page: {request.pageUrl ?? "—"}
              </div>
            </div>
          </div>
        </div>

        <div className="lf-col-4">
          <div className="lf-card">
            <div className="lf-card-heading">Actions</div>

            <Form method="post" className="lf-mt-4">
              <label className="lf-card-title" htmlFor="status">
                Change status
              </label>

              <div className="lf-mt-2">
                <select
                  id="status"
                  name="status"
                  defaultValue={request.status}
                  className="lf-input"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div className="lf-mt-3">
                <button className="lf-pill lf-pill--success" type="submit">
                  Save
                </button>
              </div>
            </Form>

            <div className="lf-mt-4 lf-muted">
              <Link to="/app/requests">← Back</Link>
            </div>
          </div>
        </div>
      </div>
    </AdminPage>
  );
}
