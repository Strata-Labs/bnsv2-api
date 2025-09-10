import nameHandlers from "./name-handlers.js";
import namespaceHandlers from "./namespace-handlers.js";
import subdomainHandlers from "./subdomain-handlers.js";
import tokenHandlers from "./token-handlers.js";
import zonefileHandlers from "./zonefile-handlers.js";

export default {
  ...nameHandlers,
  ...namespaceHandlers,
  ...tokenHandlers,
  ...subdomainHandlers,
  ...zonefileHandlers,
};
