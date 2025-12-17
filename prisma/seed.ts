// prisma/seed.ts
import { PrismaClient, FieldType, FormStatus, Placement, RoleType } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();

function readJson<T>(relPath: string): T {
  const abs = path.join(process.cwd(), relPath);
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  // ─────────────────────────────────────────────────────────
  // 0) Load DZ geo data
  // ─────────────────────────────────────────────────────────
  const wilayas = readJson<Array<{ code: number; nameFr: string; nameAr: string }>>(
    "prisma/data/wilayas.json"
  );
  const communes = readJson<Array<{ wilayaCode: number; nameFr: string; nameAr: string }>>(
    "prisma/data/communes.json"
  );

  // ─────────────────────────────────────────────────────────
  // 1) Seed wilayas
  // ─────────────────────────────────────────────────────────
  for (const w of wilayas) {
    await prisma.geoWilaya.upsert({
      where: { code: w.code },
      update: { nameFr: w.nameFr, nameAr: w.nameAr },
      create: { code: w.code, nameFr: w.nameFr, nameAr: w.nameAr },
    });
  }

  // ─────────────────────────────────────────────────────────
  // 2) Validate commune wilaya codes exist
  // ─────────────────────────────────────────────────────────
  const wilayaCodes = new Set(wilayas.map((w) => w.code));
  const bad = communes.filter((c) => !wilayaCodes.has(c.wilayaCode));
  if (bad.length) {
    console.warn(`[seed] Communes with invalid wilayaCode: ${bad.length}. Example:`, bad[0]);
  }

  // ─────────────────────────────────────────────────────────
  // 3) Seed communes
  // ─────────────────────────────────────────────────────────
  const communeRows = communes.map((c) => ({
    wilayaCode: c.wilayaCode,
    nameFr: c.nameFr,
    nameAr: c.nameAr,
  }));

  for (const part of chunk(communeRows, 1000)) {
    await prisma.geoCommune.createMany({
      data: part,
      skipDuplicates: true,
    });
  }

  // ─────────────────────────────────────────────────────────
  // 4) Seed a dev shop + roles + default form + fields
  // ─────────────────────────────────────────────────────────
  const seedShopDomain =
    process.env.SEED_SHOP_DOMAIN ||
    process.env.SHOPIFY_SHOP_DOMAIN ||
    "dev-shop.myshopify.com";

  const shop = await prisma.shop.upsert({
    where: { shopDomain: seedShopDomain },
    update: { uninstalledAt: null },
    create: {
      shopDomain: seedShopDomain,
      installedAt: new Date(),
      timezone: "Africa/Algiers",
    },
    select: { id: true, shopDomain: true },
  });

  // Roles (unique by [shopId, type])
  const roleIndividual = await prisma.role.upsert({
    where: { shopId_type: { shopId: shop.id, type: RoleType.individual } },
    update: {
      title: "Individual",
      description: "Personal purchase / quote request",
      active: true,
    },
    create: {
      shopId: shop.id,
      type: RoleType.individual,
      title: "Individual",
      description: "Personal purchase / quote request",
      active: true,
    },
  });

  const roleInstaller = await prisma.role.upsert({
    where: { shopId_type: { shopId: shop.id, type: RoleType.installer } },
    update: {
      title: "Installer",
      description: "Professional installer (document required)",
      active: true,
    },
    create: {
      shopId: shop.id,
      type: RoleType.installer,
      title: "Installer",
      description: "Professional installer (document required)",
      active: true,
    },
  });

  const roleCompany = await prisma.role.upsert({
    where: { shopId_type: { shopId: shop.id, type: RoleType.company } },
    update: {
      title: "Company",
      description: "Business / reseller (documents required)",
      active: true,
    },
    create: {
      shopId: shop.id,
      type: RoleType.company,
      title: "Company",
      description: "Business / reseller (documents required)",
      active: true,
    },
  });

  // Role requirements (installer/company)
  await prisma.roleRequirement.upsert({
    where: { roleId_key: { roleId: roleInstaller.id, key: "installer_document" } },
    update: { label: "Installer document", required: true, acceptedMimeTypes: ["application/pdf", "image/*"] },
    create: {
      roleId: roleInstaller.id,
      key: "installer_document",
      label: "Installer document",
      description: "Upload proof you are an installer",
      required: true,
      acceptedMimeTypes: ["application/pdf", "image/*"],
      maxSizeBytes: 10 * 1024 * 1024,
    },
  });

  await prisma.roleRequirement.upsert({
    where: { roleId_key: { roleId: roleCompany.id, key: "company_register" } },
    update: { label: "Company registration", required: true, acceptedMimeTypes: ["application/pdf", "image/*"] },
    create: {
      roleId: roleCompany.id,
      key: "company_register",
      label: "Company registration",
      description: "Upload company registration document",
      required: true,
      acceptedMimeTypes: ["application/pdf", "image/*"],
      maxSizeBytes: 10 * 1024 * 1024,
    },
  });

  // Default Form (unique by [shopId, slug])
  const form = await prisma.form.upsert({
    where: { shopId_slug: { shopId: shop.id, slug: "default" } },
    update: {
      name: "Default Request Form",
      status: FormStatus.active,
      placement: Placement.popup,
      isActive: true,
    },
    create: {
      shopId: shop.id,
      name: "Default Request Form",
      slug: "default",
      status: FormStatus.active,
      placement: Placement.popup,
      isActive: true,
      ui: {
        buttonLabel: "Request quote",
        successMessage: "Thanks — we received your request.",
      },
    },
    select: { id: true, slug: true },
  });

  // Pin default form in ShopSettings
  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    update: {
      currency: "DZD",
      showPriceForIndividuals: false,
      currentFormId: form.id,
    },
    create: {
      shopId: shop.id,
      currency: "DZD",
      showPriceForIndividuals: false,
      currentFormId: form.id,
    },
  });

  // Base fields (orderIndex + unique nameKey per form)
  const fields = [
    { nameKey: "firstName", label: "First name", type: FieldType.text, required: true },
    { nameKey: "lastName", label: "Last name", type: FieldType.text, required: true },
    { nameKey: "email", label: "Email", type: FieldType.email, required: false },
    { nameKey: "phone", label: "Phone", type: FieldType.tel, required: true },
    { nameKey: "address", label: "Address", type: FieldType.textarea, required: false },
    { nameKey: "wilayaCode", label: "Wilaya", type: FieldType.select, required: true },
    { nameKey: "communeId", label: "Commune", type: FieldType.select, required: false },
    { nameKey: "qty", label: "Quantity", type: FieldType.number, required: true },
  ] as const;

  // Upsert field-by-field (since unique is [formId, nameKey])
  let idx = 0;
  for (const f of fields) {
    await prisma.formField.upsert({
      where: { formId_nameKey: { formId: form.id, nameKey: f.nameKey } },
      update: {
        label: f.label,
        type: f.type,
        required: f.required,
        visible: true,
        orderIndex: idx++,
      },
      create: {
        formId: form.id,
        nameKey: f.nameKey,
        label: f.label,
        type: f.type,
        required: f.required,
        visible: true,
        orderIndex: idx++,
      },
    });
  }

  // Link role -> form (optional but useful)
  await prisma.role.updateMany({
    where: { id: { in: [roleIndividual.id, roleInstaller.id, roleCompany.id] } },
    data: { formId: form.id },
  });

  // ─────────────────────────────────────────────────────────
  // 5) Optional demo Request (only if none exist)
  // ─────────────────────────────────────────────────────────
  const existingReqCount = await prisma.request.count({ where: { shopId: shop.id } });
  if (existingReqCount === 0) {
    const w = wilayas[0]; // first wilaya in file
    const c = communes.find((x) => x.wilayaCode === w.code);

    // Find actual communeId from DB (since GeoCommune.id is cuid())
    let communeId: string | null = null;
    if (c) {
      const found = await prisma.geoCommune.findFirst({
        where: { wilayaCode: c.wilayaCode, nameFr: c.nameFr },
        select: { id: true },
      });
      communeId = found?.id ?? null;
    }

    await prisma.request.create({
      data: {
        shopId: shop.id,
        status: "received",
        roleType: RoleType.individual,
        roleId: roleIndividual.id,
        formId: form.id,
        firstName: "Demo",
        lastName: "Customer",
        phone: "0550000000",
        email: "demo@example.com",
        wilayaCode: w.code,
        communeId,
        pageUrl: "https://example.com/products/demo",
        referrer: "https://example.com/",
        ip: "127.0.0.1",
        userAgent: "seed",
        qty: 1,
        values: { note: "Seeded demo request" },
        items: {
          create: [
            {
              productId: "demo_product",
              variantId: null,
              qty: 1,
            },
          ],
        },
      },
    });
  }

  const wilayaCount = await prisma.geoWilaya.count();
  const communeCount = await prisma.geoCommune.count();
  const roleCount = await prisma.role.count({ where: { shopId: shop.id } });
  const formCount = await prisma.form.count({ where: { shopId: shop.id } });
  const reqCount = await prisma.request.count({ where: { shopId: shop.id } });

  console.log(
    `[seed] Done.
  Shop=${shop.shopDomain}
  Wilayas=${wilayaCount}
  Communes=${communeCount}
  Roles=${roleCount}
  Forms=${formCount}
  Requests=${reqCount}`
  );
}

main()
  .catch((e) => {
    console.error("[seed] Failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
