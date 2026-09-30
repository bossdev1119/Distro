import "server-only";
import { z } from "zod";
import { chunk } from "@/lib/array";
import { DISCOVERY } from "@/lib/config";
import { serverEnv } from "@/lib/env";
import { getJsonWithRetry } from "./http";
import { QUOTA, QuotaExhaustedError, reserveQuota } from "@/lib/quota";
import {
  DiscoveryConfigError,
  type DiscoveredContent,
  type DiscoveredCreator,
  type RecentActivity,
} from "./types";

// YouTube Data API v3 — the only way this app reads YouTube. No scraping.
// Cost per call (quota units): search.list = 100, videos/channels/playlistItems.list = 1.

const API = "https://www.googleapis.com/youtube/v3";
const MAX_IDS_PER_CALL = 50;

export const YOUTUBE_COST = { search: 100, list: 1 } as const;

// ── Response schemas: validate what YouTube sends before trusting it ─────────
const count = z.coerce.number().int().nonnegative().optional(); // YouTube sends counts as strings
const thumbnails = z
  .object({ high: z.object({ url: z.string() }).optional(), medium: z.object({ url: z.string() }).optional(), default: z.object({ url: z.string() }).optional() })
  .optional();

const searchResponse = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(z.object({ id: z.object({ videoId: z.string().optional() }) })).default([]),
});

const videosResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({
          title: z.string(),
          description: z.string().default(""),
          channelId: z.string(),
          channelTitle: z.string().optional(),
          publishedAt: z.string().optional(),
          thumbnails,
        }),
        statistics: z.object({ viewCount: count, likeCount: count, commentCount: count }).default({}),
      }),
    )
    .default([]),
});

const channelsResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({
          title: z.string(),
          description: z.string().default(""),
          customUrl: z.string().optional(),
          country: z.string().optional(),
          thumbnails,
        }),
        statistics: z
          .object({ subscriberCount: count, viewCount: count, hiddenSubscriberCount: z.boolean().optional() })
          .default({}),
        brandingSettings: z.object({ channel: z.object({ description: z.string().optional() }).optional() }).optional(),
      }),
    )
    .default([]),
});

const playlistItemsResponse = z.object({
  items: z
    .array(
      z.object({
        snippet: z.object({ title: z.string() }).optional(),
        contentDetails: z.object({ videoPublishedAt: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

const errorResponse = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

// ── Core request ─────────────────────────────────────────────────────────────

function apiKey(): string {
  const key = serverEnv().YOUTUBE_API_KEY;
  if (!key) throw new DiscoveryConfigError("YOUTUBE_API_KEY is not set in .env.local");
  return key;
}

/** Reserves quota, calls the API (with retries for 5xx/429), and maps errors to typed ones. */
async function call<S extends z.ZodType>(endpoint: string, params: Record<string, string>, units: number, schema: S): Promise<z.infer<S>> {
  await reserveQuota(QUOTA.youtube, units, DISCOVERY.youtubeDailyUnitStop);

  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey());

  const { status, body } = await getJsonWithRetry(url.toString());
  if (status >= 200 && status < 300) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Error(`Unexpected YouTube ${endpoint} response: ${parsed.error.message}`);
    return parsed.data;
  }

  const err = errorResponse.safeParse(body);
  const reason = err.success ? err.data.error.errors?.[0]?.reason : undefined;
  const message = err.success ? err.data.error.message : undefined;
  const detail = `YouTube ${endpoint} ${status}${reason ? ` (${reason})` : ""}: ${message ?? "no message"}`;

  // Google's own daily limit (e.g. the key is shared with another app). Wait until tomorrow.
  if (status === 403 && (reason === "quotaExceeded" || reason === "dailyLimitExceeded")) {
    console.error(`[youtube] quota exceeded — ${detail}`);
    throw new QuotaExhaustedError(detail);
  }
  // Bad key, API not enabled, malformed request, or missing resource: retrying won't help.
  if (status === 400 || status === 401 || status === 403 || status === 404) throw new DiscoveryConfigError(detail);
  throw new Error(detail); // anything else: let the Inngest step retry
}

function bestThumbnail(t: z.infer<typeof thumbnails>): string | null {
  return t?.high?.url ?? t?.medium?.url ?? t?.default?.url ?? null;
}

// ── Public functions ─────────────────────────────────────────────────────────

/**
 * Searches videos for `query` published after `publishedAfter`. Costs 100 units per page.
 * Pagination: each response may include nextPageToken; passing it back returns the next page.
 * We stop after DISCOVERY.searchPagesPerQuery pages because every page costs another 100 units.
 */
export async function searchVideos(query: string, publishedAfter: Date): Promise<string[]> {
  const videoIds: string[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < DISCOVERY.searchPagesPerQuery; page++) {
    const data = await call(
      "search",
      {
        part: "id", // "id" is all we need; stats come from videos.list for 1 unit per 50 videos
        q: query,
        type: "video",
        order: "relevance",
        maxResults: String(DISCOVERY.searchResultsPerPage),
        publishedAfter: publishedAfter.toISOString(),
        ...(pageToken ? { pageToken } : {}),
      },
      YOUTUBE_COST.search,
      searchResponse,
    );
    for (const item of data.items) if (item.id.videoId) videoIds.push(item.id.videoId);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return videoIds;
}

/** Title, description, channel and stats for videos. Batches 50 ids per call (1 unit each). */
export async function getVideoStats(ids: string[]): Promise<DiscoveredContent[]> {
  const results: DiscoveredContent[] = [];
  for (const batch of chunk(ids, MAX_IDS_PER_CALL)) {
    const data = await call("videos", { part: "snippet,statistics", id: batch.join(","), maxResults: "50" }, YOUTUBE_COST.list, videosResponse);
    for (const v of data.items) {
      results.push({
        platform: "youtube",
        externalId: v.id,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        title: v.snippet.title,
        description: v.snippet.description,
        authorId: v.snippet.channelId,
        authorName: v.snippet.channelTitle ?? null,
        thumbnailUrl: bestThumbnail(v.snippet.thumbnails),
        views: v.statistics.viewCount ?? 0,
        likes: v.statistics.likeCount ?? null,
        comments: v.statistics.commentCount ?? null,
        publishedAt: v.snippet.publishedAt ?? null,
      });
    }
  }
  return results;
}

/** Channel profile + stats. Batches 50 ids per call (1 unit each). */
export async function getChannelStats(ids: string[]): Promise<DiscoveredCreator[]> {
  const results: DiscoveredCreator[] = [];
  for (const batch of chunk(ids, MAX_IDS_PER_CALL)) {
    const data = await call(
      "channels",
      { part: "snippet,statistics,brandingSettings", id: batch.join(","), maxResults: "50" },
      YOUTUBE_COST.list,
      channelsResponse,
    );
    for (const c of data.items) {
      const handle = c.snippet.customUrl ?? null; // e.g. "@somecreator"
      results.push({
        platform: "youtube",
        externalId: c.id,
        handle,
        title: c.snippet.title,
        url: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${c.id}`,
        description: c.snippet.description || c.brandingSettings?.channel?.description || "",
        // Some channels hide their subscriber count; treat that as unknown, not zero.
        subscribers: c.statistics.hiddenSubscriberCount ? null : (c.statistics.subscriberCount ?? null),
        totalViews: c.statistics.viewCount ?? null,
        country: c.snippet.country ?? null,
        thumbnailUrl: bestThumbnail(c.snippet.thumbnails),
      });
    }
  }
  return results;
}

/**
 * Latest uploads for one channel (1 unit). Every channel's uploads playlist id is its channel
 * id with "UC" replaced by "UU", so we skip a channels.list call to look it up.
 */
export async function getRecentUploads(channelId: string, max = DISCOVERY.recentTitlesForScoring): Promise<RecentActivity> {
  const playlistId = channelId.startsWith("UC") ? `UU${channelId.slice(2)}` : null;
  if (!playlistId) return { externalId: channelId, lastUploadAt: null, recentTitles: [] };
  try {
    const data = await call(
      "playlistItems",
      { part: "snippet,contentDetails", playlistId, maxResults: String(max) },
      YOUTUBE_COST.list,
      playlistItemsResponse,
    );
    const dates = data.items.map((i) => i.contentDetails?.videoPublishedAt).filter((d): d is string => Boolean(d)).sort();
    return {
      externalId: channelId,
      lastUploadAt: dates.at(-1) ?? null,
      recentTitles: data.items.map((i) => i.snippet?.title).filter((t): t is string => Boolean(t)),
    };
  } catch (error) {
    // A channel with no public uploads has no playlist (404 → config error). Treat as inactive.
    if (error instanceof DiscoveryConfigError && /404|playlistNotFound/.test(error.message)) {
      return { externalId: channelId, lastUploadAt: null, recentTitles: [] };
    }
    throw error;
  }
}
