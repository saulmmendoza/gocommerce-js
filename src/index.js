import API from "micro-api-client";
import { calculatePrices } from "./calculator";
import { checkClaims } from "./claims";

const HTTPRegexp = /^http:\/\//;
const cartKey = "gocommerce.shopping-cart";
const vatnumbers = {};

function getPrice(prices, currency, user) {
  return prices
    .filter(price => currency == (price.currency || "USD").toUpperCase())
    .filter(price => (price.claims ? checkClaims(user && user.claims && user.claims(), price.claims) : true))
    .map(price => {
      price.cents = price.cents || parseInt(parseFloat(price.amount) * 100);
      return price;
    })
    .sort((a, b) => a.cents - b.cents)[0];
}

function priceObject(cents, currency) {
  return { cents, amount: centsToAmount(cents), currency };
}

function addPrices(...prices) {
  const result = {
    cents: 0,
  };
  prices.forEach(price => {
    if (price) {
      if (!price.hasOwnProperty("cents")) {
        price.cents = parseInt(parseFloat(price.amount) * 100);
      }
      result.cents += price.cents;
      result.currency = price.currency;
    }
  });
  result.amount = centsToAmount(result.cents);
  return result;
}

function centsToAmount(cents) {
  return `${(Math.round(cents) / 100).toFixed(2)}`;
}

function pathWithQuery(path, params, { negatedParams } = {}) {
  const query = [];
  if (params) {
    for (const key in params) {
      query.push(`${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`);
    }
  }
  if (negatedParams) {
    for (const key in negatedParams) {
      query.push(`${encodeURIComponent(key)}!=${encodeURIComponent(negatedParams[key])}`);
    }
  }
  return query.length > 0 ? `${path}?${query.join("&")}` : path;
}

function cleanPath(path) {
  return path.replace(/^https?:\/\/[^\/]+/, "");
}

/**
 * GoCommerce API client for JavaScript.
 * See README.md for Quick Start and Examples of different flows that it covers for e-commerce.
 *
 * @example
 * // Quick Start
 * import GoCommerce from "gocommerce-js";
 *
 * const commerce = new GoCommerce({
 *   APIUrl: "https://commerce.netlify.com"
 * });
 *
 * // E-commerce Flow: Adding to Cart
 * commerce.addToCart({
 *   path: "/products/book-1/",
 *   quantity: 2,
 *   meta: {
 *     photo: "/images/mugs/netlig-01.png"
 *   }
 * }).then((lineItem) => console.log(lineItem));
 *
 * @example
 * // E-commerce Flow: Checkout
 * commerce.order({
 *   email: "user@example.com",
 *   shipping_address: {
 *     name: "John Doe",
 *     address1: "123 Main St",
 *     city: "Anytown",
 *     state: "CA",
 *     country: "USA",
 *     zip: "12345"
 *   }
 * }).then(({cart, order}) => {
 *   return commerce.payment({
 *     "provider": "stripe",
 *     "stripe_token": "tok_visa",
 *     "amount": cart.total.cents,
 *     "order_id": order.id,
 *   });
 * }).then((transaction) => {
 *   console.log("Order confirmed!");
 * });
 */
export default class GoCommerce {
  /**
   * Instantiate a new GoCommerce client
   * @param {Object} options Configuration options
   * @param {string} options.APIUrl URL to the GoCommerce instance
   */
  constructor(options) {
    if (!options.APIUrl) {
      throw "You must specify an APIUrl of your GoCommerce instance";
    }
    if (options.APIUrl.match(HTTPRegexp)) {
      console.log(
        "Warning:\n\nDO NOT USE HTTP IN PRODUCTION FOR GOCOMMERCE EVER!GOCOMMERCE REQUIRES HTTPS to work securely."
      );
    }
    this.cartKey = options.cartKey || cartKey;

    this.api = new API(options.APIUrl);
    this.currency = options.currency || "USD";
    this.billing_country = options.country;
    this.settings_path = "/gocommerce/settings.json";
    this.settings_refresh_period = options.settingsRefreshPeriod || 10 * 60 * 1000;
    this.loadCart();
  }

  setUser(user) {
    this.user = user;
  }

  addToCart(item) {
    const { quantity, meta } = item;
    const path = cleanPath(item.path);
    if (quantity && path) {
      return fetch(path).then(response => {
        if (!response.ok) {
          return Promise.reject(`Failed to fetch ${path}`);
        }

        return response.text().then(html => {
          const doc = document.implementation.createHTMLDocument("product");
          doc.documentElement.innerHTML = html;
          const products = Array.from(doc.getElementsByClassName("gocommerce-product")).map(el =>
            JSON.parse(el.innerHTML)
          );

          if (products.length === 0) {
            return Promise.reject("No .gocommerce-product found in product path");
          }

          const sku = products.length === 1 ? item.sku || products[0].sku : item.sku;

          const product = products.find(prod => prod.sku === sku);
          if (!product) {
            return Promise.reject(`No .gocommerce-product matching sku=${sku} found in product path`);
          }

          const { title, prices, description, type, vat } = product;
          if (sku && title && prices) {
            if (this.line_items[sku]) {
              this.line_items[sku].quantity += quantity;
              if (meta) {
                this.line_items[sku].meta = Object.assign({}, this.line_items[sku].meta, meta);
              }
            } else {
              this.line_items[sku] = Object.assign(product, { path, meta, quantity });
            }
            if (item.addons && product.addons) {
              this.line_items[sku].addons = product.addons.filter(addon => item.addons.indexOf(addon.sku) !== -1);
              this.line_items[sku].addonPrice = addPrices(...this.line_items[sku].addons.map(addon => addon.price));
            } else {
              delete this.line_items[sku].addons;
            }
            return this.loadSettings().then(() => {
              this.persistCart();
              return this.getCart();
            });
          } else {
            return Promise.reject("Failed to read sku, title and price from product path: %o", { sku, title, prices });
          }
        });
      });
    } else {
      return Promise.reject("Invalid item - must have path and quantity");
    }
  }

  getCartItem(item_data) {
    const item = Object.assign({}, item_data, {
      price: getPrice(item_data.prices, this.currency, this.user),
    });
    (item.price.items || []).forEach(priceItem => {
      priceItem.cents = (parseFloat(priceItem.amount) * 100).toFixed(0);
    });
    if (item_data.addons) {
      item.addons = [];
      item_data.addons.forEach(addon => {
        item.addons.push(
          Object.assign({}, addon, {
            price: getPrice(addon.prices, this.currency, this.user),
          })
        );
      });
    }
    if (item.addons) {
      item.addonPrice = priceObject(
        item.addons.reduce((sum, addon) => sum + parseFloat(addon.price.amount) * 100, 0),
        this.currency
      );
    }
    return item;
  }

  calculatePrice(item_data, claims) {
    const item = this.getCartItem(item_data);
    claims = claims || (this.user && this.user.claims && this.user.claims());
    return calculatePrices(this.settings, claims, this.billing_country, this.currency, this.coupon, [item]);
  }

  /**
   * Get the current cart state
   * @returns {Object} The cart object containing items, subtotal, taxes, and total
   */
  getCart() {
    const cart = { items: {} };
    const items = [];
    for (const key in this.line_items) {
      const item = (cart.items[key] = this.getCartItem(this.line_items[key]));
      items.push(item);
    }

    const claims = this.user && this.user.claims && this.user.claims();
    const price = calculatePrices(this.settings, claims, this.billing_country, this.currency, this.coupon, items);

    cart.subtotal = priceObject(price.subtotal, this.currency);
    cart.discount = priceObject(price.discount, this.currency);
    cart.couponDiscount = priceObject(price.couponDiscount, this.currency);
    cart.memberDiscount = priceObject(price.memberDiscount, this.currency);
    cart.netTotal = priceObject(price.netTotal, this.currency);
    cart.taxes = priceObject(price.taxes, this.currency);
    cart.total = priceObject(price.total, this.currency);

    price.items.forEach((priceItem, key) => {
      const item = items[key];
      if (!item) {
        return;
      }
      cart.items[item.sku] = {
        ...item,
        calculation: priceItem,
      };
    });

    return cart;
  }

  /**
   * Set the currency
   * @param {string} currency The currency code (e.g., 'USD')
   * @returns {Promise<Object>} The updated cart
   */
  setCurrency(currency) {
    this.currency = currency;
    return Promise.resolve(this.getCart());
  }

  /**
   * Set the billing country
   * @param {string} country The country code
   * @returns {Promise<Object>} The updated cart
   */
  setCountry(country) {
    this.billing_country = country;
    return Promise.resolve(this.getCart());
  }

  /**
   * Set the VAT number
   * @param {string} vatnumber The VAT number
   * @returns {Promise<Object>} The updated cart
   */
  setVatnumber(vatnumber) {
    this.vatnumber = vatnumber;
    return this.verifyVatnumber(vatnumber).then(() => this.getCart());
  }

  /**
   * Set the coupon code
   * @param {string} code The coupon code
   * @returns {Promise<Object|null>} The coupon object if valid, else null
   */
  setCoupon(code) {
    if (code == null) {
      this.coupon = null;
      return Promise.resolve(null);
    }
    return this.verifyCoupon(code).then(coupon => {
      this.coupon = coupon;
      return coupon;
    });
  }

  /**
   * Update the quantity of an item in the cart
   * @param {string} sku The SKU of the item to update
   * @param {number} quantity The new quantity (set to 0 to remove)
   */
  updateCart(sku, quantity) {
    if (this.line_items[sku]) {
      if (quantity > 0) {
        this.line_items[sku].quantity = quantity;
      } else {
        delete this.line_items[sku];
      }
      this.persistCart();
    } else {
      throw `Item ${sku} not found in cart`;
    }
  }

  /**
   * Clear the cart
   */
  clearCart() {
    this.line_items = {};
    this.persistCart();
  }

  /**
   * Place an order
   * @param {Object} orderDetails Order details
   * @param {string} orderDetails.email The customer's email
   * @param {Object} [orderDetails.shipping_address] Shipping address
   * @param {string} [orderDetails.shipping_address_id] Shipping address ID
   * @param {Object} [orderDetails.billing_address] Billing address
   * @param {string} [orderDetails.billing_address_id] Billing address ID
   * @param {Object} [orderDetails.data] Additional data
   * @returns {Promise<Object>} A promise that resolves with cart and order objects
   */
  order(orderDetails) {
    const { email, shipping_address, shipping_address_id, billing_address, billing_address_id, data } = orderDetails;

    if (email && (shipping_address || shipping_address_id)) {
      const line_items = [];
      for (const id in this.line_items) {
        line_items.push(this.line_items[id]);
      }

      return this.authHeaders()
        .then(headers =>
          this.api.request("/orders", {
            method: "POST",
            headers: headers,
            body: JSON.stringify({
              email,
              shipping_address,
              shipping_address_id,
              billing_address,
              billing_address_id,
              vatnumber: this.vatnumber_valid ? this.vatnumber : null,
              currency: this.currency,
              coupon: this.coupon ? this.coupon.code : null,
              data,
              line_items,
            }),
          })
        )
        .then(order => {
          const cart = this.getCart();
          return { cart, order };
        });
    } else {
      return Promise.reject(
        "Invalid orderDetails - must have an email and either a shipping_address or shipping_address_id"
      );
    }
  }

  /**
   * Process a payment for an order
   * @param {Object} paymentDetails Payment details
   * @param {string} paymentDetails.order_id The order ID
   * @param {number} paymentDetails.amount The amount in cents
   * @param {string} paymentDetails.provider The payment provider (e.g., 'stripe')
   * @param {string} [paymentDetails.stripe_token] Stripe token
   * @param {string} [paymentDetails.stripe_payment_method_id] Stripe payment method ID
   * @param {string} [paymentDetails.paypal_payment_id] PayPal payment ID
   * @param {string} [paymentDetails.paypal_user_id] PayPal user ID
   * @returns {Promise<Object>} Transaction response
   */
  payment(paymentDetails) {
    const {
      order_id,
      amount,
      provider,
      stripe_token,
      stripe_payment_method_id,
      paypal_payment_id,
      paypal_user_id,
    } = paymentDetails;
    if (
      order_id &&
      amount != null &&
      provider &&
      (stripe_token || stripe_payment_method_id || (paypal_payment_id && paypal_user_id))
    ) {
      const cart = this.getCart();
      return this.authHeaders().then(headers =>
        this.api.request(`/orders/${order_id}/payments`, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            amount,
            order_id,
            provider,
            stripe_token,
            stripe_payment_method_id,
            paypal_payment_id,
            paypal_user_id,
            currency: this.currency,
          }),
        })
      );
    } else {
      return Promise.reject(
        "Invalid paymentDetails - must have an order_id, an amount, a provider, and a stripe_token or a paypal_payment_id and paypal_user_id"
      );
    }
  }

  /**
   * Confirm a payment
   * @param {string} paymentId The payment ID
   * @returns {Promise<Object>} Confirmation response
   */
  paymentConfirm(paymentId) {
    return this.authHeaders().then(headers =>
      this.api.request(`/payments/${paymentId}/confirm`, {
        method: "POST",
        headers,
      })
    );
  }

  /**
   * Resend order confirmation receipt
   * @param {string} orderID The order ID
   * @param {string} email The email to resend to
   * @returns {Promise<Object>} API response
   */
  resendConfirmation(orderID, email) {
    const path = `/orders/${orderID}/receipt`;
    return this.authHeaders().then(headers =>
      this.api.request(path, {
        headers,
        method: "POST",
        body: JSON.stringify({ email }),
      })
    );
  }

  /**
   * Claim orders for the logged-in user
   * @returns {Promise<Object|null>} API response or null if no user
   */
  claimOrders() {
    if (this.user) {
      return this.authHeaders().then(headers =>
        this.api.request("/claim", {
          headers,
          method: "POST",
        })
      );
    }
    return Promise.resolve(null);
  }

  /**
   * Update an order
   * @param {string} orderId The order ID
   * @param {Object} attributes Attributes to update
   * @returns {Promise<Object>} Updated order
   */
  updateOrder(orderId, attributes) {
    return this.authHeaders(true).then(headers =>
      this.api.request(`/orders/${orderId}`, {
        headers,
        method: "PUT",
        body: JSON.stringify(attributes),
      })
    );
  }

  /**
   * Get order history
   * @param {Object} params Query parameters
   * @param {Object} options Options like negatedParams
   * @returns {Promise<Object>} Orders and pagination data
   */
  orderHistory(params, { negatedParams } = {}) {
    let path = "/orders";
    if (params && params.user_id) {
      path = `/users/${params.user_id}/orders`;
      delete params.user_id;
    }
    path = pathWithQuery(path, params, { negatedParams });
    return this.authHeaders(true)
      .then(headers =>
        this.api.request(path, {
          headers,
        })
      )
      .then(({ items, pagination }) => ({ orders: items, pagination }));
  }

  /**
   * Get order details
   * @param {string} orderID The order ID
   * @returns {Promise<Object>} Order details
   */
  orderDetails(orderID) {
    return this.authHeaders().then(headers =>
      this.api.request(`/orders/${orderID}`, {
        headers,
      })
    );
  }

  /**
   * Get order receipt
   * @param {string} orderID The order ID
   * @param {string} [template] Receipt template name
   * @returns {Promise<Object>} Receipt response
   */
  orderReceipt(orderID, template) {
    let path = `/orders/${orderID}/receipt`;
    if (template) {
      path += `?template=${template}`;
    }
    return this.authHeaders(true).then(headers =>
      this.api.request(path, {
        headers,
      })
    );
  }

  /**
   * Get user details
   * @param {string} [userId] The user ID (defaults to current user)
   * @returns {Promise<Object>} User details
   */
  userDetails(userId) {
    userId = userId || (this.user && this.user.id);

    return this.authHeaders(true).then(headers =>
      this.api.request(`/users/${userId}`, {
        headers,
      })
    );
  }

  /**
   * Get downloads
   * @param {Object} params Query parameters
   * @returns {Promise<Object>} Downloads and pagination data
   */
  downloads(params) {
    let path = "/downloads";
    if (params && params.order_id) {
      path = `/orders/${params.order_id}/downloads`;
      delete params.order_id;
    }
    path = pathWithQuery(path, params);
    return this.authHeaders()
      .then(headers =>
        this.api.request(path, {
          headers,
        })
      )
      .then(({ items, pagination }) => ({ downloads: items, pagination }));
  }

  /**
   * Get download URL
   * @param {string} downloadId The download ID
   * @returns {Promise<string>} The download URL
   */
  downloadURL(downloadId) {
    const path = `/downloads/${downloadId}`;
    return this.authHeaders()
      .then(headers =>
        this.api.request(path, {
          headers,
        })
      )
      .then(response => response.url);
  }

  /**
   * Delete users
   * @param {Array<string>} userIds Array of user IDs to delete
   * @returns {Promise<Object>} API response
   */
  deleteUsers(userIds) {
    const path = "/users" + (userIds.length > 0 ? "?" + userIds.map(id => `id=${id}`).join("&") : "");
    return this.authHeaders(true).then(headers =>
      this.api.request(path, {
        method: "DELETE",
        headers,
      })
    );
  }

  /**
   * Get users
   * @param {Object} params Query parameters
   * @returns {Promise<Object>} Users and pagination data
   */
  users(params) {
    const path = pathWithQuery("/users", params);
    return this.authHeaders(true)
      .then(headers =>
        this.api.request(path, {
          headers,
        })
      )
      .then(({ items, pagination }) => ({ users: items, pagination }));
  }

  /**
   * Get report
   * @param {string} name Report name
   * @param {Object} params Query parameters
   * @returns {Promise<Object>} Report data
   */
  report(name, params) {
    const path = pathWithQuery(`/reports/${name}`, params);
    return this.authHeaders(true).then(headers =>
      this.api.request(path, {
        headers,
      })
    );
  }

  /**
   * Get authentication headers
   * @param {boolean} required Whether authentication is required
   * @returns {Promise<Object>} The authentication headers
   */
  authHeaders(required) {
    if (this.user) {
      return this.user.jwt().then(token => ({ Authorization: `Bearer ${token}` }));
    }
    return required ? Promise.reject("The API action requires authentication") : Promise.resolve({});
  }

  /**
   * Load the cart from local storage
   */
  loadCart() {
    const json = localStorage.getItem(this.cartKey);
    if (json) {
      const cart = JSON.parse(json);
      this.settings = cart.settings;
      this.line_items = cart.line_items || {};
    } else {
      this.settings = null;
      this.line_items = {};
    }
  }

  /**
   * Load settings from the server
   * @returns {Promise}
   */
  loadSettings() {
    if (this.settingsAreFresh()) {
      return Promise.resolve();
    }

    return fetch(this.settings_path).then(response => {
      if (!response.ok) {
        return;
      }

      return response.json().then(json => {
        this.settings = Object.assign(json, { ts: new Date().getTime() });
      });
    });
  }

  /**
   * Check if settings are fresh
   * @returns {boolean}
   */
  settingsAreFresh() {
    if (this.settings_path == null) {
      return true;
    }

    if (this.settings) {
      const diff = new Date().getTime() - this.settings.ts;
      return diff < this.settings_refresh_period;
    }

    return false;
  }

  /**
   * Verify a VAT number
   * @param {string} vatnumber The VAT number to verify
   * @returns {Promise<boolean>}
   */
  verifyVatnumber(vatnumber) {
    this.vatnumber_valid = false;
    if (!vatnumber) {
      this.vatnumber_valid = false;
      return Promise.resolve(false);
    }
    if (vatnumbers[vatnumber]) {
      this.vatnumber_valid = vatnumbers[vatnumber].valid;
      return Promise.resolve(false);
    }

    return this.api.request(`/vatnumbers/${vatnumber}`).then(response => {
      vatnumbers[vatnumber] = response;
      this.vatnumber_valid = response.valid;
      return response.valid;
    });
  }

  /**
   * Verify a coupon code
   * @param {string} code The coupon code
   * @returns {Promise<Object>}
   */
  verifyCoupon(code) {
    return this.authHeaders(false).then(headers =>
      this.api.request(`/coupons/${code}`, {
        headers,
      })
    );
  }

  /**
   * Persist the cart to local storage
   */
  persistCart() {
    const json = JSON.stringify({ line_items: this.line_items, settings: this.settings });
    localStorage.setItem(this.cartKey, json);
  }
}

if (typeof window !== "undefined") {
  window.GoCommerce = GoCommerce;
}
