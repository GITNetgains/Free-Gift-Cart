import { describe, expect, test } from "vitest";
import { cartDeliveryOptionsTransformRun } from "../src/cart_delivery_options_transform_run";

const option = (handle, title, amount, deliveryMethodType = "SHIPPING") => ({ handle, title, deliveryMethodType, cost: { amount } });
const options = [
  option("economy", "Economy", "0.0"),
  option("ground", "UPS Ground", "12.62"),
  option("2day", "UPS 2nd Day Air", "32.32"),
  option("nextday", "UPS Next Day Air", "71.33"),
  option("pickup", "Store pickup", "0.0", "PICK_UP"),
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
  test("with ShipStation's and the app's UPS Ground, Alaska keeps only the cheaper one", () => {
    const both = [option("ss-2day", "UPS 2nd Day Air", "73.66"), option("app-ground", "UPS Ground", "70.59"), option("ss-ground", "UPS® Ground", "74.10")];
    expect(hidden(run("AK", both))).toEqual(["ss-2day", "ss-ground"]);
  });
  test("the app's UPS Ground alone is kept in Hawaii", () => {
    const appOnly = [option("ss-2day", "UPS 2nd Day Air", "73.66"), option("ss-next", "UPS Next Day Air", "117.27"), option("app-ground", "UPS Ground", "70.59")];
    expect(hidden(run("HI", appOnly))).toEqual(["ss-2day", "ss-next"]);
  });
});

describe("UPS Ground title variants", () => {
  test("'UPS® Ground' is hidden outside Alaska and Hawaii", () =>
    expect(hidden(run("TX", [option("eco", "Economy", "0.0"), option("g", "UPS® Ground", "9.0")]))).toEqual(["g"]));
});
