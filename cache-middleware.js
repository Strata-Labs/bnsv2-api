import cache from "./cache.js";

export function addCacheHeaders(maxAge = 60) {
  return (request, reply, done) => {
    reply.header("Cache-Control", `public, max-age=${maxAge}`);
    done();
  };
}

export function etagCaching() {
  return (request, reply, done) => {
    const cacheKey = `etag_${request.url}_${JSON.stringify(request.query)}`;

    const cachedETag = cache.get(cacheKey);

    if (cachedETag && request.headers["if-none-match"] === cachedETag) {
      reply.code(304).send();
      return;
    }

    const originalSend = reply.send;

    reply.send = function (payload) {
      const etag = `W/"${Date.now().toString(36)}"`;

      cache.set(cacheKey, etag, 300);

      reply.header("ETag", etag);

      return originalSend.call(this, payload);
    };

    done();
  };
}

export function setupCaching(fastify) {
  const staticRoutes = ["/namespaces", "/namespaces/:namespace"];

  const dynamicRoutes = [
    "/names",
    "/names/valid",
    "/names/expired",
    "/names/revoked",
    "/names/namespace/:namespace",
  ];

  for (const route of staticRoutes) {
    fastify.addHook("onRequest", addCacheHeaders(1800));
  }

  for (const route of dynamicRoutes) {
    fastify.addHook("onRequest", addCacheHeaders(60));
  }

  fastify.addHook("onRequest", etagCaching());
}
