import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packPackages, upsGroundPriceCents, MAX_PACKAGE_OUNCES } from "../app/services/ups-ground-rate.server";

const LB17 = 7711; // grams Shopify sends for a 17 lb display case
const HI = { country: "US", province: "HI", postal_code: "96789", city: "Mililani" };

describe("packPackages", () => {
  it("keeps a light cart in one package", () => {
    expect(packPackages([{ grams: 2722, quantity: 1 }, { grams: 425, quantity: 2 }])).toHaveLength(1);
  });

  it("splits 40 x 17 lb into packages of at most 150 lb", () => {
    const packages = packPackages([{ grams: LB17, quantity: 40 }]);
    expect(packages).toHaveLength(5); // 8 cases (136 lb) per box
    expect(packages.every((ounces) => ounces <= MAX_PACKAGE_OUNCES)).toBe(true);
    const total = packages.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo((LB17 * 40) / 28.349523125, -1);
  });

  it("never splits one item, even over 150 lb", () => {
    expect(packPackages([{ grams: 70000, quantity: 1 }])).toEqual([Math.round(70000 / 28.349523125)]);
  });
});

describe("upsGroundPriceCents", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "k";
    process.env.SHIPSTATION_API_SECRET = "s";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("adds up one quote per package", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const ounces = JSON.parse(init.body).weight.value;
      return new Response(JSON.stringify([{ serviceCode: "ups_ground", shipmentCost: ounces / 100, otherCost: 0 }]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await upsGroundPriceCents({ ...HI, postal_code: "96701" }, [{ grams: LB17, quantity: 40 }]);
    expect(result.packages).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(1); // all 5 boxes weigh the same
    expect(result.cents).toBe(5 * result.packages[0]);
  });

  it("gives no price instead of $75 when a multi-package cart can't be quoted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const result = await upsGroundPriceCents({ ...HI, postal_code: "96702" }, [{ grams: LB17, quantity: 40 }]);
    expect(result.cents).toBeNull();
  });

  it("keeps the flat fallback for a one-package cart", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const result = await upsGroundPriceCents({ ...HI, postal_code: "96703" }, [{ grams: 2722, quantity: 1 }]);
    expect(result.cents).toBe(7500);
  });
});
