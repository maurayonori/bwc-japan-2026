import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          // マイクは入力欄の横の音声入力のため、このサイト自身にだけ許す（#45、ADR 0014）。カメラと位置は使わない。
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          },
          // 公開するのは審査と試用のため。検索に載せて利用を広げない（ADR 0012）。
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
    ];
  },
};

export default config;
