// app/routes/app.requests.$id.tsx
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import { createSignedUrl } from "~/lib/uploads.server";

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

    wilayaCode: number | null;
    communeId: string | null;

    // display names
    wilayaName: string | null;
    communeName: string | null;

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
      upload: {
        url: string | null; // signed
        bucket: string;
        path: string;
        mimeType: string | null;
        sizeBytes: number | null;
      };
    }>;
  };

  product: {
    title: string | null;
    imageUrl: string | null;
    storefrontUrl: string | null; // customer-facing URL
  };
};

function statusLabel(s: string) {
  if (s === "confirmed") return "Confirmed";
  if (s === "cancelled") return "Canceled";
  if (s === "archived") return "Basket";
  return s === "received" ? "Received" : s;
}

function statusBadgeClass(s: string) {
  if (s === "confirmed") return "lf-badge lf-badge--approved";
  if (s === "cancelled") return "lf-badge lf-badge--rejected";
  if (s === "received") return "lf-badge lf-badge--pending";
  return "lf-badge";
}

// Your DB sometimes stores numeric IDs, but Shopify GraphQL needs GIDs.
function asShopifyGid(kind: "Product" | "ProductVariant", idOrGid: string | null) {
  if (!idOrGid) return null;
  const raw = String(idOrGid).trim();
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/${kind}/${raw}`;
  return null;
}

function formatBytes(bytes: number | null) {
  if (!bytes || bytes <= 0) return null;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
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
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          label: true,
          requirementKey: true,
          upload: {
            select: { url: true, bucket: true, path: true, mimeType: true, sizeBytes: true },
          },
        },
      },
    },
  });

  if (!req) throw new Response("Request not found", { status: 404 });

  // Geo names (robust: no relation assumptions)
  const [wilayaRow, communeRow] = await Promise.all([
    req.wilayaCode
      ? prisma.geoWilaya.findUnique({
          where: { code: req.wilayaCode },
          select: { nameFr: true, nameAr: true },
        })
      : Promise.resolve(null),
    req.communeId
      ? prisma.geoCommune.findUnique({
          where: { id: req.communeId },
          select: { nameFr: true, nameAr: true },
        })
      : Promise.resolve(null),
  ]);

  const wilayaName = wilayaRow?.nameFr ?? wilayaRow?.nameAr ?? null;
  const communeName = communeRow?.nameFr ?? communeRow?.nameAr ?? null;

  // Signed URLs for attachments (always prefer signed for Supabase private buckets)
  const attachmentsWithSigned: LoaderData["request"]["attachments"] = await Promise.all(
    req.attachments.map(async (a) => {
      // If url is already saved and you rely on it, keep fallback to it
      let signedUrl: string | null = null;
      try {
        signedUrl = await createSignedUrl({
          bucket: a.upload.bucket,
          path: a.upload.path,
          expiresInSeconds: 60 * 60,
        });
      } catch {
        signedUrl = a.upload.url ?? null;
      }

      return {
        id: a.id,
        label: a.label,
        requirementKey: a.requirementKey,
        upload: {
          url: signedUrl,
          bucket: a.upload.bucket,
          path: a.upload.path,
          mimeType: a.upload.mimeType,
          sizeBytes: a.upload.sizeBytes,
        },
      };
    })
  );

  // Product
  const storedProductId = req.productId || req.items[0]?.productId || null;
  const productGid = asShopifyGid("Product", storedProductId);

  let productTitle: string | null = null;
  let productImageUrl: string | null = null;
  let productHandle: string | null = null;
  let primaryDomainUrl: string | null = null;

  if (productGid) {
    try {
      const resp = await admin.graphql(
        `#graphql
        query ProductCardForStorefront($id: ID!) {
          shop { primaryDomain { url } }
          product(id: $id) {
            title
            handle
            featuredImage { url }
            images(first: 1) { nodes { url } }
          }
        }`,
        { variables: { id: productGid } }
      );

      const json = await resp.json();
      const p = json?.data?.product;
      const shop = json?.data?.shop;

      primaryDomainUrl = shop?.primaryDomain?.url ?? null;
      productTitle = p?.title ?? null;
      productHandle = p?.handle ?? null;
      productImageUrl = p?.featuredImage?.url ?? p?.images?.nodes?.[0]?.url ?? null;
    } catch {
      // keep nulls
    }
  }

  const baseStoreUrl = primaryDomainUrl || `https://${session.shop}`;
  const storefrontUrl = productHandle ? `${baseStoreUrl}/products/${productHandle}` : null;

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

      wilayaCode: req.wilayaCode,
      communeId: req.communeId,
      wilayaName,
      communeName,

      pageUrl: req.pageUrl,
      referrer: req.referrer,
      ip: req.ip,
      userAgent: req.userAgent,

      productId: req.productId,
      variantId: req.variantId,
      qty: req.qty,

      items: req.items,
      attachments: attachmentsWithSigned,
    },
    product: { title: productTitle, imageUrl: productImageUrl, storefrontUrl },
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
    const allowed = new Set(["received", "confirmed", "cancelled", "archived"]);
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

    await prisma.request.update({
      where: where as any,
      data: {
        firstName: firstName?.trim() || null,
        lastName: lastName?.trim() || null,
        email: email?.trim() || null,
        phone: phone?.trim() || null,
        address: address?.trim() || null,
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

  const statusFetcher = useFetcher();
  const editFetcher = useFetcher();
  const archiveFetcher = useFetcher();

  const fullName = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || "Customer";
  const isArchived = r.status === "archived";

  return (
    <div className="lf-enter">
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
            <button className="lf-pill lf-pill--success" type="submit">
              Confirm
            </button>
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
              <button className="lf-pill" type="submit">
                Delete
              </button>
            </archiveFetcher.Form>
          ) : (
            <archiveFetcher.Form method="post">
              <input type="hidden" name="intent" value="restore" />
              <button className="lf-pill" type="submit">
                Restore
              </button>
            </archiveFetcher.Form>
          )}

          <Link to="/app/requests">
            <button type="button" className="lf-pill">
              ← Back
            </button>
          </Link>
        </div>
      </div>

      <div className="lf-detail-grid lf-mt-4">
        {/* Left */}
        <div className="lf-card">
          <div className="lf-card-title">Customer details</div>

          <editFetcher.Form method="post" className="lf-edit-form">
            <input type="hidden" name="intent" value="saveEdits" />

            <div className="lf-fields">
              <div className="lf-field">
                <div className="lf-field-label">First name</div>
                <input className="lf-input" name="firstName" defaultValue={r.firstName ?? ""} />
              </div>
              <div className="lf-field">
                <div className="lf-field-label">Last name</div>
                <input className="lf-input" name="lastName" defaultValue={r.lastName ?? ""} />
              </div>
              <div className="lf-field">
                <div className="lf-field-label">Email</div>
                <input className="lf-input" name="email" defaultValue={r.email ?? ""} />
              </div>
              <div className="lf-field">
                <div className="lf-field-label">Phone</div>
                <input className="lf-input" name="phone" defaultValue={r.phone ?? ""} />
              </div>

              <div className="lf-field lf-field--full">
                <div className="lf-field-label">Address</div>
                <input className="lf-input" name="address" defaultValue={r.address ?? ""} />
              </div>

              <div className="lf-field">
                <div className="lf-field-label">Wilaya</div>
                <div className="lf-field-value">{r.wilayaName ?? "—"}</div>
              </div>
              <div className="lf-field">
                <div className="lf-field-label">Commune</div>
                <div className="lf-field-value">{r.communeName ?? "—"}</div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10, gap: 10 }}>
              <button className="lf-pill lf-pill--primary" type="submit">
                Save
              </button>
              <span className="lf-muted" style={{ alignSelf: "center" }}>
                Tip: Ctrl+S
              </span>
            </div>
          </editFetcher.Form>
        </div>

        {/* Right */}
        <div className="lf-card">
          <div className="lf-card-title">Product</div>

          {data.product.storefrontUrl ? (
            <a
              href={data.product.storefrontUrl}
              target="_blank"
              rel="noreferrer"
              className="lf-product-card"
              style={{ textDecoration: "none", color: "inherit", display: "block" }}
              title="Open customer product page"
            >
              <div className="lf-product-card">
                <div className="lf-product-thumb">
                  {data.product.imageUrl ? <img src={data.product.imageUrl} alt="" /> : <div className="lf-product-thumb--empty" />}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 720,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {data.product.title ?? "—"}
                  </div>
                  <div className="lf-muted lf-mt-1">Qty: {r.qty ?? r.items[0]?.qty ?? "—"}</div>
                </div>
              </div>
            </a>
          ) : (
            <div className="lf-muted">Product link not available.</div>
          )}

          {/* Attachments: show ONLY if present */}
          {r.attachments.length ? (
            <>
              <div className="lf-card-title lf-mt-4">Attachments</div>
              <div className="lf-stack">
                {r.attachments.map((a) => {
                  const url = a.upload.url;
                  const mime = (a.upload.mimeType || "").toLowerCase();
                  const isImage = mime.startsWith("image/");
                  const isPdf = mime === "application/pdf";
                  const size = formatBytes(a.upload.sizeBytes);

                  return (
                    <div key={a.id} className="lf-mini-card">
                      <div style={{ fontWeight: 700 }}>
                        {a.label ?? a.requirementKey ?? "Attachment"}
                      </div>

                      <div className="lf-muted lf-mt-1">
                        {a.upload.mimeType ?? "file"}
                        {size ? ` • ${size}` : ""}
                      </div>

                      {url ? (
                        <>
                          <div style={{ marginTop: 10 }}>
                            <a className="lf-link" href={url} target="_blank" rel="noreferrer">
                              {isPdf ? "Open PDF" : "Open file"}
                            </a>
                          </div>

                          {isImage ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              style={{ display: "block", marginTop: 10 }}
                            >
                              <img
                                src={url}
                                alt=""
                                style={{
                                  width: "100%",
                                  maxHeight: 260,
                                  objectFit: "cover",
                                  borderRadius: 12,
                                  border: "1px solid rgba(0,0,0,.06)",
                                }}
                              />
                            </a>
                          ) : null}

                          {isPdf ? (
                            <div style={{ marginTop: 10 }}>
                              <iframe
                                title="PDF preview"
                                src={url}
                                style={{
                                  width: "100%",
                                  height: 420,
                                  borderRadius: 12,
                                  border: "1px solid rgba(0,0,0,.06)",
                                }}
                              />
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
