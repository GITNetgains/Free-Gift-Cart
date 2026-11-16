import { describe, expect, test } from "vitest";
import { cartDeliveryOptionsTransformRun } from "../src/cart_delivery_options_transform_run";

const options = [
  { handle: "economy", title: "Economy", deliveryMethodType: "SHIPPING" },
  { handle: "ground", title: "UPS Ground", deliveryMethodType: "SHIPPING" },
  { handle: "2day", title: "UPS 2nd Day Air", deliveryMethodType: "SHIPPING" },
  { handle: "nextday", title: "UPS Next Day Air", deliveryMethodType: "SHIPPING" },
  { handle: "pickup", title: "Store pickup", deliveryMethodType: "PICK_UP" },
];
const run = (provinceCode, deliveryOptions = options, countryCode = "US") =>
  cartDeliveryOptionsTransformRun({ cart: { deliveryGroups: [{ deliveryAddress: provinceCode === null ? null : { countryCode, provinceCode }, deliveryOptions }] } });
const hidden = (result) => result.operations.map((op) => op.deliveryOptionHide.deliveryOptionHandle);

describe("UPS Ground for Alaska and Hawaii", () => {
  test("Alaska sees only UPS Ground", () => expect(hidden(run("AK"))).toEqual(["economy", "2day", "nextday"]));
  test("Hawaii sees only UPS Ground", () => expect(hidden(run("HI"))).toEqual(["economy", "2day", "nextday"]));
  test("other states never see UPS Ground", () => expect(hidden(run("CA"))).toEqual(["ground"]));
  test("no address yet hides UPS Ground", () => expect(hidden(run(null))).toEqual(["ground"]));
  test("Alaska keeps every option when UPS Ground isn't offered", () =>
    expect(hidden(run("AK", options.filter((o) => o.handle !== "ground")))).toEqual([]));
  test("a non-US AK/HI province code is treated like any other address", () => expect(hidden(run("HI", options, "CA"))).toEqual(["ground"]));
});
