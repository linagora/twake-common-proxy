export type GifSize = 'xs' | 'sm' | 'md' | 'hd';
export type GifFormat = 'gif' | 'webp' | 'jpg' | 'mp4' | 'webm';

export interface GifMedia {
  size: GifSize;
  format: GifFormat;
  mime: string;
  url: string;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface Gif {
  id: string;
  title: string;
  blurPreview?: string;
  media: GifMedia[];
}

export interface GifPage {
  next: string | null;
  results: Gif[];
}

export interface Attribution {
  name: string;
  url: string;
  searchPlaceholder?: string;
}

export interface Locale {
  language: string;
  region?: string;
}

export interface PageRequest {
  limit?: number;
  cursor?: string;
  locale?: Locale;
}

export interface GifProvider {
  name: string;
  attribution: Attribution;
  mediaHosts: readonly string[];
  search(query: string, page: PageRequest): Promise<GifPage>;
  trending(page: PageRequest): Promise<GifPage>;
  categories(locale?: Locale): Promise<Category[]>;
  autocomplete(query: string, limit?: number): Promise<string[]>;
}

export interface Category {
  name: string;
  query: string;
}
