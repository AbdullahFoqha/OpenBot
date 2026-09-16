CREATE TABLE IF NOT EXISTS "studio_bot_secrets" (
  "id" text PRIMARY KEY NOT NULL,
  "bot_id" text NOT NULL,
  "name" text NOT NULL,
  "encrypted_value" text NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_bot_secrets" ADD CONSTRAINT "studio_bot_secrets_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "studio_bot_secrets_bot_name_idx" ON "studio_bot_secrets" ("bot_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_bot_secrets_bot_idx" ON "studio_bot_secrets" ("bot_id");
