// app/lib/uploads.server.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";

const DEFAULT_ALLOWED = [
  "application/pdf",
  "image/*", // wildcard supported
];

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
  maxSizeBytes?: number; // if provided, overrides default
};

function inferMimeFromName(name: string): string {
  const n = (name || "").toLowerCase();
  const ext = n.includes(".") ? n.split(".").pop() : "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "";
}

function isMimeAllowed(mime: string, rule: string) {
  const m = (mime || "").toLowerCase();
  const r = (rule || "").toLowerCase().trim();
  if (!m || !r) return false;

  // wildcard support: image/*
  if (r.endsWith("/*")) {
    const prefix = r.slice(0, -1); // "image/"
    return m.startsWith(prefix);
  }

  return m === r;
}

export function validateUploadFile(file: File, v?: UploadValidation) {
  if (!file || !(file instanceof File)) {
    throw new Error("Invalid file");
  }

  if (file.size <= 0) {
    throw new Error("Empty file");
  }

  const max = v?.maxSizeBytes ?? DEFAULT_MAX_BYTES;
  if (file.size > max) {
    throw new Error(`File too large. Max ${(max / (1024 * 1024)).toFixed(0)}MB`);
  }

  const allowed = (v?.allowedMimeTypes && v.allowedMimeTypes.length
    ? v.allowedMimeTypes
    : DEFAULT_ALLOWED
  ).map((s) => String(s).toLowerCase());

  // Some browsers send empty file.type; infer from filename as fallback
  const mime = (file.type || inferMimeFromName(file.name) || "").toLowerCase();

  const ok = allowed.some((rule) => isMimeAllowed(mime, rule));
  if (!ok) {
    throw new Error(`Invalid file type. Allowed: ${allowed.join(", ")}`);
  }

  return { mimeType: mime || null, sizeBytes: file.size };
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

  // Ensure we always pass a sensible contentType
  const inferred = (params.file.type || inferMimeFromName(params.file.name) || "").toLowerCase();

  const { error } = await supabase.storage
    .from(params.bucket)
    .upload(params.path, bytes, {
      contentType: inferred || undefined,
      upsert: false,
    });

  if (error) throw new Error(`Upload failed: ${error.message}`);

  return {
    checksum,
    sizeBytes: params.file.size,
    mimeType: inferred || null,
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
