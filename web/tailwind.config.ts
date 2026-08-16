import type { Config } from "tailwindcss";

// Mirrors agent-studio/apps/web/tailwind.config — same scales, same names, so
// a component moved between the two products lands unchanged. The VALUES live
// in tokens.css as CSS custom properties, which is what lets a single
// stylesheet serve both themes without a class-name swap.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg-rgb) / <alpha-value>)",
        surface: "rgb(var(--surface-rgb) / <alpha-value>)",
        "surface-2": "rgb(var(--surface-2-rgb) / <alpha-value>)",
        border: "rgb(var(--border-rgb) / <alpha-value>)",
        text: "rgb(var(--text-rgb) / <alpha-value>)",
        muted: "rgb(var(--muted-rgb) / <alpha-value>)",
        action: "rgb(var(--action-rgb) / <alpha-value>)",
        "action-text": "rgb(var(--action-text-rgb) / <alpha-value>)",
        "action-bg": "rgb(var(--action-bg-rgb) / <alpha-value>)",
        trust: "rgb(var(--trust-rgb) / <alpha-value>)",
        "trust-bg": "rgb(var(--trust-bg-rgb) / <alpha-value>)",
        attention: "rgb(var(--attention-rgb) / <alpha-value>)",
        "attention-bg": "rgb(var(--attention-bg-rgb) / <alpha-value>)",
        danger: "rgb(var(--danger-rgb) / <alpha-value>)",
        "danger-bg": "rgb(var(--danger-bg-rgb) / <alpha-value>)",
      },
      borderRadius: { sm: "var(--r-sm)", md: "var(--r-md)", lg: "var(--r-lg)" },
      spacing: {
        "2xs": "2px", xs: "4px", sm: "8px", md: "16px",
        lg: "24px", xl: "32px", "2xl": "48px", "3xl": "64px",
      },
      fontSize: {
        "display-3": ["22px", { lineHeight: "1.25", letterSpacing: "-0.01em" }],
        title: ["28px", { lineHeight: "1.2", letterSpacing: "-0.01em" }],
        section: ["13px", { lineHeight: "1.3" }],
        body: ["16px", { lineHeight: "1.5" }],
        ui: ["14px", { lineHeight: "1.45" }],
        meta: ["12px", { lineHeight: "1.4" }],
      },
      fontFamily: {
        sans: ['"Geist"', "system-ui", "sans-serif"],
        // Canon is a document product: long-form page bodies stay serif,
        // because that is a reading decision rather than a brand one. The
        // chrome is the brand sans, which is what carries the resemblance.
        serif: ['"Iowan Old Style"', "Palatino", "Georgia", "serif"],
        mono: ['"Geist Mono"', "monospace"],
      },
      boxShadow: { card: "var(--shadow)" },
    },
  },
} satisfies Config;
