import FirecrawlApp from "@mendable/firecrawl-js";
import dotenv from "dotenv";
// Removed Together import
import { z } from "zod";
// Removed zodToJsonSchema import since we no longer enforce JSON output via Together

dotenv.config();

// Initialize Firecrawl
const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const apifyToken = process.env.APIFY_API_TOKEN;
const apifyActorId =
  process.env.APIFY_TWITTER_ACTOR_ID?.trim() ||
  "kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest";

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
  const useTwitter = Boolean(apifyToken);
  const tweetStartTime = new Date(
    Date.now() - 24 * 60 * 60 * 1000,
  ).toISOString();

  for (const sourceObj of sources) {
    const source = sourceObj.identifier;

    // --- 1) Handle Twitter/X sources ---
    if (source.includes("x.com")) {
      if (useTwitter) {
        const usernameMatch = source.match(/x\.com\/([^\/]+)/);
        if (!usernameMatch) continue;
        const username = usernameMatch[1];

        if (!apifyToken) {
          console.warn(
            `Skipping X source for ${username} because APIFY_API_TOKEN is not configured.`,
          );
          continue;
        }

        const apifyUrl = `https://api.apify.com/v2/acts/${apifyActorId}/run-sync-get-dataset-items?token=${apifyToken}`;

        const requestPayload = {
          twitterContent: `from:${username} has:media -is:retweet -is:reply`,
          maxItems: 10,
          queryType: "Latest",
          within_time: "1d",
        };

        try {
          const response = await fetch(apifyUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestPayload),
          });
          if (!response.ok) {
            throw new Error(
              `Failed to fetch tweets for ${username}: ${response.statusText}`,
            );
          }
          const tweetsResponse = await response.json();
          const tweetItems = Array.isArray(tweetsResponse)
            ? tweetsResponse
            : Array.isArray(tweetsResponse?.items)
            ? tweetsResponse.items
            : [];

          if (!Array.isArray(tweetItems) || tweetItems.length === 0) {
            console.log(`No tweets found for username ${username}.`);
            continue;
          }

          const stories = tweetItems
            .filter((tweet: any) => tweet?.type === "tweet" && tweet?.id)
            .map(
              (tweet: any): Story => ({
                headline: tweet.text ?? "",
                link: tweet.url ?? `https://x.com/i/status/${tweet.id}`,
                date_posted: tweet.createdAt
                  ? new Date(tweet.createdAt).toISOString()
                  : tweetStartTime,
              }),
            )
            .filter((story: Story) => story.headline && story.link);

          if (stories.length > 0) {
            console.log(`Tweets found from username ${username}`);
            combinedText.stories.push(...stories);
          } else {
            console.log(
              `Apify response for ${username} did not contain usable tweets.`,
            );
          }
        } catch (error: any) {
          console.error(`Error fetching tweets for ${username}:`, error);
        }
      }
    }
    // --- 2) Handle all other sources with Firecrawl ---
    else {
      if (useScrape) {
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
          console.log(
            `Found ${todayStories.stories.length} stories from ${source}`,
          );
          combinedText.stories.push(...todayStories.stories);
        } catch (error: any) {
          if (error.statusCode === 429) {
            console.error(
              `Rate limit exceeded for ${source}. Skipping this source.`,
            );
          } else {
            console.error(`Error scraping source ${source}:`, error);
          }
        }
      }
    }
  }

  console.log("Combined Stories:", combinedText.stories);
  return combinedText.stories;
}
