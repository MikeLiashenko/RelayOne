CREATE TABLE IF NOT EXISTS "scheduled_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"content" text,
	"reply_to_id" uuid,
	"ttl_seconds" integer,
	"send_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_messages_send_at_idx" ON "scheduled_messages" USING btree ("send_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_messages_sender_idx" ON "scheduled_messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_expires_at_idx" ON "messages" USING btree ("expires_at");