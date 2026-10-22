ALTER TABLE "HelpDeskTicket" ADD COLUMN "number" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "HelpDeskTicket" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'Normal';
ALTER TABLE "HelpDeskTicket" ADD COLUMN "assignee" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HelpDeskTicket" ADD COLUMN "tags" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HelpDeskTicket" ADD COLUMN "customerId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HelpDeskTicket" ADD COLUMN "accessToken" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HelpDeskTicket" ADD COLUMN "unread" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "HelpDeskTicket" ADD COLUMN "firstResponseAt" DATETIME;
ALTER TABLE "HelpDeskTicket" ADD COLUMN "resolvedAt" DATETIME;
ALTER TABLE "HelpDeskTicket" ADD COLUMN "lastActivityAt" DATETIME;
UPDATE "HelpDeskTicket" SET "number" = 1000 + (SELECT COUNT(*) FROM "HelpDeskTicket" AS "earlier" WHERE "earlier"."shop" = "HelpDeskTicket"."shop" AND ("earlier"."createdAt" < "HelpDeskTicket"."createdAt" OR ("earlier"."createdAt" = "HelpDeskTicket"."createdAt" AND "earlier"."id" <= "HelpDeskTicket"."id"))), "accessToken" = lower(hex(randomblob(24))), "lastActivityAt" = "updatedAt", "unread" = false, "resolvedAt" = CASE WHEN "status" = 'Resolved' THEN "updatedAt" END;
CREATE UNIQUE INDEX "HelpDeskTicket_shop_number_key" ON "HelpDeskTicket"("shop", "number");
CREATE UNIQUE INDEX "HelpDeskTicket_accessToken_key" ON "HelpDeskTicket"("accessToken");
CREATE INDEX "HelpDeskTicket_shop_lastActivityAt_idx" ON "HelpDeskTicket"("shop", "lastActivityAt");
CREATE INDEX "HelpDeskTicket_shop_customerId_idx" ON "HelpDeskTicket"("shop", "customerId");
CREATE TABLE "HelpDeskMessage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ticketId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "emailed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HelpDeskMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HelpDeskTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "HelpDeskMessage_ticketId_createdAt_idx" ON "HelpDeskMessage"("ticketId", "createdAt");
CREATE TABLE "HelpDeskMacro" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "HelpDeskMacro_shop_idx" ON "HelpDeskMacro"("shop");
ALTER TABLE "HelpDeskSettings" ADD COLUMN "autoReply" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "HelpDeskSettings" ADD COLUMN "signature" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HelpDeskSettings" ADD COLUMN "team" TEXT NOT NULL DEFAULT ''
