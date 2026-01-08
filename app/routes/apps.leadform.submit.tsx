// app/routes/apps.leadform.submit.tsx
import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { RoleType } from "@prisma/client";
import { verifyAppProxyRequest } from "~/lib/appProxy.server";
import {
  makeRequestUploadPath,
  uploadToSupabase,
  validateUploadFile,
} from "~/lib/uploads.server";
import { syncRequestToPrimarySheet } from "~/lib/sheets.server";
import { firePixelsForRequest } from "~/lib/pixels.server";
import { createClient } from "@supabase/supabase-js";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

let _supabaseAdmin: ReturnType<typeof createClient> | null = null;
function getSupabaseAdmin() {
  if (_supabaseAdmin) return _supabaseAdmin;
  const url = mustEnv("SUPABASE_URL");
  const key = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  _supabaseAdmin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabaseAdmin;
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

function parseQty(input: unknown): number {
  const s = String(input ?? "").trim();
  const n = Number.parseInt(s || "1", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function stringOrNull(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  return s ? s : null;
}

function asFiles(val: any): File[] {
  if (!val) return [];
  if (val instanceof File) return val.size > 0 ? [val] : [];
  if (Array.isArray(val)) return val.filter((x) => x instanceof File && x.size > 0);
  return [];
}

async function readBody(request: Request): Promise<Record<string, any> | null> {
  const ct = request.headers.get("content-type") || "";

  if (ct.includes("application/json")) {
    const body = await request.json().catch(() => null);
    return body && typeof body === "object" ? (body as any) : null;
  }

  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const fd = await request.formData().catch(() => null);
    if (!fd) return null;

    const obj: Record<string, any> = {};
    for (const [k, v] of fd.entries()) {
      if (obj[k] === undefined) obj[k] = v;
      else if (Array.isArray(obj[k])) obj[k].push(v);
      else obj[k] = [obj[k], v];
    }
    return obj;
  }

  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as any) : null;
}

function parseValues(input: unknown): Record<string, any> {
  if (!input) return {};
  if (typeof input === "object" && !Array.isArray(input)) return input as any;

  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return {};
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as any;
      } catch {
        // ignore
      }
    }
  }

  return {};
}

type UploadMeta = { name: string; size: number; type: string };
function parseUploadMetas(input: unknown): UploadMeta[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((x: any) => ({
        name: String(x?.name || "").trim(),
        size: Number(x?.size || 0),
        type: String(x?.type || "").trim(),
      }))
      .filter((x) => x.name && Number.isFinite(x.size) && x.size > 0);
  }
  if (typeof input === "string") {
    try {
      return parseUploadMetas(JSON.parse(input));
    } catch {
      return [];
    }
  }
  return [];
}

type UploadedFileMeta = {
  bucket: string;
  path: string;
  mimeType: string | null;
  sizeBytes: number | null;
  originalName: string | null;
};
function parseUploadedFiles(input: unknown): UploadedFileMeta[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((x: any) => ({
        bucket: String(x?.bucket || "").trim(),
        path: String(x?.path || "").trim(),
        mimeType: x?.mimeType ? String(x.mimeType) : null,
        sizeBytes: Number.isFinite(Number(x?.sizeBytes)) ? Number(x.sizeBytes) : null,
        originalName: x?.originalName ? String(x.originalName) : null,
      }))
      .filter((x) => x.bucket && x.path);
  }
  if (typeof input === "string") {
    try {
      return parseUploadedFiles(JSON.parse(input));
    } catch {
      return [];
    }
  }
  return [];
}

function mimeAllowed(mime: string, allowed: string[]) {
  if (!mime) return false;
  for (const a of allowed) {
    if (a === mime) return true;
    if (a.endsWith("/*")) {
      const pref = a.slice(0, -2);
      if (mime.startsWith(pref + "/")) return true;
    }
  }
  return false;
}

function safeName(name: string) {
  return name
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function makePreuploadPath(args: { shopId: string; idempotencyKey: string; originalName: string }) {
  const ts = Date.now();
  const rand = Math.random().toString(16).slice(2);
  return `${args.shopId}/preuploads/${args.idempotencyKey}/${ts}-${rand}-${safeName(
    args.originalName || "document"
  )}`;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const url = new URL(request.url);

    const verified = verifyAppProxyRequest(url);
    if (!verified.ok) return json({ ok: false, error: verified.reason }, 401);

    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const body = await readBody(request);
    if (!body) return json({ ok: false, error: "Invalid body" }, 400);

    const intent = String(body.intent || "").trim();
    const isPrepare = intent === "prepare_upload";

    const roleType = asRoleType(body.roleType ?? body.role);
    if (!roleType) {
      return json({ ok: false, error: "roleType/role is required" }, 400);
    }

    const idempotencyKey =
      stringOrNull(body.idempotencyKey) || request.headers.get("Idempotency-Key") || null;

    // Upsert shop early (needed for signed upload paths + request)
    const shop = await prisma.shop.upsert({
      where: { shopDomain: verified.shop },
      update: { uninstalledAt: null },
      create: { shopDomain: verified.shop, installedAt: new Date() },
      select: { id: true },
    });

    const role = await prisma.role.findFirst({
      where: { shopId: shop.id, type: roleType, active: true },
      select: { id: true },
    });

    const needsDoc = roleType === RoleType.installer || roleType === RoleType.company;

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

    const defaultAllowed = ["application/pdf", "image/*"];
    const allowedMimeTypes = Array.from(
      new Set([...(requirement?.acceptedMimeTypes ?? []), ...defaultAllowed])
    );

    // =========================
    // PREPARE SIGNED UPLOAD URLs
    // =========================
    if (isPrepare) {
      const metas =
        parseUploadMetas(body.files) ||
        parseUploadMetas(body.filesMeta) ||
        parseUploadMetas(body.uploads);

      if (needsDoc && metas.length === 0) {
        return json({ ok: false, error: "Document is required for this role" }, 400);
      }

      if (metas.length > 10) {
        return json({ ok: false, error: "Maximum 10 files allowed" }, 400);
      }

      // Default big-file allowance for signed uploads (adjustable via RoleRequirement.maxSizeBytes)
      const maxSize =
        typeof requirement?.maxSizeBytes === "number" && requirement.maxSizeBytes > 0
          ? requirement.maxSizeBytes
          : 25 * 1024 * 1024; // 25MB default per file

      for (const m of metas) {
        if (!m.name) return json({ ok: false, error: "Invalid file meta" }, 400);
        if (!m.type || !mimeAllowed(m.type, allowedMimeTypes)) {
          return json({ ok: false, error: `File type not allowed: ${m.type || "unknown"}` }, 400);
        }
        if (m.size > maxSize) {
          return json({
            ok: false,
            error: `File too large: ${m.name} (${Math.ceil(m.size / 1024 / 1024)}MB). Max is ${Math.floor(
              maxSize / 1024 / 1024
            )}MB.`,
          }, 400);
        }
      }

      if (!idempotencyKey) {
        // Required so we can group preuploads predictably
        return json({ ok: false, error: "idempotencyKey is required for uploads" }, 400);
      }

      const bucket = process.env.SUPABASE_REVIEW_MEDIA_BUCKET || "leadform-uploads";
      const supabase = getSupabaseAdmin();

      const uploads = [];
      for (const m of metas) {
        const path = makePreuploadPath({
          shopId: shop.id,
          idempotencyKey: String(idempotencyKey),
          originalName: m.name,
        });

        const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path);
        if (error || !data?.signedUrl) {
          throw new Error(error?.message || "Failed to create signed upload URL");
        }

        uploads.push({
          bucket,
          path: data.path || path,
          signedUrl: data.signedUrl,
          // token included in signedUrl query already, but returning it is useful for debugging
          token: (data as any).token ?? null,
          mimeType: m.type,
          sizeBytes: m.size,
          originalName: m.name,
        });
      }

      return json({ ok: true, uploads }, 200);
    }

    // =========================
    // NORMAL SUBMIT
    // =========================
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

    const firstName = stringOrNull(body.firstName);
    const lastName = stringOrNull(body.lastName);
    const email = stringOrNull(body.email);
    const phone = stringOrNull(body.phone);
    const address = stringOrNull(body.address);

    const wilayaCode = parseIntOrNull(body.wilayaCode);
    const communeId = stringOrNull(body.communeId);

    const pageUrl = stringOrNull(body.pageUrl);
    const referrer = stringOrNull(body.referrer) || request.headers.get("referer") || null;

    const ip =
      stringOrNull(body.ip) ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      null;

    const userAgent = request.headers.get("user-agent") ?? null;

    const productId = stringOrNull(body.productId);
    const variantId = stringOrNull(body.variantId);
    const qty = parseQty(body.qty);

    let itemsInput: any = body.items;

    if (typeof itemsInput === "string") {
      const s = itemsInput.trim();
      if (s) {
        try {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) itemsInput = parsed;
        } catch {
          // ignore
        }
      }
    }

    const items =
      Array.isArray(itemsInput) && itemsInput.length
        ? itemsInput
            .map((it: any) => ({
              productId: stringOrNull(it?.productId),
              variantId: stringOrNull(it?.variantId),
              qty: parseQty(it?.qty),
            }))
            .filter((it: any) => Boolean(it.productId))
        : productId
        ? [{ productId, variantId, qty }]
        : null;

    if (!items || items.length === 0) {
      return json({ ok: false, error: "At least one item is required" }, 400);
    }

    // Accept either real multipart files OR preuploaded metadata (preferred for big files)
    const files = [
      ...asFiles(body.document),
      ...asFiles(body.documents),
      ...asFiles(body["documents[]"]),
      ...asFiles(body.files),
      ...asFiles(body["files[]"]),
    ];

    const uploadedFiles =
      parseUploadedFiles(body.uploadedFiles) ||
      parseUploadedFiles(body.uploads) ||
      parseUploadedFiles(body.preuploaded);

    if (needsDoc && files.length === 0 && uploadedFiles.length === 0) {
      return json({ ok: false, error: "Document is required for this role" }, 400);
    }

    if (files.length > 10 || uploadedFiles.length > 10) {
      return json({ ok: false, error: "Maximum 10 files allowed" }, 400);
    }

    // Validate real files (legacy path) using your existing helper (may have smaller default limits)
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

    // Validate uploadedFiles metadata similarly (type + size)
    // (Use a larger default than legacy path, because these do NOT hit your server size limit.)
    const metaMaxSize =
      typeof requirement?.maxSizeBytes === "number" && requirement.maxSizeBytes > 0
        ? requirement.maxSizeBytes
        : 25 * 1024 * 1024;

    for (const uf of uploadedFiles) {
      const mt = uf.mimeType || "";
      if (!mt || !mimeAllowed(mt, allowedMimeTypes)) {
        return json({ ok: false, error: `File type not allowed: ${mt || "unknown"}` }, 400);
      }
      if (typeof uf.sizeBytes === "number" && uf.sizeBytes > metaMaxSize) {
        return json({
          ok: false,
          error: `File too large: ${uf.originalName || uf.path} (${Math.ceil(
            uf.sizeBytes / 1024 / 1024
          )}MB). Max is ${Math.floor(metaMaxSize / 1024 / 1024)}MB.`,
        }, 400);
      }
    }

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

    const baseValues = parseValues((body as any).values);
    const productTitle =
      stringOrNull(body.productTitle) || stringOrNull((baseValues as any)?.productTitle);
    const productUrl =
      stringOrNull(body.productUrl) || stringOrNull((baseValues as any)?.productUrl);
    const productImageUrl =
      stringOrNull(body.productImageUrl) || stringOrNull((baseValues as any)?.productImageUrl);

    const values = {
      ...(baseValues || {}),
      ...(productTitle ? { productTitle } : {}),
      ...(productUrl ? { productUrl } : {}),
      ...(productImageUrl ? { productImageUrl } : {}),
    };

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

        productId: primary.productId!,
        variantId: primary.variantId,
        qty: primary.qty,

        values,

        items: { create: items as any },
      },
      select: { id: true, createdAt: true },
    });

    // Attachments
    if (files.length || uploadedFiles.length) {
      const bucket = process.env.SUPABASE_REVIEW_MEDIA_BUCKET || "leadform-uploads";

      try {
        // A) preuploaded files: move into final request folder + create Upload rows
        if (uploadedFiles.length) {
          const supabase = getSupabaseAdmin();

          for (const uf of uploadedFiles) {
            const fromPath = uf.path;
            const originalName = uf.originalName || "document";
            const toPath = makeRequestUploadPath({
              shopId: shop.id,
              requestId: created.id,
              originalName,
            });

            let finalPath = fromPath;

            // Try to move (keeps storage organized). If move fails, keep original path.
            try {
              const { error: moveErr } = await supabase.storage.from(uf.bucket || bucket).move(fromPath, toPath);
              if (!moveErr) finalPath = toPath;
            } catch {
              // ignore
            }

            const uploadRow = await prisma.upload.create({
              data: {
                shopId: shop.id,
                provider: "supabase",
                bucket: uf.bucket || bucket,
                path: finalPath,
                url: null,
                mimeType: uf.mimeType || "application/octet-stream",
                sizeBytes: uf.sizeBytes ?? null,
                checksum: null,
                purpose: "role_document",
              },
              select: { id: true },
            });

            await prisma.requestAttachment.create({
              data: {
                requestId: created.id,
                uploadId: uploadRow.id,
                requirementKey: requirement?.key ?? "documents",
                label: originalName || requirement?.label || "Document",
              },
              select: { id: true },
            });
          }
        }

        // B) legacy multipart files: upload through server (small files only)
        if (files.length) {
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
                url: null,
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
        }
      } catch (e: any) {
        await prisma.request.delete({ where: { id: created.id } }).catch(() => {});
        return json({ ok: false, error: e?.message || "Upload failed" }, 500);
      }
    }

    // Fire pixels (best-effort)
    await Promise.race([
      firePixelsForRequest({
        shopId: shop.id,
        event: "request_submitted",
        request: {
          id: created.id,
          email,
          phone,
          ip,
          userAgent,
          pageUrl,
          referrer,
          productId: primary.productId!,
          qty: primary.qty,
          createdAt: created.createdAt,
          items: (items as any).map((it: any) => ({
            productId: it.productId!,
            qty: it.qty,
          })),
          currency: "DZD",
          value: 0,
        },
      }),
      new Promise((resolve) => setTimeout(resolve, 800)),
    ]).catch(() => {});

    // DB -> Sheet (best-effort; never block customer)
    syncRequestToPrimarySheet(verified.shop, created.id).catch(() => {});

    return json({
      ok: true,
      requestId: created.id,
      uploadReceived: (files.length || uploadedFiles.length) ? (files.length + uploadedFiles.length) : 0,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || "Server error" }, 500);
  }
};
