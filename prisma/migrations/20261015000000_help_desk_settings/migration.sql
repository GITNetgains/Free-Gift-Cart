CREATE TABLE "HelpDeskSettings" (
  "shop" TEXT NOT NULL PRIMARY KEY,
  "notify" BOOLEAN NOT NULL DEFAULT true,
  "notifyEmail" TEXT NOT NULL DEFAULT ''
);
