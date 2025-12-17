import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { RoleType } from "@prisma/client";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

type VerifyOk = { ok: true; shop: string };
type VerifyFail = { ok: false; reason: string };
type VerifyResult = VerifyOk | VerifyFail;

async function verifyAppProxyRequest(url: URL): Promise<VerifyResult> {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return { ok: false, reason: "Missing SHOPIFY_API_SECRET" };

  const providedHmac =
    url.searchParams.get("hmac") || url.searchParams.get("signature");
  const shop = url.searchParams.get("shop");

  if (!providedHmac || !shop) {
    return { ok: false, reason: "Missing shop or hmac" };
  }

  // Shopify App Proxy rule:
  // - take original query string
  // - remove hmac/signature
  // - DO NOT re-encode values
  const query = url.search.slice(1);
  const message = query
    .split("&")
    .filter(
      (part) =>
        !part.startsWith("hmac=") &&
        !part.startsWith("signature=")
    )
    .sort()
    .join("&");

  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const digest = createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(providedHmac, "utf8");

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "Bad signature" };
  }

  return { ok: true, shop };
}


function asRoleType(input: unknown): RoleType | null {
  if (input === "individual") return RoleType.individual;
  if (input === "installer") return RoleType.installer;
  if (input === "company") return RoleType.company;
  return null;
}

function parseIntOrNull(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

function stringOrNull(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  return s ? s : null;
}

async function readBody(request: Request): Promise<Record<string, any> | null> {
  const ct = request.headers.get("content-type") || "";

  // JSON
  if (ct.includes("application/json")) {
    const body = await request.json().catch(() => null);
    return body && typeof body === "object" ? (body as any) : null;
  }

  // FormData (multipart or urlencoded)
  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const fd = await request.formData().catch(() => null);
    if (!fd) return null;

    const obj: Record<string, any> = {};
    for (const [k, v] of fd.entries()) {
      // keep File objects as-is
      obj[k] = v;
    }
    return obj;
  }

  // Fallback: try JSON
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as any) : null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const verified = await verifyAppProxyRequest(url);
  if (!verified.ok) return json({ ok: false, error: verified.reason }, 401);

  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const shopDomain: string = verified.shop;

  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "Invalid body" }, 400);

  // accept roleType OR role (theme uses role)
  const roleType = asRoleType(body.roleType ?? body.role);
  if (!roleType) return json({ ok: false, error: "roleType/role is required" }, 400);

  // idempotency
  const idempotencyKey =
    stringOrNull(body.idempotencyKey) || request.headers.get("Idempotency-Key") || null;

  // Ensure Shop exists
  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    update: { uninstalledAt: null },
    create: { shopDomain, installedAt: new Date() },
    select: { id: true },
  });

  // Resolve active form
  const settings = await prisma.shopSettings.findUnique({
    where: { shopId: shop.id },
    select: { currentFormId: true },
  });

  const form =
    (settings?.currentFormId
      ? await prisma.form.findFirst({
          where: { id: settings.currentFormId, shopId: shop.id },
          select: { id: true },
        })
      : null) ||
    (await prisma.form.findFirst({
      where: { shopId: shop.id, isActive: true },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    }));

  const role = await prisma.role.findFirst({
    where: { shopId: shop.id, type: roleType, active: true },
    select: { id: true },
  });

  // Fields
  const firstName = stringOrNull(body.firstName);
  const lastName = stringOrNull(body.lastName);
  const email = stringOrNull(body.email);
  const phone = stringOrNull(body.phone);
  const address = stringOrNull(body.address);

  const wilayaCode = parseIntOrNull(body.wilayaCode);
  // COMMUNE OPTIONAL: "" -> null
  const communeId = stringOrNull(body.communeId);

  const pageUrl = stringOrNull(body.pageUrl);
  const referrer =
    stringOrNull(body.referrer) || request.headers.get("referer") || null;

  const ip =
    stringOrNull(body.ip) ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;

  const userAgent = request.headers.get("user-agent") ?? null;

  // Items (support theme's single product fields)
  const productId = stringOrNull(body.productId);
  const variantId = stringOrNull(body.variantId);
  const qty = Math.max(1, Number(body.qty ?? 1));

  const items =
    Array.isArray(body.items) && body.items.length
      ? body.items.map((it: any) => ({
          productId: String(it.productId),
          variantId: it.variantId ? String(it.variantId) : null,
          qty: Math.max(1, Number(it.qty ?? 1)),
        }))
      : productId
      ? [{ productId, variantId, qty }]
      : null;

  if (!items || items.length === 0) {
    return json({ ok: false, error: "At least one item is required" }, 400);
  }

  // Document requirement check (if you want to enforce now)
  const file = body.document instanceof File ? body.document : null;
  const needsDoc = roleType === RoleType.installer || roleType === RoleType.company;
  if (needsDoc && !file) {
    return json({ ok: false, error: "Document is required for this role" }, 400);
  }

  // Idempotency dedupe
  if (idempotencyKey) {
    const existing = await prisma.request.findFirst({
      where: { shopId: shop.id, idempotencyKey: String(idempotencyKey) },
      select: { id: true },
    });
    if (existing) return json({ ok: true, requestId: existing.id, deduped: true });
  }

  const primary = items[0];

  // values bag (optional)
  const values =
    body.values && typeof body.values === "object" ? body.values : {};

  const created = await prisma.request.create({
    data: {
      shopId: shop.id,

      // if your schema uses enum/status values, adjust this one string accordingly
      status: "received",

      idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,

      roleType,
      roleId: role?.id ?? null,
      formId: form?.id ?? null,

      firstName,
      lastName,
      email,
      phone,
      address,

      wilayaCode,
      communeId, // null allowed

      pageUrl,
      referrer,
      ip,
      userAgent,

      productId: primary.productId,
      variantId: primary.variantId,
      qty: primary.qty,

      values,

      items: { create: items },
    },
    select: { id: true },
  });

  // Upload handling: you currently don't have a storage pipeline shown here.
  // For now we just acknowledge it exists; next step is wiring to Supabase Storage or DB model.
  const uploadReceived = Boolean(file);

  return json({ ok: true, requestId: created.id, uploadReceived });
};
