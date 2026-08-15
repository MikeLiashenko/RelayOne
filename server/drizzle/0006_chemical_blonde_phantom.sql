ALTER TABLE "users" ADD COLUMN "privacy_messages" text DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "privacy_last_seen" text DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "privacy_avatar" text DEFAULT 'everyone' NOT NULL;