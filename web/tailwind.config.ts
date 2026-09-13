import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "#2563eb",
          light: "#3b82f6",
          dark: "#1d4ed8",
          muted: "#dbeafe",
        },
        surface: {
          bg: "#f8fafc",
          raised: "#ffffff",
          sunken: "#f1f5f9",
          border: "#e2e8f0",
          "border-strong": "#cbd5e1",
        },
        ink: {
          DEFAULT: "#0f172a",
          secondary: "#475569",
          tertiary: "#94a3b8",
          inverse: "#f8fafc",
        },
        monospace: {
          bg: "#f1f5f9",
          border: "#e2e8f0",
        },
      },
      fontFamily: {
        display: [
          '"Source Serif 4"',
          '"Noto Serif SC"',
          '"Source Han Serif SC"',
          '"Songti SC"',
          "Georgia",
          "serif",
        ],
        body: [
          '"Inter"',
          '"Noto Sans SC"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          "system-ui",
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          '"Sarasa Mono SC"',
          '"Cascadia Mono"',
          '"Fira Code"',
          '"SF Mono"',
          "ui-monospace",
          "monospace",
        ],
      },
      fontSize: {
        "display-xl": ["2rem", { lineHeight: "2.5rem", fontWeight: "700" }],
        "display-lg": ["1.5rem", { lineHeight: "2rem", fontWeight: "600" }],
        "display-md": ["1.25rem", { lineHeight: "1.75rem", fontWeight: "600" }],
      },
      animation: {
        "fade-in": "fadeIn 0.3s ease-out",
        "slide-up": "slideUp 0.3s ease-out",
        "pulse-soft": "pulseSoft 2s ease-in-out infinite",
        "stream-cursor": "streamCursor 1s step-end infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "1" },
        },
        streamCursor: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
