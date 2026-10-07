// Shapes copied from the KLIPY API docs (docs.klipy.com/gifs-api/gifs-search-api.md).
const base = 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af';

export const klipyHelloGif = {
  id: 8041071659142944,
  slug: 'hello-hi-662',
  title: 'Hello',
  file: {
    hd: {
      gif: { url: `${base}/um0L4dFH.gif`, width: 498, height: 498, size: 4001918 },
      mp4: { url: `${base}/MCCBoQlZ.mp4`, size: 119294 },
    },
    sm: {
      webp: { url: `${base}/SE72470w.webp`, width: 220, height: 220, size: 80118 },
      jpg: { url: `${base}/uvntdY4w.jpg`, size: 8560 },
    },
  },
  tags: [],
  type: 'gif',
  blur_preview: 'data:image/jpeg;base64,AAAA',
};

export const klipyPage = (items: unknown[], page = 1, hasNext = true) => ({
  result: true,
  data: { data: items, current_page: page, per_page: 24, has_next: hasNext },
});
