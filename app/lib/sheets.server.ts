// app/lib/sheets.server.ts
import { google } from "googleapis";
import { prisma } from "~/db.server";
import { decryptString, encryptString, getGoogleOAuthClient } from "~/lib/google.server";

type GoogleAuthForShop = {
  client: any;
  shopId: string;
};

async function getGoogleClientForShop(shopDomain: string): Promise<GoogleAuthForShop> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) throw new Error("shop_not_found");

  const oauth = await prisma.oAuthGoogle.findUnique({
    where: { shopId: shop.id },
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

  // Ensure token is valid; googleapis will refresh if refresh_token exists.
  // After refresh, persist new access token if it changed.
  const before = String(client.credentials.access_token || "");
  await client.getAccessToken();
  const after = String(client.credentials.access_token || "");

  if (after && after !== before) {
    await prisma.oAuthGoogle.update({
      where: { shopId: shop.id },
      data: {
        accessTokenEnc: encryptString(after),
        // expiresAt is not always provided here; keep existing unless you want to compute
      },
    });
  }

  return { client, shopId: shop.id };
}

export function sheetsApi(client: any) {
  return google.sheets({ version: "v4", auth: client });
}

export async function createLeadformSpreadsheet(shopDomain: string) {
  const { client, shopId } = await getGoogleClientForShop(shopDomain);
  const sheets = sheetsApi(client);

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `LeadForm — Requests` },
      sheets: [{ properties: { title: "Requests" } }],
    },
  });

  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) throw new Error("sheet_create_failed");

  // Format + headers (premium sheet)
  await ensureRequestsSheetFormatted(sheets, spreadsheetId);

  // Store connection
  const conn = await prisma.sheetsConnection.upsert({
    where: { shopId_spreadsheetId: { shopId, spreadsheetId } },
    update: { active: true, spreadsheetName: created.data.properties?.title ?? null, defaultSheetName: "Requests" },
    create: {
      shopId,
      spreadsheetId,
      spreadsheetName: created.data.properties?.title ?? null,
      defaultSheetName: "Requests",
      active: true,
    },
    select: { id: true, spreadsheetId: true },
  });

  // Make it primary for deterministic sync
  await prisma.shopSettings.upsert({
    where: { shopId },
    update: { primarySheetsConnectionId: conn.id },
    create: { shopId, primarySheetsConnectionId: conn.id },
  });

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

export function parseSpreadsheetId(input: string) {
  const raw = (input || "").trim();
  if (!raw) return null;

  // Full URL
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m?.[1]) return m[1];

  // Plain ID
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) return raw;

  return null;
}

export async function linkExistingSpreadsheet(shopDomain: string, spreadsheetId: string) {
  const { shopId } = await getGoogleClientForShop(shopDomain);

  const conn = await prisma.sheetsConnection.upsert({
    where: { shopId_spreadsheetId: { shopId, spreadsheetId } },
    update: { active: true },
    create: { shopId, spreadsheetId, active: true },
    select: { id: true },
  });

  await prisma.shopSettings.upsert({
    where: { shopId },
    update: { primarySheetsConnectionId: conn.id },
    create: { shopId, primarySheetsConnectionId: conn.id },
  });

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

async function ensureRequestsSheetFormatted(sheets: any, spreadsheetId: string) {
  const headers = [
    "Request ID",
    "Status",
    "Created At",
    "Role",
    "Customer",
    "Email",
    "Phone",
    "Wilaya",
    "Commune",
    "Address",
    "Product",
    "Product URL",
    "Product Image URL",
    "Qty",
    "Admin Link",
  ];

  // Write header row
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Requests!A1:O1",
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  });

  // Batch format
  // - freeze header
  // - style header row
  // - set column widths
  // - add basic conditional formatting for Status
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetId =
    meta.data.sheets?.find((s: any) => s.properties?.title === "Requests")?.properties?.sheetId ?? 0;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.10, green: 0.12, blue: 0.18 },
                horizontalAlignment: "CENTER",
                textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
          },
        },
        // Column widths (A..O)
        ...Array.from({ length: 15 }).map((_, i) => ({
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
            properties: { pixelSize: i === 0 ? 210 : i === 1 ? 120 : 180 },
            fields: "pixelSize",
          },
        })),
      ],
    },
  });
}
