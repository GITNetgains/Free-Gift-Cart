import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../extensions/free-gift-popup/assets/tiered-gift-popup.js", import.meta.url), "utf8");

const gift = (product: string, variant: string, title: string, price = "30.00") => ({
  productId: `gid://shopify/Product/${product}`, productTitle: title, variantId: `gid://shopify/ProductVariant/${variant}`,
  variantTitle: "Default Title", price, imageUrl: "",
});
const sling2 = gift("1", "11", "Zion Cases Sling 2.0");
const shirt = gift("2", "21", "FREE GIFT | T-Shirt");
// T-shirt sizes and colours: S/black, M/black and L/gray exist; L/black and S/gray don't.
const shirtVariants = [["21", "S", "black"], ["22", "M", "black"], ["23", "L", "gray"]].map(([id, size, color]) => ({
  ...shirt, variantId: `gid://shopify/ProductVariant/${id}`, variantTitle: `${size} / ${color}`, optionNames: ["Size", "Color"], optionValues: [size, color],
}));
const sling3 = gift("3", "31", "Zion Cases Sling 3.0");
const settings = {
  enabled: true,
  tiers: [
    { id: "t1", minimumSpend: 29900, mode: "one", products: [sling2, shirt] },
    // Every gift is free.
    { id: "t2", minimumSpend: 39900, mode: "all", products: [...shirtVariants, sling3] },
  ],
};

type Item = { key: string; variant_id: number; product_id: number; quantity: number; original_line_price: number; original_price: number; properties?: Record<string, string> };
const paid = (cents: number): Item => ({ key: "paid", variant_id: 999, product_id: 999, quantity: 1, original_line_price: cents, original_price: cents });
const giftLine = (key: string, variant: number, tier: string): Item => ({ key, variant_id: variant, product_id: variant, quantity: 1, original_line_price: 3000, original_price: 3000, properties: { _tier_gift: tier } });

// A Dawn-style cart row: id CartItem-<line>, a product link and a quantity selector.
function cartRow(line: number) {
  const attributes: Record<string, string> = { href: "/products/hoodie?variant=31" };
  const link = {
    dataset: {} as Record<string, string>,
    getAttribute: (name: string) => attributes[name] ?? null,
    setAttribute: (name: string, value: string) => { attributes[name] = value; },
    removeAttribute: (name: string) => { delete attributes[name]; },
  };
  const quantityBox = { hidden: false, querySelector: () => null };
  const quantityInput = { hidden: false, closest: () => quantityBox };
  const row = {
    id: `CartItem-${line}`, classes: new Set<string>(),
    classList: { add(name: string) { row.classes.add(name); } },
    closest: () => row,
    querySelectorAll: (selector: string) => selector === "a[href]" ? (attributes.href ? [link] : []) : selector.includes("updates[]") ? [quantityInput] : [],
  };
  return { row, link: attributes, quantityBox };
}

async function run(items: Item[], pathname = "/products/case", shop = { currency: "USD", active: "USD", rate: "1.0" }, rows: Array<ReturnType<typeof cartRow>> = [], dismissed: string | null = null, offerSettings = settings, stock: { live?: Record<string, {available: boolean}>; products?: Record<string, unknown>; fail?: boolean } = {}) {
  let html = "";
  // Every innerHTML the popup writes (cards, then each options refresh).
  const writes: string[] = [];
  const updates: Array<Record<string, number>> = [];
  const productRequests: string[] = [];
  const additions: Array<{id: number; quantity: number; properties: Record<string, string>}> = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  class MockElement {
    constructor(public dataset: Record<string, string>, public selector: string) {}
    closest(selector: string) { return selector === this.selector ? this : null; }
  }
  const cached: Record<string, Record<string, unknown>> = {};
  const node = (selector: string): Record<string, unknown> => cached[selector] ||= element(selector);
  const element = (selector = ""): Record<string, unknown> => {
    let inner = "";
    return {
      set innerHTML(value: string) { inner = value; writes.push(value); }, get innerHTML() { return inner; },
      addEventListener(type: string, callback: (event: unknown) => void) { listeners[selector + ":" + type] = callback; }, focus() {}, classList: { add() {}, toggle() {} }, hidden: false,
      querySelector: (selector: string) => node(selector), querySelectorAll: () => [],
    };
  };
  const nodes: Record<string, { textContent: string }> = {
    "[data-tiered-gift-settings]": { textContent: JSON.stringify(offerSettings) },
    "[data-free-gift-settings]": { textContent: "{}" },
    "[data-tiered-gift-inventory]": { textContent: JSON.stringify(stock.live || {}) },
  };
  const root = {
    dataset: { cartPath: "/cart", shopCurrency: shop.currency } as Record<string, string>, hidden: true, classList: { add() {} }, style: { setProperty() {} },
    querySelector: (selector: string) => nodes[selector] || (selector === ".fgc-overlay" ? (html ? element() : null) : node(selector)),
    querySelectorAll: () => [],
    contains: () => false,
    insertAdjacentHTML: (_: string, value: string) => { html += value; },
  };
  const fetch = async (url: string, init?: { body?: string }) => {
    if (url.includes("/products/")) {
      productRequests.push(url);
      if (stock.fail) throw new Error("Network unavailable");
      const handle = decodeURIComponent(url.split("/products/")[1].replace(/\.js$/, ""));
      return { ok: Boolean(stock.products?.[handle]), json: async () => stock.products?.[handle] };
    }
    if (url.endsWith("cart.js")) return { ok: true, json: async () => ({ currency: "USD", items }) };
    if (url.endsWith("cart/add.js")) { additions.push(...JSON.parse(init!.body!).items); return { ok: true, json: async () => ({}) }; }
    if (url.endsWith("cart/update.js")) { updates.push(JSON.parse(init!.body!).updates); return { ok: true, json: async () => ({ items: [] }) }; }
    return { ok: true, json: async () => ({}) };
  };
  const window = {
    fetch, location: { pathname, reload() {} }, setInterval() {}, setTimeout() {},
  Shopify: { currency: { rate: shop.rate, active: shop.active }, routes: { root: "/" } },
  };
  runInNewContext(source, {
    window, document: {
      getElementById: () => root, addEventListener() {}, visibilityState: "visible", body: {},
      querySelectorAll: (selector: string) => rows.filter(({ row }) => selector.includes(`#${row.id},`) || selector.endsWith(`#${row.id}`)).map(({ row }) => row),
      documentElement: { classList: { add() {}, remove() {} }, lang: "en" },
      createElement: () => { let text = ""; return { set textContent(value: string) { text = value; }, get innerHTML() { return text.replaceAll("<", "&lt;"); } }; },
    },
    sessionStorage: { getItem: () => dismissed, setItem() {}, removeItem() {} },
    XMLHttpRequest: function XMLHttpRequest() {}, MutationObserver: class { observe() {} }, Element: MockElement,
    Intl, JSON, Number, String, Math, Set, Map, Object, Array, Promise, AbortSignal,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { html, content: writes.join("\n"), updates, additions, productRequests,
    claimDisabled: () => cached[".fgc-claim"]?.disabled,
    clickCard: (id: string) => listeners[".fgc-content:click"]?.({ target: new MockElement({productId: id}, "[data-product-id]") }),
    clickOption: (product: string, value: string) => listeners[".fgc-content:click"]?.({target: new MockElement({product, optionIndex:"0", optionValue:value}, "[data-option-index]")}),
    clickClaim: () => listeners[".fgc-content:click"]?.({ target: new MockElement({}, ".fgc-claim") }),
  };
}


const campaign = { enabled: true, tiers: [
 {id:"low",minimumSpend:15000,mode:"one",products:[sling2,shirt,sling3]},
 {id:"high",minimumSpend:35000,mode:"one",products:[sling2,shirt,sling3]},
]};
const runCampaign = (items: Item[], offer=campaign) => run(items,"/products/case",undefined,[],null,offer);
const convertedRun = (amount: number, currency: string, active: string, rate: string) =>
 run([paid(amount)], "/products/case", {currency: "USD", active, rate}, [], null, campaign);
describe("Netgains10 tier gift selection",()=>{
 test.each([15000,29997,34999])("Tier 1 at %i cents offers choices and claims one",async amount=>{
  const popup=await runCampaign([paid(amount)]);
  for(const title of ["Sling 2.0","T-Shirt","Sling 3.0"]) expect(popup.content).toContain(title);
  expect(popup.html).toContain("Choose 1 free gift");
  popup.clickCard(sling3.productId);popup.clickClaim();
  expect(popup.additions.map(i=>i.id)).toEqual([31]);
 });
 test.each([35000,90000])("Tier 2 at %i cents lets the shopper choose two of three",async amount=>{
  const popup=await runCampaign([paid(amount)]);
  for(const title of ["Sling 2.0","T-Shirt","Sling 3.0"]) expect(popup.content).toContain(title);
  expect(popup.html).toContain("CHOOSE 2 FREE GIFTS");
  popup.clickCard(sling2.productId);popup.clickCard(shirt.productId);popup.clickClaim();
  expect(popup.additions.map(i=>i.id)).toEqual([11,21]);
  expect(popup.additions.every(i=>i.quantity===1)).toBe(true);
 });
 test("an existing Tier 1 gift stays and Tier 2 offers one more claim",async()=>{
  const popup=await runCampaign([paid(35000),giftLine("kept",11,"low")]);
  expect(popup.html).toContain("CHOOSE 1 FREE GIFT");expect(popup.updates).toEqual([]);
  popup.clickCard(shirt.productId);popup.clickClaim();
  expect(popup.additions.map(i=>i.id)).toEqual([21]);
 });
 test("a Tier 1 gift not listed in Tier 2 still counts: pick only 1 more, nothing removed",async()=>{
  const other1=gift("4","41","Sticker"),other2=gift("5","51","Hat"),other3=gift("6","61","Mug");
  const offer={enabled:true,tiers:[
   {id:"low",minimumSpend:15000,mode:"one",products:[sling2,shirt,sling3]},
   {id:"high",minimumSpend:35000,mode:"two",products:[other1,other2,other3]},
  ]};
  const popup=await runCampaign([paid(35000),giftLine("kept",11,"low")],offer);
  expect(popup.updates).toEqual([]);
  expect(popup.html).toContain("CHOOSE 1 FREE GIFT");
  // With 1 left to pick, a second click swaps the choice instead of locking.
  popup.clickCard(other1.productId);popup.clickCard(other2.productId);popup.clickClaim();
  expect(popup.additions.map(i=>i.id)).toEqual([51]);
 });
 test("Tier 2 with 1 left: no card is locked, every gift shows its own options",async()=>{
  const offer={enabled:true,tiers:[campaign.tiers[0],{id:"high",minimumSpend:35000,mode:"two",products:[sling2,...shirtVariants]}]};
  const popup=await runCampaign([paid(35000),giftLine("kept",31,"low")],offer);
  expect(popup.html).toContain("CHOOSE 1 FREE GIFT");
  expect(popup.html).toContain("Your first free gift is already in your cart");
  expect(popup.content).toContain("fgc-products--two fgc-products--or");
  // The T-shirt's size options show before it is picked.
  expect(popup.content).toContain('data-option-value="M"');
  expect(popup.content).not.toMatch(/data-product-id="[^"]+"[^>]*disabled/);
  popup.clickCard(sling2.productId);popup.clickCard(shirt.productId);
  expect(popup.claimDisabled()).toBe(false);
  popup.clickClaim();
  expect(popup.additions.map(i=>i.id)).toEqual([21]);
 });
 test("Tier 2: picking a size of a gift picks that gift",async()=>{
  const offer={enabled:true,tiers:[campaign.tiers[0],{id:"high",minimumSpend:35000,mode:"two",products:[sling2,...shirtVariants]}]};
  const popup=await runCampaign([paid(35000),giftLine("kept",31,"low")],offer);
  popup.clickCard(sling2.productId);popup.clickOption(shirt.productId,"M");popup.clickClaim();
  expect(popup.additions.map(i=>i.id)).toEqual([22]);
 });
 test("a Tier 1 gift of another variant of a Tier 2 product counts as one of the two",async()=>{
  const line={...giftLine("kept",77,"low"),product_id:2};
  const popup=await runCampaign([paid(35000),line]);
  expect(popup.updates).toEqual([]);
  expect(popup.html).toContain("CHOOSE 1 FREE GIFT");
 });
 test("two existing gifts prompt shopper to keep one below Tier 2",async()=>{
  const amount=29997;
  const popup=await runCampaign([paid(amount),giftLine("a",11,"low"),giftLine("b",21,"high")]);
  expect(popup.html).toContain("CHOOSE 1 GIFT TO KEEP");
 });
 test("Tier 2 pick-two rule applies even when saved mode is one",async()=>{
  const offer={...campaign,tiers:campaign.tiers.map(t=>({...t,mode:"one"}))};
  const popup=await runCampaign([paid(35000)],offer);
  popup.clickCard(shirt.productId);popup.clickCard(sling3.productId);popup.clickClaim();expect(popup.additions.map(i=>i.id)).toEqual([21,31]);
 });
 test("sold-out choices remain visible but cannot be claimed",async()=>{
  const offer={...campaign,tiers:campaign.tiers.map(t=>({...t,products:[{...sling2,availableForSale:false},shirt,sling3]}))};
  const popup=await runCampaign([paid(35000)],offer);
  expect(popup.content).toContain("Sling 2.0");expect(popup.content).toContain("OUT OF STOCK");
  popup.clickCard(shirt.productId);popup.clickCard(sling3.productId);popup.clickClaim();expect(popup.additions.map(i=>i.id)).toEqual([21,31]);
 });
 test("below the minimum removes every gift",async()=>{
  expect((await runCampaign([paid(14999),giftLine("a",11,"low"),giftLine("b",21,"high")])).updates).toEqual([{a:0,b:0}]);
 });
 test("extra quantity and duplicate lines are removed",async()=>{
  const popup=await runCampaign([paid(35000),{...giftLine("a",11,"low"),quantity:3},giftLine("b",11,"high")]);
  expect(popup.updates).toEqual([{a:1,b:0}]);
 });
 test("size/color selectors are available for the chosen product",async()=>{
  const offer={...campaign,tiers:campaign.tiers.map(t=>({...t,products:[sling2,...shirtVariants,sling3]}))};
  const popup=await runCampaign([paid(35000)],offer);
  popup.clickCard(shirt.productId);popup.clickCard(sling2.productId);popup.clickClaim();expect(popup.additions.map(i=>i.id)).toEqual([11,21]);
 });
 test("closing only dismisses the unchanged cart",async()=>{
  const result=await run([paid(15000)],"/products/case",undefined,[],"low|999:1",campaign);
  expect(result.html).toBe("");
 });
 test("tier 2 popup opens exactly at its minimum and offers the higher tier",async()=>{
  const popup=await runCampaign([paid(35000)]);
  expect(popup.html).toContain("CHOOSE 2 FREE GIFTS");
  expect(popup.content).toContain("Sling 3.0");
 });
 test("cart just below tier 2 stays in tier 1",async()=>{
  const popup=await runCampaign([paid(34999)]);
  expect(popup.html).toContain("Choose 1 free gift");
 });
 test("presentment conversion is used only when active currency matches cart",async()=>{
  expect((await convertedRun(70000,"INR","INR","2.0")).content).toContain("Sling 3.0");
  expect((await convertedRun(70000,"INR","USD","2.0")).content).toContain("Sling 2.0");
 });
});

describe("current variant availability",()=>{
 const withFirst=(first: typeof sling2)=>({...campaign,tiers:campaign.tiers.map(t=>({...t,products:[first,shirt,sling3]}))});
 const open=(offer: ReturnType<typeof withFirst>,stock: Parameters<typeof run>[6])=>run([paid(19998)],"/products/case",undefined,[],null,offer,stock);
 test("stale zero inventory does not override live availability",async()=>{
  const offer=withFirst({...sling2,inventoryTracked:true,inventoryQuantity:0,availableForSale:false} as typeof sling2);
  const popup=await open(offer,{live:{[sling2.variantId]:{available:true}}});
  popup.clickCard(sling2.productId);popup.clickClaim();
  expect(popup.additions.map(i=>i.id)).toEqual([11]);
 });
 test("saved zero count cannot override availableForSale when live lookup is missing",async()=>{
  const offer=withFirst({...sling2,inventoryTracked:true,inventoryQuantity:0,availableForSale:true} as typeof sling2);
  const popup=await open(offer,{});popup.clickCard(sling2.productId);popup.clickClaim();
  expect(popup.additions.map(i=>i.id)).toEqual([11]);
 });
 test("fresh Ajax availability overrides stale unavailable snapshots and fetches once per product",async()=>{
  const offer=withFirst({...sling2,productHandle:"slab-case-one",inventoryTracked:true,inventoryQuantity:0,availableForSale:false} as typeof sling2);
  const popup=await open(offer,{live:{[sling2.variantId]:{available:false}},products:{"slab-case-one":{variants:[{id:11,available:true}]}}});
  expect(popup.productRequests).toEqual(["/products/slab-case-one.js"]);
  popup.clickCard(sling2.productId);popup.clickClaim();expect(popup.additions.map(i=>i.id)).toEqual([11]);
 });
 test("an unavailable original variant stays blocked while a new available variant can be claimed",async()=>{
  const offer=withFirst({...sling2,productHandle:"slab-case-one"} as typeof sling2);
  const popup=await open(offer,{products:{"slab-case-one":{options:["Type"],variants:[{id:11,title:"Original",options:["Original"],available:false},{id:12,title:"Restocked",options:["Restocked"],available:true}]}}});
  expect(popup.content).not.toContain("Original");expect(popup.content).toContain("Restocked");
  popup.clickCard(sling2.productId);popup.clickClaim();expect(popup.additions.map(i=>i.id)).toEqual([12]);
 });
 test("a failed refresh preserves the server-rendered availability",async()=>{
  const offer=withFirst({...sling2,productHandle:"slab-case-one",availableForSale:false} as typeof sling2);
  const popup=await open(offer,{fail:true,live:{[sling2.variantId]:{available:true}}});
  popup.clickCard(sling2.productId);popup.clickClaim();expect(popup.additions.map(i=>i.id)).toEqual([11]);
 });
});

describe("all current variants of the gift product",()=>{
 const titles=["PSA","BGS","SGC","CGC","MagPro (All sizes)","Magnetic Card Holder"];
 const full=()=>({id:1,options:[{name:"Slab type"}],variants:titles.map((title,index)=>({id:101+index,title,options:[title],available:true}))});
 const offer=()=>({...campaign,tiers:campaign.tiers.map(t=>({...t,products:[{...sling2,productHandle:"slab-case-one",variantId:"gid://shopify/ProductVariant/103",variantTitle:"SGC",optionNames:["Slab type"],optionValues:["SGC"]},shirt,sling3]}))});
 test.each(titles)("loads and claims %s even when only SGC was saved",async title=>{
  const popup=await run([paid(19998)],"/products/case",undefined,[],null,offer(),{products:{"slab-case-one":full()}});
  for(const value of titles) expect(popup.content).toContain(value);
  expect(popup.content).toContain("Choose your slab type");
  popup.clickOption(sling2.productId,title);popup.clickClaim();
  expect(popup.additions.map(i=>i.id)).toEqual([101+titles.indexOf(title)]);
 });
 test("unavailable variants are not shown",async()=>{
  const product=full();product.variants[0].available=false;
  const popup=await run([paid(19998)],"/products/case",undefined,[],null,offer(),{products:{"slab-case-one":product}});
  expect(popup.content).not.toContain('data-option-value="PSA"');expect(popup.content).not.toContain("Unavailable");
  expect(popup.content).toContain('data-option-value="BGS"');
  popup.clickClaim();expect(popup.additions.map(i=>i.id)).toEqual([102]);
 });
 test("newly discovered variants remain valid in the cart after reload",async()=>{
  const popup=await run([paid(19998),giftLine("new",101,"low")],"/products/case",undefined,[],null,offer(),{products:{"slab-case-one":full()}});
  expect(popup.updates).toEqual([]);expect(popup.html).toBe("");
 });
});
