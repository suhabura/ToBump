import { supabase } from '@/lib/supabase';

export type ShopProduct = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  image_url: string | null;
  category: string;
  stock: number | null;
  is_active: boolean;
  sort_order: number;
};

/** Fallback catalog if shop SQL has not been run yet */
export const FALLBACK_PRODUCTS: ShopProduct[] = [
  {
    id: 'local-tee',
    name: 'ToBump Tee',
    description: 'Soft cotton tee with the ToBump mark. Unisex fit.',
    price: 24,
    currency: 'EUR',
    image_url: null,
    category: 'apparel',
    stock: 50,
    is_active: true,
    sort_order: 1,
  },
  {
    id: 'local-hoodie',
    name: 'ToBump Hoodie',
    description: 'Midweight hoodie for cool evenings after the match.',
    price: 49,
    currency: 'EUR',
    image_url: null,
    category: 'apparel',
    stock: 30,
    is_active: true,
    sort_order: 2,
  },
  {
    id: 'local-cap',
    name: 'ToBump Cap',
    description: 'Adjustable cap with embroidered logo.',
    price: 19,
    currency: 'EUR',
    image_url: null,
    category: 'accessories',
    stock: 40,
    is_active: true,
    sort_order: 3,
  },
  {
    id: 'local-bottle',
    name: 'ToBump Bottle',
    description: '750 ml stainless bottle — stay hydrated between events.',
    price: 22,
    currency: 'EUR',
    image_url: null,
    category: 'gear',
    stock: 60,
    is_active: true,
    sort_order: 4,
  },
  {
    id: 'local-tote',
    name: 'ToBump Tote',
    description: 'Canvas tote for kit, snacks, and plans.',
    price: 16,
    currency: 'EUR',
    image_url: null,
    category: 'accessories',
    stock: 80,
    is_active: true,
    sort_order: 5,
  },
];

export async function fetchShopProducts(): Promise<ShopProduct[]> {
  const { data, error } = await supabase
    .from('shop_products')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error || !data?.length) return FALLBACK_PRODUCTS;
  return (data as ShopProduct[]).map((p) => ({
    ...p,
    price: Number(p.price),
  }));
}

export async function fetchShopProduct(id: string): Promise<ShopProduct | null> {
  if (id.startsWith('local-')) {
    return FALLBACK_PRODUCTS.find((p) => p.id === id) ?? null;
  }
  const { data, error } = await supabase.from('shop_products').select('*').eq('id', id).maybeSingle();
  if (error || !data) {
    return FALLBACK_PRODUCTS.find((p) => p.id === id) ?? null;
  }
  return { ...(data as ShopProduct), price: Number((data as ShopProduct).price) };
}

export async function requestShopOrder(opts: {
  userId: string;
  productId: string;
  quantity?: number;
  size?: string | null;
  note?: string | null;
}): Promise<{ error?: string }> {
  if (opts.productId.startsWith('local-')) {
    return { error: 'Run supabase/shop.sql to enable order requests.' };
  }
  const { error } = await supabase.from('shop_orders').insert({
    user_id: opts.userId,
    product_id: opts.productId,
    quantity: opts.quantity ?? 1,
    size: opts.size?.trim() || null,
    note: opts.note?.trim() || null,
  });
  return { error: error?.message };
}

export function formatShopPrice(price: number, currency = 'EUR'): string {
  if (currency === 'EUR') return `${price.toFixed(2)} €`;
  return `${price.toFixed(2)} ${currency}`;
}
