import { describe, expect, it } from "vitest"

import { getScaffoldMessage } from "../src/index"

describe("getScaffoldMessage", () => {
  it("returns the scaffold readiness message", () => {
    expect(getScaffoldMessage()).toBe("Guizhan Resources upload action scaffold is ready.")
  })
})
