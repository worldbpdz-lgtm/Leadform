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
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!secret) return { ok: false, reason: "Missing SHOPIFY_API_SECRET" };

  const shop = url.searchParams.get("shop");
  const sig = url.searchParams.get("signature");
  const hmac = url.searchParams.get("hmac");
  const provided = sig || hmac;

  if (!shop || !provided) return { ok: false, reason: "Missing shop/signature" };

  const pairs: string[] = [];
  url.searchParams.forEach((value, key) => {
    if (key === "signature" || key === "hmac") return;
    pairs.push(`${key}=${value}`);
  });
  pairs.sort();
  const message = pairs.join("&");

  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const digest = createHmac("sha256", secret).update(message).digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided, "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);

  return ok ? { ok: true, shop } : { ok: false, reason: "Bad signature" };
}

function asRoleType(input: unknown): RoleType | null {
  if (input === "individual") return RoleType.individual;
  if (input === "installer") return RoleType.installer;
  if (input === "company") return RoleType.company;
  return null;
}

function parseWilayaCode(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  const n = Number(input);
  return Number.isInteger(n) ? n : null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const verified = await verifyAppProxyRequest(url);
  if (!verified.ok) return json({ ok: false, error: verified.reason }, 401);

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const shopDomain: string = verified.shop;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ ok: false, error: "Invalid JSON" }, 400);

  const roleType = asRoleType((body as any).roleType);
  if (!roleType) return json({ ok: false, error: "roleType is required" }, 400);

  const idempotencyKey =
    (body as any).idempotencyKey || request.headers.get("Idempotency-Key") || null;

  // Ensure Shop exists
  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    update: { uninstalledAt: null },
    create: { shopDomain, installedAt: new Date() },
    select: { id: true },
  });

  // Resolve active form (ShopSettings.currentFormId preferred)
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

  // Resolve roleId
  const role = await prisma.role.findFirst({
    where: { shopId: shop.id, type: roleType, active: true },
    select: { id: true },
  });

  // Basic fields
  const firstName = (body as any).firstName ?? null;
  const lastName = (body as any).lastName ?? null;
  const email = (body as any).email ?? null;
  const phone = (body as any).phone ?? null;
  const address = (body as any).address ?? null;

  const wilayaCode = parseWilayaCode((body as any).wilayaCode);
  const communeId = (body as any).communeId ? String((body as any).communeId) : null;

  const pageUrl = (body as any).pageUrl ?? null;
  const referrer = (body as any).referrer ?? request.headers.get("referer") ?? null;

  const ip =
    (body as any).ip ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;

  const userAgent = request.headers.get("user-agent") ?? null;

  // Items: accept either items[] OR productId/variantId/qty
  const itemsIn = Array.isArray((body as any).items) ? (body as any).items : null;
  const fallbackItem =
    (body as any).productId
      ? [
          {
            productId: (body as any).productId,
            variantId: (body as any).variantId ?? null,
            qty: (body as any).qty ?? 1,
          },
        ]
      : null;

  const items = (itemsIn ?? fallbackItem)?.map((it: any) => ({
    productId: String(it.productId),
    variantId: it.variantId ? String(it.variantId) : null,
    qty: Math.max(1, Number(it.qty ?? 1)),
  }));

  if (!items || items.length === 0) {
    return json({ ok: false, error: "At least one item is required" }, 400);
  }

  const primary = items[0];

  // Safe values bag (do NOT store full body)
  const values =
    typeof (body as any).values === "object" && (body as any).values
      ? (body as any).values
      : {};

  // Idempotency (prevents duplicates)
  if (idempotencyKey) {
    const existing = await prisma.request.findFirst({
      where: { shopId: shop.id, idempotencyKey: String(idempotencyKey) },
      select: { id: true },
    });
    if (existing) return json({ ok: true, requestId: existing.id, deduped: true });
  }

  const created = await prisma.request.create({
    data: {
      shopId: shop.id,

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
      communeId,

      pageUrl,
      referrer,
      ip,
      userAgent,

      // keep Request top-level columns consistent with items
      productId: primary.productId,
      variantId: primary.variantId,
      qty: primary.qty,

      values,

      items: { create: items },
    },
    select: { id: true },
  });

  return json({ ok: true, requestId: created.id });
};
