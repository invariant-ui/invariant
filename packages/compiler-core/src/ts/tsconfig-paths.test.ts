import { describe, expect, it } from "vitest"
import { TSCONFIG_FILE, tsconfigPaths } from "./tsconfig-paths.js"

const files = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries))

describe("tsconfigPaths", () => {
  it("reads paths relative to the config directory, honoring baseUrl", () => {
    const f = files({
      "pkg/tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"], "lib": ["./lib/index.ts"] } } }`,
      "other/tsconfig.json": `{ "compilerOptions": { "baseUrl": "./src", "paths": { "x/*": ["x/*"] } } }`
    })
    expect(tsconfigPaths(f, "pkg")).toEqual({ "@/*": ["pkg/src/*"], lib: ["pkg/lib/index.ts"] })
    expect(tsconfigPaths(f, "other")).toEqual({ "x/*": ["other/src/x/*"] })
  })

  it("follows solution-style references and tolerates comments", () => {
    const f = files({
      "p/tsconfig.json": `{ // solution style\n "references": [{ "path": "./tsconfig.app.json" }, { "path": "./sub" }], "files": [] }`,
      "p/tsconfig.app.json": `{ "compilerOptions": { /* real options */ "paths": { "@/*": ["./src/*"] } } }`,
      "p/sub/tsconfig.json": `{ "compilerOptions": { "paths": { "sub/*": ["./*"] } } }`
    })
    expect(tsconfigPaths(f, "p")).toEqual({ "@/*": ["p/src/*"], "sub/*": ["p/sub/*"] })
  })

  it("follows relative extends, with the extending config overriding the base", () => {
    const f = files({
      "p/tsconfig.base.json": `{ "compilerOptions": { "paths": { "a": ["./base-a"], "b": ["./base-b"] } } }`,
      "p/tsconfig.json": `{ "extends": "./tsconfig.base", "compilerOptions": { "paths": { "b": ["./own-b"] } } }`
    })
    expect(tsconfigPaths(f, "p")).toEqual({ a: ["p/base-a"], b: ["p/own-b"] })
  })

  it("ignores package extends, missing files, invalid JSON and reference cycles", () => {
    const f = files({
      "p/tsconfig.json": `{ "extends": "@vue/tsconfig/tsconfig.json", "references": [{ "path": "./a.json" }, { "path": "./missing.json" }] }`,
      "p/a.json": `{ "references": [{ "path": "./tsconfig.json" }], "compilerOptions": { "paths": { "k": ["./k"] } } }`
    })
    expect(tsconfigPaths(f, "p")).toEqual({ k: ["p/k"] })
    expect(tsconfigPaths(files({ "p/tsconfig.json": "{ nope" }), "p")).toEqual({})
    expect(tsconfigPaths(files({}), "p")).toEqual({})
  })

  it("uses the project root for a package at '.'", () => {
    expect(
      tsconfigPaths(
        files({ "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }` }),
        "."
      )
    ).toEqual({ "@/*": ["src/*"] })
  })

  it("recognizes tsconfig file names", () => {
    for (const ok of ["tsconfig.json", "a/tsconfig.app.json", "tsconfig.base.json"])
      expect(TSCONFIG_FILE.test(ok)).toBe(true)
    for (const no of ["package.json", "mytsconfig.json", "tsconfig.ts"])
      expect(TSCONFIG_FILE.test(no)).toBe(false)
  })
})
