import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const src = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@invariant/shared": src("shared"),
      "@invariant/contract": src("contract"),
      "@invariant/compiler-ir": src("compiler-ir"),
      "@invariant/compiler-core/testing": fileURLToPath(
        new URL("./packages/compiler-core/src/testing/index.ts", import.meta.url)
      ),
      "@invariant/compiler-core": src("compiler-core"),
      "@invariant/artifact-generator": src("artifact-generator"),
      "@invariant/compiler-tokens": src("compiler-tokens"),
      "@invariant/compiler-react": src("compiler-react"),
      "@invariant/compiler-storybook": src("compiler-storybook"),
      "@invariant/reconciliation": src("reconciliation"),
      "@invariant/semantic-engine": src("semantic-engine"),
      "@invariant/contract-query": src("contract-query"),
      "@invariant/mcp": src("mcp"),
      "@invariant/validation": src("validation"),
      "@invariant/browser-verify": src("browser-verify"),
      "@invariant/governance": src("governance"),
      "@invariant/agent-kit": src("agent-kit"),
      "@invariant/cli": fileURLToPath(new URL("./apps/cli/src/index.ts", import.meta.url)),
      "@invariant/compiler-vue": src("compiler-vue"),
      "@invariant/compiler-angular": src("compiler-angular")
    }
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/**/*.test.ts"]
  }
})
