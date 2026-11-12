CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "create_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"provider" text NOT NULL,
	"size" text NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "create_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"size" text NOT NULL,
	"preset" text,
	"provider" text,
	"provider_sandbox_id" text,
	"cpu" integer,
	"memory_mib" integer,
	"disk_mib" integer,
	"home_dir" text,
	"rate_per_hour_micros" bigint DEFAULT 0 NOT NULL,
	"hold_micros" bigint DEFAULT 0 NOT NULL,
	"billing_started_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"cost_micros" bigint,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandboxes_hold_nonneg" CHECK ("sandboxes"."hold_micros" >= 0),
	CONSTRAINT "sandboxes_rate_nonneg" CHECK ("sandboxes"."rate_per_hour_micros" >= 0),
	CONSTRAINT "sandboxes_status_valid" CHECK (status in ('creating', 'running', 'ended', 'failed')),
	CONSTRAINT "sandboxes_end_reason_valid" CHECK (end_reason in ('killed', 'expired', 'lost', 'create_failed'))
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "create_attempts" ADD CONSTRAINT "create_attempts_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_account_idx" ON "api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "create_attempts_provider_created_idx" ON "create_attempts" USING btree ("provider","created_at");--> statement-breakpoint
CREATE INDEX "sandboxes_account_created_idx" ON "sandboxes" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "sandboxes_status_expires_idx" ON "sandboxes" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_provider_ref_idx" ON "sandboxes" USING btree ("provider","provider_sandbox_id");