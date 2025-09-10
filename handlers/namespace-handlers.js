import { getCurrentBurnBlockHeight } from "../burnblock-service.js";
import cache from "../cache.js";
import { getPool } from "../db.js";
import { getNamespaceInfo } from "../query-utils.js";

const CACHE_TTL = {
  NAMESPACE_LIST: 1800,
  NAMESPACE_COUNT: 3600,
};

const namespaceHandlers = {
  getAllNamespaces: async (request, reply, { schema, network }) => {
    const { limit = 50, offset = 0 } = request.query;
    const cacheKey = `all_namespaces_${network}_${limit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const countCacheKey = `namespaces_count_${network}`;
    let totalCount = cache.get(countCacheKey);

    if (totalCount === undefined) {
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM ${schema}.namespaces`
      );
      totalCount = parseInt(countResult.rows[0].count);
      cache.set(countCacheKey, totalCount, CACHE_TTL.NAMESPACE_COUNT);
    }

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
        can_update_price_function,
        (SELECT COUNT(*) FROM ${schema}.names WHERE names.namespace_string = namespaces.namespace_string) as total_names,
        (SELECT COUNT(*) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND (renewal_height = 0 OR renewal_height > $3)
         AND revoked = false) as active_names
       FROM ${schema}.namespaces 
       ORDER BY namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      total: totalCount,
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      namespaces: result.rows,
    };

    cache.set(cacheKey, response, CACHE_TTL.NAMESPACE_LIST);

    reply.send(response);
  },

  getNamespace: async (request, reply, { schema, network }) => {
    const { namespace } = request.params;
    const cacheKey = `namespace_details_${network}_${namespace}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

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
        can_update_price_function,
        (SELECT COUNT(*) FROM ${schema}.names WHERE names.namespace_string = namespaces.namespace_string) as total_names,
        (SELECT COUNT(*) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND (renewal_height = 0 OR renewal_height > $2)
         AND revoked = false) as active_names,
        (SELECT COUNT(*) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND renewal_height != 0 
         AND renewal_height <= $2
         AND revoked = false) as expired_names,
        (SELECT COUNT(*) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string 
         AND revoked = true) as revoked_names,
        (SELECT MIN(registered_at) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string) as first_registration,
        (SELECT MAX(registered_at) 
         FROM ${schema}.names 
         WHERE names.namespace_string = namespaces.namespace_string) as last_registration
       FROM ${schema}.namespaces 
       WHERE namespace_string = $1`,
      [namespace, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      current_burn_block: currentBurnBlock,
      namespace: result.rows[0],
    };

    cache.set(cacheKey, response, CACHE_TTL.NAMESPACE_LIST);

    reply.send(response);
  },

  getRarestNames: async (request, reply, { schema, network }) => {
    const { namespace } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const cacheKey = `rarest_names_${network}_${namespace}_${limit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const namespaceInfo = await getNamespaceInfo(namespace, network);

    if (!namespaceInfo) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names WHERE namespace_string = $1`,
      [namespace]
    );

    const result = await pool.query(
      `
      WITH name_metrics AS (
        SELECT 
          name_string,
          namespace_string,
          owner,
          LENGTH(name_string) as name_length,
          CASE 
            WHEN name_string ~ '^[0-9]+$' THEN true 
            WHEN name_string ~ '^[a-z]+$' THEN true
            WHEN name_string ~ '[^a-z0-9]' THEN true
            ELSE false 
          END as has_pattern,
          name_string = REVERSE(name_string) as is_palindrome
        FROM ${schema}.names 
        WHERE namespace_string = $1
        AND revoked = false
        AND (renewal_height = 0 OR renewal_height > $4)
      )
      SELECT 
        name_string,
        namespace_string,
        owner,
        name_length,
        has_pattern,
        is_palindrome,
        CASE
          WHEN name_length = 1 THEN 10
          WHEN name_length = 2 THEN 20
          WHEN name_length = 3 THEN 30
          WHEN name_length <= 5 THEN 50
          WHEN name_length <= 7 THEN 70
          ELSE 90
        END - 
        CASE WHEN is_palindrome THEN 5 ELSE 0 END -
        CASE WHEN has_pattern THEN 5 ELSE 0 END
        as rarity_score
      FROM name_metrics
      ORDER BY rarity_score ASC, name_length ASC
      LIMIT $2 OFFSET $3
    `,
      [namespace, limit, offset, currentBurnBlock]
    );

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      rare_names: result.rows.map((name) => ({
        ...name,
        rarity_classification:
          name.rarity_score <= 20
            ? "Ultra Rare"
            : name.rarity_score <= 40
            ? "Rare"
            : name.rarity_score <= 60
            ? "Uncommon"
            : name.rarity_score <= 80
            ? "Common"
            : "Very Common",
      })),
    };

    cache.set(cacheKey, response, CACHE_TTL.NAMESPACE_LIST);

    reply.send(response);
  },
};

export default namespaceHandlers;
