import { defineConfig } from "vitest/config";

export default defineConfig({
  // The sources use NodeNext ESM specifiers ("./config.js"); map them back to the TS files
  // so tests can import src directly without a build step.
  resolve: {
    alias: [{ find: /^(\..*?)\.js$/, replacement: "$1" }],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 40000,
    hookTimeout: 40000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    reporters: ["default"],
  },
});
