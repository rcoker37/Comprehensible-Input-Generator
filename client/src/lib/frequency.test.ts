import { describe, it, expect } from "vitest";
import { rankToTier } from "./frequency";

describe("rankToTier", () => {
  it("buckets ranks into tiers", () => {
    expect(rankToTier(1)).toBe("very-common");
    expect(rankToTier(1500)).toBe("very-common");
    expect(rankToTier(1501)).toBe("common");
    expect(rankToTier(5000)).toBe("common");
    expect(rankToTier(5001)).toBe("uncommon");
    expect(rankToTier(15000)).toBe("uncommon");
    expect(rankToTier(15001)).toBe("rare");
    expect(rankToTier(30000)).toBe("rare");
    expect(rankToTier(30001)).toBe("very-rare");
    expect(rankToTier(null)).toBe("very-rare");
  });
});
