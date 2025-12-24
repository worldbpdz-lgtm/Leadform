// app/routes/app.requests.$id.tsx
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, Link, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

type LoaderData = {
  request: {
    id: string;
    createdAt: string;

    status: "received" | "confirmed" | "cancelled" | "archived";
    roleType: string;

    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;

    wilaya: { code: number; nameFr: string; nameAr: string } | null;
    commune: { id: string; nameFr: string; nameAr: string } | null;

    pageUrl: string | null;
    referrer: string | null;
    ip: string | null;

    productId: string | null;
    variantId: string | null;
    qty: number | null;

    items: Array<{
      id: string;
      productId: string;
      variantId: string | null;
      qty: number;
    }>;

    attachments: Array<{
      id: string;
      label: string | null;
      requirementKey: string | null;
      upload: {
        url: string | null;
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
    adminUrl: string | null; // link to Shopify admin product
  };
};

function statusUI(s: LoaderData["request"]["status"]) {
  if (s === "confirmed") return { label: "Confirmed", badge: "lf-badge lf-badge--approved" as const };
  if (s === "cancelled") return { label: "Cancelled", badge: "lf-badge lf-badge--rejected" as const };
  if (s === "archived") return { label: "Basket", badge: "lf-badge lf-badge--basket" as const };
  return { label: "New", badge: "lf-badge lf-badge--pending" as const };
}

function normStr(v: FormDataEntryValue | null) {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
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
      wilaya: { select: { code: true, nameFr: true, nameAr: true } },
      commune: { select: { id: true, nameFr: true, nameAr: true } },
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

  // Keep internal statuses, but UI will only offer Confirm/Cancel/Basket.
  const status = (req.status as any) as LoaderData["request"]["status"];

  const primaryItem = req.items[0] ?? null;
  const shopifyProductId = req.productId || primaryItem?.productId || null;

  let productTitle: string | null = null;
  let productImageUrl: string | null = null;
  let productAdminUrl: string | null = null;

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

      const j = await resp.json();
      const p = j?.data?.product;
      productTitle = p?.title ?? null;
      productImageUrl = p?.featuredImage?.url ?? p?.images?.nodes?.[0]?.url ?? null;

      // Shopify admin product URL (always works in embedded admin)
      // The ID is already "gid://shopify/Product/123"
      const numeric = String(shopifyProductId).split("/").pop() || "";
      productAdminUrl = numeric
        ? `https://admin.shopify.com/store/${session.shop.replace(".myshopify.com", "")}/products/${numeric}`
        : null;
    } catch {
      // ignore
    }
  }

  const data: LoaderData = {
    request: {
      id: req.id,
      createdAt: req.createdAt.toISOString(),
      status,
      roleType: String(req.roleType),

      firstName: req.firstName,
      lastName: req.lastName,
      email: req.email,
      phone: req.phone,
      address: req.address,

      wilaya: req.wilaya ? { ...req.wilaya } : null,
      commune: req.commune ? { ...req.commune } : null,

      pageUrl: req.pageUrl,
      referrer: req.referrer,
      ip: req.ip,

      productId: req.productId,
      variantId: req.variantId,
      qty: req.qty,

      items: req.items,
      attachments: req.attachments,
    },
    product: { title: productTitle, imageUrl: productImageUrl, adminUrl: productAdminUrl },
  };

  return data;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = String(params.id || "");
  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shopRow) return { ok: false };

  const where = { id, shopId: shopRow.id };

  // Only allow these UI transitions:
  // - confirmed
  // - cancelled
  // - basket (archived)
  if (intent === "setStatus") {
    const status = String(fd.get("status") || "");
    const allowed = new Set(["confirmed", "cancelled"]);
    if (!allowed.has(status)) return { ok: false, error: "Invalid status" };

    await prisma.request.update({
      where: where as any,
      data: { status: status as any },
    });
    return { ok: true };
  }

  if (intent === "saveInline") {
    await prisma.request.update({
      where: where as any,
      data: {
        firstName: normStr(fd.get("firstName")),
        lastName: normStr(fd.get("lastName")),
        email: normStr(fd.get("email")),
        phone: normStr(fd.get("phone")),
        address: normStr(fd.get("address")),
      },
    });
    return { ok: true };
  }

  // “Delete” => Basket (archived)
  if (intent === "toBasket") {
    await prisma.request.update({
      where: where as any,
      data: { status: "archived" as any },
    });
    return { ok: true };
  }

  // Permanent delete only from Basket page later
  return { ok: false };
};

export default function RequestDetails() {
  const data = useLoaderData() as LoaderData;
  const r = data.request;

  const ui = statusUI(r.status);
  const statusFetcher = useFetcher();
  const saveFetcher = useFetcher();
  const basketFetcher = useFetcher();

  const fullName =
    `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || "Customer";

  const wilayaLabel = r.wilaya ? `${r.wilaya.code} — ${r.wilaya.nameFr}` : "—";
  const communeLabel = r.commune ? r.commune.nameFr : "—";

  const qtyLabel = r.qty ?? r.items[0]?.qty ?? null;

  return (
    <div className="lf-enter">
      {/* Top bar */}
      <div className="lf-detail-top">
        <div className="lf-detail-title">
          <div className="lf-detail-name">
            {fullName}
            <span className="lf-detail-id">#{r.id.slice(0, 10)}…</span>
          </div>
          <div className="lf-muted">
            Created {new Date(r.createdAt).toLocaleString()} • Role: {r.roleType}
          </div>
        </div>

        <div className="lf-detail-actions">
          <span className={ui.badge} title={r.status}>
            <span className="lf-dot" />
            {ui.label}
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
            <button className="lf-pill lf-pill--danger" type="submit">
              Cancel
            </button>
          </statusFetcher.Form>

          <basketFetcher.Form method="post">
            <input type="hidden" name="intent" value="toBasket" />
            <button className="lf-pill" type="submit">
              Delete
            </button>
          </basketFetcher.Form>

          <Link to="/app/requests" className="lf-pill lf-pill--ghost">
            <span aria-hidden="true">←</span>
            Back
          </Link>
        </div>
      </div>

      {/* Grid */}
      <div className="lf-detail-grid lf-mt-4">
        {/* Left: editable customer */}
        <div className="lf-card">
          <div className="lf-card-title">Customer</div>

          <saveFetcher.Form
            id="lf-inline-form"
            method="post"
            className="lf-form-grid"
            onKeyDown={(e) => {
              // Ctrl+S / Cmd+S saves
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                const form = document.getElementById("lf-inline-form") as HTMLFormElement | null;
                if (form) saveFetcher.submit(form, { method: "post" });
              }
            }}
          >
            <input type="hidden" name="intent" value="saveInline" />

            <label className="lf-field">
              <div className="lf-field-label">First name</div>
              <input className="lf-input" name="firstName" defaultValue={r.firstName ?? ""} />
            </label>

            <label className="lf-field">
              <div className="lf-field-label">Last name</div>
              <input className="lf-input" name="lastName" defaultValue={r.lastName ?? ""} />
            </label>

            <label className="lf-field">
              <div className="lf-field-label">Email</div>
              <input className="lf-input" name="email" defaultValue={r.email ?? ""} />
            </label>

            <label className="lf-field">
              <div className="lf-field-label">Phone</div>
              <input className="lf-input" name="phone" defaultValue={r.phone ?? ""} />
            </label>

            <label className="lf-field lf-field--full">
              <div className="lf-field-label">Address</div>
              <input className="lf-input" name="address" defaultValue={r.address ?? ""} />
            </label>

            <div className="lf-field">
              <div className="lf-field-label">Wilaya</div>
              <div className="lf-read">{wilayaLabel}</div>
            </div>

            <div className="lf-field">
              <div className="lf-field-label">Commune</div>
              <div className="lf-read">{communeLabel}</div>
            </div>

            <div className="lf-form-actions">
              <button className="lf-pill lf-pill--primary" type="submit">
                Save
              </button>
              <span className="lf-muted">Tip: Ctrl+S</span>
            </div>
          </saveFetcher.Form>
        </div>

        {/* Right: product + attachments */}
        <div className="lf-card">
          <div className="lf-card-title">Product</div>

          <a
            className="lf-product"
            href={data.product.adminUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
          >
            <div className="lf-product-thumb">
              {data.product.imageUrl ? <img src={data.product.imageUrl} alt="" /> : <div className="lf-thumb-empty" />}
            </div>

            <div className="lf-product-meta">
              <div className="lf-product-title">{data.product.title ?? "—"}</div>
              <div className="lf-muted">Qty: {qtyLabel ?? "—"}</div>
            </div>
          </a>

          <div className="lf-card-title lf-mt-4">Attachments</div>
          {r.attachments.length ? (
            <div className="lf-stack">
              {r.attachments.map((a) => (
                <div key={a.id} className="lf-mini-card">
                  <div style={{ fontWeight: 750 }}>
                    {a.label ?? a.requirementKey ?? "Attachment"}
                  </div>
                  <div className="lf-muted lf-mt-1">
                    {a.upload.mimeType ?? "file"}
                    {a.upload.sizeBytes ? ` • ${a.upload.sizeBytes} bytes` : ""}
                  </div>
                  {a.upload.url ? (
                    <a className="lf-link" href={a.upload.url} target="_blank" rel="noreferrer">
                      Open file
                    </a>
                  ) : (
                    <div className="lf-muted">No public URL.</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="lf-muted">No attachments.</div>
          )}

          <details className="lf-details lf-mt-4">
            <summary>Meta</summary>
            <div className="lf-mini-card lf-mt-2">
              <div className="lf-muted">Page URL</div>
              <div className="lf-break">{r.pageUrl ?? "—"}</div>
            </div>
            <div className="lf-mini-card lf-mt-2">
              <div className="lf-muted">Referrer</div>
              <div className="lf-break">{r.referrer ?? "—"}</div>
            </div>
            <div className="lf-mini-card lf-mt-2">
              <div className="lf-muted">IP</div>
              <div className="lf-break">{r.ip ?? "—"}</div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
