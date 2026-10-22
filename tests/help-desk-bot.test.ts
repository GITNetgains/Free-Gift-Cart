import { describe, expect, it } from "vitest";
import { defaultFaqs, extractEmail, extractOrderNumber, isOrderStatusQuestion, matchFaq } from "../app/services/help-desk-bot";

const faqs = defaultFaqs.map((faq, index) => ({ id: String(index), ...faq }));
const answerFor = (question: string) => matchFaq(question, faqs)?.question ?? null;

describe("Chat bot FAQ matching", () => {
  it("matches differently worded questions to the right answer", () => {
    expect(answerFor("Can I send my item back for a refund?")).toBe("How do I return, exchange or get a refund?");
    expect(answerFor("my case arrived cracked")).toBe("I received a damaged or wrong product");
    expect(answerFor("do you do international shipping to Canada")).toBe("Do you ship internationally?");
    expect(answerFor("I want to cancel my order")).toBe("Can I change or cancel my order?");
    expect(answerFor("Interested in becoming a wholesale reseller")).toBe("Wholesale and affiliate enquiries");
  });
  it("gives no answer for greetings, unrelated or empty questions rather than guessing", () => {
    expect(answerFor("hello")).toBeNull();
    expect(answerFor("what is the meaning of life")).toBeNull();
    expect(answerFor("   ")).toBeNull();
    expect(matchFaq("refund", [])).toBeNull();
  });
  it("refuses a match when two answers score about the same", () => {
    const close = [
      { id: "a", question: "Shipping to Canada", keywords: "canada shipping", answer: "A" },
      { id: "b", question: "Shipping to Canada fast", keywords: "canada shipping", answer: "B" },
    ];
    expect(matchFaq("canada shipping", close)).toBeNull();
  });
  it("prefers the entry with an exact multi-word phrase", () => {
    const entries = [
      { id: "a", question: "Order status", keywords: "order, status", answer: "A" },
      { id: "b", question: "Change address", keywords: "wrong address, change address", answer: "B" },
    ];
    expect(matchFaq("I typed the wrong address on my order", entries)?.id).toBe("b");
  });
  it("finds order numbers and emails in order questions only", () => {
    expect(extractOrderNumber("where is order #1042?")).toBe("1042");
    expect(extractOrderNumber("#1042 not arrived")).toBe("1042");
    expect(extractOrderNumber("do you ship in 5 days")).toBeNull();
    expect(extractEmail("order 1001, Rahul.S+test@Example.co.in")).toBe("Rahul.S+test@Example.co.in");
    expect(isOrderStatusQuestion("where is my order")).toBe(true);
    expect(isOrderStatusQuestion("what is your return policy")).toBe(false);
  });
});
