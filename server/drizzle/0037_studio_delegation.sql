CREATE TABLE "agent_delegation_capability" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"declared_by" text,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_run_id" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "callback_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_delegation_capability" ADD CONSTRAINT "agent_delegation_capability_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_delegation_capability" ADD CONSTRAINT "agent_delegation_capability_declared_by_users_id_fk" FOREIGN KEY ("declared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_delegation_capability_revoked_idx" ON "agent_delegation_capability" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "callback_operations_run_idx" ON "callback_operations" USING btree ("run_id","bot_id");--> statement-breakpoint
CREATE INDEX "callback_operations_created_idx" ON "callback_operations" USING btree ("created_at");