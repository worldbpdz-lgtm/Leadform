// app/lib/sheets.server.ts
import { google } from "googleapis";
import { prisma } from "~/db.server";
import { decryptString, encryptString, getGoogleOAuthClient } from "~/lib/google.server";

type GoogleAuthForShop = {
  client: any; // google.auth.OAuth2
  shopId: string;
};

const REQUESTS_SHEET_NAME = "Requests";

/**
 * Premium, organized columns (matches your Requests UI, but cleaner for Sheets).
 * A..R
 */
const HEADERS = [
  "Request ID", // A (locked)
  "Status", // B (editable dropdown)
  "Created At", // C
  "Role", // D
  "Customer", // E
  "Email", // F (editable)
  "Phone", // G (editable)
  "Wilaya", // H
  "Commune", // I
  "Address", // J (editable)
  "Items", // K
  "Product", // L
  "Qty", // M
  "Product URL", // N
  "Product Image", // O (formula)
  "Product Image URL", // P (raw url)
  "Admin Link", // Q
  "Last Sync", // R
] as const;

const STATUS_VALUES = [
  "received",
  "in_review",
  "contacted",
  "confirmed",
  "cancelled",
  "spam",
  "archived",
] as const;

function nowIso() {
  return new Date().toISOString();
}

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

  // Force a refresh if needed; persist new tokens
  const before = String(client.credentials.access_token || "");
  await client.getAccessToken();
  const after = String(client.credentials.access_token || "");
  const expiry = (client.credentials as any)?.expiry_date;

  if (after && after !== before) {
    await prisma.oAuthGoogle.update({
      where: { shopId: shop.id },
      data: {
        accessTokenEnc: encryptString(after),
        ...(typeof expiry === "number" ? { expiresAt: new Date(expiry) } : {}),
      },
    });
  }

  return { client, shopId: shop.id };
}

export function sheetsApi(client: any) {
  return google.sheets({ version: "v4", auth: client });
}

async function getPrimaryConnection(shopId: string) {
  const settings = await prisma.shopSettings.findUnique({
    where: { shopId },
    select: { primarySheetsConnectionId: true },
  });

  if (settings?.primarySheetsConnectionId) {
    const conn = await prisma.sheetsConnection.findUnique({
      where: { id: settings.primarySheetsConnectionId },
      select: { id: true, spreadsheetId: true, spreadsheetName: true, defaultSheetName: true, active: true },
    });
    if (conn?.active) return conn;
  }

  const fallback = await prisma.sheetsConnection.findFirst({
    where: { shopId, active: true },
    orderBy: { updatedAt: "desc" },
    select: { id: true, spreadsheetId: true, spreadsheetName: true, defaultSheetName: true, active: true },
  });

  return fallback;
}

function parseSpreadsheetId(input: string) {
  const raw = (input || "").trim();
  if (!raw) return null;

  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m?.[1]) return m[1];

  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) return raw;

  return null;
}

export { parseSpreadsheetId };

export async function createLeadformSpreadsheet(shopDomain: string) {
  const { client, shopId } = await getGoogleClientForShop(shopDomain);
  const sheets = sheetsApi(client);

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `LeadForm — Requests` },
      sheets: [{ properties: { title: REQUESTS_SHEET_NAME } }],
    },
  });

  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) throw new Error("sheet_create_failed");

  const spreadsheetName = created.data.properties?.title ?? `LeadForm — Requests`;

  await ensureRequestsSheetFormatted(sheets, spreadsheetId);

  const conn = await prisma.sheetsConnection.upsert({
    where: { shopId_spreadsheetId: { shopId, spreadsheetId } },
    update: { active: true, spreadsheetName, defaultSheetName: REQUESTS_SHEET_NAME },
    create: { shopId, spreadsheetId, spreadsheetName, defaultSheetName: REQUESTS_SHEET_NAME, active: true },
    select: { id: true, spreadsheetId: true },
  });

  await prisma.shopSettings.upsert({
    where: { shopId },
    update: { primarySheetsConnectionId: conn.id },
    create: { shopId, primarySheetsConnectionId: conn.id },
  });

  // Backfill: put existing requests into the sheet
  await backfillRequestsToSheet(shopDomain, { spreadsheetId, connectionId: conn.id });

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

export async function linkExistingSpreadsheet(shopDomain: string, spreadsheetIdRaw: string) {
  const spreadsheetId = parseSpreadsheetId(spreadsheetIdRaw) || spreadsheetIdRaw;
  if (!spreadsheetId) throw new Error("bad_spreadsheet_id");

  const { client, shopId } = await getGoogleClientForShop(shopDomain);
  const sheets = sheetsApi(client);

  // Ensure it is accessible + fetch name
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const spreadsheetName = meta.data.properties?.title ?? null;

  await ensureRequestsSheetFormatted(sheets, spreadsheetId);

  const conn = await prisma.sheetsConnection.upsert({
    where: { shopId_spreadsheetId: { shopId, spreadsheetId } },
    update: { active: true, spreadsheetName, defaultSheetName: REQUESTS_SHEET_NAME },
    create: { shopId, spreadsheetId, active: true, spreadsheetName, defaultSheetName: REQUESTS_SHEET_NAME },
    select: { id: true },
  });

  await prisma.shopSettings.upsert({
    where: { shopId },
    update: { primarySheetsConnectionId: conn.id },
    create: { shopId, primarySheetsConnectionId: conn.id },
  });

  // Backfill existing requests so sheet is not empty
  await backfillRequestsToSheet(shopDomain, { spreadsheetId, connectionId: conn.id });

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

/**
 * DB -> Sheet: upsert one request row (fast enough for now by scanning col A).
 * Also writes a SheetsSyncLog (success/failed).
 */
export async function syncRequestToPrimarySheet(shopDomain: string, requestId: string) {
  const { client, shopId } = await getGoogleClientForShop(shopDomain);

  const primary = await getPrimaryConnection(shopId);
  if (!primary?.spreadsheetId) throw new Error("no_primary_sheet");

  const sheets = sheetsApi(client);
  const spreadsheetId = primary.spreadsheetId;

  try {
    await ensureRequestsSheetFormatted(sheets, spreadsheetId);

    const r = await loadRequestForSheet(shopId, requestId);
    if (!r) throw new Error("request_not_found");

    const idToRow = await getRequestIdToRowMap(sheets, spreadsheetId);
    const existingRow = idToRow.get(r.id);

    const rowValues = buildSheetRowValues(shopDomain, r, existingRow ?? null);

    if (existingRow) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${REQUESTS_SHEET_NAME}!A${existingRow}:R${existingRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowValues] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${REQUESTS_SHEET_NAME}!A:R`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [rowValues] },
      });
    }

    await prisma.sheetsSyncLog.create({
      data: {
        connectionId: primary.id,
        requestId: r.id,
        status: "success",
        error: null,
      },
    });
  } catch (e: any) {
    await prisma.sheetsSyncLog
      .create({
        data: {
          connectionId: primary.id,
          requestId,
          status: "failed",
          error: e?.message || "sync_failed",
        },
      })
      .catch(() => {});
    throw e;
  }
}

/**
 * Sheet -> DB: reads the sheet and applies changes into Requests:
 * - Status (column B)
 * - Email (F)
 * - Phone (G)
 * - Address (J)
 *
 * You can call this from an admin action button "Sync from sheet".
 */
export async function syncRequestsFromSheetToDb(shopDomain: string) {
  const { client, shopId } = await getGoogleClientForShop(shopDomain);

  const primary = await getPrimaryConnection(shopId);
  if (!primary?.spreadsheetId) throw new Error("no_primary_sheet");

  const sheets = sheetsApi(client);
  const spreadsheetId = primary.spreadsheetId;

  await ensureRequestsSheetFormatted(sheets, spreadsheetId);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${REQUESTS_SHEET_NAME}!A2:R`,
  });

  const rows: any[][] = resp.data.values || [];
  if (!rows.length) return { ok: true, updated: 0 };

  // Build updates in-memory
  const allowedStatus = new Set(STATUS_VALUES);

  let updated = 0;

  for (const row of rows) {
    const requestId = String(row[0] || "").trim();
    if (!requestId) continue;

    const status = String(row[1] || "").trim();
    const email = String(row[5] || "").trim();
    const phone = String(row[6] || "").trim();
    const address = String(row[9] || "").trim();

    const data: any = {};
    if (status && allowedStatus.has(status as any)) data.status = status as any;
    data.email = email || null;
    data.phone = phone || null;
    data.address = address || null;

    // Only update if request belongs to this shop
    const res = await prisma.request.updateMany({
      where: { id: requestId, shopId },
      data,
    });

    if (res.count > 0) updated += 1;
  }

  return { ok: true, updated };
}

async function ensureRequestsSheetFormatted(sheets: any, spreadsheetId: string) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });

  const found = meta.data.sheets?.find((s: any) => s.properties?.title === REQUESTS_SHEET_NAME);
  const sheetId: number | null = found?.properties?.sheetId ?? null;

  // If missing: create the Requests sheet
  if (sheetId === null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { addSheet: { properties: { title: REQUESTS_SHEET_NAME } } },
        ],
      },
    });
  }

  // Re-fetch to get sheetId
  const meta2 = sheetId === null ? await sheets.spreadsheets.get({ spreadsheetId }) : meta;
  const sid =
    meta2.data.sheets?.find((s: any) => s.properties?.title === REQUESTS_SHEET_NAME)?.properties?.sheetId ?? 0;

  // Header row
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${REQUESTS_SHEET_NAME}!A1:R1`,
    valueInputOption: "RAW",
    requestBody: { values: [Array.from(HEADERS)] },
  });

  // Formatting + validation
  const statusValidation = {
    condition: {
      type: "ONE_OF_LIST",
      values: STATUS_VALUES.map((v) => ({ userEnteredValue: v })),
    },
    strict: true,
    showCustomUi: true,
  };

  const colWidths = [
    210, // A
    120, // B
    170, // C
    110, // D
    220, // E
    220, // F
    160, // G
    160, // H
    160, // I
    260, // J
    90,  // K
    240, // L
    70,  // M
    260, // N
    140, // O
    260, // P
    240, // Q
    170, // R
  ];

  const requests: any[] = [
    // Freeze header
    {
      updateSheetProperties: {
        properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },

    // Header style
    {
      repeatCell: {
        range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.10, green: 0.12, blue: 0.18 },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 10 },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)",
      },
    },

    // Banded rows
    {
      addBanding: {
        bandedRange: {
          range: { sheetId: sid, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 18 },
          rowProperties: {
            firstBandColor: { red: 0.98, green: 0.98, blue: 0.99 },
            secondBandColor: { red: 1, green: 1, blue: 1 },
          },
          headerColor: { red: 0.10, green: 0.12, blue: 0.18 },
        },
      },
    },

    // Filter
    {
      setBasicFilter: {
        filter: {
          range: { sheetId: sid, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 18 },
        },
      },
    },

    // Status validation (B2:B)
    {
      setDataValidation: {
        range: { sheetId: sid, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
        rule: statusValidation,
      },
    },

    // Conditional formatting for Status column (B)
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: sid, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "confirmed" }] },
            format: { backgroundColor: { red: 0.86, green: 0.97, blue: 0.90 } },
          },
        },
        index: 0,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: sid, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "cancelled" }] },
            format: { backgroundColor: { red: 0.99, green: 0.90, blue: 0.90 } },
          },
        },
        index: 0,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: sid, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "received" }] },
            format: { backgroundColor: { red: 0.99, green: 0.95, blue: 0.87 } },
          },
        },
        index: 0,
      },
    },
  ];

  // Column widths
  for (let i = 0; i < colWidths.length; i++) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: sid, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: colWidths[i] },
        fields: "pixelSize",
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

async function backfillRequestsToSheet(
  shopDomain: string,
  opts: { spreadsheetId: string; connectionId: string }
) {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) throw new Error("shop_not_found");

  const { client } = await getGoogleClientForShop(shopDomain);
  const sheets = sheetsApi(client);

  // Load recent requests (adjust take if needed)
  const requests = await prisma.request.findMany({
    where: { shopId: shop.id, status: { not: "archived" } },
    orderBy: { createdAt: "desc" },
    take: 1000,
    include: { items: true, wilaya: true, commune: true },
  });

  // Build rows (top-down oldest->newest for nicer sheet chronology)
  const rows = requests
    .slice()
    .reverse()
    .map((r, idx) => buildSheetRowValues(shopDomain, r as any, 2 + idx));

  // Clear old content (keep header row)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: opts.spreadsheetId,
    range: `${REQUESTS_SHEET_NAME}!A2:R`,
  });

  if (rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: opts.spreadsheetId,
      range: `${REQUESTS_SHEET_NAME}!A2:R${rows.length + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
  }
}

async function loadRequestForSheet(shopId: string, requestId: string) {
  return prisma.request.findFirst({
    where: { id: requestId, shopId },
    include: { items: true, wilaya: true, commune: true },
  });
}

async function getRequestIdToRowMap(sheets: any, spreadsheetId: string) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${REQUESTS_SHEET_NAME}!A2:A`,
  });

  const values: any[][] = resp.data.values || [];
  const map = new Map<string, number>();

  for (let i = 0; i < values.length; i++) {
    const id = String(values[i]?.[0] || "").trim();
    if (!id) continue;
    map.set(id, i + 2); // because we started at row 2
  }

  return map;
}

function buildSheetRowValues(shopDomain: string, r: any, rowNumberOrNull: number | null) {
  const fullName = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
  const customer = fullName || r.email || r.phone || "—";

  const itemsCount = Array.isArray(r.items) ? r.items.length : 0;

  const productTitle =
    (r.values && typeof r.values === "object" ? (r.values as any).productTitle : null) ||
    r.productId ||
    (r.items?.[0]?.productId ?? null) ||
    "—";

  const qty = r.qty ?? r.items?.[0]?.qty ?? 1;

  const productUrl =
    (r.values && typeof r.values === "object" ? (r.values as any).productUrl : null) || "";

  const productImageUrl =
    (r.values && typeof r.values === "object" ? (r.values as any).productImageUrl : null) || "";

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const adminLink = appUrl ? `${appUrl}/app/requests/${r.id}?shop=${encodeURIComponent(shopDomain)}` : "";

  const row = rowNumberOrNull ?? 999999; // only used to build formula; harmless if appending
  const imageFormula = `=IF(LEN(P${row}),IMAGE(P${row},4,80,80),"")`;

  return [
    r.id, // A
    String(r.status), // B
    new Date(r.createdAt).toLocaleString(), // C
    String(r.roleType), // D
    customer, // E
    r.email ?? "", // F
    r.phone ?? "", // G
    r.wilaya?.nameFr ?? r.wilaya?.nameAr ?? (r.wilayaCode ? String(r.wilayaCode) : ""), // H
    r.commune?.nameFr ?? r.commune?.nameAr ?? "", // I
    r.address ?? "", // J
    String(itemsCount), // K
    String(productTitle ?? "—"), // L
    String(qty ?? 1), // M
    String(productUrl), // N
    imageFormula, // O (formula)
    String(productImageUrl), // P (url)
    String(adminLink), // Q
    nowIso(), // R
  ];
}
