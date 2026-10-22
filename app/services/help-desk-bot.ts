// Rule-based chat bot for the storefront chat widget (no AI/LLM). The store's
// FAQ entries are scored against the customer's question with a TF-IDF-style
// word overlap (a word used by only one entry is a stronger signal than one
// many entries share) plus a bonus for exact multi-word keyword phrases. The
// best entry wins only when it clears a minimum score and clearly beats the
// runner-up; otherwise the customer is offered a person instead of a
// confident-looking wrong answer.

export type Faq = { id: string; question: string; keywords: string; answer: string };

const STOPWORDS = new Set(("a an and are as at be but by can could do does for from get got has have how i i'm if in into is it its me my "
  + "of on or our please so that the their them then there this to too us was we what when where which who why will with would you your "
  + "hi hello hey thanks thank want need know tell").split(" "));

const tokenize = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

// A light stemmer so "orders", "ordered" and "ordering" all match "order".
function stem(token: string) {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("es") && /(ch|sh|x|ss)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

const meaningful = (text: string) => tokenize(text).filter((token) => !STOPWORDS.has(token)).map(stem);
const phrases = (faq: Faq) => faq.keywords.split(",").map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);

const MIN_SCORE = 2.2;
const AMBIGUITY_RATIO = 0.82;

export function matchFaq(question: string, faqs: Faq[]): Faq | null {
  const words = new Set(meaningful(question));
  if (!words.size || !faqs.length) return null;
  const lower = ` ${tokenize(question).join(" ")} `;
  const entries = faqs.map((faq) => ({ faq, words: new Set(meaningful(`${faq.question} ${faq.keywords}`)) }));
  const frequency = new Map<string, number>();
  for (const entry of entries) for (const word of entry.words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const idf = (word: string) => Math.log((entries.length + 1) / ((frequency.get(word) ?? entries.length) + 1)) + 1;

  const scored = entries.map(({ faq, words: entryWords }) => {
    let score = 0;
    for (const word of words) if (entryWords.has(word)) score += idf(word);
    for (const phrase of phrases(faq)) {
      const length = tokenize(phrase).length;
      // A longer exact phrase is more specific than a short one it contains.
      if (length > 1 && lower.includes(` ${tokenize(phrase).join(" ")} `)) score += 4 + (length - 2);
    }
    return { faq, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);

  const [best, second] = scored;
  if (!best || best.score < MIN_SCORE) return null;
  if (second && second.score >= best.score * AMBIGUITY_RATIO) return null;
  return best.faq;
}

// "Where is order #1042" -> "1042". Needs an order word so FAQ questions with
// numbers in them ("5 days") aren't treated as lookups.
export function extractOrderNumber(text: string) {
  if (!/\b(order|orders|parcel|package|shipment|tracking|track|delivery)\b/i.test(text) && !/#\d/.test(text)) return null;
  return text.match(/#?\b(\d{3,10})\b/)?.[1] ?? null;
}

export const extractEmail = (text: string) => text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] ?? null;

export const isOrderStatusQuestion = (text: string) =>
  /\b(where|status|track|tracking|shipped|ship|delivered|arrive|arrival|dispatch|dispatched)\b/i.test(text) && /\b(order|orders|parcel|package|shipment|delivery)\b/i.test(text);

export const NO_ANSWER = "I couldn't find an answer to that yet. Tap \"Talk to our team\" and a person will get back to you.";

// Starter answers. They only describe how this Help Desk works, never store
// policies (shipping times, return windows), which each store adds itself.
export const defaultFaqs = [
  {
    question: "Where is my order?",
    keywords: "where is my order, track my order, order status, tracking number, has my order shipped, delivery status, not arrived",
    answer: "I can check that for you. If you're signed in, just ask \"where is my order?\". Otherwise send your order number and the email you used, for example: \"Order #1001, name@example.com\".",
  },
  {
    question: "How do I return, exchange or get a refund?",
    keywords: "return, exchange, refund, send back, money back, return policy, return an item, refund status",
    answer: "Open our Help Desk form and choose \"Returns, Exchanges & Refunds\". Add your order number, what went wrong and a few photos, and we'll take it from there.",
  },
  {
    question: "I received a damaged or wrong product",
    keywords: "damaged, broken, defective, wrong product, wrong item, missing item, cracked, faulty, arrived damaged, arrived broken, arrived cracked, received wrong",
    answer: "Sorry about that! Please use our Help Desk form and choose \"Order Queries\", then \"Product Issues\" or \"Wrong Product Received\". Photos of the product and packaging help us sort it out quickly.",
  },
  {
    question: "Can I change or cancel my order?",
    keywords: "change my order, cancel my order, update order, change address, wrong address, change quantity, edit order",
    answer: "If your order hasn't shipped yet we can usually help. Choose \"Order Queries\" and then \"Update order\" in our Help Desk form, or tap \"Talk to our team\" below.",
  },
  {
    question: "Do you ship internationally?",
    keywords: "international shipping, ship to my country, overseas, worldwide shipping, outside the country, customs",
    answer: "Send us an \"International Shipping query\" from our Help Desk form with the products and your address, and we'll confirm options and costs for your country.",
  },
  {
    question: "Wholesale and affiliate enquiries",
    keywords: "wholesale, bulk order, reseller, stockist, affiliate, partnership, collaborate, influencer",
    answer: "Choose \"Wholesale Queries\" or \"Affiliates Queries\" in our Help Desk form and tell us a little about you. Our team replies by email.",
  },
];
