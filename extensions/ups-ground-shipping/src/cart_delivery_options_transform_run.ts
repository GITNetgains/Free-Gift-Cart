import type {
  CartDeliveryOptionsTransformRunInput,
  CartDeliveryOptionsTransformRunResult,
} from "../generated/api";

// Alaska and Hawaii only get UPS Ground; every other address never sees it.
const UPS_GROUND_ONLY_STATES = ["AK", "HI"];

const isUpsGround = (title?: string | null) => /ups\s*ground/i.test(title ?? "");

export function cartDeliveryOptionsTransformRun(input: CartDeliveryOptionsTransformRunInput): CartDeliveryOptionsTransformRunResult {
  const hide: string[] = [];

  for (const group of input.cart.deliveryGroups) {
    const address = group.deliveryAddress;
    const shipping = group.deliveryOptions.filter((option) => option.deliveryMethodType === "SHIPPING");
    const groundOnly = address?.countryCode === "US"
      && UPS_GROUND_ONLY_STATES.includes((address.provinceCode ?? "").toUpperCase());

    if (groundOnly) {
      // Never leave the customer with no way to ship: only hide the others
      // when UPS Ground is actually offered for this address.
      if (!shipping.some((option) => isUpsGround(option.title))) continue;
      for (const option of shipping) if (!isUpsGround(option.title)) hide.push(option.handle);
    } else {
      for (const option of shipping) if (isUpsGround(option.title)) hide.push(option.handle);
    }
  }

  return { operations: hide.map((deliveryOptionHandle) => ({ deliveryOptionHide: { deliveryOptionHandle } })) };
}
