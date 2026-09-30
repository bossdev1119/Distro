import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // YouTube video and channel thumbnails. next/image only loads hosts listed here.
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "yt3.ggpht.com" },
      { protocol: "https", hostname: "yt3.googleusercontent.com" },
    ],
  },
};

export default nextConfig;
