// app/routes/apps.leadform.form.tsx
import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parse as parseQuery } from "node:querystring";

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

function verifyAppProxyRequest(url: URL): VerifyResult {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return { ok: false, reason: "Missing SHOPIFY_API_SECRET" };

  const provided = url.searchParams.get("signature") || url.searchParams.get("hmac");
  const shop = url.searchParams.get("shop");

  if (!shop || !provided) return { ok: false, reason: "Missing shop/signature" };

  const queryHash = parseQuery(url.search.slice(1)) as Record<string, any>;
  delete queryHash.signature;
  delete queryHash.hmac;

  const message = Object.keys(queryHash)
    .map((k) => {
      const v = queryHash[k];
      const arr = Array.isArray(v) ? v : [v];
      return `${k}=${arr.join(",")}`;
    })
    .sort()
    .join("");

  const digest = createHmac("sha256", secret).update(message).digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided, "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);

  return ok ? { ok: true, shop } : { ok: false, reason: "Bad signature" };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const verified = verifyAppProxyRequest(url);
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

  // Public pixel config for storefront (IDs only; no secrets)
  const pixels = await prisma.trackingPixel.findMany({
    where: { shopId: shop.id, enabled: true },
    select: { platform: true, pixelId: true, events: true },
    orderBy: { platform: "asc" },
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
    pixels: pixels.map((p) => ({
      platform: p.platform,
      pixelId: p.pixelId,
      events: p.events,
    })),
  });
};
