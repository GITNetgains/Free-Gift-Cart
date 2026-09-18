import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = (name: string) => readFileSync(new URL(`../extensions/free-gift-popup/assets/${name}.js`, import.meta.url), "utf8");
describe("storefront regression checks", () => {
  test.each(["free-gift-popup", "free-gift-product-widget"])("%s escapes product names used in HTML attributes", (name) => {
    const script = source(name);
    const helper = script.match(/const escapeHtml = \(value\) => \{[\s\S]*?\n\s*\};/)![0];
    const escape = runInNewContext(`${helper}; escapeHtml`, { document: { createElement: () => {
      let value = "";
      return { set textContent(text: string) { value = text; }, get innerHTML() { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); } };
    } } });
    expect(escape('Case " onclick="alert(1)')).toBe('Case &quot; onclick=&quot;alert(1)');
    expect(escape("Collector's <case>")).toBe("Collector&#39;s &lt;case&gt;");
  });
  test("cart gift removal retries after a network failure", async () => {
    const settings = { enabled: true, minimumSpend: 5000, products: [{ variantId: "gid://shopify/ProductVariant/1", productId: "1", productTitle: "Gift" }] };
    const settingsNode = { textContent: JSON.stringify(settings) };
    let poll: (() => Promise<void>) | undefined;
    let removals = 0;
    let reloads = 0;
    const root = { dataset: { cartPath: "/cart" }, hidden: true, querySelector: (selector: string) => selector === "[data-free-gift-settings]" ? settingsNode : null };
    runInNewContext(source("free-gift-popup"), {
      document: { getElementById: () => root, documentElement: { classList: { remove() {} } } },
      sessionStorage: { removeItem() {} },
      window: { location: { pathname: "/cart", reload: () => reloads++ }, setInterval: (callback: () => Promise<void>) => { poll = callback; } },
      fetch: async (url: string) => {
        if (url.endsWith("cart.js")) return { ok: true, json: async () => ({ items: [{ key: "gift", properties: { _free_gift: "true" }, original_line_price: 1000 }] }) };
        removals++;
        if (removals === 1) throw new Error("Connection lost");
        return { ok: true };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removals).toBe(1);
    await poll!();
    expect(removals).toBe(2);
    expect(reloads).toBe(1);
  });
});
