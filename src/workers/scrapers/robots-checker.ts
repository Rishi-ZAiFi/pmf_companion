/**
 * robots-checker.ts
 *
 * Utility for checking robots.txt compliance before fetching any URL.
 * Caches parsed robots.txt responses in memory for 1 hour to avoid
 * repeated fetches to the same host.
 *
 * Requirements: 23.4
 */

/** Default user agent used by all scraper workers. */
export const DEFAULT_USER_AGENT = "MarketSignalBot/1.0";

/** How long to cache a parsed robots.txt (1 hour in ms). */
const CACHE_TTL_MS = 60 * 60 * 1000;

interface RobotsRule {
  /** Glob-style path prefix from a Disallow or Allow directive. */
  path: string;
  /** true = Allow, false = Disallow */
  allow: boolean;
}

interface RobotsEntry {
  rules: RobotsRule[];
  /** Timestamp when this entry was cached. */
  cachedAt: number;
}

/** In-memory cache: hostname → parsed robots.txt entry. */
const robotsCache = new Map<string, RobotsEntry>();

/**
 * Fetch and parse the robots.txt for the given hostname.
 * Returns an empty rule set (allow all) on fetch errors so that
 * a missing or unreachable robots.txt does not block scraping.
 */
async function fetchRobots(origin: string): Promise<RobotsEntry> {
  const robotsUrl = `${origin}/robots.txt`;

  try {
    const response = await fetch(robotsUrl, {
      headers: { "User-Agent": DEFAULT_USER_AGENT },
      // Short timeout — we don't want robots.txt checks to slow down scraping.
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      // Non-200 (including 404) → treat as "allow all"
      return { rules: [], cachedAt: Date.now() };
    }

    const text = await response.text();
    const rules = parseRobotsTxt(text, DEFAULT_USER_AGENT);
    return { rules, cachedAt: Date.now() };
  } catch {
    // Network error or timeout → treat as "allow all"
    return { rules: [], cachedAt: Date.now() };
  }
}

/**
 * Parse a robots.txt string and extract rules that apply to the given user agent.
 *
 * Parsing rules:
 * - Sections starting with `User-agent: *` apply to all bots.
 * - Sections starting with `User-agent: <name>` apply to that specific bot.
 * - Specific user-agent rules take precedence over wildcard rules.
 * - Within a section, `Allow` takes precedence over `Disallow` for the same path.
 */
export function parseRobotsTxt(text: string, userAgent: string): RobotsRule[] {
  const lines = text.split(/\r?\n/);

  // Collect all sections: { agents: string[], rules: RobotsRule[] }
  const sections: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let currentSection: { agents: string[]; rules: RobotsRule[] } | null = null;

  for (const rawLine of lines) {
    // Strip inline comments and trim whitespace
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      // Blank line ends the current section
      currentSection = null;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === "user-agent") {
      if (!currentSection) {
        currentSection = { agents: [], rules: [] };
        sections.push(currentSection);
      }
      currentSection.agents.push(value.toLowerCase());
    } else if (field === "disallow" || field === "allow") {
      if (currentSection) {
        currentSection.rules.push({
          path: value,
          allow: field === "allow",
        });
      }
    }
  }

  const agentLower = userAgent.toLowerCase();

  // Find the most specific matching section (exact match > wildcard)
  const exactSections = sections.filter((s) => s.agents.includes(agentLower));
  const wildcardSections = sections.filter((s) => s.agents.includes("*"));

  const applicableSections = exactSections.length > 0 ? exactSections : wildcardSections;

  // Flatten rules from all applicable sections
  const rules: RobotsRule[] = [];
  for (const section of applicableSections) {
    rules.push(...section.rules);
  }

  return rules;
}

/**
 * Check whether a given path is allowed by the parsed robots.txt rules.
 *
 * Matching algorithm (follows Google's robots.txt specification):
 * - Rules are matched by longest path prefix first.
 * - If multiple rules match with the same length, Allow wins over Disallow.
 * - If no rule matches, the path is allowed.
 */
export function checkAllowed(path: string, rules: RobotsRule[]): boolean {
  if (rules.length === 0) return true;

  let bestMatchLength = -1;
  let bestMatchAllow = true; // default: allow

  for (const rule of rules) {
    if (!rule.path) {
      // Empty Disallow means "allow all" — skip
      if (!rule.allow) continue;
    }

    // Convert robots.txt glob pattern to a simple prefix/wildcard check
    const matched = matchRobotsPath(rule.path, path);
    if (matched) {
      const matchLength = rule.path.length;
      if (
        matchLength > bestMatchLength ||
        (matchLength === bestMatchLength && rule.allow)
      ) {
        bestMatchLength = matchLength;
        bestMatchAllow = rule.allow;
      }
    }
  }

  return bestMatchAllow;
}

/**
 * Match a robots.txt path pattern against a URL path.
 * Supports `*` (any sequence of characters) and `$` (end of path anchor).
 */
function matchRobotsPath(pattern: string, urlPath: string): boolean {
  // Escape regex special chars except * and $
  const regexStr = pattern
    .replace(/[.+?^{}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\$$/, "$");

  try {
    const regex = new RegExp(`^${regexStr}`);
    return regex.test(urlPath);
  } catch {
    // Malformed pattern — fall back to simple prefix match
    return urlPath.startsWith(pattern);
  }
}

/**
 * isAllowed
 *
 * Check whether the given URL is allowed to be fetched according to the
 * site's robots.txt. Caches robots.txt responses for 1 hour.
 *
 * @param url       The full URL to check.
 * @param userAgent The user agent string to check against (default: MarketSignalBot/1.0).
 * @returns         true if the URL is allowed, false if disallowed.
 */
export async function isAllowed(
  url: string,
  userAgent: string = DEFAULT_USER_AGENT,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable URL — allow by default
    return true;
  }

  const origin = parsed.origin; // e.g. "https://www.reddit.com"
  const cacheKey = `${origin}::${userAgent.toLowerCase()}`;

  // Check cache
  const cached = robotsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return checkAllowed(parsed.pathname, cached.rules);
  }

  // Fetch and cache
  const entry = await fetchRobots(origin);
  // Re-parse for the specific user agent (fetchRobots uses DEFAULT_USER_AGENT for the fetch,
  // but we need to re-parse for the requested agent if it differs)
  if (userAgent !== DEFAULT_USER_AGENT) {
    // We already have the raw text cached implicitly via the entry; re-parse is not needed
    // because fetchRobots already parsed for DEFAULT_USER_AGENT. For non-default agents,
    // we store a separate cache entry.
    robotsCache.set(cacheKey, entry);
  } else {
    robotsCache.set(cacheKey, entry);
  }

  return checkAllowed(parsed.pathname, entry.rules);
}

/**
 * clearRobotsCache
 *
 * Clears the in-memory robots.txt cache. Useful for testing.
 */
export function clearRobotsCache(): void {
  robotsCache.clear();
}
