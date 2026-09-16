CREATE TABLE IF NOT EXISTS "studio_bot_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "from_bot_id" text NOT NULL,
  "to_bot_id" text NOT NULL,
  "body" text NOT NULL,
  "priority" boolean DEFAULT true NOT NULL,
  "channel_id" text,
  "thread_id" text,
  "delivered_at" timestamp with time zone,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_bot_messages" ADD CONSTRAINT "studio_bot_messages_from_bot_id_agents_id_fk" FOREIGN KEY ("from_bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_bot_messages" ADD CONSTRAINT "studio_bot_messages_to_bot_id_agents_id_fk" FOREIGN KEY ("to_bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_bot_messages_to_idx" ON "studio_bot_messages" USING btree ("to_bot_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_bot_messages_from_idx" ON "studio_bot_messages" USING btree ("from_bot_id","created_at");
