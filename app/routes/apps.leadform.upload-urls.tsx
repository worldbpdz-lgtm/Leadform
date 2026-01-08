import type { ActionFunctionArgs } from "react-router";
import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parse as parseQuery } from "node:querystring";
import prisma from "~/db.server";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

type VerifyOk = { ok: true; shop: string };
type VerifyFail = { ok: false; reason: string };
type VerifyResult = VerifyOk | VerifyFail;

function verifyAppProxyRequest(url: URL): VerifyResult {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return { ok: false, reason: "Missing SHOPIFY_API_SECRET" };

  const q = parseQuery(url.searchParams.toString());

  const signature = String(q.signature || "");
  const hmac = String(q.hmac || "");
  if (!signature || !hmac) return { ok: false, reason: "Missing signature/hmac" };

  delete (q as any).signature;
  delete (q as any).hmac;

  const msg = Object.keys(q)
    .sort()
    .map((k) => `${k}=${Array.isArray((q as any)[k]) ? (q as any)[k].join(",") : (q as any)[k]}`)
    .join("");

  const sig = createHmac("sha256", secret).update(msg).digest("hex");

  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "Bad signature" };

  const shop = String(q.shop || "");
  if (!shop) return { ok: false, reason: "Missing shop" };

  return { ok: true, shop };
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function sanitizeFileName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function inferStorageHostFromSupabaseUrl(supabaseUrl: string) {
  // https://<ref>.supabase.co -> https://<ref>.storage.supabase.co
  try {
    const u = new URL(supabaseUrl);
    const host = u.host; // <ref>.supabase.co
    const ref = host.split(".")[0];
    return `${u.protocol}//${ref}.storage.supabase.co`;
  } catch {
    return supabaseUrl;
  }
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25MB per file (adjust)
const ALLOWED_PREFIXES = ["image/", "application/pdf"];

export async function action({ request }: ActionFunctionArgs) {
  const url = new URL(request.url);
  const v = verifyAppProxyRequest(url);
  if (!v.ok) return json({ ok: false, error: v.reason }, 401);

  const { idempotencyKey, files } = await request.json().catch(() => ({} as any));

  if (!idempotencyKey || typeof idempotencyKey !== "string") {
    return json({ ok: false, error: "Missing idempotencyKey" }, 400);
  }
  if (!Array.isArray(files) || files.length < 1) {
    return json({ ok: false, error: "No files requested" }, 400);
  }
  if (files.length > 10) {
    return json({ ok: false, error: "Max 10 files" }, 400);
  }

  const supabaseUrl = mustEnv("SUPABASE_URL");
  const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  const bucket = process.env.SUPABASE_REVIEW_MEDIA_BUCKET || "leadform-uploads";
  const maxBytes = Number(process.env.LF_MAX_UPLOAD_BYTES || DEFAULT_MAX_BYTES);

  // Find shopId
  const shop = await prisma.shop.findUnique({ where: { shopDomain: v.shop }, select: { id: true } });
  if (!shop) return json({ ok: false, error: "Shop not found" }, 404);

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const storageHost = inferStorageHostFromSupabaseUrl(supabaseUrl);

  const uploads: Array<{
    path: string;
    token: string;
    uploadUrl: string;
    originalName: string;
    contentType: string;
    size: number;
  }> = [];

  for (const f of files) {
    const originalName = String(f?.name || "");
    const contentType = String(f?.type || "");
    const size = Number(f?.size || 0);

    if (!originalName || !contentType || !size) {
      return json({ ok: false, error: "Invalid file metadata" }, 400);
    }
    if (size > maxBytes) {
      return json({ ok: false, error: `File too large. Max is ${Math.floor(maxBytes / (1024 * 1024))}MB.` }, 400);
    }
    if (!ALLOWED_PREFIXES.some((p) => (p.endsWith("/") ? contentType.startsWith(p) : contentType === p))) {
      return json({ ok: false, error: `Unsupported file type: ${contentType}` }, 400);
    }

    const safe = sanitizeFileName(originalName);
    const rand = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const path = `${shop.id}/preuploads/${idempotencyKey}/${rand}-${safe}`;

    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path, { upsert: false });
    if (error || !data?.token) {
      return json({ ok: false, error: error?.message || "Failed to create signed upload URL" }, 500);
    }

    // Upload happens here (client will PUT file bytes to this URL)
    const uploadUrl = `${storageHost}/storage/v1/object/upload/sign/${bucket}/${encodeURIComponent(path)}?token=${encodeURIComponent(
      data.token
    )}`;

    uploads.push({ path, token: data.token, uploadUrl, originalName, contentType, size });
  }

  return json({ ok: true, bucket, uploads });
}
