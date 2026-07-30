import type { InstagramPost } from "./types";

export type ProcessResult = {
  action: "keep" | "skip";
  post: InstagramPost;
  skipReason?: string;
  notifyWebhook?: boolean;
  notifyDM?: boolean;
  discordConfig?: {
    embedTitle?: string;
    includeUrl?: boolean;
    includeImage?: boolean;
  };
};

type ProcessorFunction = (post: InstagramPost) => ProcessResult;

export const accountProcessors: Record<string, ProcessorFunction> = {
  "1": (post) => {
    let caption = post.caption || "";
    
    // Skip if it contains "review" or "book"
    if (caption.toLowerCase().includes("review") || caption.toLowerCase().includes("book")) {
      return { action: "skip", post, skipReason: "Contains 'review' or 'book'" };
    }

    // strip hashtags
    caption = caption.replace(/#[\p{L}\p{N}_]+/gu, '').trim();

    return { action: "keep", post: { ...post, caption } };
  },

  "2": (post) => {
    let caption = post.caption || "";

    // Skip if it does not contain food deals
    if (!caption.toLowerCase().includes("food deals")){
      return { action: "skip", post, skipReason: "Does not contain a food deal" };
    }
    // Strip extra / unwanted stuff
    caption = caption.replace("Link in bio explains how to redeem these deals.", "");
    caption = caption.replace("(Los Angeles area)", "");

    // Strip hashtags
    caption = caption.replace(/#[\p{L}\p{N}_]+/gu, '').trim();

    const captionSplit = caption.split("\n", 1);
    var captionTitle = "Food Deals";
    if (captionSplit.length != 0) {
      captionTitle = captionSplit[0];
      caption = caption.replace(captionTitle, "");
    }

    return { action: "keep", post: { ...post, caption }, discordConfig: {includeUrl: false, includeImage: false, embedTitle: captionTitle } };
    //return { action: "keep", notifyDM: false, post: { ...post, caption } };

  },
  // Fallback default processor for all other accounts
  "default": (post) => {
    let caption = post.caption || "";
    
    // Strip hashtags by default
    caption = caption.replace(/#[\p{L}\p{N}_]+/gu, '').trim();
    
    return { action: "keep", notifyDM: false, post: { ...post, caption } };
  }
};
