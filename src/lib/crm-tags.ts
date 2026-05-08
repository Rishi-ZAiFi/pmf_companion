/**
 * crm-tags.ts
 *
 * Helpers for pushing signal-derived tags back to connected CRMs as contact
 * properties (HubSpot) or custom attributes (Intercom).
 *
 * These functions are called after contacts are synced or after new signals
 * are processed and tags are derived from them.
 *
 * Requirements: 20.2
 */

// ── HubSpot ───────────────────────────────────────────────────────────────────

/**
 * Pushes signal-derived tags to a HubSpot contact as a custom property.
 *
 * The tags are stored as a semicolon-delimited string in the
 * `market_signal_tags` property. This property must be created in HubSpot
 * before use (or the API call will fail with a 400).
 *
 * @param accessToken - Decrypted HubSpot OAuth access token.
 * @param hubspotContactId - The HubSpot contact record ID (numeric string).
 * @param tags - Array of signal-derived segment tags to push.
 */
export async function pushTagsToHubSpot(
  accessToken: string,
  hubspotContactId: string,
  tags: string[],
): Promise<void> {
  if (tags.length === 0) return;

  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${hubspotContactId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          market_signal_tags: tags.join(";"),
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HubSpot PATCH contact ${hubspotContactId} failed: ${response.status} ${errorText}`,
    );
  }
}

/**
 * Bulk-pushes signal-derived tags to multiple HubSpot contacts using the
 * HubSpot Batch Update API (up to 100 contacts per call).
 *
 * @param accessToken - Decrypted HubSpot OAuth access token.
 * @param updates - Array of { hubspotContactId, tags } pairs.
 */
export async function bulkPushTagsToHubSpot(
  accessToken: string,
  updates: Array<{ hubspotContactId: string; tags: string[] }>,
): Promise<void> {
  if (updates.length === 0) return;

  // HubSpot batch update supports up to 100 records per request
  const BATCH_SIZE = 100;

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);

    const inputs = batch.map(({ hubspotContactId, tags }) => ({
      id: hubspotContactId,
      properties: {
        market_signal_tags: tags.join(";"),
      },
    }));

    const response = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/update",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `HubSpot batch update failed (batch ${i / BATCH_SIZE + 1}): ${response.status} ${errorText}`,
      );
    }
  }
}

// ── Intercom ──────────────────────────────────────────────────────────────────

/**
 * Pushes signal-derived tags to an Intercom contact as a custom attribute.
 *
 * The tags are stored as a comma-delimited string in the
 * `market_signal_tags` custom attribute on the contact.
 *
 * @param accessToken - Decrypted Intercom OAuth access token.
 * @param intercomContactId - The Intercom contact ID.
 * @param tags - Array of signal-derived segment tags to push.
 */
export async function pushTagsToIntercom(
  accessToken: string,
  intercomContactId: string,
  tags: string[],
): Promise<void> {
  if (tags.length === 0) return;

  const response = await fetch(
    `https://api.intercom.io/contacts/${intercomContactId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        custom_attributes: {
          market_signal_tags: tags.join(","),
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Intercom PUT contact ${intercomContactId} failed: ${response.status} ${errorText}`,
    );
  }
}

/**
 * Applies an Intercom tag to a contact by tag name.
 * Creates the tag if it does not already exist.
 *
 * This is an alternative to custom attributes — it uses Intercom's native
 * tagging system, which is visible in the Intercom UI without custom attribute setup.
 *
 * @param accessToken - Decrypted Intercom OAuth access token.
 * @param intercomContactId - The Intercom contact ID.
 * @param tagName - The tag name to apply.
 */
export async function applyIntercomTag(
  accessToken: string,
  intercomContactId: string,
  tagName: string,
): Promise<void> {
  // Step 1: Create or find the tag
  const tagResponse = await fetch("https://api.intercom.io/tags", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ name: tagName }),
  });

  if (!tagResponse.ok) {
    const errorText = await tagResponse.text();
    throw new Error(
      `Intercom create tag "${tagName}" failed: ${tagResponse.status} ${errorText}`,
    );
  }

  const tagData = (await tagResponse.json()) as { id?: string };
  const tagId = tagData.id;

  if (!tagId) {
    throw new Error(`Intercom did not return a tag ID for tag "${tagName}"`);
  }

  // Step 2: Apply the tag to the contact
  const applyResponse = await fetch(
    `https://api.intercom.io/contacts/${intercomContactId}/tags`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ id: tagId }),
    },
  );

  if (!applyResponse.ok) {
    const errorText = await applyResponse.text();
    throw new Error(
      `Intercom apply tag "${tagName}" to contact ${intercomContactId} failed: ${applyResponse.status} ${errorText}`,
    );
  }
}
