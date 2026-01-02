// app/lib/sheets.server.ts
import { google } from "googleapis";
import { prisma } from "~/db.server";
import {
  decryptString,
  encryptString,
  getGoogleOAuthClient,
} from "~/lib/google.server";

type GoogleAuthForShop = { client: any; shopId: string };

export type ShopifyAdminClient = {
  graphql: (query: string, opts?: any) => Promise<Response>;
};

const REQUESTS_SHEET_NAME = "Requests";

const HEADERS = [
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
  "Items",
  "Product",
  "Qty",
  "Product URL",
  "Product Image",
  "Product Image URL",
  "Admin Link",
  "Last Sync",
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

function asShopifyGid(
  kind: "Product" | "ProductVariant",
  idOrGid: string | null
) {
  if (!idOrGid) return null;
  const raw = String(idOrGid).trim();
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/${kind}/${raw}`;
  return null;
}

async function getGoogleClientForShop(
  shopDomain: string
): Promise<GoogleAuthForShop> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) throw new Error("shop_not_found");

  const oauth = await prisma.oAuthGoogle.findUnique({
    where: { shopId: shop.id },
    select: { accessTokenEnc: true, refreshTokenEnc: true },
  });
  if (!oauth) throw new Error("google_not_connected");

  const client = getGoogleOAuthClient();

  const accessToken = decryptString(oauth.accessTokenEnc);
  const refreshToken = oauth.refreshTokenEnc
    ? decryptString(oauth.refreshTokenEnc)
    : "";

  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken || undefined,
  });

  // refresh if needed; persist new access token when changed
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

function driveApi(client: any) {
  return google.drive({ version: "v3", auth: client });
}

export function parseSpreadsheetId(input: string) {
  const raw = (input || "").trim();
  if (!raw) return null;
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m?.[1]) return m[1];
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

  return prisma.sheetsConnection.findFirst({
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
}

async function setPrimaryConnection(shopId: string, connectionId: string) {
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
 * Unlink current primary sheet (does NOT delete the Drive file).
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

  if (!settings?.primarySheetsConnectionId) return { ok: true, unlinked: false };

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

/**
 * DELETE current sheet (move Drive file to trash) + create a brand new sheet + export all requests to it.
 * This is what your UI "Delete" button should call.
 *
 * Notes:
 * - We "trash" (not permanent delete) to avoid irreversible loss.
 * - If Drive trash fails (permissions), we still unlink + replace.
 */
export async function deleteAndReplacePrimarySpreadsheet(opts: {
  shopDomain: string;
  admin?: ShopifyAdminClient;
}) {
  const { shopDomain, admin } = opts;

  const { client, shopId } = await getGoogleClientForShop(shopDomain);

  const primary = await getPrimaryConnection(shopId);
  if (!primary?.spreadsheetId) throw new Error("no_primary_sheet");

  const oldSpreadsheetId = primary.spreadsheetId;

  // Try to trash the Drive file (best-effort)
  try {
    const drive = driveApi(client);
    await drive.files.update({
      fileId: oldSpreadsheetId,
      requestBody: { trashed: true },
    });
  } catch {
    // ignore; still proceed with unlink + replace
  }

  // Unlink + deactivate connection
  await prisma.$transaction([
    prisma.shopSettings.update({
      where: { shopId },
      data: { primarySheetsConnectionId: null },
    }),
    prisma.sheetsConnection.update({
      where: { id: primary.id },
      data: { active: false },
    }),
  ]);

  // Create a new sheet
  const sheets = sheetsApi(client);
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `LeadForm — Requests` },
      sheets: [{ properties: { title: REQUESTS_SHEET_NAME } }],
    },
  });

  const newSpreadsheetId = created.data.spreadsheetId;
  if (!newSpreadsheetId) throw new Error("sheet_create_failed");

  const spreadsheetName = created.data.properties?.title ?? `LeadForm — Requests`;

  await ensureRequestsSheetFormatted(sheets, newSpreadsheetId);

  const conn = await prisma.sheetsConnection.upsert({
    where: { shopId_spreadsheetId: { shopId, spreadsheetId: newSpreadsheetId } },
    update: { active: true, spreadsheetName, defaultSheetName: REQUESTS_SHEET_NAME },
    create: { shopId, spreadsheetId: newSpreadsheetId, spreadsheetName, defaultSheetName: REQUESTS_SHEET_NAME, active: true },
    select: { id: true },
  });

  await setPrimaryConnection(shopId, conn.id);

  // Export ALL requests into the new sheet (with optional Shopify enrichment)
  await exportRequestsToSpreadsheet({
    shopDomain,
    spreadsheetId: newSpreadsheetId,
    admin,
  });

  return {
    ok: true,
    deletedSpreadsheetId: oldSpreadsheetId,
    spreadsheetId: newSpreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${newSpreadsheetId}`,
  };
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
    select: { id: true },
  });

  await setPrimaryConnection(shopId, conn.id);

  // backfill (DB-based)
  await exportRequestsToSpreadsheet({ shopDomain, spreadsheetId });

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

export async function linkExistingSpreadsheet(
  shopDomain: string,
  spreadsheetIdRaw: string
) {
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

  await exportRequestsToSpreadsheet({ shopDomain, spreadsheetId });

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

/**
 * Export ALL requests to a spreadsheet (fresh rebuild).
 * If `admin` is provided, enrich product title/handle/image + use primaryDomain url.
 */
export async function exportRequestsToSpreadsheet(opts: {
  shopDomain: string;
  spreadsheetId: string;
  admin?: ShopifyAdminClient;
}) {
  const { shopDomain, spreadsheetId, admin } = opts;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) throw new Error("shop_not_found");

  const { client } = await getGoogleClientForShop(shopDomain);
  const sheets = sheetsApi(client);

  await ensureRequestsSheetFormatted(sheets, spreadsheetId);

  const reqs = await prisma.request.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 5000,
    include: { items: true, wilaya: true, commune: true },
  });

  let baseStoreUrl = `https://${shopDomain}`;
  const productMap = new Map<
    string,
    { title: string | null; handle: string | null; imageUrl: string | null }
  >();

  if (admin) {
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
          const imageUrl =
            n?.featuredImage?.url ?? n?.images?.nodes?.[0]?.url ?? null;
          productMap.set(String(n.id), {
            title: n?.title ?? null,
            handle: n?.handle ?? null,
            imageUrl,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${REQUESTS_SHEET_NAME}!A2:R`,
  });

  const rows = reqs
    .slice()
    .reverse()
    .map((r) => buildSheetRowValues(shopDomain, r, { baseStoreUrl, productMap }));

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
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const found = meta.data.sheets?.find(
    (s: any) => s.properties?.title === REQUESTS_SHEET_NAME
  );
  const sheetId: number | null = found?.properties?.sheetId ?? null;

  if (sheetId === null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: REQUESTS_SHEET_NAME } } }],
      },
    });
  }

  const meta2 = sheetId === null ? await sheets.spreadsheets.get({ spreadsheetId }) : meta;
  const sheet =
    meta2.data.sheets?.find((s: any) => s.properties?.title === REQUESTS_SHEET_NAME) ?? null;
  const sid = sheet?.properties?.sheetId ?? 0;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${REQUESTS_SHEET_NAME}!A1:R1`,
    valueInputOption: "RAW",
    requestBody: { values: [Array.from(HEADERS)] },
  });

  const requests: any[] = [];

  // clean existing banding/conditional formats to avoid stacking
  const bandedRanges = (sheet as any)?.bandedRanges ?? [];
  for (const br of bandedRanges) {
    if (br?.bandedRangeId != null) requests.push({ deleteBanding: { bandedRangeId: br.bandedRangeId } });
  }
  const conditional = (sheet as any)?.conditionalFormats ?? [];
  for (let i = conditional.length - 1; i >= 0; i--) {
    requests.push({ deleteConditionalFormatRule: { sheetId: sid, index: i } });
  }

  requests.push({
    updateSheetProperties: {
      properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } },
      fields: "gridProperties.frozenRowCount",
    },
  });

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
      fields:
        "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)",
    },
  });

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

  requests.push({
    setBasicFilter: {
      filter: {
        range: { sheetId: sid, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 18 },
      },
    },
  });

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

  const statusRange = { sheetId: sid, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 };

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

  const colWidths = [
    210, 120, 170, 110, 220, 220, 160, 160, 160, 260, 90, 240, 70, 260, 140, 260, 240, 170,
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

  const v = r.values && typeof r.values === "object" ? (r.values as any) : {};
  let productTitle = v.productTitle || r.productId || r.items?.[0]?.productId || "—";
  let productUrl: string = v.productUrl || "";
  let productImageUrl: string = v.productImageUrl || "";

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

  // Works for both update + append (no need to know row number)
  const imageFormula = `=IF(LEN(INDIRECT("P"&ROW())),IMAGE(INDIRECT("P"&ROW()),4,80,80),"")`;

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
    String(itemsCount),           // K
    String(productTitle ?? "—"),  // L
    String(qty ?? 1),             // M
    productLink,                  // N
    imageFormula,                 // O
    String(productImageUrl ?? ""),// P
    adminLink,                    // Q
    nowIso(),                     // R
  ];
}
