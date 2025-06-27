import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { checkPoolHealth } from "../db.js";
import { setupCaching } from "../cache-middleware.js";
import handlers from "../handlers/index.js";

const fastify = Fastify({
  logger: false,
});

await fastify.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "DELETE"],
});

await fastify.register(rateLimit, {
  max: 1000,
  timeWindow: "1 minute",
});

setupCaching(fastify);

const NETWORK_CONFIG = {
  mainnet: {
    schema: "public",
    apiUrl: "https://api.hiro.so",
    contract: "SP2QEZ06AGJ3RKJPBV14SY1V5BBFNAW33D96YPGZF.BNS-V2",
  },
  testnet: {
    schema: "testnet",
    apiUrl: "https://api.testnet.hiro.so",
    contract: "ST2QEZ06AGJ3RKJPBV14SY1V5BBFNAW33D9SZJQ0M.BNS-V2",
  },
};

function createNetworkHandler(handler) {
  return async (request, reply) => {
    const network = request.url.startsWith("/testnet/") ? "testnet" : "mainnet";
    const { schema, apiUrl } = NETWORK_CONFIG[network];

    try {
      return await handler(request, reply, { schema, network, apiUrl });
    } catch (error) {
      fastify.log.error(error);

      if (error.code === "23505") {
        reply.status(409).send({ error: "Conflict: Resource already exists" });
      } else if (error.code === "42P01") {
        reply.status(500).send({ error: "Database schema error" });
      } else if (error.code === "28P01") {
        reply.status(500).send({ error: "Database authentication error" });
      } else if (error.message && error.message.includes("timeout")) {
        reply.status(504).send({ error: "Request timed out" });
      } else {
        reply.status(500).send({ error: "Internal Server Error" });
      }
    }
  };
}

fastify.get("/health", async (request, reply) => {
  const isMainDbHealthy = await checkPoolHealth();

  if (isMainDbHealthy) {
    return reply.send({
      status: "healthy",
      database: "healthy",
    });
  } else {
    return reply.status(503).send({
      status: "unhealthy",
      database: "unhealthy",
      message: "Database connection issue",
    });
  }
});

function registerRoutes() {
  fastify.get("/names", createNetworkHandler(handlers.getAllNames));
  fastify.get("/names/valid", createNetworkHandler(handlers.getValidNames));
  fastify.get("/names/expired", createNetworkHandler(handlers.getExpiredNames));
  fastify.get("/names/revoked", createNetworkHandler(handlers.getRevokedNames));
  fastify.get(
    "/names/address/:address/valid",
    createNetworkHandler(handlers.getValidNamesByAddress)
  );
  fastify.get(
    "/names/address/:address/expired",
    createNetworkHandler(handlers.getExpiredNamesByAddress)
  );
  fastify.get(
    "/names/address/:address/expiring-soon",
    createNetworkHandler(handlers.getExpiringNamesByAddress)
  );
  fastify.get(
    "/names/address/:address/revoked",
    createNetworkHandler(handlers.getRevokedNamesByAddress)
  );
  fastify.get(
    "/names/:full_name",
    createNetworkHandler(handlers.getNameDetails)
  );
  fastify.get("/namespaces", createNetworkHandler(handlers.getAllNamespaces));
  fastify.get(
    "/names/namespace/:namespace",
    createNetworkHandler(handlers.getNamesByNamespace)
  );
  fastify.get(
    "/resolve-name/:full_name",
    createNetworkHandler(handlers.resolveName)
  );
  fastify.get(
    "/namespaces/:namespace",
    createNetworkHandler(handlers.getNamespace)
  );
  fastify.get(
    "/names/:namespace/:name/can-register",
    createNetworkHandler(handlers.canNameBeRegistered)
  );
  fastify.get("/token/last-id", createNetworkHandler(handlers.getLastTokenId));
  fastify.get(
    "/names/:full_name/renewal",
    createNetworkHandler(handlers.getNameRenewal)
  );
  fastify.get(
    "/names/:full_name/can-resolve",
    createNetworkHandler(handlers.canResolve)
  );
  fastify.get(
    "/names/:full_name/owner",
    createNetworkHandler(handlers.getNameOwner)
  );
  fastify.get(
    "/tokens/:id/owner",
    createNetworkHandler(handlers.getTokenOwner)
  );
  fastify.get("/names/:full_name/id", createNetworkHandler(handlers.getNameId));
  fastify.get("/tokens/:id/name", createNetworkHandler(handlers.getTokenName));
  fastify.get("/tokens/:id/info", createNetworkHandler(handlers.getTokenInfo));
  fastify.get(
    "/namespaces/:namespace/rare-names",
    createNetworkHandler(handlers.getRarestNames)
  );
  fastify.get(
    "/subdomains/:full_name",
    createNetworkHandler(handlers.getSubdomains)
  );
  fastify.get(
    "/btc-address/:full_name",
    createNetworkHandler(handlers.getBtcAddress)
  );
  fastify.get(
    "/subdomain/:full_subdomain",
    createNetworkHandler(handlers.getSingleSubdomain)
  );
  fastify.get(
    "/subdomain/:full_subdomain/owner",
    createNetworkHandler(handlers.getSingleSubdomainOwner)
  );
  fastify.get(
    "/zonefile/:full_name/raw",
    createNetworkHandler(handlers.getRawZonefile)
  );
  fastify.get(
    "/zonefile/:full_name/profile",
    createNetworkHandler(handlers.getProfileZonefile)
  );

  fastify.get("/testnet/names", createNetworkHandler(handlers.getAllNames));
  fastify.get(
    "/testnet/names/valid",
    createNetworkHandler(handlers.getValidNames)
  );
  fastify.get(
    "/testnet/names/expired",
    createNetworkHandler(handlers.getExpiredNames)
  );
  fastify.get(
    "/testnet/names/revoked",
    createNetworkHandler(handlers.getRevokedNames)
  );
  fastify.get(
    "/testnet/names/address/:address/valid",
    createNetworkHandler(handlers.getValidNamesByAddress)
  );
  fastify.get(
    "/testnet/names/address/:address/expired",
    createNetworkHandler(handlers.getExpiredNamesByAddress)
  );
  fastify.get(
    "/testnet/names/address/:address/expiring-soon",
    createNetworkHandler(handlers.getExpiringNamesByAddress)
  );
  fastify.get(
    "/testnet/names/address/:address/revoked",
    createNetworkHandler(handlers.getRevokedNamesByAddress)
  );
  fastify.get(
    "/testnet/names/:full_name",
    createNetworkHandler(handlers.getNameDetails)
  );
  fastify.get(
    "/testnet/namespaces",
    createNetworkHandler(handlers.getAllNamespaces)
  );
  fastify.get(
    "/testnet/names/namespace/:namespace",
    createNetworkHandler(handlers.getNamesByNamespace)
  );
  fastify.get(
    "/testnet/resolve-name/:full_name",
    createNetworkHandler(handlers.resolveName)
  );
  fastify.get(
    "/testnet/namespaces/:namespace",
    createNetworkHandler(handlers.getNamespace)
  );
  fastify.get(
    "/testnet/names/:namespace/:name/can-register",
    createNetworkHandler(handlers.canNameBeRegistered)
  );
  fastify.get(
    "/testnet/token/last-id",
    createNetworkHandler(handlers.getLastTokenId)
  );
  fastify.get(
    "/testnet/names/:full_name/renewal",
    createNetworkHandler(handlers.getNameRenewal)
  );
  fastify.get(
    "/testnet/names/:full_name/can-resolve",
    createNetworkHandler(handlers.canResolve)
  );
  fastify.get(
    "/testnet/names/:full_name/owner",
    createNetworkHandler(handlers.getNameOwner)
  );
  fastify.get(
    "/testnet/tokens/:id/owner",
    createNetworkHandler(handlers.getTokenOwner)
  );
  fastify.get(
    "/testnet/names/:full_name/id",
    createNetworkHandler(handlers.getNameId)
  );
  fastify.get(
    "/testnet/tokens/:id/name",
    createNetworkHandler(handlers.getTokenName)
  );
  fastify.get(
    "/testnet/tokens/:id/info",
    createNetworkHandler(handlers.getTokenInfo)
  );
  fastify.get(
    "/testnet/namespaces/:namespace/rare-names",
    createNetworkHandler(handlers.getRarestNames)
  );
  fastify.get(
    "/testnet/subdomains/:full_name",
    createNetworkHandler(handlers.getSubdomains)
  );
  fastify.get(
    "/testnet/btc-address/:full_name",
    createNetworkHandler(handlers.getBtcAddress)
  );
  fastify.get(
    "/testnet/subdomain/:full_subdomain",
    createNetworkHandler(handlers.getSingleSubdomain)
  );
  fastify.get(
    "/testnet/subdomain/:full_subdomain/owner",
    createNetworkHandler(handlers.getSingleSubdomainOwner)
  );
  fastify.get(
    "/testnet/zonefile/:full_name/raw",
    createNetworkHandler(handlers.getRawZonefile)
  );
  fastify.get(
    "/testnet/zonefile/:full_name/profile",
    createNetworkHandler(handlers.getProfileZonefile)
  );
}

registerRoutes();

export default async function handler(req, res) {
  await fastify.ready();
  fastify.server.emit("request", req, res);
}
