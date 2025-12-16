// prisma/seed.ts
import { PrismaClient } from "@prisma/client";
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
  const wilayas = readJson<Array<{ code: number; nameFr: string; nameAr: string }>>(
    "prisma/data/wilayas.json"
  );
  const communes = readJson<Array<{ wilayaCode: number; nameFr: string; nameAr: string }>>(
    "prisma/data/communes.json"
  );

  // 1) Seed wilayas
  for (const w of wilayas) {
    await prisma.geoWilaya.upsert({
      where: { code: w.code },
      update: { nameFr: w.nameFr, nameAr: w.nameAr },
      create: { code: w.code, nameFr: w.nameFr, nameAr: w.nameAr },
    });
  }

  // 2) Validate wilaya codes exist
  const wilayaCodes = new Set(wilayas.map((w) => w.code));
  const bad = communes.filter((c) => !wilayaCodes.has(c.wilayaCode));
  if (bad.length) {
    console.warn(`[seed] Communes with invalid wilayaCode: ${bad.length}. Example:`, bad[0]);
  }

  // 3) Seed communes
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

  const wilayaCount = await prisma.geoWilaya.count();
  const communeCount = await prisma.geoCommune.count();
  console.log(`[seed] Done. Wilayas=${wilayaCount}, Communes=${communeCount}`);
}

main()
  .catch((e) => {
    console.error("[seed] Failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
