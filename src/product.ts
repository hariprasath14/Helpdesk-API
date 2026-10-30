/**
 * The product's name: the one place to change it in the API. System emails (their subject, text
 * and header), the sender name, the authenticator app's account label, the audit log's "system"
 * actor and the reserved workspace addresses all read it from here. The web app has the same
 * constant in its src/product.ts; change both (docs/BRANDING.md has the steps).
 */
export const PRODUCT_NAME = 'Helpdesk';
