# Sanctioned-API fixture payloads

Saved vendor payloads for the sanctioned API adapter, in the shape the vendor's
own documentation publishes: a single-product call answers with the product
document, and a search answers with `{ "products": [ ... ] }`.

These are the whole of what the SOURCE-3 suite is graded against. Nothing in
this repository makes a live request to that vendor - not a test, not CI, not a
development session - so a payload only exists here if somebody wrote it from
the vendor's published documentation.

Two invariants hold over every file here, and both are checked by the suite
rather than trusted:

- **No real credential.** `fixture-api-key-do-not-use` is a stand-in. It is
  deliberately present inside `product-on-sale.json`'s `canonicalUrl` and
  `error-403.json`'s `requestedUrl`, because this vendor echoes the request URL
  back inside its own responses, and the adapter's redaction has to be graded
  against a payload that actually carries one.
- **No personal content.** No review body, no reviewer name, no account
  identifier, in line with the fixture invariant the extractor's fixtures
  already hold. The adapter narrows its request with the vendor's own `show=`
  projection so a real response cannot carry any either.

| file | what it is for |
|---|---|
| `product-on-sale.json` | the happy path: both price fields, a vendor price-update instant, and a credential echoed back inside `canonicalUrl` |
| `product-not-on-sale.json` | sale price equal to regular price, so the derived `onSale` is false |
| `product-no-price-update-date.json` | the vendor publishes no price-update instant |
| `product-unreadable-price-update-date.json` | the field is present but is not a timestamp |
| `product-inexact-price.json` | a price with more fractional digits than USD's minor unit can represent exactly |
| `product-no-sale-price.json` | no `salePrice` |
| `product-no-regular-price.json` | no `regularPrice`, so `onSale` cannot be derived |
| `product-price-not-a-number.json` | a price that is prose |
| `product-wrong-sku.json` | a document about another listing entirely |
| `products-two-results.json` | a search answering with two products where one listing was asked about |
| `products-one-result.json` | the same envelope, resolving to one product |
| `product-whole-number-price.json` | a price with no decimal point, for the zero-exponent currency case |
| `error-403.json` | the body beside the status the vendor documents as an exceeded limit |
