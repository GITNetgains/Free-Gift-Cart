import { describe, expect, test } from "vitest";
import { functionSettings, normalizeSettings, priceGiftsEnabledFor, tierRange, type TierGiftProduct } from "../app/services/price-gifts";

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
      id: "high", minimumSpend: 30000, mode: "all",
      products: [sling3, shirtS, shirtM].map(({ productId, variantId }) => ({ productId, variantId })),
    });
  });

  test("only netgains10 gets the feature", () => {
    expect(priceGiftsEnabledFor("netgains10.myshopify.com")).toBe(true);
    expect(priceGiftsEnabledFor("custom-collection-cases.myshopify.com")).toBe(false);
  });
});
