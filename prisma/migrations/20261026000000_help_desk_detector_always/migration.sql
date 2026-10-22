-- The AI detector now runs for every photo layers 1-4 can't settle by default.
-- SQLite can't change a column default in place, so the table is rebuilt.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_HelpDeskSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmail" TEXT NOT NULL DEFAULT '',
    "autoReply" BOOLEAN NOT NULL DEFAULT true,
    "signature" TEXT NOT NULL DEFAULT '',
    "team" TEXT NOT NULL DEFAULT '',
    "statusEmails" BOOLEAN NOT NULL DEFAULT true,
    "chatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "chatGreeting" TEXT NOT NULL DEFAULT '',
    "faqsSeeded" BOOLEAN NOT NULL DEFAULT false,
    "aiDetectionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "aiDetectorMode" TEXT NOT NULL DEFAULT 'always',
    "aiDetectionProvider" TEXT NOT NULL DEFAULT 'sightengine',
    "sightengineUser" TEXT NOT NULL DEFAULT '',
    "sightengineSecret" TEXT NOT NULL DEFAULT '',
    "truthscanKey" TEXT NOT NULL DEFAULT '',
    "formLastSeenAt" DATETIME,
    "chatLastSeenAt" DATETIME,
    "faqsReviewed" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_HelpDeskSettings" ("shop", "notify", "notifyEmail", "autoReply", "signature", "team", "statusEmails", "chatEnabled", "chatGreeting", "faqsSeeded", "aiDetectionEnabled", "aiDetectorMode", "aiDetectionProvider", "sightengineUser", "sightengineSecret", "truthscanKey", "formLastSeenAt", "chatLastSeenAt", "faqsReviewed")
SELECT "shop", "notify", "notifyEmail", "autoReply", "signature", "team", "statusEmails", "chatEnabled", "chatGreeting", "faqsSeeded", "aiDetectionEnabled",
  CASE WHEN "aiDetectorMode" = 'suspicious' THEN 'always' ELSE "aiDetectorMode" END,
  "aiDetectionProvider", "sightengineUser", "sightengineSecret", "truthscanKey", "formLastSeenAt", "chatLastSeenAt", "faqsReviewed"
FROM "HelpDeskSettings";
DROP TABLE "HelpDeskSettings";
ALTER TABLE "new_HelpDeskSettings" RENAME TO "HelpDeskSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
