// app/routes/app.integrations._index.tsx
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useActionData, useFetcher } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Redirect } from "@shopify/app-bridge/actions";
import { createLeadformSpreadsheet, linkExistingSpreadsheet, parseSpreadsheetId } from "~/lib/sheets.server";

type LoaderData = {
  google: {
    connected: boolean;
    tokenExpiresAt: string | null;
  };
  sheet: {
    spreadsheetId: string | null;
    spreadsheetUrl: string | null;
  };
  recipients: Array<{ id: string; email: string; active: boolean; createdAt: string }>;
  limits: { recipientsMax: number };
};

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
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
      sheet: { spreadsheetId: null, spreadsheetUrl: null },
      recipients: [],
      limits: { recipientsMax: 10 },
    };
    return data;
  }

  const [oauth, conn, recipients] = await Promise.all([
    prisma.oAuthGoogle.findUnique({
      where: { shopId: shop.id },
      select: { id: true, expiresAt: true },
    }),
    prisma.sheetsConnection.findFirst({
      where: { shopId: shop.id, active: true },
      select: { spreadsheetId: true, spreadsheetName: true, defaultSheetName: true },
    }),
    prisma.notificationRecipient.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, active: true, createdAt: true },
    }),
  ]);

  const spreadsheetId = conn?.spreadsheetId ?? null;
  const spreadsheetUrl = spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : null;

  const data: LoaderData = {
    google: {
      connected: Boolean(oauth),
      tokenExpiresAt: oauth?.expiresAt ? oauth.expiresAt.toISOString() : null,
    },
    sheet: { spreadsheetId, spreadsheetUrl },
    recipients: recipients.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    limits: { recipientsMax: 10 },
  };

  return data;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) return { ok: false, error: "shop_not_found" };

  // ─────────────────────────────────────────
  // Notifications recipients (max 10)
  // ─────────────────────────────────────────
  if (intent === "addRecipient") {
    const email = String(fd.get("email") || "").trim().toLowerCase();
    if (!isValidEmail(email)) return { ok: false, error: "invalid_email" };

    const count = await prisma.notificationRecipient.count({ where: { shopId: shop.id } });
    if (count >= 10) return { ok: false, error: "limit_reached" };

    await prisma.notificationRecipient.upsert({
      where: { shopId_email: { shopId: shop.id, email } },
      update: { active: true },
      create: { shopId: shop.id, email, active: true },
    });

    return { ok: true };
  }

  if (intent === "toggleRecipient") {
    const id = String(fd.get("id") || "");
    const active = String(fd.get("active") || "") === "true";
    await prisma.notificationRecipient.update({
      where: { id },
      data: { active },
    });
    return { ok: true };
  }

  if (intent === "deleteRecipient") {
    const id = String(fd.get("id") || "");
    await prisma.notificationRecipient.delete({ where: { id } });
    return { ok: true };
  }

  // ─────────────────────────────────────────
  // Google / Sheets
  // ─────────────────────────────────────────
  if (intent === "disconnectGoogle") {
    await prisma.sheetsConnection.updateMany({
      where: { shopId: shop.id },
      data: { active: false },
    });
    await prisma.oAuthGoogle.deleteMany({ where: { shopId: shop.id } });
    return { ok: true };
  }

  if (intent === "createSheet") {
    const res = await createLeadformSpreadsheet(session.shop);
    return { ok: true, created: true, spreadsheetUrl: res.spreadsheetUrl };
  }

  if (intent === "linkSheet") {
    const input = String(fd.get("spreadsheet") || "");
    const spreadsheetId = parseSpreadsheetId(input);
    if (!spreadsheetId) return { ok: false, error: "invalid_sheet_id" };

    const res = await linkExistingSpreadsheet(session.shop, spreadsheetId);
    return { ok: true, linked: true, spreadsheetUrl: res.spreadsheetUrl };
  }

  return { ok: false, error: "unknown_intent" };
};

export default function IntegrationsIndex() {
  const data = useLoaderData() as LoaderData;
  const actionData = useActionData() as any;

  // App Bridge remote redirect for Google OAuth (avoids iframe/CSP issues)
  const shopify = useAppBridge();
  const googleAuthFetcher = useFetcher<{ ok: boolean; authUrl?: string; error?: string }>();

  useEffect(() => {
    const authUrl = googleAuthFetcher.data?.authUrl;
    if (!authUrl) return;

    const redirect = Redirect.create(shopify);
    redirect.dispatch(Redirect.Action.REMOTE, authUrl);
  }, [googleAuthFetcher.data?.authUrl, shopify]);

  const expiryLabel = data.google.tokenExpiresAt ? new Date(data.google.tokenExpiresAt).toLocaleString() : "—";
  const connected = data.google.connected;

  return (
    <div className="lf-enter" style={{ display: "grid", gap: 14 }}>
      {/* TABLE 1: Notifications Emails */}
      <div className="lf-card">
        <div
          className="lf-card-heading"
          style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
        >
          <div>
            <div style={{ fontWeight: 800 }}>Notification emails</div>
            <div className="lf-muted">
              Up to {data.limits.recipientsMax}. Every active email receives a “new request” notification with a direct link
              to the sheet.
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

          {actionData?.error === "limit_reached" ? (
            <span className="lf-muted" style={{ color: "rgba(239,68,68,.9)" }}>
              Limit reached (10).
            </span>
          ) : null}
          {actionData?.error === "invalid_email" ? (
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
                      <button className={r.active ? "lf-pill lf-pill--success" : "lf-pill"} type="submit">
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
          style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
        >
          <div>
            <div style={{ fontWeight: 800 }}>Google Sheets</div>
            <div className="lf-muted">
              Connect Google, then create a premium “Requests” sheet or link an existing one. This will be the source of
              truth for two-way sync.
            </div>
          </div>
          <div className="lf-muted">
            {connected ? "Connected" : "Not connected"} • Token expires: {expiryLabel}
          </div>
        </div>

        {!connected ? (
          <div className="lf-toolbar" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="lf-pill lf-pill--primary"
              onClick={() => {
                const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
                googleAuthFetcher.load(`/app/integrations/google/auth-url?returnTo=${returnTo}`);
              }}
              disabled={googleAuthFetcher.state !== "idle"}
            >
              {googleAuthFetcher.state !== "idle" ? "Connecting…" : "Connect Google"}
            </button>

            {googleAuthFetcher.data?.error ? (
              <span className="lf-muted" style={{ color: "rgba(239,68,68,.9)" }}>
                {googleAuthFetcher.data.error}
              </span>
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
              {actionData?.error === "invalid_sheet_id" ? (
                <span className="lf-muted" style={{ color: "rgba(239,68,68,.9)" }}>
                  Invalid Spreadsheet URL/ID.
                </span>
              ) : null}
            </Form>
          </div>
        )}

        <div className="lf-mt-4">
          <div
            className="lf-mini-card"
            style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
          >
            <div>
              <div style={{ fontWeight: 750 }}>Current sheet</div>
              <div className="lf-muted">{data.sheet.spreadsheetId ?? "—"}</div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {data.sheet.spreadsheetUrl ? (
                <a
                  className="lf-pill lf-pill--primary"
                  href={data.sheet.spreadsheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: "none" }}
                >
                  Open sheet
                </a>
              ) : (
                <span className="lf-muted">No sheet linked yet.</span>
              )}
            </div>
          </div>

          <div className="lf-muted lf-mt-2">
            Next: two-way sync (Requests ⇄ Sheet), status mapping, product image + product URL, and premium formatting rules.
          </div>
        </div>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
