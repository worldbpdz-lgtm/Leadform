import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

type LoaderData = {
  request: {
    id: string;
    status: string;
    roleType: string;
    createdAt: string;

    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;

    address: string | null;
    zip: string | null;
    country: string | null;

    wilayaCode: number | null;
    communeId: string | null;

    pageUrl: string | null;
    referrer: string | null;
    ip: string | null;
    userAgent: string | null;

    productId: string | null;
    variantId: string | null;
    qty: number | null;

    items: Array<{ id: string; productId: string; variantId: string | null; qty: number }>;
    attachments: Array<{
      id: string;
      label: string | null;
      requirementKey: string | null;
      upload: { url: string | null; bucket: string; path: string; mimeType: string | null; sizeBytes: number | null };
    }>;
  };

  product: {
    title: string | null;
    imageUrl: string | null;
  };
};

function statusLabel(s: string) {
  if (s === "received") return "Received";
  if (s === "in_review") return "In review";
  if (s === "contacted") return "Contacted";
  if (s === "confirmed") return "Confirmed";
  if (s === "cancelled") return "Cancelled";
  if (s === "spam") return "Spam";
  if (s === "archived") return "Archived";
  return s;
}

function statusBadgeClass(s: string) {
  if (s === "confirmed") return "lf-badge lf-badge--approved";
  if (s === "cancelled" || s === "spam") return "lf-badge lf-badge--rejected";
  if (s === "received" || s === "in_review" || s === "contacted") return "lf-badge lf-badge--pending";
  return "lf-badge";
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const id = String(params.id || "");

  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shopRow) throw new Response("Shop not found", { status: 404 });

  const req = await prisma.request.findFirst({
    where: { id, shopId: shopRow.id },
    include: {
      items: { select: { id: true, productId: true, variantId: true, qty: true } },
      attachments: {
        select: {
          id: true,
          label: true,
          requirementKey: true,
          upload: { select: { url: true, bucket: true, path: true, mimeType: true, sizeBytes: true } },
        },
      },
    },
  });

  if (!req) throw new Response("Request not found", { status: 404 });

  const shopifyProductId = req.productId || req.items[0]?.productId || null;

  let productTitle: string | null = null;
  let productImageUrl: string | null = null;

  if (shopifyProductId) {
    try {
      const resp = await admin.graphql(
        `#graphql
        query ProductCard($id: ID!) {
          product(id: $id) {
            title
            featuredImage { url }
            images(first: 1) { nodes { url } }
          }
        }`,
        { variables: { id: shopifyProductId } }
      );
      const json = await resp.json();
      const p = json?.data?.product;
      productTitle = p?.title ?? null;
      productImageUrl = p?.featuredImage?.url ?? p?.images?.nodes?.[0]?.url ?? null;
    } catch {}
  }

  const data: LoaderData = {
    request: {
      id: req.id,
      status: req.status,
      roleType: req.roleType,
      createdAt: req.createdAt.toISOString(),

      firstName: req.firstName,
      lastName: req.lastName,
      email: req.email,
      phone: req.phone,

      address: req.address,
      zip: req.zip,
      country: req.country,

      wilayaCode: req.wilayaCode,
      communeId: req.communeId,

      pageUrl: req.pageUrl,
      referrer: req.referrer,
      ip: req.ip,
      userAgent: req.userAgent,

      productId: req.productId,
      variantId: req.variantId,
      qty: req.qty,

      items: req.items,
      attachments: req.attachments,
    },
    product: { title: productTitle, imageUrl: productImageUrl },
  };

  return data;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = String(params.id || "");
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shopRow) return { ok: false };

  const where = { id, shopId: shopRow.id };

  if (intent === "setStatus") {
    const status = String(formData.get("status") || "");
    const allowed = new Set(["received", "in_review", "contacted", "confirmed", "cancelled", "spam", "archived"]);
    if (!allowed.has(status)) return { ok: false, error: "Invalid status" };

    await prisma.request.update({ where: where as any, data: { status: status as any } });
    return { ok: true };
  }

  if (intent === "saveEdits") {
    const firstName = (formData.get("firstName") as string | null) ?? null;
    const lastName = (formData.get("lastName") as string | null) ?? null;
    const email = (formData.get("email") as string | null) ?? null;
    const phone = (formData.get("phone") as string | null) ?? null;
    const address = (formData.get("address") as string | null) ?? null;
    const zip = (formData.get("zip") as string | null) ?? null;

    await prisma.request.update({
      where: where as any,
      data: {
        firstName: firstName?.trim() || null,
        lastName: lastName?.trim() || null,
        email: email?.trim() || null,
        phone: phone?.trim() || null,
        address: address?.trim() || null,
        zip: zip?.trim() || null,
      },
    });
    return { ok: true };
  }

  if (intent === "archive") {
    await prisma.request.update({ where: where as any, data: { status: "archived" } });
    return { ok: true };
  }

  if (intent === "restore") {
    await prisma.request.update({ where: where as any, data: { status: "received" } });
    return { ok: true };
  }

  if (intent === "deletePermanent") {
    await prisma.request.delete({ where: where as any });
    return { ok: true, deleted: true };
  }

  return { ok: false };
};

export default function RequestDetails() {
  const data = useLoaderData() as LoaderData;
  const r = data.request;
  const isArchived = r.status === "archived";

  const statusFetcher = useFetcher();
  const editFetcher = useFetcher();
  const archiveFetcher = useFetcher();

  const fullName = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || "Customer";

  return (
    <div className="lf-enter">
      {/* Header */}
      <div className="lf-detail-header">
        <div>
          <div className="lf-card-heading" style={{ margin: 0 }}>
            {fullName}
            <span className="lf-muted" style={{ marginLeft: 10, fontWeight: 600 }}>
              #{r.id.slice(0, 10)}…
            </span>
          </div>
          <div className="lf-muted lf-mt-1">
            Created {new Date(r.createdAt).toLocaleString()} • Role: {r.roleType}
          </div>
        </div>

        <div className="lf-btn-row">
          <span className={statusBadgeClass(r.status)} title={r.status}>
            <span className="lf-dot" />
            {statusLabel(r.status)}
          </span>

          <statusFetcher.Form method="post">
            <input type="hidden" name="intent" value="setStatus" />
            <input type="hidden" name="status" value="confirmed" />
            <button className="lf-pill lf-pill--success" type="submit">Confirm</button>
          </statusFetcher.Form>

          <statusFetcher.Form method="post">
            <input type="hidden" name="intent" value="setStatus" />
            <input type="hidden" name="status" value="cancelled" />
            <button className="lf-pill" type="submit" style={{ borderColor: "rgba(239,68,68,.30)" }}>
              Cancel
            </button>
          </statusFetcher.Form>

          {!isArchived ? (
            <archiveFetcher.Form method="post">
              <input type="hidden" name="intent" value="archive" />
              <button className="lf-pill" type="submit">Archive</button>
            </archiveFetcher.Form>
          ) : (
            <archiveFetcher.Form method="post">
              <input type="hidden" name="intent" value="restore" />
              <button className="lf-pill" type="submit">Restore</button>
            </archiveFetcher.Form>
          )}

          <Link to="/app/requests">
            <button type="button" className="lf-pill">Back</button>
          </Link>
        </div>
      </div>

      {/* Content grid */}
      <div className="lf-detail-grid lf-mt-4">
        {/* Left */}
        <div className="lf-card">
          <div className="lf-card-title">Customer details</div>

          <div className="lf-fields">
            <div className="lf-field">
              <div className="lf-field-label">First name</div>
              <div className="lf-field-value">{r.firstName ?? "—"}</div>
            </div>
            <div className="lf-field">
              <div className="lf-field-label">Last name</div>
              <div className="lf-field-value">{r.lastName ?? "—"}</div>
            </div>
            <div className="lf-field">
              <div className="lf-field-label">Email</div>
              <div className="lf-field-value">{r.email ?? "—"}</div>
            </div>
            <div className="lf-field">
              <div className="lf-field-label">Phone</div>
              <div className="lf-field-value">{r.phone ?? "—"}</div>
            </div>

            <div className="lf-field lf-field--full">
              <div className="lf-field-label">Address</div>
              <div className="lf-field-value">{r.address ?? "—"}</div>
            </div>

            <div className="lf-field">
              <div className="lf-field-label">Wilaya</div>
              <div className="lf-field-value">{r.wilayaCode ?? "—"}</div>
            </div>
            <div className="lf-field">
              <div className="lf-field-label">Commune</div>
              <div className="lf-field-value">{r.communeId ?? "—"}</div>
            </div>

            <div className="lf-field">
              <div className="lf-field-label">ZIP</div>
              <div className="lf-field-value">{r.zip ?? "—"}</div>
            </div>
            <div className="lf-field">
              <div className="lf-field-label">Country</div>
              <div className="lf-field-value">{r.country ?? "—"}</div>
            </div>
          </div>

          <div className="lf-card-title lf-mt-4">Edit</div>
          <editFetcher.Form method="post" className="lf-edit-form">
            <input type="hidden" name="intent" value="saveEdits" />
            <div className="lf-edit-grid">
              <input className="lf-input" name="firstName" defaultValue={r.firstName ?? ""} placeholder="First name" />
              <input className="lf-input" name="lastName" defaultValue={r.lastName ?? ""} placeholder="Last name" />
              <input className="lf-input" name="email" defaultValue={r.email ?? ""} placeholder="Email" />
              <input className="lf-input" name="phone" defaultValue={r.phone ?? ""} placeholder="Phone" />
              <input className="lf-input" name="address" defaultValue={r.address ?? ""} placeholder="Address" style={{ gridColumn: "1 / -1" }} />
              <input className="lf-input" name="zip" defaultValue={r.zip ?? ""} placeholder="ZIP" />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button className="lf-pill lf-pill--primary" type="submit">Save changes</button>
            </div>
          </editFetcher.Form>

          <div className="lf-card-title lf-mt-4">Danger zone</div>
          <div className="lf-muted">Archive is reversible. Permanent delete is not.</div>

          <div className="lf-btn-row lf-mt-2">
            <archiveFetcher.Form method="post">
              <input type="hidden" name="intent" value="archive" />
              <button className="lf-pill" type="submit">Archive</button>
            </archiveFetcher.Form>

            <Form
              method="post"
              onSubmit={(e) => {
                if (!confirm("Delete permanently? This cannot be undone.")) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="deletePermanent" />
              <button className="lf-pill" type="submit" style={{ borderColor: "rgba(239,68,68,.35)" }}>
                Delete permanently
              </button>
            </Form>
          </div>
        </div>

        {/* Right */}
        <div className="lf-card">
          <div className="lf-card-title">Product</div>

          <div className="lf-product-card">
            <div className="lf-product-thumb">
              {data.product.imageUrl ? (
                <img src={data.product.imageUrl} alt="" />
              ) : (
                <div className="lf-product-thumb--empty" />
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 720, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {data.product.title ?? "—"}
              </div>
              <div className="lf-muted lf-mt-1">
                Qty: {r.qty ?? r.items[0]?.qty ?? "—"}
              </div>
              <div className="lf-muted">
                Product ID: {r.productId ?? r.items[0]?.productId ?? "—"}
              </div>
            </div>
          </div>

          <div className="lf-card-title lf-mt-4">Items</div>
          <div className="lf-stack">
            {r.items.length ? (
              r.items.map((it) => (
                <div key={it.id} className="lf-mini-card">
                  <div><span className="lf-muted">Product</span> {it.productId}</div>
                  <div><span className="lf-muted">Variant</span> {it.variantId ?? "—"}</div>
                  <div><span className="lf-muted">Qty</span> {it.qty}</div>
                </div>
              ))
            ) : (
              <div className="lf-muted">No items recorded.</div>
            )}
          </div>

          <div className="lf-card-title lf-mt-4">Attachments</div>
          <div className="lf-stack">
            {r.attachments.length ? (
              r.attachments.map((a) => (
                <div key={a.id} className="lf-mini-card">
                  <div style={{ fontWeight: 700 }}>{a.label ?? a.requirementKey ?? "Attachment"}</div>
                  <div className="lf-muted lf-mt-1">
                    {a.upload.mimeType ?? "file"} {a.upload.sizeBytes ? `• ${a.upload.sizeBytes} bytes` : ""}
                  </div>
                  {a.upload.url ? (
                    <a className="lf-link" href={a.upload.url} target="_blank" rel="noreferrer">
                      Open file
                    </a>
                  ) : (
                    <div className="lf-muted">No public URL saved.</div>
                  )}
                </div>
              ))
            ) : (
              <div className="lf-muted">No attachments.</div>
            )}
          </div>

          <div className="lf-card-title lf-mt-4">Meta</div>
          <div className="lf-stack">
            <div className="lf-mini-card">
              <div className="lf-muted">Page URL</div>
              <div style={{ wordBreak: "break-word" }}>{r.pageUrl ?? "—"}</div>
            </div>
            <div className="lf-mini-card">
              <div className="lf-muted">Referrer</div>
              <div style={{ wordBreak: "break-word" }}>{r.referrer ?? "—"}</div>
            </div>
            <div className="lf-mini-card">
              <div className="lf-muted">IP</div>
              <div>{r.ip ?? "—"}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
