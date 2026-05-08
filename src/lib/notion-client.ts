/**
 * notion-client.ts
 *
 * Thin wrapper around the Notion REST API for creating pages and blocks.
 * Uses the bot access token obtained via OAuth.
 *
 * Notion API reference: https://developers.notion.com/reference
 * API version: 2022-06-28
 *
 * Requirements: 20.3
 */

// ── Notion block types used in exports ───────────────────────────────────────

export interface NotionRichText {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    color?: string;
  };
}

export interface NotionHeading1Block {
  object: "block";
  type: "heading_1";
  heading_1: { rich_text: NotionRichText[] };
}

export interface NotionHeading2Block {
  object: "block";
  type: "heading_2";
  heading_2: { rich_text: NotionRichText[] };
}

export interface NotionHeading3Block {
  object: "block";
  type: "heading_3";
  heading_3: { rich_text: NotionRichText[] };
}

export interface NotionParagraphBlock {
  object: "block";
  type: "paragraph";
  paragraph: { rich_text: NotionRichText[] };
}

export interface NotionBulletedListItemBlock {
  object: "block";
  type: "bulleted_list_item";
  bulleted_list_item: { rich_text: NotionRichText[] };
}

export interface NotionDividerBlock {
  object: "block";
  type: "divider";
  divider: Record<string, never>;
}

export interface NotionCalloutBlock {
  object: "block";
  type: "callout";
  callout: {
    rich_text: NotionRichText[];
    icon: { type: "emoji"; emoji: string };
    color?: string;
  };
}

export type NotionBlock =
  | NotionHeading1Block
  | NotionHeading2Block
  | NotionHeading3Block
  | NotionParagraphBlock
  | NotionBulletedListItemBlock
  | NotionDividerBlock
  | NotionCalloutBlock;

// ── Page creation payload ─────────────────────────────────────────────────────

export interface NotionPageParent {
  type: "database_id" | "page_id";
  database_id?: string;
  page_id?: string;
}

export interface NotionTitleProperty {
  title: Array<{ text: { content: string } }>;
}

export interface NotionCreatePagePayload {
  parent: NotionPageParent;
  properties: {
    title?: NotionTitleProperty;
    Name?: NotionTitleProperty;
    [key: string]: unknown;
  };
  children: NotionBlock[];
}

/** Shape of a successful Notion page creation response (relevant fields). */
export interface NotionPageResponse {
  object: "page";
  id: string;
  url: string;
  created_time: string;
  last_edited_time: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Create a Notion page using the provided bot access token.
 *
 * @param accessToken - The Notion bot access token from the OAuth flow.
 * @param payload     - The page creation payload (parent, properties, children).
 * @returns The created page's ID and URL.
 * @throws If the Notion API returns a non-2xx response.
 */
export async function createNotionPage(
  accessToken: string,
  payload: NotionCreatePagePayload,
): Promise<NotionPageResponse> {
  const response = await fetch(`${NOTION_API_BASE}/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Notion API error ${response.status}: ${errorText}`,
    );
  }

  return (await response.json()) as NotionPageResponse;
}

// ── Block builder helpers ─────────────────────────────────────────────────────

/** Create a plain-text rich text object. */
export function richText(content: string, url?: string): NotionRichText {
  return {
    type: "text",
    text: {
      content: content.slice(0, 2000), // Notion's 2000-char limit per rich text object
      link: url ? { url } : null,
    },
  };
}

/** Create a bold rich text object. */
export function boldText(content: string): NotionRichText {
  return {
    type: "text",
    text: { content: content.slice(0, 2000), link: null },
    annotations: { bold: true },
  };
}

export function heading1(text: string): NotionHeading1Block {
  return {
    object: "block",
    type: "heading_1",
    heading_1: { rich_text: [richText(text)] },
  };
}

export function heading2(text: string): NotionHeading2Block {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [richText(text)] },
  };
}

export function heading3(text: string): NotionHeading3Block {
  return {
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: [richText(text)] },
  };
}

export function paragraph(text: string): NotionParagraphBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [richText(text)] },
  };
}

export function bulletItem(text: string, url?: string): NotionBulletedListItemBlock {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: [richText(text, url)] },
  };
}

export function divider(): NotionDividerBlock {
  return {
    object: "block",
    type: "divider",
    divider: {},
  };
}

export function callout(text: string, emoji = "💡"): NotionCalloutBlock {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: [richText(text)],
      icon: { type: "emoji", emoji },
    },
  };
}
