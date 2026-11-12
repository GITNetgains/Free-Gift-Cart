import { describe, expect, test } from "vitest";
import { functionSettings, normalizeSettings, priceGiftsEnabledFor, tierRange, tierRangeErrors, type TierGiftProduct } from "../app/services/price-gifts";

const variant = (productId: string, variantId: string, title = productId): TierGiftProduct => ({
  productId: `gid://shopify/Product/${productId}`, productTitle: title,
  variantId: `gid://shopify/ProductVariant/${variantId}`, variantTitle: "Default Title", imageUrl: "", price: "0.00",
});
const sling2 = variant("1", "11", "Sling 2.0");
const shirtS = variant("2", "21", "T-shirt");
const shirtM = variant("2", "22", "T-shirt");
const sling3 = variant("3", "31", "Sling 3.0");

describe("price gift settings", () => {
  const settings = normalizeSettings({
    enabled: true,
    tiers: [
      { id: "high", minimumSpend: 30000, mode: "all", products: [], replacements: [{ fromProductId: sling2.productId, products: [sling3] }] },
      { id: "low", minimumSpend: 12000, mode: "one", products: [sling2, shirtS, shirtM], replacements: [] },
    ],
  });

  test("tiers sort low to high", () => {
    expect(settings.tiers.map((tier) => tier.id)).toEqual(["low", "high"]);
  });

  test("a higher tier takes the Tier 1 gifts with replacements applied", () => {
    expect(settings.tiers[1].products.map((product) => product.variantId)).toEqual([sling3.variantId, shirtS.variantId, shirtM.variantId]);
  });

  test("ranges read $120 – $299 and $300 or more", () => {
    expect(tierRange(settings.tiers, 0)).toBe("$120 – $299");
    expect(tierRange(settings.tiers, 1)).toBe("$300 or more");
  });

  test("a replacement for a product no longer in Tier 1 is dropped", () => {
    const next = normalizeSettings({ ...settings, tiers: [{ ...settings.tiers[0], products: [shirtS] }, settings.tiers[1]] });
    expect(next.tiers[1].replacements).toEqual([]);
    expect(next.tiers[1].products.map((product) => product.variantId)).toEqual([shirtS.variantId]);
  });

  test("the function copy keeps only ids and rules", () => {
    expect(JSON.parse(functionSettings(settings)).tiers[1]).toEqual({
      // Saved as "all", but every tier gives one gift.
      id: "high", minimumSpend: 30000, maximumSpend: null, mode: "one",
      products: [sling3, shirtS, shirtM].map(({ productId, variantId }) => ({ productId, variantId })),
    });
  });

  test("a maximum shows in the range and keeps empty as 'until the next tier'", () => {
    const capped = normalizeSettings({ ...settings, tiers: [{ ...settings.tiers[0], maximumSpend: 35000 }, settings.tiers[1]] });
    expect(tierRange(capped.tiers, 0)).toBe("$120 – $350");
    expect(capped.tiers[1].maximumSpend).toBeNull();
    expect(tierRange(capped.tiers, 1)).toBe("$300 or more");
  });

  test("overlapping or inverted ranges are refused", () => {
    const tier = (minimumSpend: number, maximumSpend: number | null) => ({ ...settings.tiers[0], minimumSpend, maximumSpend });
    expect(tierRangeErrors([tier(29900, 39800), tier(39900, null)])).toEqual([]);
    expect(tierRangeErrors([tier(29900, 40000), tier(39900, null)])[0]).toContain("inside Tier 2");
    expect(tierRangeErrors([tier(29900, 20000), tier(39900, null)])[0]).toContain("below the minimum");
    expect(tierRangeErrors([tier(29900, null), tier(29900, null)])[0]).toContain("same amount");
  });

  test("only netgains10 gets the feature", () => {
    expect(priceGiftsEnabledFor("netgains10.myshopify.com")).toBe(true);
    expect(priceGiftsEnabledFor("custom-collection-cases.myshopify.com")).toBe(false);
  });
});
