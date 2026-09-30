import { buildContextJob } from "./build-context";
import { buildCreatorsJob } from "./build-creators";
import { buildProfileJob } from "./build-profile";
import { estimateDemandJob } from "./estimate-demand";
import { generateQueriesJob } from "./generate-queries";
import { scoreCreatorsJob } from "./score-creators";
import { scoreRelevanceJob } from "./score-relevance";
import { youtubeSearchJob } from "./youtube-search";

export const functions = [
  buildProfileJob,
  buildContextJob,
  generateQueriesJob,
  youtubeSearchJob,
  scoreRelevanceJob,
  estimateDemandJob,
  buildCreatorsJob,
  scoreCreatorsJob,
];
