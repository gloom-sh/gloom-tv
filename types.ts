export interface ResolvedLiveStream {
  provider: "youtube";
  sourceId: string;
  videoId: string;
  title: string;
  isLive?: boolean;
  publishedText?: string;
  manifestUrl: string;
  compatibleUrl?: string;
  watchUrl: string;
  posterUrl?: string;
  resolvedAt: number;
  expiresAt: number;
}
