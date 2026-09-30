// Shapes every discovery module returns. A future platform (e.g. lib/discovery/reddit.ts)
// maps its API responses into these, so jobs and scoring don't change.

export type DiscoveryPlatform = "youtube";

/** One piece of content (a video, a post) found by a search. */
export type DiscoveredContent = {
  platform: DiscoveryPlatform;
  externalId: string;
  url: string;
  title: string;
  description: string;
  authorId: string;
  authorName: string | null;
  thumbnailUrl: string | null;
  views: number;
  likes: number | null;
  comments: number | null;
  publishedAt: string | null;
};

/** A creator's public profile stats. */
export type DiscoveredCreator = {
  platform: DiscoveryPlatform;
  externalId: string;
  handle: string | null;
  title: string;
  url: string;
  description: string;
  subscribers: number | null;
  totalViews: number | null;
  country: string | null;
  thumbnailUrl: string | null;
};

/** Recent uploads for a creator: when they last posted and what about. */
export type RecentActivity = {
  externalId: string;
  lastUploadAt: string | null;
  recentTitles: string[];
};

/** The request can never succeed as sent (bad key, API not enabled, bad parameter). */
export class DiscoveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryConfigError";
  }
}
