-- CreateTable
CREATE TABLE "HelpDeskStaff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL DEFAULT '',
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "HelpDeskStaff_shop_idx" ON "HelpDeskStaff"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "HelpDeskStaff_shop_userId_key" ON "HelpDeskStaff"("shop", "userId");
