import { describe, expect, test } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run";
import { DiscountClass, type CartInput } from "../generated/api";

const SLING2 = { productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/11" };
const SHIRT = { productId: "gid://shopify/Product/2", variantId: "gid://shopify/ProductVariant/21" };
const SLING3 = { productId: "gid://shopify/Product/3", variantId: "gid://shopify/ProductVariant/31" };

const settings = {
  enabled: true,
  tiers: [
    { id: "t120", minimumSpend: 12000, mode: "one", products: [SLING2, SHIRT] },
    { id: "t300", minimumSpend: 30000, mode: "all", products: [SLING3, SHIRT] },
  ],
};

type Gift = { id: string; tier: string; variantId: string };

function input(paid: string, gifts: Gift[], rate = "1.0", cartCurrency = "USD", shopCurrency = "USD"): CartInput {
  return {
    presentmentCurrencyRate: rate,
    discount: { discountClasses: [DiscountClass.Product], tierSettings: { jsonValue: { ...settings, shopCurrency } } },
    cart: {
      cost: { subtotalAmount: { currencyCode: cartCurrency } },
      lines: [
        { id: "paid", quantity: 1, tierMarker: null, oldGiftMarker: null,
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/999", product: { id: "gid://shopify/Product/999" } },
          cost: { subtotalAmount: { amount: paid } } },
        ...gifts.map((gift) => ({
          id: gift.id, quantity: 1, tierMarker: { value: gift.tier }, oldGiftMarker: null,
          merchandise: { __typename: "ProductVariant", id: gift.variantId, product: { id: [SLING2, SHIRT, SLING3].find(product => product.variantId === gift.variantId)?.productId || "gid://shopify/Product/unconfigured" } },
          cost: { subtotalAmount: { amount: "50.00" } },
        })),
      ],
    },
  } as unknown as CartInput;
}

const targets = (result: ReturnType<typeof cartLinesDiscountsGenerateRun>) =>
  result.operations.flatMap((op) => op.productDiscountsAdd?.candidates[0].targets.map((t) => t.cartLine?.id ?? "") ?? []);


describe("Netgains10 gift limits by spend tier",()=>{
 const run=(amount:string,variants=[SLING2.variantId,SHIRT.variantId,SLING3.variantId],mode="all")=>{
  const data=input(amount,variants.map((variantId,index)=>({id:"g"+index,tier:"low",variantId})));
  data.discount.tierSettings!.jsonValue={enabled:true,shopCurrency:"USD",tiers:[
   {id:"low",minimumSpend:15000,mode:"one",products:[SLING2,SHIRT,SLING3]},
   {id:"high",minimumSpend:35000,mode,products:[SLING2,SHIRT,SLING3]},
  ]};return cartLinesDiscountsGenerateRun(data);
 };
 test.each([
  ["150.00",["g0"]], ["299.97",["g0"]], ["349.99",["g0"]],
  ["350.00",["g0","g1"]], ["999.00",["g0","g1"]],
 ] as const)("discounts the allowed number of distinct gift lines at %s",(amount,expected)=>{
  const result=run(amount);expect(targets(result)).toEqual(expected);
  expect(result.operations[0].productDiscountsAdd?.candidates[0].targets.map(t=>t.cartLine?.quantity)).toEqual(expected.map(()=>1));
 });
 test.each([SLING2.variantId,SHIRT.variantId,SLING3.variantId])("each gift can be chosen independently: %s",variant=>{
  expect(targets(run("350.00",[variant]))).toEqual(["g0"]);
 });
 test.each(["one","two","all"])("Tier 2 stays pick-two with saved legacy mode %s",mode=>{
  expect(targets(run("350.00",undefined,mode))).toEqual(["g0","g1"]);
 });
 test("below threshold nothing is free",()=>expect(targets(run("149.99"))).toEqual([]));
 test("unconfigured variants do not qualify",()=>expect(targets(run("350.00",["gid://shopify/ProductVariant/unknown"]))).toEqual([]));
 test("duplicate product lines do not consume both Tier 2 gift slots",()=>expect(targets(run("350.00",[SHIRT.variantId,SHIRT.variantId]))).toEqual(["g0"]));
 test("disabled campaign has no discounts",()=>{
  const data=input("350.00",[{id:"gift",tier:"low",variantId:SHIRT.variantId}]);
  data.discount.tierSettings!.jsonValue={enabled:false,tiers:settings.tiers};
  expect(targets(cartLinesDiscountsGenerateRun(data))).toEqual([]);
 });
});

test("a newly added variant of an allowed gift product gets one free unit",()=>{
 const data=input("350.00",[{id:"new",tier:"t300",variantId:"gid://shopify/ProductVariant/NEW"}]);
 if(data.cart.lines[1].merchandise.__typename === "ProductVariant") data.cart.lines[1].merchandise.product.id=SHIRT.productId;
 expect(targets(cartLinesDiscountsGenerateRun(data))).toEqual(["new"]);
});
test("forged gift attributes cannot discount an unrelated product",()=>{
 const data=input("350.00",[{id:"forged",tier:"t300",variantId:SHIRT.variantId}]);
 if(data.cart.lines[1].merchandise.__typename === "ProductVariant") data.cart.lines[1].merchandise.product.id="gid://shopify/Product/unconfigured";
 expect(targets(cartLinesDiscountsGenerateRun(data))).toEqual([]);
});
