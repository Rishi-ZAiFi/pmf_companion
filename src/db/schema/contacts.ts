import { pgTable, uuid, text, boolean, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects";

/**
 * contacts — people targeted by outreach campaigns.
 * At least one of email or phone must be present (enforced by CHECK constraint).
 *
 * Encryption at rest (Requirement 22.1):
 * Contact PII (email, phone, first_name, last_name) is protected at the
 * storage layer via AWS RDS encryption (AES-256), which encrypts the
 * underlying EBS volumes and automated backups. Row-Level Security (RLS)
 * policies scoped to `app.current_account_id` enforce tenant isolation at
 * the database level, ensuring no cross-account data access is possible.
 *
 * For additional field-level encryption of contact PII in a future iteration,
 * the `encrypt()`/`decrypt()` helpers in `src/lib/encryption.ts` (AES-256-GCM)
 * can be applied to individual columns before write and after read.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    /** Segment tags for targeting, e.g. ['power_user', 'churned'] */
    segmentTags: text("segment_tags")
      .array()
      .notNull()
      .default(sql`'{}'`),
    optedOutEmail: boolean("opted_out_email").notNull().default(false),
    optedOutSms: boolean("opted_out_sms").notNull().default(false),
    optedOutVoice: boolean("opted_out_voice").notNull().default(false),
    /** hubspot | intercom | mailchimp | csv */
    crmSource: text("crm_source"),
    /** External CRM record ID for sync */
    crmId: text("crm_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Require at least one contact channel
    contactHasChannel: check(
      "contact_has_channel",
      sql`${table.email} IS NOT NULL OR ${table.phone} IS NOT NULL`,
    ),
  }),
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
