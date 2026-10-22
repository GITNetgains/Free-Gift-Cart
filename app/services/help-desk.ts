export const topics = ["International Shipping query", "Wholesale Queries", "Affiliates Queries", "Order Queries", "Returns, Exchanges & Refunds"] as const;
export const orderTypes = ["Update order", "Product Issues", "Wrong Product Received"];
export const updates = ["Change Product or Quantity", "Update Shipping Details"];
export const issues = ["Defective product received", "Wrong product received", "Missing items", "Wrong item ordered"];
export type HelpDeskValues = Record<string, string>;
export type Attachment = { name: string; size: number; type: string };
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 5;

export function imagesRequired(values: HelpDeskValues) {
  return values.topic === topics[4] || (values.topic === topics[3] && (values.orderType === orderTypes[2] || (values.orderType === orderTypes[1] && issues.slice(0, 2).includes(values.issue))));
}

export function validateHelpDesk(values: HelpDeskValues, products: string[], files: Attachment[], receivedProducts: string[] = []) {
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
    } else if (values.orderType === orderTypes[2]) {
      if (!receivedProducts.length) errors.receivedProducts = "Select the product you received.";
      if (!products.length) errors.products = "Select the product you wanted.";
    }
  }
  if (values.topic === topics[4]) {
    required("orderNumber", "Order number"); required("orderDetails", "Order details"); required("productDetails", "Product details");
    choice("issue", issues, "an issue"); required("details", "Issue details"); choice("resolution", ["Return", "Exchange", "Refund"], "a preferred resolution");
  }
  const allowsImages = values.topic === topics[4] || (values.topic === topics[3] && (values.orderType === orderTypes[1] || values.orderType === orderTypes[2]));
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

export const ticketStatuses = ["Open", "In progress", "Waiting on customer", "Resolved"] as const;
export const priorities = ["Low", "Normal", "High", "Urgent"] as const;
// Topic of tickets started from the storefront chat widget.
export const CHAT_TOPIC = "Live chat";
export const MAX_MESSAGE_LENGTH = 10000;
export const ticketLabel = (number: number) => `#${number}`;

// Placeholders saved replies can use, with what each one inserts.
export const macroPlaceholders: [string, string][] = [
  ["customer.first_name", "Customer's first name"], ["customer.name", "Customer's full name"], ["ticket.number", "Ticket number"],
  ["ticket.topic", "Ticket topic"], ["order.number", "Order number from the request"], ["store.name", "Your store name"],
];

export function fillMacro(body: string, ticket: { name: string; number: number; topic: string; details: Record<string, string> }, storeName: string) {
  const values: Record<string, string> = {
    "customer.first_name": ticket.name.trim().split(/\s+/)[0] || ticket.name,
    "customer.name": ticket.name,
    "ticket.number": `#${ticket.number}`,
    "ticket.topic": ticket.topic,
    "order.number": ticket.details.orderNumber || "",
    "store.name": storeName,
  };
  return body.replace(/\{\{\s*([a-z_.]+)\s*\}\}/g, (match, key: string) => values[key] ?? match);
}

// Saved replies a new store starts with.
export const defaultMacros = [
  { title: "Acknowledge and investigating", body: "Hi {{ customer.first_name }},\n\nThanks for getting in touch about {{ ticket.topic }}. We're looking into this now and will update you shortly.\n\nBest regards,\n{{ store.name }}" },
  { title: "Request photos", body: "Hi {{ customer.first_name }},\n\nSorry to hear about this. Could you send us a few clear photos of the product and its packaging? You can reply on your request page and we'll take it from there.\n\nThanks,\n{{ store.name }}" },
  { title: "Replacement on the way", body: "Hi {{ customer.first_name }},\n\nGood news: we've arranged a replacement for order {{ order.number }}. You'll receive a shipping confirmation by email as soon as it's dispatched.\n\nThanks for your patience,\n{{ store.name }}" },
  { title: "Refund processed", body: "Hi {{ customer.first_name }},\n\nWe've processed your refund for order {{ order.number }}. Depending on your bank, it can take 5-10 business days to appear on your statement.\n\nBest regards,\n{{ store.name }}" },
  { title: "Closing: resolved", body: "Hi {{ customer.first_name }},\n\nWe're glad this is sorted. We'll mark ticket {{ ticket.number }} as resolved, but just reply if there's anything else we can help with.\n\nHave a great day,\n{{ store.name }}" },
];

// Labels for submitted fields, in display order. Name, email and topic are
// shown separately in the admin ticket header and the notification email.
export const fieldLabels: Record<string, string> = {
  phone: "Phone", orderNumber: "Order number", orderType: "Order query", update: "Order update",
  issue: "Issue", resolution: "Requested resolution", orderDetails: "Order details", productDetails: "Product details",
  details: "Details", existing: "Existing partner", registeredEmail: "Registered email", query: "Query",
  country: "Country", address: "Address", otherDetails: "Other details", transcript: "Chat transcript",
};
export const countryName = (code: string) => countries.find(country => country.code === code)?.name || code;
