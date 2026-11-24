import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../extensions/free-gift-popup/assets/tiered-gift-cart-banner.js", import.meta.url), "utf8");

const gift = (product: string, variant: string, title: string) => ({
  productId: `gid://shopify/Product/${product}`, productTitle: title, variantId: `gid://shopify/ProductVariant/${variant}`, imageUrl: "",
});
const settings = {
  enabled: true,
  tiers: [
    { id: "t1", minimumSpend: 29900, mode: "one", products: [gift("1", "11", "Sling 2.0"), gift("2", "21", "T-Shirt")] },
    { id: "t2", minimumSpend: 39900, mode: "all", products: [gift("3", "31", "Sling 3.0"), gift("2", "21", "T-Shirt")] },
  ],
};
const paid = (cents: number) => ({ key: "paid", variant_id: 999, product_id: 999, quantity: 1, original_line_price: cents, original_price: cents });
const tierGift = (variant: number, tier: string) => ({ key: `g${variant}`, variant_id: variant, product_id: variant, quantity: 1, original_line_price: 3000, original_price: 3000, properties: { _tier_gift: tier } });

async function render(items: unknown[], shopCurrency = "INR", offerSettings = settings) {
  const root = {
    dataset: { shopCurrency } as Record<string, string>, hidden: true, innerHTML: "", addEventListener() {},
    querySelector: () => ({ textContent: JSON.stringify(offerSettings) }),
  };
  let currentRoot = root;
  let cartItems = items;
  let onMutation: (() => void) | undefined;
  runInNewContext(source, {
    document: {
      body: {}, querySelectorAll: () => currentRoot.dataset.initialized ? [] : [currentRoot], getElementById: () => null, head: { appendChild() {} },
      createElement: () => { let text = ""; return { set textContent(value: string) { text = value; }, get innerHTML() { return text; } }; },
    },
    window: { Shopify: { currency: { rate: "0.012", active: "USD" }, routes: { root: "/" } }, setInterval() {} },
    fetch: async () => ({ ok: true, json: async () => ({ currency: "USD", items: cartItems }) }),
    MutationObserver: class { constructor(callback: () => void) { onMutation = callback; } observe() {} },
    Intl, JSON, Number, String, Math, Set, Map, Array, Object,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { ...root, replaceSection: async (nextItems: unknown[]) => {
    cartItems = nextItems;
    currentRoot = { ...root, dataset: {shopCurrency}, hidden: true, innerHTML: "" };
    onMutation?.();
    await new Promise(resolve => setTimeout(resolve, 20));
    return currentRoot;
  } };
}


const campaign={enabled:true,tiers:[
 {id:"low",minimumSpend:15000,mode:"one",products:[gift("1","11","First"),gift("2","21","Second"),gift("3","31","Third")]},
 {id:"high",minimumSpend:35000,mode:"one",products:[gift("1","11","First"),gift("2","21","Second"),gift("3","31","Third")]},
]};
describe("Netgains10 tier banner",()=>{
 test.each([15000,29997,34999])("Tier 1 at %i cents clearly shows its one-gift offer",async amount=>{
  const root=await render([paid(amount)],"USD",campaign);
  expect(root.innerHTML).toContain("Choose <strong>1 of 3</strong>");
  expect(root.innerHTML).toContain("Cart subtotal:");expect(root.innerHTML).toContain("Gift unlocked at:");
  expect(root.innerHTML).not.toContain("&nbsp;/&nbsp;");
  expect(root.innerHTML).toContain("2 gifts at Tier 2");
  expect(root.innerHTML).toContain("fgcb-card--three");
  for(const title of ["First","Second","Third"])expect(root.innerHTML).toContain(title);
 });
 test.each([35000,80000])("Tier 2 at %i cents offers two of three",async amount=>{
  const root=await render([paid(amount)],"USD",campaign);
  expect(root.innerHTML).toContain("Choose <strong>2</strong> more free gifts!");
  expect(root.innerHTML).toContain("Choose 2 from the remaining gifts");
  expect(root.innerHTML).toContain("fgcb-card--three");
 });
 test("299.97 uses clear dollar labels instead of an overfilled ratio",async()=>{
  const root=await render([paid(29997)],"USD",campaign);
  expect(root.innerHTML).toContain("Cart subtotal: <strong>$299.97</strong>");
  expect(root.innerHTML).toContain("Gift unlocked at: <strong>$150.00</strong>");
  expect(root.innerHTML).toContain("width:100%");
 });
 test("below threshold shows remaining spend",async()=>{
  const root=await render([paid(10000)],"USD",campaign);
  expect(root.innerHTML).toContain("Gift unlocks at:");expect(root.innerHTML).not.toContain("2nd");
 });
 test("below Tier 1 the OR line names the Tier 2 offer",async()=>{
  const root=await render([paid(10000)],"USD",campaign);
  expect(root.innerHTML).toContain("Spend <strong>$350.00</strong> and choose <strong>2 of 3</strong> gifts <strong>FREE</strong>.");
  expect(root.innerHTML).not.toContain("Choose your favourite. One free gift per order.");
 });
 test.each([15000,29997])("one claimed Tier 1 gift keeps the banner visible at %i cents",async amount=>{
  const root = await render([paid(amount),tierGift(11,"low")],"USD",campaign);
  expect(root.hidden).toBe(false);
  expect(root.innerHTML).toContain("Your <strong>free gift</strong> is in your cart.");
  expect(root.innerHTML).not.toContain("data-open-gift");
 });
 test("one retained Tier 1 gift leaves one Tier 2 gift to claim",async()=>{
  const root=await render([paid(35000),tierGift(11,"low")],"USD",campaign);
  expect(root.innerHTML).toContain("Choose <strong>1</strong> more free gift!");
  expect(root.innerHTML).toContain("data-open-gift");
 });
 test("a sold-out configured product still has its informational card",async()=>{
  const offer={...campaign,tiers:campaign.tiers.map(t=>({...t,products:t.products.map(p=>({...p,availableForSale:false}))}))};
  expect((await render([paid(15000)],"USD",offer)).innerHTML).toContain("Third");
 });
});

test("claiming an unsaved variant retains next-tier progress",async()=>{
 const root=await render([paid(19998),{...tierGift(9991,"low"),product_id:1}],"USD",campaign);
 expect(root.hidden).toBe(false);
 expect(root.innerHTML).toContain("Next tier at: <strong>$350.00</strong>");
});

describe("tier progression after adding products and gifts",()=>{
 test.each([0,9999,14999,15000,19998,34999,35000,99999])("banner remains visible for a paid cart of %i cents",async amount=>{
  const root=await render([paid(amount)],"USD",campaign);expect(root.hidden).toBe(false);
 });
 test("claimed gift at 199.98 shows the exact remaining amount to Tier 2",async()=>{
  const root=await render([paid(19998),tierGift(11,"low")],"USD",campaign);
  expect(root.innerHTML).toContain("$150.02");
  expect(root.innerHTML).toContain("Tier 2");
  expect(Number(root.innerHTML.match(/style="width:([\d.]+)%/)?.[1])).toBeCloseTo(57.14, 2);
  expect(root.innerHTML).toContain("Next tier at: <strong>$350.00</strong>");
  expect(root.innerHTML).toContain("choose 2 free gifts from 3 options");
 });
 test("exactly 350 after one retained gift unlocks one more Tier 2 gift",async()=>{
  const root=await render([paid(35000),tierGift(11,"low")],"USD",campaign);
  expect(root.innerHTML).toContain("Choose <strong>1</strong> more free gift!");
  expect(root.innerHTML).toContain("Gift unlocked at: <strong>$350.00</strong>");
  expect(root.innerHTML).toContain("data-open-gift");
 });
 test("removing the gift brings back the claim action without hiding the banner",async()=>{
  const root=await render([paid(19998)],"USD",campaign);
  expect(root.hidden).toBe(false);expect(root.innerHTML).toContain("data-open-gift");
 });
});

test("a theme cart-section replacement initializes its new banner and current tier",async()=>{
 const first=await render([paid(15000)],"USD",campaign);
 const replaced=await first.replaceSection([paid(19998),tierGift(11,"low")]);
 expect(replaced.hidden).toBe(false);
 expect(replaced.innerHTML).toContain("Next tier at: <strong>$350.00</strong>");
 expect(replaced.innerHTML).toContain("$150.02");
 const upper=await first.replaceSection([paid(35000),tierGift(11,"low")]);
 expect(upper.hidden).toBe(false);expect(upper.innerHTML).toContain("Choose <strong>1</strong> more free gift!");
});
