import FirecrawlApp from "@mendable/firecrawl-js";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

// Initialize Firecrawl
const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const DEFAULT_APIFY_ACTOR_ID =
  "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest";
const apifyToken = process.env.APIFY_API_TOKEN?.trim() ?? "";
const apifyActorId =
  process.env.APIFY_TWITTER_ACTOR_ID?.trim() || DEFAULT_APIFY_ACTOR_ID;
const apifyMaxItems = (() => {
  const raw = process.env.APIFY_TWITTER_MAX_ITEMS;
  if (!raw) return 20;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;
})();

// 1. Define the schema for our expected JSON
const StorySchema = z.object({
  headline: z.string().describe("Story or post headline"),
  link: z.string().describe("A link to the post or story"),
  date_posted: z.string().describe("The date the story or post was published"),
});

const StoriesSchema = z.object({
  stories: z
    .array(StorySchema)
    .describe("A list of today's AI or LLM-related stories"),
});

// Define the TypeScript type for a story using the schema
type Story = z.infer<typeof StorySchema>;

type ApifyTweetItem = {
  id?: string;
  text?: string;
  full_text?: string;
  url?: string;
  twitterUrl?: string;
  createdAt?: string;
  created_at?: string;
  date?: string;
  type?: string;
};

const TWEET_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const hasApifyCredentials = Boolean(apifyToken && apifyActorId);
const apifyEndpoint = hasApifyCredentials
  ? `https://api.apify.com/v2/acts/${apifyActorId}/run-sync-get-dataset-items?token=${apifyToken}`
  : null;

function formatDateForApify(date: Date): string {
  const iso = date.toISOString();
  const [datePart, timePartWithMs] = iso.split("T");
  const timePart = timePartWithMs?.slice(0, 8) ?? "00:00:00";
  return `${datePart}_${timePart}_UTC`;
}

function extractTwitterUsername(source: string): string | null {
  try {
    const url = new URL(source.startsWith("http") ? source : `https://${source}`);
    const host = url.hostname.toLowerCase();
    if (!host.endsWith("x.com") && !host.endsWith("twitter.com")) {
      return null;
    }

    const [firstSegment] = url.pathname.split("/").filter(Boolean);
    if (!firstSegment) {
      return null;
    }

    if (["i", "hashtag", "search"].includes(firstSegment.toLowerCase())) {
      return null;
    }

    return firstSegment.replace(/^@/, "");
  } catch {
    return null;
  }
}

function mapApifyItemsToStories(
  items: ApifyTweetItem[],
  fallbackDateIso: string,
): Story[] {
  const deduped = new Map<string, Story>();

  for (const item of items) {
    if (!item || item.type && item.type !== "tweet") {
      continue;
    }

    const rawHeadline = item.text ?? item.full_text ?? "";
    const headline = rawHeadline?.trim();
    if (!headline) {
      continue;
    }

    const candidateLinks = [item.url, item.twitterUrl, item.id
      ? `https://x.com/i/status/${item.id}`
      : undefined];
    const link = candidateLinks
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find((value) => value.length > 0);

    if (!link) {
      continue;
    }

    const rawDate = item.createdAt ?? item.created_at ?? item.date ?? null;
    let parsedDateIso = fallbackDateIso;
    if (rawDate) {
      const parsedDate = new Date(rawDate);
      if (!Number.isNaN(parsedDate.getTime())) {
        parsedDateIso = parsedDate.toISOString();
      }
    }

    deduped.set(link, {
      headline,
      link,
      date_posted: parsedDateIso,
    });
  }

  return Array.from(deduped.values());
}

async function fetchTweetsFromApify(username: string): Promise<Story[]> {
  if (!apifyEndpoint) {
    return [];
  }

  const now = new Date();
  const lookbackStart = new Date(now.getTime() - TWEET_LOOKBACK_MS);
  const requestPayload: Record<string, unknown> = {
    from: username,
    maxItems: apifyMaxItems,
    queryType: "Latest",
    since: formatDateForApify(lookbackStart),
    until: formatDateForApify(now),
    "include:nativeretweets": false,
    "filter:replies": false,
  };

  const response = await fetch(apifyEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestPayload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Apify request failed with ${response.status} ${response.statusText}: ${errorBody}`,
    );
  }

  const payload = await response.json();
  const items: unknown = Array.isArray(payload)
    ? payload
    : payload?.items ?? payload?.data ?? [];

  if (!Array.isArray(items)) {
    console.warn("Unexpected Apify response format", payload);
    return [];
  }

  const fallbackDateIso = lookbackStart.toISOString();
  const stories = mapApifyItemsToStories(
    items as ApifyTweetItem[],
    fallbackDateIso,
  );

  return stories.slice(0, apifyMaxItems);
}

/**
 * Scrape sources using Firecrawl (for non-Twitter URLs) and the Twitter API.
 * Returns a combined array of story objects.
 */
export async function scrapeSources(
  sources: { identifier: string }[],
): Promise<Story[]> {
  // Explicitly type the stories array so it is Story[]
  const combinedText: { stories: Story[] } = { stories: [] };

  // Configure toggles for scrapers
  const useScrape = true;
  const useTwitter = hasApifyCredentials;

  let sawTwitterSource = false;
  const processedTwitterUsernames = new Set<string>();

  for (const sourceObj of sources) {
    const source = sourceObj.identifier;

    const username = extractTwitterUsername(source);
    if (username) {
      sawTwitterSource = true;
    }
    if (useTwitter && username) {
      const normalizedUsername = username.toLowerCase();
      if (processedTwitterUsernames.has(normalizedUsername)) {
        continue;
      }
      processedTwitterUsernames.add(normalizedUsername);

      try {
        const stories = await fetchTweetsFromApify(username);
        if (stories.length === 0) {
          console.log(`No tweets found for username ${username}.`);
          continue;
        }

        console.log(`Tweets found from username ${username}`);
        combinedText.stories.push(...stories);
      } catch (error) {
        console.error(`Error fetching tweets for ${username}:`, error);
      }
      continue;
    }

    if (username && !useTwitter) {
      console.warn(
        `Skipping X source ${source} because Apify credentials are not configured.`,
      );
      continue;
    }

    if (!useScrape) {
      continue;
    }

    const currentDate = new Date().toLocaleDateString();
    const promptForFirecrawl = `
Return only today's AI or LLM related story or post headlines and links in JSON format from the page content.
They must be posted today, ${currentDate}. The format should be:
{
  "stories": [
    {
      "headline": "headline1",
      "link": "link1",
      "date_posted": "YYYY-MM-DD"
    },
    ...
  ]
}
If there are no AI or LLM stories from today, return {"stories": []}.

The source link is ${source}.
If a story link is not absolute, prepend ${source} to make it absolute.
Return only pure JSON in the specified format (no extra text, no markdown, no \`\`\`).
    `;
    try {
      const scrapeResult = await app.extract([source], {
        prompt: promptForFirecrawl,
        schema: StoriesSchema,
      });
      if (!scrapeResult.success) {
        throw new Error(`Failed to scrape: ${scrapeResult.error}`);
      }
      // Cast the result to our expected type
      const todayStories = scrapeResult.data as { stories: Story[] };
      if (!todayStories || !todayStories.stories) {
        console.error(
          `Scraped data from ${source} does not have a "stories" key.`,
          todayStories,
        );
        continue;
      }
      console.log(`Found ${todayStories.stories.length} stories from ${source}`);
      combinedText.stories.push(...todayStories.stories);
    } catch (error: any) {
      if (error.statusCode === 429) {
        console.error(`Rate limit exceeded for ${source}. Skipping this source.`);
      } else {
        console.error(`Error scraping source ${source}:`, error);
      }
    }
  }

  if (!useTwitter && sawTwitterSource) {
    console.log(
      "APIFY_API_TOKEN or APIFY_TWITTER_ACTOR_ID not configured; X sources were skipped.",
    );
  }

  console.log("Combined Stories:", combinedText.stories);
  return combinedText.stories;
}
