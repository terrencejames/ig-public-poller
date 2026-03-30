export type InstagramPost = {
  shortcode: string;
  permalink: string;
  caption?: string;
  mediaUrl?: string;
  timestamp?: number;
};

export type ProfileConfig = {
  id: string;
  username: string;
  profileUrl: string;
};

export type AppState = {
  accounts: Record<
    string,
    {
      lastShortcode: string | null;
      lastNotifiedAt: string | null;
    }
  >;
};

