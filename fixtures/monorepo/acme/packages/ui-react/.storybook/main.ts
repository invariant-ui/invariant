import { dirname, join } from "node:path"
import type { StorybookConfig } from "@storybook/react-vite"

function getAbsolutePath(value: string): string {
  return dirname(require.resolve(join(value, "package.json")))
}

const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(ts|tsx)"],
  addons: [getAbsolutePath("@storybook/addon-essentials"), "@storybook/addon-a11y"],
  framework: { name: getAbsolutePath("@storybook/react-vite"), options: {} },
  staticDirs: ["../public"],
  viteFinal: async (viteConfig) => viteConfig
}
export default config
