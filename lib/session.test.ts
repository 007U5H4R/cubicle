import { describe, expect, it } from "vitest";
import { referrerFrom } from "./session";
describe("referrerFrom", () => {
  it("maps search params to the §11 enum", () => {
    expect(referrerFrom(new URLSearchParams(""))).toBe("direct");
    expect(referrerFrom(new URLSearchParams("ref=abc"))).toBe("share_link");
    expect(referrerFrom(new URLSearchParams("utm_source=x"))).toBe("campaign");
    expect(referrerFrom(new URLSearchParams("ref=abc&utm_source=x"))).toBe("share_link");
  });
});
