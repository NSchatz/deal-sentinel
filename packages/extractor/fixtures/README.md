# Extractor fixtures

Committed files, not markup built inside a test. A recaptured page is then a
diff a human can read, and malformed markup is a test case rather than an
incident.

**The invariant, repo-wide.** A fixture is reduced to the offer markup under
test. No review body, no reviewer name and no account identifier is ever
committed here. Retail pages carry customer reviews with display names, and
"save a new fixture" is the documented repair loop, so this is the one way real
people's data could reach this repo. Every fixture below is synthetic markup
written for this suite; when a real page is captured later, it is reduced to the
same shape before it lands.

| fixture | what it proves |
|---|---|
| `single-offer-clean.html` | one offer, USD, resolves to 12999 minor units |
| `single-offer-jpy.html` | JPY has an ISO 4217 exponent of 0, so 12800 yen is 12800 minor units; a fixed multiply-by-100 fails here and only here |
| `single-offer-kwd.html` | KWD has an exponent of 3, so 12.995 dinars is 12995 fils |
| `offer-without-price.html` | an offer with no price at all: `no-price` |
| `price-not-a-number.html` | `"Call for price"` in the price field: `no-price` |
| `price-without-currency.html` | a price with no `priceCurrency`: `no-currency` |
| `currency-not-iso-4217.html` | `priceCurrency` of `"$"`: `no-currency` |
| `unrecognised-availability-token.html` | an availability token outside the twelve documented members, stored as received |
| `offer-without-availability.html` | no availability field at all, which is not the same as an unrecognised one |
| `no-offer-markup.html` | no offer markup, plus a malformed JSON-LD block: `no-offer` |
| `two-variant-offers.html` | two offers on one page: `ambiguous-offer` |
| `aggregate-offer-range.html` | an AggregateOffer whose ends differ: `ambiguous-offer` |
| `negative-price.html` | a price below zero, which no new-retail offer has: `no-price` |
| `microdata-single-offer.html` | the microdata reader, GBP |
| `microdata-two-offers.html` | two microdata offers at two prices: `ambiguous-offer`, the same answer its JSON-LD twin gets |
| `microdata-price-outside-offer.html` | an unrelated priced item above the offer, which must not supply this offer's price |
| `microdata-aggregate-offer-range.html` | a microdata AggregateOffer whose ends differ: `ambiguous-offer` |
| `microdata-two-prices-one-offer.html` | one offer element stating a struck-out price and a sale price: `ambiguous-offer` |
| `microdata-price-stated-twice.html` | one offer element stating one price twice, machine-readable and visible: one price, 12999 |

**Both dialects, on purpose.** The extractor reads JSON-LD and microdata, and a
markup dialect must never change the verdict on the same page: a multi-offer
page answers `ambiguous-offer` in either. The microdata rows above exist because
a reader that scans a whole document for `itemprop` values instead of scoping
them to their enclosing offer element gets both the multi-offer case and the
adjacent-item case wrong in the silent direction.
