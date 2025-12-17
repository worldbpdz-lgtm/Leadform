import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Shopify App Proxy verification
 * App Proxy sends `shop` + `signature` (or sometimes `hmac`).
 * We verify by hashing the sorted query string excluding signature/hmac.
 */
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const verified = await verifyAppProxyRequest(url);
  if (!verified.ok) return json({ ok: false, error: verified.reason }, 401);

  const shopDomain: string = verified.shop;

  // Ensure Shop exists (App Proxy can hit before install webhook logic)
  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    update: { uninstalledAt: null },
    create: { shopDomain, installedAt: new Date() },
    select: { id: true },
  });

  const settings = await prisma.shopSettings.findUnique({
    where: { shopId: shop.id },
    select: { currentFormId: true, showPriceForIndividuals: true },
  });

  const form =
    (settings?.currentFormId
      ? await prisma.form.findFirst({
          where: { id: settings.currentFormId, shopId: shop.id },
          include: { fields: { orderBy: { orderIndex: "asc" } } },
        })
      : null) ||
    (await prisma.form.findFirst({
      where: { shopId: shop.id, isActive: true },
      include: { fields: { orderBy: { orderIndex: "asc" } } },
      orderBy: { updatedAt: "desc" },
    }));

  const roles = await prisma.role.findMany({
    where: { shopId: shop.id, active: true },
    orderBy: [{ type: "asc" }],
    include: { requirements: { orderBy: { createdAt: "asc" } } },
  });

  return json({
    ok: true,
    shop: shopDomain,
    settings: {
      showPriceForIndividuals: settings?.showPriceForIndividuals ?? false,
    },
    form: form
      ? {
          id: form.id,
          slug: form.slug,
          name: form.name,
          placement: form.placement,
          ui: form.ui,
          fields: form.fields.map((f) => ({
            id: f.id,
            type: f.type,
            label: f.label,
            nameKey: f.nameKey,
            placeholder: f.placeholder,
            helpText: f.helpText,
            required: f.required,
            visible: f.visible,
            options: f.options,
            validation: f.validation,
            errorMessage: f.errorMessage,
            orderIndex: f.orderIndex,
          })),
        }
      : null,
    roles: roles.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      description: r.description,
      ui: r.ui,
      requirements: r.requirements.map((req) => ({
        key: req.key,
        label: req.label,
        description: req.description,
        required: req.required,
        acceptedMimeTypes: req.acceptedMimeTypes,
        maxSizeBytes: req.maxSizeBytes,
      })),
    })),
  });
};
