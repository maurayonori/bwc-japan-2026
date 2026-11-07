// あそぶの絵。すべてこのリポジトリで新しく描いたインライン SVG（#52、ADR 0015）。
// 文字・記号・絵文字は使わない。読み上げの名前は、絵を包むリンクやボタンの aria-label に置く。

export function HousePicture() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path d="M12 31 32 13l20 18" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 29v21h28V29" fill="none" stroke="currentColor" strokeWidth="5" strokeLinejoin="round" />
      <rect x="28" y="38" width="8" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

// 「ぽん」: 触れたところに広がる丸と粒。
export function PonPicture() {
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <circle cx="60" cy="60" r="44" fill="var(--play-sun)" opacity="0.35" />
      <circle cx="60" cy="60" r="30" fill="var(--play-sun)" />
      <circle cx="60" cy="60" r="14" fill="var(--play-coral)" />
      <circle cx="18" cy="26" r="7" fill="var(--play-sky)" />
      <circle cx="102" cy="30" r="6" fill="var(--play-green)" />
      <circle cx="98" cy="96" r="8" fill="var(--play-plum)" />
      <circle cx="22" cy="94" r="6" fill="var(--play-coral)" />
    </svg>
  );
}

// 「ばあ」: 布のうしろから、耳がのぞく。
export function BaaPicture() {
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <ellipse cx="42" cy="34" rx="11" ry="15" fill="var(--play-fur)" />
      <ellipse cx="78" cy="34" rx="11" ry="15" fill="var(--play-fur)" />
      <ellipse cx="42" cy="36" rx="5" ry="8" fill="var(--play-blush)" />
      <ellipse cx="78" cy="36" rx="5" ry="8" fill="var(--play-blush)" />
      <path
        d="M14 44c10-6 20 6 30 0s20 6 32 0 20 6 30 0v58c-10 6-20-6-30 0s-22-6-32 0-20-6-30 0z"
        fill="var(--play-sky)"
      />
      <path d="M24 60v40M46 58v42M68 60v40M90 58v42" stroke="var(--play-paper)" strokeWidth="4" strokeLinecap="round" opacity="0.35" />
    </svg>
  );
}

// 「しゃぼん玉」: ふわりと浮かぶ玉。
export function BubblePicture() {
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <circle cx="52" cy="62" r="34" fill="var(--play-sky)" opacity="0.18" stroke="var(--play-sky)" strokeWidth="4" />
      <path d="M34 50a20 20 0 0 1 14-12" fill="none" stroke="var(--play-paper)" strokeWidth="6" strokeLinecap="round" />
      <circle cx="94" cy="32" r="16" fill="var(--play-plum)" opacity="0.18" stroke="var(--play-plum)" strokeWidth="3" />
      <circle cx="96" cy="94" r="11" fill="var(--play-green)" opacity="0.18" stroke="var(--play-green)" strokeWidth="3" />
    </svg>
  );
}
