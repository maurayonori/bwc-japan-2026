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
          // マイクは入力欄の横の音声入力（#45、ADR 0014）とかがみの録画の音声のため、カメラはかがみ（#54、ADR 0016）のため、
          // このサイト自身にだけ許す。位置は使わない。X-Frame-Options: DENY なので、他のサイトの枠の中では使えない。
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=()",
          },
          // 公開するのは審査と試用のため。検索に載せて利用を広げない（ADR 0012）。
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
    ];
  },
};

export default config;
