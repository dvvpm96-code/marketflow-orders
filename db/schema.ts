import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const orders = sqliteTable('orders', {
 id: text('id').primaryKey(), owner: text('owner').notNull(), mode: text('mode').notNull(),
 market: text('market').notNull(), scheme: text('scheme').notNull(), externalId: text('external_id').notNull(),
 stage: text('stage').notNull().default('new'), payload: text('payload').notNull(), updated: text('updated').notNull(),
}, t => [index('orders_owner_mode').on(t.owner,t.mode)]);
export const events = sqliteTable('events', {id: integer('id').primaryKey({autoIncrement:true}), owner:text('owner').notNull(), mode:text('mode').notNull(), action:text('action').notNull(), detail:text('detail').notNull(), created:text('created').notNull()},t=>[index('events_owner').on(t.owner)]);
export const credentials = sqliteTable('credentials', {id:text('id').primaryKey(), owner:text('owner').notNull(), market:text('market').notNull(), encrypted:text('encrypted').notNull(), updated:text('updated').notNull()});
