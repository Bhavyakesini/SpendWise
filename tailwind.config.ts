import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17211f",
        mint: "#0f766e",
        coral: "#d96c4a"
      },
      boxShadow: {
        soft: "0 18px 45px rgba(23, 33, 31, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;
