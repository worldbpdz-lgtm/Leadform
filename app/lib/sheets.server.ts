// app/lib/sheets.server.ts
import { google } from "googleapis";
import { prisma } from "~/db.server";
import {
  decryptString,
  encryptString,
  getGoogleOAuthClient,
} from "~/lib/google.server";

/**
 * Google Sheets integration for LeadForm:
 * - Create / link / unlink sheet
 * - Premium formatting (headers, banding, filters, dropdown status, conditional colors)
 * - DB -> Sheet upsert per request
 * - Sheet -> DB sync (status/email/phone/address)
 * - Full export (rebuild) with optional Shopify Admin GraphQL enrichment (title/handle/image + primary domain)
 */

type GoogleAuthForShop = {
  client: any; // google.auth.OAuth2
  shopId: string;
};

export type ShopifyAdminClient = {
  graphql: (query: string, opts?: any) => Promise<Response>;
};

const REQUESTS_SHEET_NAME = "Requests";

/**
 * Premium, organized columns A..R
 */
const HEADERS = [
  "Request ID", // A (locked-ish)
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
  "Product URL", // N (hyperlink)
  "Product Image", // O (formula)
  "Product Image URL", // P (raw url)
  "Admin Link", // Q (hyperlink)
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

function asShopifyGid(kind: "Product" | "ProductVariant", idOrGid: string | null) {
  if (!idOrGid) return null;
  const raw = String(idOrGid).trim();
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/${kind}/${raw}`;
  return null;
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

  // Force a refresh if needed; persist new access token + expiresAt when available.
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

async function getPrimaryConnection(shopId: string) {
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
        defaultSheetName: true,
        active: true,
      },
    });
    if (conn?.active) return conn;
  }

  // fallback to latest active connection
  const fallback = await prisma.sheetsConnection.findFirst({
    where: { shopId, active: true },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      spreadsheetId: true,
      spreadsheetName: true,
      defaultSheetName: true,
      active: true,
    },
  });

  return fallback;
}

async function setPrimaryConnection(shopId: string, connectionId: string) {
  // deterministic: only one active primary
  await prisma.$transaction([
    prisma.sheetsConnection.updateMany({
      where: { shopId },
      data: { active: false },
    }),
    prisma.sheetsConnection.update({
      where: { id: connectionId },
      data: { active: true },
    }),
    prisma.shopSettings.upsert({
      where: { shopId },
      update: { primarySheetsConnectionId: connectionId },
      create: { shopId, primarySheetsConnectionId: connectionId },
    }),
  ]);
}

/**
 * Unlink current primary sheet.
 * Does NOT delete the Google Sheet file (Drive file remains).
 */
export async function unlinkPrimarySpreadsheet(shopDomain: string) {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) throw new Error("shop_not_found");

  const settings = await prisma.shopSettings.findUnique({
    where: { shopId: shop.id },
    select: { primarySheetsConnectionId: true },
  });

  if (!settings?.primarySheetsConnectionId) {
    return { ok: true, unlinked: false };
  }

  await prisma.$transaction([
    prisma.shopSettings.update({
      where: { shopId: shop.id },
      data: { primarySheetsConnectionId: null },
    }),
    prisma.sheetsConnection.update({
      where: { id: settings.primarySheetsConnectionId },
      data: { active: false },
    }),
  ]);

  return { ok: true, unlinked: true };
}

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

  await setPrimaryConnection(shopId, conn.id);

  // Backfill so sheet is not empty (uses DB values; for enriched export call exportRequestsToSpreadsheet with admin)
  await exportRequestsToSpreadsheet({ shopDomain, spreadsheetId });

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

  // Ensure accessible + name
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const spreadsheetName = meta.data.properties?.title ?? null;

  await ensureRequestsSheetFormatted(sheets, spreadsheetId);

  const conn = await prisma.sheetsConnection.upsert({
    where: { shopId_spreadsheetId: { shopId, spreadsheetId } },
    update: { active: true, spreadsheetName, defaultSheetName: REQUESTS_SHEET_NAME },
    create: { shopId, spreadsheetId, active: true, spreadsheetName, defaultSheetName: REQUESTS_SHEET_NAME },
    select: { id: true },
  });

  await setPrimaryConnection(shopId, conn.id);

  // Backfill so sheet is not empty (uses DB values; for enriched export call exportRequestsToSpreadsheet with admin)
  await exportRequestsToSpreadsheet({ shopDomain, spreadsheetId });

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

/**
 * DB -> Sheet: upsert one request row (scans column A to find row).
 * Writes SheetsSyncLog (success/failed).
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
    const existingRow = idToRow.get(r.id) ?? null;

    const rowValues = buildSheetRowValues(shopDomain, r);

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
          connectionId: primary?.id ?? "unknown",
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
 * Call this from an admin button "Sync from sheet".
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

  const allowedStatus = new Set<string>(STATUS_VALUES as unknown as string[]);

  let updated = 0;

  for (const row of rows) {
    const requestId = String(row[0] || "").trim();
    if (!requestId) continue;

    const status = String(row[1] || "").trim();
    const email = String(row[5] || "").trim();
    const phone = String(row[6] || "").trim();
    const address = String(row[9] || "").trim();

    const data: any = {};
    if (status && allowedStatus.has(status)) data.status = status as any;
    data.email = email || null;
    data.phone = phone || null;
    data.address = address || null;

    const res = await prisma.request.updateMany({
      where: { id: requestId, shopId },
      data,
    });

    if (res.count > 0) updated += 1;
  }

  return { ok: true, updated };
}

/**
 * Export ALL requests to a spreadsheet (fresh rebuild).
 *
 * Default behavior (no admin provided):
 * - uses DB values (values.productTitle/productUrl/productImageUrl) if present
 *
 * If you pass `admin`:
 * - enriches product title/handle/image using Shopify Admin GraphQL
 * - builds product URL using primaryDomain.url
 */
export async function exportRequestsToSpreadsheet(opts: {
  shopDomain: string;
  spreadsheetId?: string; // if omitted, uses primary
  admin?: ShopifyAdminClient;
}) {
  const { shopDomain, admin } = opts;
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) throw new Error("shop_not_found");

  const { client, shopId } = await getGoogleClientForShop(shopDomain);
  const sheets = sheetsApi(client);

  const primary =
    opts.spreadsheetId
      ? { spreadsheetId: opts.spreadsheetId }
      : await getPrimaryConnection(shopId);

  const spreadsheetId = (primary as any)?.spreadsheetId;
  if (!spreadsheetId) throw new Error("no_sheet");

  await ensureRequestsSheetFormatted(sheets, spreadsheetId);

  // Load requests
  const reqs = await prisma.request.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 5000,
    include: { items: true, wilaya: true, commune: true },
  });

  // Optional enrichment (Shopify primary domain + product nodes)
  let baseStoreUrl = `https://${shopDomain}`;
  const productMap = new Map<string, { title: string | null; handle: string | null; imageUrl: string | null }>();

  if (admin) {
    // primary domain
    try {
      const resp = await admin.graphql(
        `#graphql
        query ShopPrimaryDomain {
          shop { primaryDomain { url } }
        }`
      );
      const json = await resp.json();
      const pd = json?.data?.shop?.primaryDomain?.url;
      if (typeof pd === "string" && pd) baseStoreUrl = pd;
    } catch {
      // ignore
    }

    // products
    const productIds = Array.from(
      new Set(
        reqs
          .map((r) => r.productId || r.items?.[0]?.productId || null)
          .map((id) => asShopifyGid("Product", id))
          .filter(Boolean) as string[]
      )
    );

    for (let i = 0; i < productIds.length; i += 80) {
      const chunk = productIds.slice(i, i + 80);
      try {
        const resp = await admin.graphql(
          `#graphql
          query ProductsNodes($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                title
                handle
                featuredImage { url }
                images(first: 1) { nodes { url } }
              }
            }
          }`,
          { variables: { ids: chunk } }
        );
        const json = await resp.json();
        const nodes = json?.data?.nodes ?? [];
        for (const n of nodes) {
          if (!n?.id) continue;
          const imageUrl = n?.featuredImage?.url ?? n?.images?.nodes?.[0]?.url ?? null;
          productMap.set(String(n.id), {
            title: n?.title ?? null,
            handle: n?.handle ?? null,
            imageUrl,
          });
        }
      } catch {
        // ignore chunk errors
      }
    }
  }

  // Clear old content (keep header row)
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${REQUESTS_SHEET_NAME}!A2:R`,
  });

  // Build rows oldest->newest for nice chronology
  const rows = reqs
    .slice()
    .reverse()
    .map((r) => buildSheetRowValues(shopDomain, r, { baseStoreUrl, productMap }));

  // Write in chunks
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const startRow = 2 + i;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${REQUESTS_SHEET_NAME}!A${startRow}:R${startRow + chunk.length - 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: chunk },
    });
  }

  return { ok: true, exported: rows.length };
}

async function ensureRequestsSheetFormatted(sheets: any, spreadsheetId: string) {
  // Ensure the tab exists (create if missing)
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const found = meta.data.sheets?.find((s: any) => s.properties?.title === REQUESTS_SHEET_NAME);
  const sheetId: number | null = found?.properties?.sheetId ?? null;

  if (sheetId === null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: REQUESTS_SHEET_NAME } } }] },
    });
  }

  // Re-fetch
  const meta2 = sheetId === null ? await sheets.spreadsheets.get({ spreadsheetId }) : meta;
  const sheet =
    meta2.data.sheets?.find((s: any) => s.properties?.title === REQUESTS_SHEET_NAME) ?? null;
  const sid = sheet?.properties?.sheetId ?? 0;

  // Write header row (A1:R1)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${REQUESTS_SHEET_NAME}!A1:R1`,
    valueInputOption: "RAW",
    requestBody: { values: [Array.from(HEADERS)] },
  });

  // Best-effort cleanup to keep formatting idempotent
  const requests: any[] = [];

  // Remove existing banding (prevents stacking)
  const bandedRanges = (sheet as any)?.bandedRanges ?? [];
  for (const br of bandedRanges) {
    if (br?.bandedRangeId != null) {
      requests.push({ deleteBanding: { bandedRangeId: br.bandedRangeId } });
    }
  }

  // Remove existing conditional formats (prevents stacking)
  const conditional = (sheet as any)?.conditionalFormats ?? [];
  for (let i = conditional.length - 1; i >= 0; i--) {
    requests.push({ deleteConditionalFormatRule: { sheetId: sid, index: i } });
  }

  // Freeze header
  requests.push({
    updateSheetProperties: {
      properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } },
      fields: "gridProperties.frozenRowCount",
    },
  });

  // Header style
  requests.push({
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
  });

  // Banded rows
  requests.push({
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
  });

  // Filter (whole table)
  requests.push({
    setBasicFilter: {
      filter: {
        range: { sheetId: sid, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 18 },
      },
    },
  });

  // Status dropdown validation (B2:B)
  requests.push({
    setDataValidation: {
      range: { sheetId: sid, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
      rule: {
        condition: {
          type: "ONE_OF_LIST",
          values: STATUS_VALUES.map((v) => ({ userEnteredValue: v })),
        },
        strict: true,
        showCustomUi: true,
      },
    },
  });

  // Conditional formatting for status column (B)
  const statusRange = { sheetId: sid, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 };

  // confirmed
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [statusRange],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "confirmed" }] },
          format: { backgroundColor: { red: 0.86, green: 0.97, blue: 0.90 } },
        },
      },
      index: 0,
    },
  });
  // cancelled
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [statusRange],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "cancelled" }] },
          format: { backgroundColor: { red: 0.99, green: 0.90, blue: 0.90 } },
        },
      },
      index: 0,
    },
  });
  // received
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [statusRange],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "received" }] },
          format: { backgroundColor: { red: 0.99, green: 0.95, blue: 0.87 } },
        },
      },
      index: 0,
    },
  });
  // spam
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [statusRange],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "spam" }] },
          format: { backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 } },
        },
      },
      index: 0,
    },
  });
  // archived
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [statusRange],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "archived" }] },
          format: { backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 } },
        },
      },
      index: 0,
    },
  });

  // Column widths (A..R)
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
    map.set(id, i + 2); // row index starts at 2
  }

  return map;
}

function buildSheetRowValues(
  shopDomain: string,
  r: any,
  enrich?: {
    baseStoreUrl?: string;
    productMap?: Map<string, { title: string | null; handle: string | null; imageUrl: string | null }>;
  }
) {
  const fullName = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
  const customer = fullName || r.email || r.phone || "—";

  const itemsCount = Array.isArray(r.items) ? r.items.length : 0;

  // From DB values (fallback)
  const v = r.values && typeof r.values === "object" ? (r.values as any) : {};
  let productTitle = v.productTitle || r.productId || r.items?.[0]?.productId || "—";
  let productUrl: string = v.productUrl || "";
  let productImageUrl: string = v.productImageUrl || "";

  // Optional enrichment
  const baseStoreUrl = enrich?.baseStoreUrl || `https://${shopDomain}`;
  const storedProductId = r.productId || r.items?.[0]?.productId || null;
  const gid = asShopifyGid("Product", storedProductId);
  const p = gid && enrich?.productMap ? enrich.productMap.get(gid) : null;

  if (p) {
    if (p.title) productTitle = p.title;
    if (p.handle) productUrl = `${baseStoreUrl}/products/${p.handle}`;
    if (p.imageUrl) productImageUrl = p.imageUrl;
  }

  const qty = r.qty ?? r.items?.[0]?.qty ?? 1;

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const adminUrl = appUrl
    ? `${appUrl}/app/requests/${r.id}?shop=${encodeURIComponent(shopDomain)}`
    : "";

  const adminLink = adminUrl ? `=HYPERLINK("${adminUrl}", "Open")` : "";
  const productLink = productUrl ? `=HYPERLINK("${productUrl}", "Open")` : "";

  // Robust formula: uses ROW() so it works for both update + append
  const imageFormula = `=IF(LEN(INDIRECT("P"&ROW())),IMAGE(INDIRECT("P"&ROW()),4,80,80),"")`;

  // Items summary (compact)
  const itemsSummary =
    Array.isArray(r.items) && r.items.length
      ? String(r.items.length)
      : String(itemsCount);

  const w =
    r.wilaya?.nameFr ??
    r.wilaya?.nameAr ??
    (r.wilayaCode ? String(r.wilayaCode) : "");

  const c = r.commune?.nameFr ?? r.commune?.nameAr ?? "";

  return [
    r.id,                         // A
    String(r.status),             // B
    new Date(r.createdAt).toISOString(), // C
    String(r.roleType),           // D
    customer,                     // E
    r.email ?? "",                // F
    r.phone ?? "",                // G
    w ?? "",                      // H
    c ?? "",                      // I
    r.address ?? "",              // J
    itemsSummary,                 // K
    String(productTitle ?? "—"),  // L
    String(qty ?? 1),             // M
    productLink,                  // N
    imageFormula,                 // O
    String(productImageUrl ?? ""),// P
    adminLink,                    // Q
    nowIso(),                     // R
  ];
}
