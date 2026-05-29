import { describe, it, expect } from "vitest";
import { costForAngles, netCostForRun, refundForRun } from "./angles";

// These guard the money math: a bug here either overcharges customers or lets
// generations run for free (real Gemini/Vertex spend). prompt=0.10, image=0.50.
describe("token cost math", () => {
  it("costForAngles = prompt + per-image * N", () => {
    expect(costForAngles(8)).toBeCloseTo(4.1);
    expect(costForAngles(1)).toBeCloseTo(0.6);
    expect(costForAngles(0)).toBeCloseTo(0.1);
  });

  it("net cost charges only for images that actually succeeded", () => {
    expect(netCostForRun(8, 8)).toBeCloseTo(4.1);
    expect(netCostForRun(8, 5)).toBeCloseTo(0.1 + 0.5 * 5);
    expect(netCostForRun(8, 0)).toBe(0); // nothing generated → no charge at all
  });

  it("reserve always equals net + refund (no money created or lost)", () => {
    for (let n = 1; n <= 8; n++) {
      for (let done = 0; done <= n; done++) {
        expect(netCostForRun(n, done) + refundForRun(n, done)).toBeCloseTo(costForAngles(n));
      }
    }
  });

  it("never refunds more than was reserved, never negative", () => {
    expect(refundForRun(8, 8)).toBe(0); // all succeeded → nothing to refund
    expect(refundForRun(8, 0)).toBeCloseTo(4.1); // all failed → full refund
    for (let n = 1; n <= 8; n++) {
      for (let done = 0; done <= n; done++) {
        const r = refundForRun(n, done);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(costForAngles(n) + 1e-9);
      }
    }
  });
});
