import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import { AdminPage } from "~/ui/AdminPage";

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

  // Fetch product image from Shopify (best effort).
  // Uses Request.productId if present, else falls back to first item productId.
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
            featuredImage {
              url
              altText
            }
            images(first: 1) {
              nodes {
                url
                altText
              }
            }
          }
        }`,
        { variables: { id: shopifyProductId } }
      );
      const json = await resp.json();
      const p = json?.data?.product;
      productTitle = p?.title ?? null;
      productImageUrl =
        p?.featuredImage?.url ??
        p?.images?.nodes?.[0]?.url ??
        null;
    } catch {
      // ignore
    }
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
    // Validate against your enum values
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
    // Restore to received by default (you can change this)
    await prisma.request.update({ where: where as any, data: { status: "received" } });
    return { ok: true };
  }

  if (intent === "deletePermanent") {
    // Permanent delete (use carefully). This will cascade RequestItem/RequestAttachment by schema.
    await prisma.request.delete({ where: where as any });
    return { ok: true, deleted: true };
  }

  return { ok: false };
};

export default function RequestDetails() {
  const data = useLoaderData() as LoaderData;
  const r = data.request;

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

  const isArchived = r.status === "archived";

  const statusFetcher = useFetcher();
  const editFetcher = useFetcher();
  const archiveFetcher = useFetcher();

  return (
    <AdminPage
      title="Request details"
      primaryAction={
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <statusFetcher.Form method="post">
            <input type="hidden" name="intent" value="setStatus" />
            <input type="hidden" name="status" value="confirmed" />
            <button className="lf-btn" type="submit" style={{ borderColor: "rgba(16,185,129,.5)" }}>
              Confirm
            </button>
          </statusFetcher.Form>

          <statusFetcher.Form method="post">
            <input type="hidden" name="intent" value="setStatus" />
            <input type="hidden" name="status" value="cancelled" />
            <button className="lf-btn" type="submit" style={{ borderColor: "rgba(239,68,68,.5)" }}>
              Cancel
            </button>
          </statusFetcher.Form>

          {!isArchived ? (
            <archiveFetcher.Form method="post">
              <input type="hidden" name="intent" value="archive" />
              <button className="lf-btn lf-btn-secondary" type="submit">
                Archive
              </button>
            </archiveFetcher.Form>
          ) : (
            <archiveFetcher.Form method="post">
              <input type="hidden" name="intent" value="restore" />
              <button className="lf-btn lf-btn-secondary" type="submit">
                Restore
              </button>
            </archiveFetcher.Form>
          )}
        </div>
      }
    >
      <div className="lf-card">
        <div className="lf-card-heading" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 650 }}>Request #{r.id}</div>
            <div className="lf-muted">Created: {new Date(r.createdAt).toLocaleString()}</div>
          </div>
          <div className="lf-badge">{statusLabel(r.status)}</div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 16, marginTop: 14 }}>
          {/* Left: details + edit */}
          <div className="lf-card" style={{ margin: 0 }}>
            <div className="lf-card-title">Customer</div>

            <div className="lf-grid" style={{ marginTop: 12 }}>
              <div className="lf-col-6"><div className="lf-muted">First name</div><div>{r.firstName ?? "—"}</div></div>
              <div className="lf-col-6"><div className="lf-muted">Last name</div><div>{r.lastName ?? "—"}</div></div>
              <div className="lf-col-6"><div className="lf-muted">Email</div><div>{r.email ?? "—"}</div></div>
              <div className="lf-col-6"><div className="lf-muted">Phone</div><div>{r.phone ?? "—"}</div></div>

              <div className="lf-col-12"><div className="lf-muted">Address</div><div>{r.address ?? "—"}</div></div>
              <div className="lf-col-6"><div className="lf-muted">ZIP</div><div>{r.zip ?? "—"}</div></div>
              <div className="lf-col-6"><div className="lf-muted">Country</div><div>{r.country ?? "—"}</div></div>

              <div className="lf-col-6"><div className="lf-muted">Wilaya</div><div>{r.wilayaCode ?? "—"}</div></div>
              <div className="lf-col-6"><div className="lf-muted">Commune</div><div title={r.communeId ?? ""}>{r.communeId ?? "—"}</div></div>
            </div>

            <div className="lf-card-title" style={{ marginTop: 16 }}>Edit</div>
            <editFetcher.Form method="post" style={{ display: "grid", gap: 10, marginTop: 10 }}>
              <input type="hidden" name="intent" value="saveEdits" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <input className="lf-input" name="firstName" defaultValue={r.firstName ?? ""} placeholder="First name" />
                <input className="lf-input" name="lastName" defaultValue={r.lastName ?? ""} placeholder="Last name" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <input className="lf-input" name="email" defaultValue={r.email ?? ""} placeholder="Email" />
                <input className="lf-input" name="phone" defaultValue={r.phone ?? ""} placeholder="Phone" />
              </div>
              <input className="lf-input" name="address" defaultValue={r.address ?? ""} placeholder="Address" />
              <input className="lf-input" name="zip" defaultValue={r.zip ?? ""} placeholder="ZIP" />
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="lf-btn" type="submit">Save changes</button>
              </div>
            </editFetcher.Form>

            <div className="lf-card-title" style={{ marginTop: 16 }}>Danger zone</div>
            <div className="lf-muted" style={{ marginTop: 8 }}>
              Archive is reversible. Permanent delete is not.
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              <archiveFetcher.Form method="post">
                <input type="hidden" name="intent" value="archive" />
                <button className="lf-btn lf-btn-secondary" type="submit">
                  Archive
                </button>
              </archiveFetcher.Form>

              <Form
                method="post"
                onSubmit={(e) => {
                  if (!confirm("Delete permanently? This cannot be undone.")) e.preventDefault();
                }}
              >
                <input type="hidden" name="intent" value="deletePermanent" />
                <button className="lf-btn" type="submit" style={{ borderColor: "rgba(239,68,68,.6)" }}>
                  Delete permanently
                </button>
              </Form>

              <Link to="/app/requests">
                <button type="button" className="lf-btn lf-btn-secondary">Back</button>
              </Link>
            </div>
          </div>

          {/* Right: product + meta */}
          <div className="lf-card" style={{ margin: 0 }}>
            <div className="lf-card-title">Product</div>

            <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
              <div style={{ width: 88, height: 88, borderRadius: 12, overflow: "hidden", background: "#f4f4f5", flex: "0 0 auto" }}>
                {data.product.imageUrl ? (
                  <img src={data.product.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : null}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>{data.product.title ?? "—"}</div>
                <div className="lf-muted" style={{ marginTop: 4 }}>
                  Role: {r.roleType}
                </div>
                <div className="lf-muted" style={{ marginTop: 4 }}>
                  Qty: {r.qty ?? (r.items[0]?.qty ?? "—")}
                </div>
              </div>
            </div>

            <div className="lf-card-title" style={{ marginTop: 16 }}>Items</div>
            <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
              {r.items.length ? r.items.map((it) => (
                <div key={it.id} className="lf-muted" style={{ border: "1px solid rgba(0,0,0,.06)", borderRadius: 12, padding: 10 }}>
                  <div>Product ID: {it.productId}</div>
                  <div>Variant ID: {it.variantId ?? "—"}</div>
                  <div>Qty: {it.qty}</div>
                </div>
              )) : <div className="lf-muted">No items recorded.</div>}
            </div>

            <div className="lf-card-title" style={{ marginTop: 16 }}>Attachments</div>
            <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
              {r.attachments.length ? r.attachments.map((a) => (
                <div key={a.id} style={{ border: "1px solid rgba(0,0,0,.06)", borderRadius: 12, padding: 10 }}>
                  <div style={{ fontWeight: 650 }}>{a.label ?? a.requirementKey ?? "Attachment"}</div>
                  <div className="lf-muted" style={{ marginTop: 4 }}>
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
              )) : <div className="lf-muted">No attachments.</div>}
            </div>

            <div className="lf-card-title" style={{ marginTop: 16 }}>Meta</div>
            <div className="lf-muted" style={{ marginTop: 8, display: "grid", gap: 6 }}>
              <div>Page URL: {r.pageUrl ?? "—"}</div>
              <div>Referrer: {r.referrer ?? "—"}</div>
              <div>IP: {r.ip ?? "—"}</div>
              <div>User agent: {r.userAgent ?? "—"}</div>
            </div>
          </div>
        </div>
      </div>
    </AdminPage>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
