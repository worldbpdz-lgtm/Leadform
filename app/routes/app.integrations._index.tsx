// app/routes/app.integrations._index.tsx
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData, useLocation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { google } from "googleapis";

import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

import {
  createLeadformSpreadsheet,
  linkExistingSpreadsheet,
  parseSpreadsheetId,
  exportRequestsToSpreadsheet,
} from "~/lib/sheets.server";
import {
  decryptString,
  encryptString,
  getGoogleOAuthClient,
} from "~/lib/google.server";

type SheetConnRow = {
  id: string;
  spreadsheetId: string;
  spreadsheetName: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type LoaderData = {
  google: {
    connected: boolean;
    tokenExpiresAt: string | null;
  };
  primary: {
    connectionId: string | null;
    spreadsheetId: string | null;
    spreadsheetUrl: string | null;
  };
  connections: SheetConnRow[];
  recipients: Array<{ id: string; email: string; active: boolean; createdAt: string }>;
  limits: { recipientsMax: number };
};

type ActionData =
  | { ok: true; message?: string }
  | { ok: false; error: string; message?: string };

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Important:
 * Shopify shows a generic “Application error” if an action throws uncaught.
 * This file hardens all intents with try/catch and returns structured {ok:false,...}.
 *
 * Additional hardening:
 * - Handle google_reconnect_required (from sheets.server.ts refresh logic)
 * - Safer token refresh for Drive deletes
 * - Prevent cross-shop updates by scoping update/delete queries with shopId
 * - Avoid picking an inactive sheet as primary in loader
 */

function normalizeGoogleError(e: any): string {
  const msg = String(e?.message || "");
  const status = e?.code ? String(e.code) : "";
  const reason =
    e?.response?.data?.error?.toString?.() ||
    e?.response?.data?.error?.message ||
    e?.errors?.[0]?.reason ||
    "";
  const combined = [msg, status, reason].filter(Boolean).join(" | ");
  return combined || "google_error";
}

function isInvalidGrant(e: any) {
  const m = normalizeGoogleError(e).toLowerCase();
  return m.includes("invalid_grant") || m.includes("invalid grant");
}

function friendlyErrorMessage(code: string, fallback?: string) {
  if (code === "google_not_connected")
    return "Google is not connected. Please connect Google again.";
  if (code === "invalid_grant" || code === "google_reconnect_required")
    return "Google authorization expired or was revoked. Please reconnect Google.";
  if (code === "shop_not_found")
    return "Shop not found. Reinstall the app or refresh the page.";
  if (code === "invalid_sheet_id") return "Invalid Spreadsheet URL/ID.";
  if (code === "sheet_not_found") return "Sheet not found.";
  if (code === "delete_failed")
    return fallback || "Delete failed (insufficient Drive permissions).";
  if (code === "sheet_create_failed") return "Failed to create a new sheet.";
  if (code === "limit_reached") return "Limit reached (10 emails).";
  if (code === "invalid_email") return "Invalid email.";
  return fallback || "Something went wrong.";
}

function extractErrorCode(e: any): { code: string; message?: string } {
  const msg = String(e?.message || "");
  if (msg.includes("google_not_connected"))
    return { code: "google_not_connected", message: msg };
  if (msg.includes("google_reconnect_required"))
    return { code: "google_reconnect_required", message: msg };
  if (msg.includes("invalid_grant"))
    return { code: "invalid_grant", message: msg };
  if (msg.includes("shop_not_found"))
    return { code: "shop_not_found", message: msg };
  if (msg.includes("sheet_create_failed"))
    return { code: "sheet_create_failed", message: msg };
  if (msg.includes("invalid_sheet_id"))
    return { code: "invalid_sheet_id", message: msg };
  if (msg.includes("sheet_not_found"))
    return { code: "sheet_not_found", message: msg };
  return { code: "unknown", message: msg || undefined };
}

async function getGoogleClientForShopId(shopId: string) {
  const oauth = await prisma.oAuthGoogle.findUnique({
    where: { shopId },
    select: { accessTokenEnc: true, refreshTokenEnc: true, expiresAt: true },
  });
  if (!oauth) throw new Error("google_not_connected");

  const client = getGoogleOAuthClient();

  const accessToken = decryptString(oauth.accessTokenEnc);
  const refreshToken = oauth.refreshTokenEnc ? decryptString(oauth.refreshTokenEnc) : "";

  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken || undefined,
  });

  // No refresh token => cannot refresh reliably; force reconnect
  if (!refreshToken) {
    throw new Error("google_reconnect_required");
  }

  // Force refresh if needed; persist new access token + expiresAt when available.
  try {
    const before = String(client.credentials.access_token || "");
    await client.getAccessToken();
    const after = String(client.credentials.access_token || "");
    const expiry = (client.credentials as any)?.expiry_date;

    if (after && after !== before) {
      await prisma.oAuthGoogle.update({
        where: { shopId },
        data: {
          accessTokenEnc: encryptString(after),
          ...(typeof expiry === "number" ? { expiresAt: new Date(expiry) } : {}),
        },
      });
    }
  } catch (e: any) {
    if (isInvalidGrant(e)) throw new Error("google_reconnect_required");
    throw new Error(normalizeGoogleError(e));
  }

  return client;
}

async function deleteSpreadsheetFile(shopId: string, spreadsheetId: string) {
  const client = await getGoogleClientForShopId(shopId);
  const drive = google.drive({ version: "v3", auth: client });

  try {
    await drive.files.delete({ fileId: spreadsheetId });
  } catch (e: any) {
    // Surface permission errors cleanly (action catch will display banner)
    throw new Error(`delete_failed: ${normalizeGoogleError(e)}`);
  }
}

async function pickPrimaryConnection(shopId: string) {
  const settings = await prisma.shopSettings.findUnique({
    where: { shopId },
    select: { primarySheetsConnectionId: true },
  });

  if (settings?.primarySheetsConnectionId) {
    const conn = await prisma.sheetsConnection.findUnique({
      where: { id: settings.primarySheetsConnectionId },
      select: {
        id: true,
        spreadsheetId: true,
        spreadsheetName: true,
        active: true,
        updatedAt: true,
        createdAt: true,
      },
    });
    // Only accept settings primary if it is active (prevents showing a “primary” that was removed)
    if (conn?.active) return { settingsPrimaryId: settings.primarySheetsConnectionId, conn };
  }

  // fallback: latest active
  const fallback = await prisma.sheetsConnection.findFirst({
    where: { shopId, active: true },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      spreadsheetId: true,
      spreadsheetName: true,
      active: true,
      updatedAt: true,
      createdAt: true,
    },
  });

  return { settingsPrimaryId: settings?.primarySheetsConnectionId ?? null, conn: fallback };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!shop) {
    const data: LoaderData = {
      google: { connected: false, tokenExpiresAt: null },
      primary: { connectionId: null, spreadsheetId: null, spreadsheetUrl: null },
      connections: [],
      recipients: [],
      limits: { recipientsMax: 10 },
    };
    return data;
  }

  const [oauth, recipients, connections, primaryPick] = await Promise.all([
    prisma.oAuthGoogle.findUnique({
      where: { shopId: shop.id },
      select: { id: true, expiresAt: true },
    }),
    prisma.notificationRecipient.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, active: true, createdAt: true },
    }),
    prisma.sheetsConnection.findMany({
      where: { shopId: shop.id },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        spreadsheetId: true,
        spreadsheetName: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    pickPrimaryConnection(shop.id),
  ]);

  const primaryConn = primaryPick.conn ?? null;
  const spreadsheetId = primaryConn?.spreadsheetId ?? null;
  const spreadsheetUrl = spreadsheetId
    ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
    : null;

  const data: LoaderData = {
    google: {
      connected: Boolean(oauth),
      tokenExpiresAt: oauth?.expiresAt ? oauth.expiresAt.toISOString() : null,
    },
    primary: {
      connectionId: primaryConn?.id ?? null,
      spreadsheetId,
      spreadsheetUrl,
    },
    connections: connections.map((c) => ({
      id: c.id,
      spreadsheetId: c.spreadsheetId,
      spreadsheetName: c.spreadsheetName,
      active: c.active,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    recipients: recipients.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    limits: { recipientsMax: 10 },
  };

  return data;
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData> => {
  const { session } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) return { ok: false, error: "shop_not_found" };

  try {
    // ─────────────────────────────────────────
    // Notifications recipients (max 10)
    // ─────────────────────────────────────────
    if (intent === "addRecipient") {
      const email = String(fd.get("email") || "").trim().toLowerCase();
      if (!isValidEmail(email)) return { ok: false, error: "invalid_email" };

      const count = await prisma.notificationRecipient.count({
        where: { shopId: shop.id },
      });
      if (count >= 10) return { ok: false, error: "limit_reached" };

      await prisma.notificationRecipient.upsert({
        where: { shopId_email: { shopId: shop.id, email } },
        update: { active: true },
        create: { shopId: shop.id, email, active: true },
      });

      return { ok: true, message: "Recipient added." };
    }

    if (intent === "toggleRecipient") {
      const id = String(fd.get("id") || "");
      const active = String(fd.get("active") || "") === "true";

      const res = await prisma.notificationRecipient.updateMany({
        where: { id, shopId: shop.id },
        data: { active },
      });

      if (res.count === 0) return { ok: false, error: "not_found" };
      return { ok: true, message: "Recipient updated." };
    }

    if (intent === "deleteRecipient") {
      const id = String(fd.get("id") || "");

      const res = await prisma.notificationRecipient.deleteMany({
        where: { id, shopId: shop.id },
      });

      if (res.count === 0) return { ok: false, error: "not_found" };
      return { ok: true, message: "Recipient removed." };
    }

    // ─────────────────────────────────────────
    // Google / Sheets
    // ─────────────────────────────────────────
    if (intent === "disconnectGoogle") {
      await prisma.$transaction([
        prisma.sheetsConnection.updateMany({
          where: { shopId: shop.id },
          data: { active: false },
        }),
        prisma.shopSettings.upsert({
          where: { shopId: shop.id },
          update: { primarySheetsConnectionId: null },
          create: { shopId: shop.id, primarySheetsConnectionId: null },
        }),
        prisma.oAuthGoogle.deleteMany({ where: { shopId: shop.id } }),
      ]);
      return { ok: true, message: "Google disconnected." };
    }

    if (intent === "createSheet") {
      const res = await createLeadformSpreadsheet(session.shop);
      return { ok: true, message: `Sheet created: ${res.spreadsheetId}` };
    }

    if (intent === "linkSheet") {
      const input = String(fd.get("spreadsheet") || "");
      const spreadsheetId = parseSpreadsheetId(input);
      if (!spreadsheetId) return { ok: false, error: "invalid_sheet_id" };

      await linkExistingSpreadsheet(session.shop, spreadsheetId);
      return { ok: true, message: "Sheet linked and activated." };
    }

    if (intent === "activateSheet") {
      const connectionId = String(fd.get("connectionId") || "");
      const conn = await prisma.sheetsConnection.findFirst({
        where: { id: connectionId, shopId: shop.id },
        select: { id: true, spreadsheetId: true },
      });
      if (!conn) return { ok: false, error: "sheet_not_found" };

      await prisma.$transaction([
        prisma.sheetsConnection.updateMany({
          where: { shopId: shop.id },
          data: { active: false },
        }),
        prisma.sheetsConnection.update({ where: { id: conn.id }, data: { active: true } }),
        prisma.shopSettings.upsert({
          where: { shopId: shop.id },
          update: { primarySheetsConnectionId: conn.id },
          create: { shopId: shop.id, primarySheetsConnectionId: conn.id },
        }),
      ]);

      await exportRequestsToSpreadsheet({
        shopDomain: session.shop,
        spreadsheetId: conn.spreadsheetId,
      });

      return { ok: true, message: "Sheet activated and exported." };
    }

    if (intent === "removeSheet") {
      const connectionId = String(fd.get("connectionId") || "");

      const settings = await prisma.shopSettings.findUnique({
        where: { shopId: shop.id },
        select: { primarySheetsConnectionId: true },
      });

      const isPrimary = settings?.primarySheetsConnectionId === connectionId;

      await prisma.$transaction([
        prisma.sheetsConnection.updateMany({
          where: { id: connectionId, shopId: shop.id },
          data: { active: false },
        }),
        ...(isPrimary
          ? [
              prisma.shopSettings.upsert({
                where: { shopId: shop.id },
                update: { primarySheetsConnectionId: null },
                create: { shopId: shop.id, primarySheetsConnectionId: null },
              }),
            ]
          : []),
      ]);

      if (isPrimary) {
        const fallback = await prisma.sheetsConnection.findFirst({
          where: { shopId: shop.id, id: { not: connectionId } },
          orderBy: { updatedAt: "desc" },
          select: { id: true, spreadsheetId: true },
        });

        if (fallback) {
          await prisma.$transaction([
            prisma.sheetsConnection.updateMany({
              where: { shopId: shop.id },
              data: { active: false },
            }),
            prisma.sheetsConnection.update({
              where: { id: fallback.id },
              data: { active: true },
            }),
            prisma.shopSettings.upsert({
              where: { shopId: shop.id },
              update: { primarySheetsConnectionId: fallback.id },
              create: { shopId: shop.id, primarySheetsConnectionId: fallback.id },
            }),
          ]);

          await exportRequestsToSpreadsheet({
            shopDomain: session.shop,
            spreadsheetId: fallback.spreadsheetId,
          });

          return { ok: true, message: "Primary removed. Another sheet was activated." };
        }

        return { ok: true, message: "Primary removed. No remaining sheets to activate." };
      }

      return { ok: true, message: "Sheet removed from app." };
    }

    if (intent === "deleteSheet") {
      const connectionId = String(fd.get("connectionId") || "");

      const conn = await prisma.sheetsConnection.findFirst({
        where: { id: connectionId, shopId: shop.id },
        select: { id: true, spreadsheetId: true },
      });
      if (!conn) return { ok: false, error: "sheet_not_found" };

      const settings = await prisma.shopSettings.findUnique({
        where: { shopId: shop.id },
        select: { primarySheetsConnectionId: true },
      });
      const isPrimary = settings?.primarySheetsConnectionId === conn.id;

      await deleteSpreadsheetFile(shop.id, conn.spreadsheetId);

      await prisma.$transaction([
        prisma.sheetsConnection.delete({ where: { id: conn.id } }),
        ...(isPrimary
          ? [
              prisma.shopSettings.upsert({
                where: { shopId: shop.id },
                update: { primarySheetsConnectionId: null },
                create: { shopId: shop.id, primarySheetsConnectionId: null },
              }),
            ]
          : []),
      ]);

      if (isPrimary) {
        const fallback = await prisma.sheetsConnection.findFirst({
          where: { shopId: shop.id },
          orderBy: { updatedAt: "desc" },
          select: { id: true, spreadsheetId: true },
        });

        if (fallback) {
          await prisma.$transaction([
            prisma.sheetsConnection.updateMany({
              where: { shopId: shop.id },
              data: { active: false },
            }),
            prisma.sheetsConnection.update({
              where: { id: fallback.id },
              data: { active: true },
            }),
            prisma.shopSettings.upsert({
              where: { shopId: shop.id },
              update: { primarySheetsConnectionId: fallback.id },
              create: { shopId: shop.id, primarySheetsConnectionId: fallback.id },
            }),
          ]);

          await exportRequestsToSpreadsheet({
            shopDomain: session.shop,
            spreadsheetId: fallback.spreadsheetId,
          });

          return { ok: true, message: "Sheet deleted. Another sheet was activated." };
        }
      }

      return { ok: true, message: "Sheet deleted." };
    }

    if (intent === "deleteAndReplace") {
      const connectionId = String(fd.get("connectionId") || "");

      const conn = await prisma.sheetsConnection.findFirst({
        where: { id: connectionId, shopId: shop.id },
        select: { id: true, spreadsheetId: true },
      });
      if (!conn) return { ok: false, error: "sheet_not_found" };

      await deleteSpreadsheetFile(shop.id, conn.spreadsheetId);

      await prisma.$transaction([
        prisma.sheetsConnection.delete({ where: { id: conn.id } }),
        prisma.shopSettings.upsert({
          where: { shopId: shop.id },
          update: { primarySheetsConnectionId: null },
          create: { shopId: shop.id, primarySheetsConnectionId: null },
        }),
      ]);

      const res = await createLeadformSpreadsheet(session.shop);
      return { ok: true, message: `Replaced with new sheet: ${res.spreadsheetId}` };
    }

    if (intent === "exportActive") {
      await exportRequestsToSpreadsheet({ shopDomain: session.shop });
      return { ok: true, message: "Active sheet exported." };
    }

    return { ok: false, error: "unknown_intent" };
  } catch (e: any) {
    // Prefer deterministic codes surfaced by libs
    const extracted = extractErrorCode(e);

    // Normalize delete_failed: ...
    if (String(e?.message || "").startsWith("delete_failed:")) {
      return {
        ok: false,
        error: "delete_failed",
        message: String(e.message).replace(/^delete_failed:\s*/i, ""),
      };
    }

    // If google refresh/consent is required, ensure the UI shows a reconnect message.
    if (extracted.code === "google_reconnect_required" || extracted.code === "invalid_grant") {
      return {
        ok: false,
        error: "google_reconnect_required",
        message: "Google authorization expired or was revoked. Please reconnect Google.",
      };
    }

    if (extracted.code === "google_not_connected") {
      return {
        ok: false,
        error: "google_not_connected",
        message: "Google is not connected. Please connect Google again.",
      };
    }

    return {
      ok: false,
      error: extracted.code === "unknown" ? "unknown" : extracted.code,
      message: extracted.message || "Request failed.",
    };
  }
};

export default function IntegrationsIndex() {
  const data = useLoaderData() as LoaderData;
  const actionData = useActionData() as ActionData | undefined;
  const location = useLocation();

  // Preserve embedded params for internal navigation
  const qs = new URLSearchParams(location.search);
  const shop = qs.get("shop");
  const host = qs.get("host");
  const hasEmbedParams = Boolean(shop && host);

  // Google OAuth cannot be framed inside Shopify Admin (iframe), so we must escape iframe.
  const embeddedQuery = qs.toString();
  const googleStartHref = `/app/integrations/google/start${embeddedQuery ? `?${embeddedQuery}` : ""}`;

  const expiryLabel = data.google.tokenExpiresAt
    ? new Date(data.google.tokenExpiresAt).toLocaleString()
    : "—";
  const connected = data.google.connected;

  const primaryConnId = data.primary.connectionId;

  const showBanner = Boolean(actionData);
  const bannerIsOk = Boolean((actionData as any)?.ok);
  const bannerText = bannerIsOk
    ? (actionData as any)?.message || "Done."
    : friendlyErrorMessage(
        (actionData as any)?.error || "unknown",
        (actionData as any)?.message
      );

  // If we just got a reconnect-required error, present the Connect CTA even if oauth row exists.
  const wantsReconnect =
    !bannerIsOk &&
    (actionData as any)?.error &&
    ["google_reconnect_required", "invalid_grant"].includes(String((actionData as any).error));

  return (
    <div className="lf-enter" style={{ display: "grid", gap: 14 }}>
      {/* TABLE 1: Notifications Emails */}
      <div className="lf-card">
        <div
          className="lf-card-heading"
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontWeight: 800 }}>Notification emails</div>
            <div className="lf-muted">
              Up to {data.limits.recipientsMax}. Every active email receives a “new request”
              notification with a direct link to the active sheet.
            </div>
          </div>
          <div className="lf-muted">
            {data.recipients.length}/{data.limits.recipientsMax}
          </div>
        </div>

        <Form method="post" className="lf-toolbar" style={{ marginTop: 12, gap: 10 }}>
          <input type="hidden" name="intent" value="addRecipient" />
          <input className="lf-input" name="email" placeholder="Add recipient email…" />
          <button className="lf-pill lf-pill--primary" type="submit">
            Add
          </button>

          {actionData && !bannerIsOk && (actionData as any)?.error === "limit_reached" ? (
            <span className="lf-muted" style={{ color: "rgba(239,68,68,.9)" }}>
              Limit reached (10).
            </span>
          ) : null}
          {actionData && !bannerIsOk && (actionData as any)?.error === "invalid_email" ? (
            <span className="lf-muted" style={{ color: "rgba(239,68,68,.9)" }}>
              Invalid email.
            </span>
          ) : null}
        </Form>

        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table className="lf-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Email</th>
                <th style={{ width: 120 }}>Active</th>
                <th style={{ width: 160 }}>Added</th>
                <th style={{ textAlign: "right", width: 140 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.recipients.map((r) => (
                <tr key={r.id} className="lf-row-hover">
                  <td style={{ fontWeight: 650 }}>{r.email}</td>
                  <td>
                    <Form method="post">
                      <input type="hidden" name="intent" value="toggleRecipient" />
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="active" value={String(!r.active)} />
                      <button
                        className={r.active ? "lf-pill lf-pill--success" : "lf-pill"}
                        type="submit"
                      >
                        {r.active ? "On" : "Off"}
                      </button>
                    </Form>
                  </td>
                  <td className="lf-muted">{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td style={{ textAlign: "right" }}>
                    <Form method="post">
                      <input type="hidden" name="intent" value="deleteRecipient" />
                      <input type="hidden" name="id" value={r.id} />
                      <button className="lf-pill lf-pill--danger" type="submit">
                        Remove
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
              {data.recipients.length === 0 ? (
                <tr>
                  <td colSpan={4} className="lf-muted" style={{ padding: 14 }}>
                    No recipients yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* TABLE 2: Google Sheets */}
      <div className="lf-card">
        <div
          className="lf-card-heading"
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontWeight: 800 }}>Google Sheets</div>
            <div className="lf-muted">
              Connect Google, then create a premium “Requests” sheet or link an existing one. You can
              keep multiple sheets and activate one (used for emails + auto-sync).
            </div>
          </div>
          <div className="lf-muted">
            {connected ? "Connected" : "Not connected"} • Token expires: {expiryLabel}
          </div>
        </div>

        {showBanner ? (
          <div className="lf-toolbar" style={{ marginTop: 12 }}>
            <div
              className={bannerIsOk ? "lf-pill lf-pill--success" : "lf-pill lf-pill--danger"}
              style={{ whiteSpace: "normal", lineHeight: 1.35 }}
            >
              {bannerText}
            </div>
          </div>
        ) : null}

        {!hasEmbedParams ? (
          <div className="lf-toolbar" style={{ marginTop: 12 }}>
            <div className="lf-muted">
              Open this page from inside Shopify Admin (embedded). Missing shop/host in URL.
            </div>
          </div>
        ) : !connected || wantsReconnect ? (
          <div className="lf-toolbar" style={{ marginTop: 12, gap: 10, flexWrap: "wrap" }}>
            <a
              className="lf-pill lf-pill--primary"
              href={googleStartHref}
              target="_top"
              rel="noreferrer"
              style={{ textDecoration: "none" }}
            >
              {wantsReconnect ? "Reconnect Google" : "Connect Google"}
            </a>
            {connected ? (
              <Form method="post">
                <input type="hidden" name="intent" value="disconnectGoogle" />
                <button className="lf-pill" type="submit">
                  Disconnect
                </button>
              </Form>
            ) : null}
          </div>
        ) : (
          <div className="lf-toolbar" style={{ marginTop: 12, gap: 10, flexWrap: "wrap" }}>
            <Form method="post">
              <input type="hidden" name="intent" value="disconnectGoogle" />
              <button className="lf-pill" type="submit">
                Disconnect
              </button>
            </Form>

            <Form method="post">
              <input type="hidden" name="intent" value="createSheet" />
              <button className="lf-pill lf-pill--primary" type="submit">
                Create sheet
              </button>
            </Form>

            <Form method="post" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input type="hidden" name="intent" value="linkSheet" />
              <input
                className="lf-input"
                name="spreadsheet"
                placeholder="Paste Spreadsheet URL or ID…"
                style={{ minWidth: 320 }}
              />
              <button className="lf-pill" type="submit">
                Link
              </button>
            </Form>

            <Form method="post">
              <input type="hidden" name="intent" value="exportActive" />
              <button className="lf-pill" type="submit">
                Export active
              </button>
            </Form>
          </div>
        )}

        {/* Saved sheets table */}
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table className="lf-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Sheet</th>
                <th style={{ width: 150 }}>Updated</th>
                <th style={{ width: 120 }}>Status</th>
                <th style={{ textAlign: "right", width: 520 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.connections.map((c) => {
                const isPrimary = c.id === primaryConnId;
                const url = `https://docs.google.com/spreadsheets/d/${c.spreadsheetId}`;

                return (
                  <tr key={c.id} className="lf-row-hover">
                    <td>
                      <div style={{ fontWeight: 700 }}>
                        {c.spreadsheetName || "Google Sheet"}
                        {isPrimary ? (
                          <span className="lf-pill lf-pill--success" style={{ marginLeft: 8 }}>
                            Active
                          </span>
                        ) : null}
                      </div>
                      <div className="lf-muted" style={{ fontSize: 12 }}>
                        {c.spreadsheetId}
                      </div>
                    </td>

                    <td className="lf-muted">{new Date(c.updatedAt).toLocaleString()}</td>

                    <td>
                      {c.active ? (
                        <span className="lf-pill lf-pill--success">On</span>
                      ) : (
                        <span className="lf-pill">Off</span>
                      )}
                    </td>

                    <td style={{ textAlign: "right" }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "flex-end",
                          gap: 10,
                          flexWrap: "wrap",
                        }}
                      >
                        <a
                          className="lf-pill lf-pill--primary"
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ textDecoration: "none" }}
                        >
                          Open
                        </a>

                        {!isPrimary ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="activateSheet" />
                            <input type="hidden" name="connectionId" value={c.id} />
                            <button className="lf-pill lf-pill--success" type="submit">
                              Activate
                            </button>
                          </Form>
                        ) : null}

                        {connected && isPrimary ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="deleteAndReplace" />
                            <input type="hidden" name="connectionId" value={c.id} />
                            <button className="lf-pill lf-pill--danger" type="submit">
                              Delete &amp; replace
                            </button>
                          </Form>
                        ) : null}

                        <Form method="post">
                          <input type="hidden" name="intent" value="removeSheet" />
                          <input type="hidden" name="connectionId" value={c.id} />
                          <button className="lf-pill" type="submit">
                            Remove
                          </button>
                        </Form>

                        {connected ? (
                          <Form method="post">
                            <input type="hidden" name="intent" value="deleteSheet" />
                            <input type="hidden" name="connectionId" value={c.id} />
                            <button className="lf-pill lf-pill--danger" type="submit">
                              Delete
                            </button>
                          </Form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {data.connections.length === 0 ? (
                <tr>
                  <td colSpan={4} className="lf-muted" style={{ padding: 14 }}>
                    No sheets saved yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="lf-muted lf-mt-2">
          Active sheet is used for: notification email links, DB → Sheet sync, and full exports.
        </div>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
