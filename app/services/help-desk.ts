export const topics = ["International Shipping query", "Wholesale Queries", "Affiliates Queries", "Order Queries", "Returns, Exchanges & Refunds"] as const;
export const orderTypes = ["Update order", "Product Issues", "Wrong Product Ordered"];
export const updates = ["Change Product or Quantity", "Update Shipping Details"];
export const issues = ["Defective product received", "Wrong product received", "Missing items", "Wrong item ordered"];
export type HelpDeskValues = Record<string, string>;
export type Attachment = { name: string; size: number; type: string };
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 5;

export function imagesRequired(values: HelpDeskValues) {
  return values.topic === topics[4] || (values.topic === topics[3] && values.orderType === orderTypes[1] && issues.slice(0, 2).includes(values.issue));
}

export function validateHelpDesk(values: HelpDeskValues, products: string[], files: Attachment[]) {
  const errors: Record<string, string> = {};
  const required = (key: string, label: string) => { if (!values[key]?.trim()) errors[key] = `${label} is required.`; };
  const choice = (key: string, options: readonly string[], label: string) => { if (!options.includes(values[key])) errors[key] = `Select ${label}.`; };
  required("name", "Name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email?.trim() || "")) errors.email = "Enter a valid email address.";
  choice("topic", topics, "a topic");
  if (values.topic === topics[0]) {
    if (!products.length) errors.products = "Select at least one product.";
    required("country", "Country"); required("address", "Address");
  }
  if (values.topic === topics[1] || values.topic === topics[2]) {
    choice("existing", ["Yes", "No"], "Yes or No");
    if (values.existing === "Yes" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.registeredEmail?.trim() || "")) errors.registeredEmail = "Enter your registered email address.";
    required("query", "Query");
  }
  if (values.topic === topics[3]) {
    required("orderNumber", "Order number"); choice("orderType", orderTypes, "an order query type");
    if (values.orderType === orderTypes[0]) {
      choice("update", updates, "an order update"); required("details", "Update details");
    } else if (values.orderType === orderTypes[1]) {
      choice("issue", issues.slice(0, 3), "a product issue"); required("details", "Issue details");
    } else if (values.orderType === orderTypes[2]) required("details", "Product and correction details");
  }
  if (values.topic === topics[4]) {
    required("orderNumber", "Order number"); required("orderDetails", "Order details"); required("productDetails", "Product details");
    choice("issue", issues, "an issue"); required("details", "Issue details"); choice("resolution", ["Return", "Exchange", "Refund"], "a preferred resolution");
  }
  const allowsImages = values.topic === topics[4] || (values.topic === topics[3] && values.orderType === orderTypes[1]);
  if (allowsImages) {
    if (imagesRequired(values) && !files.length) errors.images = "Upload at least one image for this issue.";
    if (files.length > MAX_IMAGES) errors.images = `Upload no more than ${MAX_IMAGES} images.`;
    if (files.some(file => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size === 0 || file.size > MAX_IMAGE_BYTES)) errors.images = "Use non-empty JPG, PNG or WebP images, up to 5 MB each.";
  }
  return errors;
}

// ISO 3166-1 regions, including territories; labels are localized by Intl.
const regionCodes = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
export const countries = regionCodes.split(" ").map(code => ({ code, name: regionNames.of(code) || code })).sort((a, b) => a.name.localeCompare(b.name));
