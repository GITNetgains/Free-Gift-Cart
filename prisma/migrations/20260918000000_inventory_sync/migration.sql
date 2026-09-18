CREATE TABLE "InventorySyncPair" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "originalVariantId" TEXT NOT NULL,
  "duplicateVariantId" TEXT NOT NULL,
  "originalItemId" TEXT NOT NULL,
  "duplicateItemId" TEXT NOT NULL,
  "originalTitle" TEXT NOT NULL,
  "duplicateTitle" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "locationName" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sharedQuantity" INTEGER NOT NULL,
  "originalBaseline" INTEGER NOT NULL,
  "duplicateBaseline" INTEGER NOT NULL,
  "pending" TEXT,
  "lastSyncedAt" DATETIME,
  "lastError" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockToken" TEXT,
  "lockUntil" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "InventorySyncMember" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "pairId" TEXT NOT NULL,
  CONSTRAINT "InventorySyncMember_pairId_fkey" FOREIGN KEY ("pairId") REFERENCES "InventorySyncPair" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "InventorySyncPair_enabled_nextRunAt_idx" ON "InventorySyncPair"("enabled", "nextRunAt");
CREATE INDEX "InventorySyncPair_shop_idx" ON "InventorySyncPair"("shop");
CREATE UNIQUE INDEX "InventorySyncMember_shop_inventoryItemId_locationId_key" ON "InventorySyncMember"("shop", "inventoryItemId", "locationId");
