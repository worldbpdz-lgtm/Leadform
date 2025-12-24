// app/routes/apps.leadform.submit.tsx
import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { RoleType } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parse as parseQuery } from "node:querystring";
import {
  makeRequestUploadPath,
  uploadToSupabase,
  validateUploadFile,
} from "~/lib/uploads.server";

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

  const provided =
    url.searchParams.get("signature") || url.searchParams.get("hmac");
  const shop = url.searchParams.get("shop");

  if (!provided || !shop) return { ok: false, reason: "Missing shop/signature" };

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

function asFiles(val: any): File[] {
  if (!val) return [];
  if (val instanceof File) return val.size > 0 ? [val] : [];
  if (Array.isArray(val))
    return val.filter((x) => x instanceof File && x.size > 0);
  return [];
}

async function readBody(request: Request): Promise<Record<string, any> | null> {
  const ct = request.headers.get("content-type") || "";

  // JSON
  if (ct.includes("application/json")) {
    const body = await request.json().catch(() => null);
    return body && typeof body === "object" ? (body as any) : null;
  }

  // FormData (multipart or urlencoded)
  if (
    ct.includes("multipart/form-data") ||
    ct.includes("application/x-www-form-urlencoded")
  ) {
    const fd = await request.formData().catch(() => null);
    if (!fd) return null;

    const obj: Record<string, any> = {};
    for (const [k, v] of fd.entries()) {
      // preserve repeated keys as arrays (multi-file uploads)
      if (obj[k] === undefined) obj[k] = v;
      else if (Array.isArray(obj[k])) obj[k].push(v);
      else obj[k] = [obj[k], v];
    }
    return obj;
  }

  // Fallback: try JSON
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as any) : null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);

  const verified = verifyAppProxyRequest(url);
  if (!verified.ok) return json({ ok: false, error: verified.reason }, 401);

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "Invalid body" }, 400);

  const roleType = asRoleType(body.roleType ?? body.role);
  if (!roleType) {
    return json({ ok: false, error: "roleType/role is required" }, 400);
  }

  const idempotencyKey =
    stringOrNull(body.idempotencyKey) ||
    request.headers.get("Idempotency-Key") ||
    null;

  // Ensure Shop exists
  const shop = await prisma.shop.upsert({
    where: { shopDomain: verified.shop },
    update: { uninstalledAt: null },
    create: { shopDomain: verified.shop, installedAt: new Date() },
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

  // Basic fields
  const firstName = stringOrNull(body.firstName);
  const lastName = stringOrNull(body.lastName);
  const email = stringOrNull(body.email);
  const phone = stringOrNull(body.phone);
  const address = stringOrNull(body.address);

  const wilayaCode = parseIntOrNull(body.wilayaCode);
  const communeId = stringOrNull(body.communeId);

  const pageUrl = stringOrNull(body.pageUrl);
  const referrer =
    stringOrNull(body.referrer) || request.headers.get("referer") || null;

  const ip =
    stringOrNull(body.ip) ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;

  const userAgent = request.headers.get("user-agent") ?? null;

  // Items
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

  // Documents (up to 10 PDFs/images; mix allowed)
  // Accept: "document" OR "documents" OR repeated keys (documents[])
  const files = [
    ...asFiles(body.document),
    ...asFiles(body.documents),
    ...asFiles(body["documents[]"]),
    ...asFiles(body.files),
    ...asFiles(body["files[]"]),
  ];

  const needsDoc =
    roleType === RoleType.installer || roleType === RoleType.company;

  if (needsDoc && files.length === 0) {
    return json({ ok: false, error: "Document is required for this role" }, 400);
  }

  if (files.length > 10) {
    return json({ ok: false, error: "Maximum 10 files allowed" }, 400);
  }

  // Load role requirement (optional)
  const requirement =
    needsDoc && role?.id
      ? await prisma.roleRequirement.findFirst({
          where: { roleId: role.id, required: true },
          orderBy: { createdAt: "asc" },
          select: {
            key: true,
            label: true,
            acceptedMimeTypes: true,
            maxSizeBytes: true,
          },
        })
      : null;

  // Always allow PDF + images even if DB is misconfigured
  const defaultAllowed = ["application/pdf", "image/*"];
  const allowedMimeTypes = Array.from(
    new Set([...(requirement?.acceptedMimeTypes ?? []), ...defaultAllowed])
  );

  for (const f of files) {
    try {
      validateUploadFile(f, {
        allowedMimeTypes,
        maxSizeBytes: requirement?.maxSizeBytes ?? undefined,
      });
    } catch (e: any) {
      return json({ ok: false, error: e?.message || "Invalid file" }, 400);
    }
  }

  // Idempotency (only if client provides it; dedupe BEFORE creating uploads)
  if (idempotencyKey) {
    const existing = await prisma.request.findFirst({
      where: { shopId: shop.id, idempotencyKey: String(idempotencyKey) },
      select: { id: true },
    });
    if (existing) {
      return json({ ok: true, requestId: existing.id, deduped: true }, 200);
    }
  }

  const primary = items[0];
  const values = body.values && typeof body.values === "object" ? body.values : {};

  // Create request first, then attach uploads. If upload fails and docs required -> rollback.
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

      productId: primary.productId,
      variantId: primary.variantId,
      qty: primary.qty,

      values,

      items: { create: items },
    },
    select: { id: true },
  });

  if (files.length) {
    const bucket =
      process.env.SUPABASE_REVIEW_MEDIA_BUCKET || "leadform-uploads";

    try {
      for (const f of files) {
        const path = makeRequestUploadPath({
          shopId: shop.id,
          requestId: created.id,
          originalName: f.name || "document",
        });

        const up = await uploadToSupabase({ bucket, path, file: f });

        const uploadRow = await prisma.upload.create({
          data: {
            shopId: shop.id,
            provider: "supabase",
            bucket,
            path,
            url: null, // signed URLs in admin
            mimeType: up.mimeType,
            sizeBytes: up.sizeBytes,
            checksum: up.checksum,
            purpose: "role_document",
          },
          select: { id: true },
        });

        await prisma.requestAttachment.create({
          data: {
            requestId: created.id,
            uploadId: uploadRow.id,
            requirementKey: requirement?.key ?? "documents",
            label: f.name || requirement?.label || "Document",
          },
          select: { id: true },
        });
      }
    } catch (e: any) {
      // enforce requirement by deleting request if upload failed
      await prisma.request.delete({ where: { id: created.id } }).catch(() => {});
      return json({ ok: false, error: e?.message || "Upload failed" }, 500);
    }
  }

  return json({
    ok: true,
    requestId: created.id,
    uploadReceived: files.length,
  });
};
