import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROLES } from "@/lib/engine/envelope";
import { ROLE_PREFIX } from "./roles";
import hashes from "./prefix-hashes.json";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
describe("ROLE_PREFIX", () => {
  it.each(ROLES)("%s prefix is byte-stable against prefix-hashes.json", (role) => {
    expect(sha256(ROLE_PREFIX[role])).toBe((hashes as Record<string, string>)[role]);
  });
});
