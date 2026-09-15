CREATE TYPE "public"."studio_reservation_state" AS ENUM('held', 'suspended', 'released', 'lost');--> statement-breakpoint
CREATE TYPE "public"."studio_task_kind" AS ENUM('execution', 'review', 'coordination');--> statement-breakpoint
CREATE TYPE "public"."studio_task_state" AS ENUM('backlog', 'ready', 'in_progress', 'in_review', 'ready_to_integrate', 'integrated');--> statement-breakpoint
CREATE TABLE "studio_products" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repository_url" text,
	"board_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "studio_reservations" (
	"task_id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"kind" "studio_task_kind" NOT NULL,
	"state" "studio_reservation_state" DEFAULT 'held' NOT NULL,
	"claimed_by" text NOT NULL,
	"fence" integer DEFAULT 1 NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"max_turns" integer NOT NULL,
	"checkpoint" jsonb,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"title" text NOT NULL,
	"state" "studio_task_state" DEFAULT 'backlog' NOT NULL,
	"kind" "studio_task_kind" DEFAULT 'execution' NOT NULL,
	"blocked_reason" text,
	"owner_bot_id" text,
	"parent_task_id" text,
	"depends_on" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_reservations" ADD CONSTRAINT "studio_reservations_task_id_studio_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."studio_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_tasks" ADD CONSTRAINT "studio_tasks_product_id_studio_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."studio_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_tasks" ADD CONSTRAINT "studio_tasks_owner_bot_id_agents_id_fk" FOREIGN KEY ("owner_bot_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_products_retired_idx" ON "studio_products" USING btree ("retired_at");--> statement-breakpoint
CREATE INDEX "studio_reservations_state_idx" ON "studio_reservations" USING btree ("state","lease_until");--> statement-breakpoint
CREATE INDEX "studio_reservations_bot_idx" ON "studio_reservations" USING btree ("bot_id","state");--> statement-breakpoint
CREATE INDEX "studio_tasks_product_state_idx" ON "studio_tasks" USING btree ("product_id","state");--> statement-breakpoint
CREATE INDEX "studio_tasks_owner_idx" ON "studio_tasks" USING btree ("owner_bot_id");--> statement-breakpoint
CREATE INDEX "studio_tasks_parent_idx" ON "studio_tasks" USING btree ("parent_task_id");