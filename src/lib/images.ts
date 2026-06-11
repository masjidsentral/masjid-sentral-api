// Cloudflare Images URL construction — builds delivery URLs from stored image path and variant name.

export function buildImageUrl(
  deliveryUrl: string,
  imagePath: string,
  variant: 'thumbnail' | 'public'
): string {
  // Strip trailing slash defensively — IMAGES_DELIVERY_URL may or may not include it
  const base = deliveryUrl.replace(/\/$/, '')
  return `${base}/${imagePath}/${variant}`
}
