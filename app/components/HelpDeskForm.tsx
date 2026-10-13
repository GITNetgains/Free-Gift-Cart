import { useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { loader as productLoader } from "../routes/app.help-desk-products";
import { countries, imagesRequired, issues, orderTypes, topics, updates, validateHelpDesk, type HelpDeskValues } from "../services/help-desk";

export default function HelpDeskForm() {
  const [values, setValues] = useState<HelpDeskValues>({});
  const [products, setProducts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const [search, setSearch] = useState("");
  const [searchedTerm, setSearchedTerm] = useState("");
  const [fileKey, setFileKey] = useState(0);
  const statusRef = useRef<HTMLDivElement>(null);
  const productFetcher = useFetcher<typeof productLoader>();
  const topic = values.topic;
  const isPartner = topic === topics[1] || topic === topics[2];
  const isOrder = topic === topics[3];
  const isReturn = topic === topics[4];
  const showImages = isReturn || (isOrder && values.orderType === orderTypes[1]);

  function change(key: string, input: string | undefined) {
    const value = input || "";
    setChecked(false);
    setErrors({});
    if (key === "topic") {
      setValues(previous => ({ name: previous.name || "", email: previous.email || "", phone: previous.phone || "", topic: value }));
      setProducts({}); setFiles([]); setFileKey(previous => previous + 1);
    } else {
      setValues(previous => {
        const next = { ...previous, [key]: value };
        if (key === "orderType") { delete next.issue; delete next.update; delete next.details; }
        if (key === "update") delete next.details;
        if (key === "existing") delete next.registeredEmail;
        return next;
      });
      if (key === "orderType") { setFiles([]); setFileKey(previous => previous + 1); }
    }
  }

  function textField(key: string, label: string, required = true, placeholder?: string, multiline = false) {
    const props = { name: key, label, required, value: values[key] || "", error: errors[key], placeholder, onInput: (event: { currentTarget: { value?: string } }) => change(key, event.currentTarget.value) };
    return multiline ? <s-text-area {...props} rows={4} maxLength={5000} /> : <s-text-field {...props} maxLength={200} />;
  }

  function select(key: string, label: string, options: readonly string[]) {
    return <s-select name={key} label={label} value={values[key] || ""} required error={errors[key]} onChange={event => change(key, event.currentTarget.value)}>
      <s-option value="">Select an option</s-option>
      {options.map(option => <s-option key={option} value={option}>{option}</s-option>)}
    </s-select>;
  }

  function loadProducts(after?: string) {
    const term = after ? searchedTerm : search;
    if (!after) setSearchedTerm(search);
    const params = new URLSearchParams({ q: term });
    if (after) params.set("after", after);
    void productFetcher.load(`/app/help-desk-products?${params}`);
  }

  function checkForm() {
    setErrors(validateHelpDesk(values, Object.keys(products), files));
    setChecked(true);
    requestAnimationFrame(() => statusRef.current?.focus());
  }

  return <s-page heading="Help Desk" inlineSize="base">
    <s-badge slot="primary-action" tone="info">Form preview</s-badge>
    <s-section>
      <s-banner heading="Preview your help desk form" tone="info">
        Explore each topic and check the required fields. Requests and images are not saved or sent yet.
      </s-banner>
    </s-section>
    <form onSubmit={event => { event.preventDefault(); checkForm(); }} noValidate>
      <s-stack gap="base">
        <s-section heading="Contact information">
          <s-stack gap="base">
            {textField("name", "Name")}
            <s-email-field name="email" label="Email" autocomplete="email" required value={values.email || ""} error={errors.email} onInput={event => change("email", event.currentTarget.value)} />
            {textField("phone", "Phone number (optional)", false)}
            {select("topic", "How can we help you?", topics)}
          </s-stack>
        </s-section>

        {topic === topics[0] && <s-section heading="International shipping">
          <s-stack gap="base">
            <details onToggle={event => { if (event.currentTarget.open && !productFetcher.data && productFetcher.state === "idle") loadProducts(); }}>
              <summary style={{ cursor: "pointer", padding: "12px", border: "1px solid #bbb", borderRadius: "8px" }}>Select products * ({Object.keys(products).length} selected)</summary>
              <div style={{ padding: "12px", display: "grid", gap: "12px" }}>
                <s-search-field label="Search products" value={search} onInput={event => setSearch(event.currentTarget.value)} />
                <s-button type="button" onClick={() => loadProducts()} disabled={productFetcher.state !== "idle"}>Search products</s-button>
                <s-paragraph color="subdued">Select multiple products. Selections stay selected across searches and pages.</s-paragraph>
                {productFetcher.state !== "idle" ? <s-spinner accessibilityLabel="Loading products" /> : <>
                  {productFetcher.data?.error && <s-banner tone="critical">{productFetcher.data.error}</s-banner>}
                  {productFetcher.data && !productFetcher.data.error && !productFetcher.data.products.length && <s-paragraph>No products found. Try another search.</s-paragraph>}
                  <div style={{ maxHeight: "240px", overflowY: "auto" }}>
                    {productFetcher.data?.products.map(product => <s-checkbox key={product.id} label={product.title} checked={Boolean(products[product.id])} onChange={event => {
                      const selected = event.currentTarget.checked;
                      setProducts(previous => { const next = { ...previous }; if (selected) next[product.id] = product.title; else delete next[product.id]; return next; });
                      setChecked(false); setErrors({});
                    }} />)}
                  </div>
                  {productFetcher.data?.pageInfo.hasNextPage && <s-button type="button" onClick={() => loadProducts(productFetcher.data?.pageInfo.endCursor || undefined)}>Next products</s-button>}
                </>}
              </div>
            </details>
            {errors.products && <s-text tone="critical">{errors.products}</s-text>}
            {Object.entries(products).map(([id, title]) => <s-stack key={id} direction="inline" gap="small" alignItems="center">
              <s-text>{String(title)}</s-text><s-button type="button" variant="tertiary" accessibilityLabel={`Remove ${title}`} onClick={() => { setProducts(previous => { const next = { ...previous }; delete next[id]; return next; }); setChecked(false); setErrors({}); }}>Remove</s-button>
            </s-stack>)}
            <s-select label="Select country" name="country" required value={values.country || ""} error={errors.country} onChange={event => change("country", event.currentTarget.value)}>
              <s-option value="">Select a country</s-option>
              {countries.map(country => <s-option key={country.code} value={country.code}>{country.name}</s-option>)}
            </s-select>
            {textField("address", "Address", true, "Street address, city, state / province and postal code", true)}
            {textField("otherDetails", "Any other details (optional)", false, "Tell us anything else we should know", true)}
          </s-stack>
        </s-section>}

        {isPartner && <s-section heading={topic === topics[1] ? "Wholesale queries" : "Affiliate queries"}>
          <s-stack gap="base">
            <s-choice-list name="existing" label={`Are you an existing ${topic === topics[1] ? "wholesaler" : "affiliate"}?`} error={errors.existing} onChange={event => change("existing", event.currentTarget.values?.[0] || "")}>
              {["Yes", "No"].map(option => <s-choice key={option} value={option} selected={values.existing === option}>{option}</s-choice>)}
            </s-choice-list>
            {values.existing === "Yes" && <s-email-field label="Registered email" name="registeredEmail" required value={values.registeredEmail || ""} error={errors.registeredEmail} onInput={event => change("registeredEmail", event.currentTarget.value)} />}
            {values.existing === "No" && <s-paragraph>Want to become {topic === topics[1] ? "a wholesaler" : "an affiliate"}? Share your interest below. We will use the contact information entered above.</s-paragraph>}
            {values.existing && textField("query", "Query", true, "How can we help you?", true)}
          </s-stack>
        </s-section>}

        {(isOrder || isReturn) && <s-section heading={isReturn ? "Returns, exchanges & refunds" : "Order queries"}>
          <s-stack gap="base">
            {textField("orderNumber", "Order number", true, "e.g. #1001")}
            {isReturn ? <>
              {textField("orderDetails", "Order details", true, "Order date and any relevant order information", true)}
              {textField("productDetails", "Product details", true, "Product name, variant and quantity", true)}
              {select("issue", "Issue faced", issues)}
              {textField("details", "Issue details", true, "Share in detail", true)}
              {select("resolution", "What would you like to do?", ["Return", "Exchange", "Refund"])}
            </> : <>
              {select("orderType", "What is your order query?", orderTypes)}
              {values.orderType === orderTypes[0] && <>
                {select("update", "Order update", updates)}
                {values.update && textField("details", values.update === updates[1] ? "Shipping details" : "Product or quantity changes", true, values.update === updates[1] ? "Share the current address and updated address" : "Share the current product / quantity and the changes you would like", true)}
              </>}
              {values.orderType === orderTypes[1] && <>
                {select("issue", "Product issue", issues.slice(0, 3))}
                {textField("details", "Issue details", true, "Share in detail", true)}
              </>}
              {values.orderType === orderTypes[2] && textField("details", "Wrong product ordered", true, "Tell us which product you ordered and which product you intended to order", true)}
            </>}
            {showImages && <div>
              <label htmlFor="help-desk-images">Upload images {imagesRequired(values) ? "(required)" : "(optional)"}</label>
              <p id="help-desk-image-help">Up to 5 JPG, PNG or WebP images, 5 MB each. Files stay in this preview and are not uploaded.</p>
              <input key={fileKey} id="help-desk-images" name="images" type="file" accept="image/jpeg,image/png,image/webp" multiple required={imagesRequired(values)} aria-describedby="help-desk-image-help help-desk-image-error" aria-invalid={Boolean(errors.images)} onChange={event => { setFiles(Array.from((event.currentTarget as HTMLInputElement).files || [])); setChecked(false); setErrors({}); }} />
              <div id="help-desk-image-error">{errors.images && <s-text tone="critical">{errors.images}</s-text>}</div>
              {files.length > 0 && <><ul>{files.map((file, index) => <li key={`${file.name}-${index}`}>{file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</li>)}</ul><s-button type="button" onClick={() => { setFiles([]); setFileKey(previous => previous + 1); setChecked(false); setErrors({}); }}>Clear images</s-button></>}
            </div>}
          </s-stack>
        </s-section>}

        <s-section>
          <s-stack gap="base">
            <div ref={statusRef} tabIndex={-1} role="status">
              {checked && (Object.keys(errors).length ? <s-banner tone="critical" heading="Check the required fields"><ul>{Object.entries(errors).map(([key, error]) => <li key={key}>{String(error)}</li>)}</ul></s-banner> : <s-banner tone="success" heading="Form validation passed">The form is complete. This preview has not saved or sent a request.</s-banner>)}
            </div>
            <s-stack direction="inline" gap="base">
              <s-button type="submit" variant="primary">Check form</s-button>
              <s-button type="button" onClick={() => { setValues({}); setProducts({}); setFiles([]); setErrors({}); setChecked(false); setFileKey(previous => previous + 1); }}>Reset form</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>
    </form>
  </s-page>;
}

