CREATE TABLE IF NOT EXISTS "studio_memories" (
  "id" text PRIMARY KEY NOT NULL,
  "bot_id" text,
  "scope" text DEFAULT 'agent' NOT NULL,
  "tier" text DEFAULT 'log' NOT NULL,
  "fact" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_memories" ADD CONSTRAINT "studio_memories_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_memories_bot_idx" ON "studio_memories" ("bot_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_memories_scope_idx" ON "studio_memories" ("scope","created_at");
