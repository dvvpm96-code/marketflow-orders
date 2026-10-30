CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`market` text NOT NULL,
	`encrypted` text NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`mode` text NOT NULL,
	`action` text NOT NULL,
	`detail` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_owner` ON `events` (`owner`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`mode` text NOT NULL,
	`market` text NOT NULL,
	`scheme` text NOT NULL,
	`external_id` text NOT NULL,
	`stage` text DEFAULT 'new' NOT NULL,
	`payload` text NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `orders_owner_mode` ON `orders` (`owner`,`mode`);