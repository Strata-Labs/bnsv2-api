import nameHandlers from "./name-handlers.js";
import namespaceHandlers from "./namespace-handlers.js";
import tokenHandlers from "./token-handlers.js";
import subdomainHandlers from "./subdomain-handlers.js";

export default {
  ...nameHandlers,
  ...namespaceHandlers,
  ...tokenHandlers,
  ...subdomainHandlers,
};
