CREATE TABLE "HelpDeskTicket" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "details" TEXT NOT NULL,
  "products" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Open',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "HelpDeskTicket_shop_requestKey_key" ON "HelpDeskTicket"("shop", "requestKey");
CREATE INDEX "HelpDeskTicket_shop_createdAt_idx" ON "HelpDeskTicket"("shop", "createdAt");
CREATE TABLE "HelpDeskAttachment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ticketId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "data" BLOB NOT NULL,
  CONSTRAINT "HelpDeskAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HelpDeskTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
