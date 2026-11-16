import type {
  CartDeliveryOptionsTransformRunInput,
  CartDeliveryOptionsTransformRunResult,
} from "../generated/api";

// Alaska and Hawaii only get UPS Ground; every other address never sees it.
const UPS_GROUND_ONLY_STATES = ["AK", "HI"];

const isUpsGround = (title?: string | null) => /ups\W*ground/i.test(title ?? "");

export function cartDeliveryOptionsTransformRun(input: CartDeliveryOptionsTransformRunInput): CartDeliveryOptionsTransformRunResult {
  const hide: string[] = [];

  for (const group of input.cart.deliveryGroups) {
    const address = group.deliveryAddress;
    const shipping = group.deliveryOptions.filter((option) => option.deliveryMethodType === "SHIPPING");
    const groundOnly = address?.countryCode === "US"
      && UPS_GROUND_ONLY_STATES.includes((address.provinceCode ?? "").toUpperCase());

    if (groundOnly) {
      // UPS Ground can come from ShipStation and from the app's own rate.
      // Keep the cheapest one and hide everything else. Never leave the
      // customer with no way to ship: if no UPS Ground is offered, hide nothing.
      const grounds = shipping.filter((option) => isUpsGround(option.title));
      if (!grounds.length) continue;
      const keep = grounds.reduce((best, option) =>
        Number(option.cost.amount) < Number(best.cost.amount) ? option : best);
      for (const option of shipping) if (option !== keep) hide.push(option.handle);
    } else {
      for (const option of shipping) if (isUpsGround(option.title)) hide.push(option.handle);
    }
  }

  return { operations: hide.map((deliveryOptionHandle) => ({ deliveryOptionHide: { deliveryOptionHandle } })) };
}
