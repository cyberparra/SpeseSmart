import type { CSSProperties } from "react";
const paths: Record<string, string> = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  pie: "M21 12a9 9 0 1 1-9-9v9z M15 3a6 6 0 0 1 6 6h-6z",
  plus: "M12 5v14M5 12h14",
  arrow: "M7 17 17 7M7 7h10v10",
  down: "m7 10 5 5 5-5",
  camera: "M4 6h4l2-3h4l2 3h4v14H4z M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  image: "M3 3h18v18H3z m0 14 6-6 4 4 3-3 5 5 M16 7h.01",
  edit: "m4 16 12-12 4 4L8 20H4z M14 6l4 4",
  wallet: "M20 7H4V4h14v3 M4 7v13h17V7z M16 12h5v4h-5z",
  bag: "M5 7h14l2 14H3z M9 8V6a3 3 0 0 1 6 0v2",
  home: "m3 10 9-7 9 7v11H3z M9 21v-8h6v8",
  car: "m5 4-2 9v7h3v-3h12v3h3v-7l-2-9z M3 12h18M7 15h.01M17 15h.01",
  coffee: "M4 4h13v10a6 6 0 0 1-12 0V4 M17 6h2a3 3 0 0 1 0 6h-2M3 21h17",
  paw: "M8 15c0-4 8-4 8 0l3 4c1 3-4 3-7 1-3 2-8 2-7-1z M6 5a2 3 0 1 0 0 6 2 3 0 1 0 0-6 M11 2a2 3 0 1 0 0 6 2 3 0 1 0 0-6 M17 3a2 3 0 1 0 0 6 2 3 0 1 0 0-6 M21 8a2 3 0 1 0 0 6 2 3 0 1 0 0-6",
  heart: "M20 5c-3-3-7-1-8 2-1-3-5-5-8-2-5 5 4 11 8 15 4-4 13-10 8-15",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
  eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  eyeOff: "m3 3 18 18 M10 5a12 12 0 0 1 2 0c7 0 10 7 10 7a18 18 0 0 1-3 4 M6 6a21 21 0 0 0-4 6s3 7 10 7a13 13 0 0 0 6-2 M10 10a3 3 0 0 0 4 4",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6",
  calendar: "M4 5h16v16H4zM8 3v4M16 3v4M4 10h16",
  search: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  leaf: "M20 3C7 1 1 8 7 16s16 0 13-13ZM5 21 16 9",
  info: "M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
};
export function Icon({
  name,
  size = 20,
  style,
}: {
  name: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name] || paths.bag} />
    </svg>
  );
}
