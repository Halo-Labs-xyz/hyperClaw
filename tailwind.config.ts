import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "#06060a",
        surface: "#0c0c14",
        card: {
          DEFAULT: "#10101c",
          hover: "#14142a",
        },
        "card-border": "rgba(255, 255, 255, 0.06)",
        foreground: "#e8e8f0",

        // Primary: Neon green (Hyperliquid energy)
        accent: {
          DEFAULT: "#30e8a0",
          dim: "rgba(48, 232, 160, 0.15)",
          glow: "rgba(48, 232, 160, 0.25)",
        },

        // Secondary: Purple (Monad identity)
        "accent-light": "#836ef9",
        purple: {
          DEFAULT: "#836ef9",
          dim: "rgba(131, 110, 249, 0.15)",
          glow: "rgba(131, 110, 249, 0.2)",
        },

        // Functional
        success: "#30e8a0",
        danger: "#ff4a6e",
        warning: "#ffb84a",
        cyan: "#4af0ff",
        muted: "#8888a8",
        dim: "#555570",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.25rem",
      },
      boxShadow: {
        glow: "0 0 20px rgba(48, 232, 160, 0.15), 0 0 60px rgba(48, 232, 160, 0.05)",
        "glow-purple": "0 0 20px rgba(131, 110, 249, 0.15), 0 0 60px rgba(131, 110, 249, 0.05)",
        "glow-lg": "0 0 40px rgba(48, 232, 160, 0.2), 0 0 80px rgba(48, 232, 160, 0.08)",
        soft: "0 8px 32px rgba(0, 0, 0, 0.25)",
        "card-hover": "0 12px 40px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.04)",
      },
      animation: {
        "fade-in-up": "fade-in-up 0.5s ease-out forwards",
        float: "float 6s ease-in-out infinite",
        shimmer: "shimmer 1.5s ease-in-out infinite",
        "gradient-shift": "gradient-shift 4s ease infinite",
      },
      keyframes: {
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "gradient-shift": {
          "0%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
          "100%": { backgroundPosition: "0% 50%" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
