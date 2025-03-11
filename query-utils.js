import { getPool } from "./db.js";
import { getCurrentBurnBlockHeight } from "./burnblock-service.js";
import cache from "./cache.js";

const CACHE_TTL = {
  NAMESPACE_INFO: 3600,
  NAME_INFO: 300,
  NAME_EXISTS: 600,
};

export async function getNameInfo(nameString, namespaceString, network) {
  const cacheKey = `name_info_${network}_${nameString}.${namespaceString}`;

  const cachedData = cache.get(cacheKey);
  if (cachedData) return cachedData;

  const pool = getPool(network);
  const schema = network === "testnet" ? "testnet" : "public";

  const result = await pool.query(
    `SELECT 
      name_string,
      namespace_string,
      owner,
      registered_at,
      renewal_height,
      stx_burn,
      revoked,
      imported_at
     FROM ${schema}.names 
     WHERE name_string = $1 AND namespace_string = $2`,
    [nameString, namespaceString]
  );

  const nameInfo = result.rows.length > 0 ? result.rows[0] : null;

  if (nameInfo) {
    cache.set(cacheKey, nameInfo, CACHE_TTL.NAME_INFO);
  }

  return nameInfo;
}

export async function isNameValid(nameInfo, network) {
  if (!nameInfo || nameInfo.revoked) {
    return false;
  }

  if (nameInfo.renewal_height === 0) {
    return true;
  }

  const currentBurnBlock = await getCurrentBurnBlockHeight(network);
  return nameInfo.renewal_height > currentBurnBlock;
}

export async function getNamespaceInfo(namespaceString, network) {
  const cacheKey = `namespace_info_${network}_${namespaceString}`;

  const cachedData = cache.get(cacheKey);
  if (cachedData) return cachedData;

  const pool = getPool(network);
  const schema = network === "testnet" ? "testnet" : "public";

  const result = await pool.query(
    `SELECT 
      namespace_string,
      launched_at,
      lifetime,
      namespace_manager,
      price_function_base,
      price_function_coeff,
      price_function_buckets,
      price_function_no_vowel_discount,
      price_function_nonalpha_discount,
      manager_transferable,
      can_update_price_function
     FROM ${schema}.namespaces 
     WHERE namespace_string = $1`,
    [namespaceString]
  );

  const namespaceInfo = result.rows.length > 0 ? result.rows[0] : null;

  if (namespaceInfo) {
    cache.set(cacheKey, namespaceInfo, CACHE_TTL.NAMESPACE_INFO);
  }

  return namespaceInfo;
}

export async function getNameStatus(nameInfo, network) {
  if (!nameInfo) {
    return "not_found";
  }

  if (nameInfo.revoked) {
    return "revoked";
  }

  if (nameInfo.renewal_height === 0) {
    return "active";
  }

  const currentBurnBlock = await getCurrentBurnBlockHeight(network);
  const renewalHeight = parseInt(nameInfo.renewal_height);

  if (currentBurnBlock > renewalHeight + 5000) {
    return "expired";
  } else if (currentBurnBlock > renewalHeight) {
    return "grace-period";
  } else if (currentBurnBlock > renewalHeight - 4320) {
    return "expiring-soon";
  } else {
    return "active";
  }
}

export function formatNameResponse(nameInfo) {
  return {
    full_name: `${nameInfo.name_string}.${nameInfo.namespace_string}`,
    name_string: nameInfo.name_string,
    namespace_string: nameInfo.namespace_string,
    owner: nameInfo.owner,
    registered_at: nameInfo.registered_at,
    renewal_height: nameInfo.renewal_height,
    stx_burn: nameInfo.stx_burn,
    ...(nameInfo.revoked !== undefined && { revoked: nameInfo.revoked }),
  };
}
