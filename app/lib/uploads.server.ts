// app/lib/uploads.server.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";

const DEFAULT_ALLOWED = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB

function getEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

let _client: SupabaseClient | null = null;
export function supabaseAdmin(): SupabaseClient {
  if (_client) return _client;

  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  _client = createClient(url, key, {
    auth: { persistSession: false },
  });

  return _client;
}

export type UploadValidation = {
  allowedMimeTypes?: string[]; // if provided, overrides default set
  maxSizeBytes?: number;       // if provided, overrides default
};

export function validateUploadFile(file: File, v?: UploadValidation) {
  const allowed = new Set(
    (v?.allowedMimeTypes && v.allowedMimeTypes.length ? v.allowedMimeTypes : Array.from(DEFAULT_ALLOWED))
      .map((s) => s.toLowerCase())
  );

  const mime = (file.type || "").toLowerCase();
  if (!mime || !allowed.has(mime)) {
    throw new Error(
      `Invalid file type. Allowed: ${Array.from(allowed).join(", ")}`
    );
  }

  const max = v?.maxSizeBytes ?? DEFAULT_MAX_BYTES;
  if (file.size > max) {
    throw new Error(`File too large. Max ${(max / (1024 * 1024)).toFixed(0)}MB`);
  }
}

function safeFilename(name: string) {
  // keep it simple: remove weird chars
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
}

export async function uploadToSupabase(params: {
  bucket: string;
  path: string;
  file: File;
}) {
  const supabase = supabaseAdmin();

  const ab = await params.file.arrayBuffer();
  const bytes = new Uint8Array(ab);

  const checksum = createHash("sha256").update(bytes).digest("hex");

  const { error } = await supabase.storage
    .from(params.bucket)
    .upload(params.path, bytes, {
      contentType: params.file.type || undefined,
      upsert: false,
    });

  if (error) throw new Error(`Upload failed: ${error.message}`);

  return {
    checksum,
    sizeBytes: params.file.size,
    mimeType: params.file.type || null,
  };
}

export async function createSignedUrl(params: {
  bucket: string;
  path: string;
  expiresInSeconds?: number;
}) {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase.storage
    .from(params.bucket)
    .createSignedUrl(params.path, params.expiresInSeconds ?? 60 * 60);

  if (error) return null;
  return data?.signedUrl ?? null;
}

export function makeRequestUploadPath(input: {
  shopId: string;
  requestId: string;
  originalName: string;
}) {
  const stamp = Date.now();
  const rand = randomBytes(8).toString("hex");
  const name = safeFilename(input.originalName || "document");
  return `${input.shopId}/requests/${input.requestId}/${stamp}-${rand}-${name}`;
}
