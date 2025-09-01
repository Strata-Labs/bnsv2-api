import { getCurrentBurnBlockHeight } from "../burnblock-service.js";
import { getPool } from "../db.js";
import {
  getNameInfo,
  getNamespaceInfo,
  getNameStatus,
  formatNameResponse,
} from "../query-utils.js";
import cache from "../cache.js";
import {
  getAndValidateZonefile,
  hasValidBtcAddress,
} from "../zonefile-utils.js";

const CACHE_TTL = {
  NAME_LIST: 60,
  NAME_COUNT: 300,
  RARITY: 3600,
};

const nameHandlers = {
  getNameDetails: async (request, reply, { schema, network }) => {
    const [nameString, namespaceString] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);

    const pool = getPool();

    const namespaceResult = await pool.query(
      `SELECT namespace_manager, lifetime FROM ${schema}.namespaces WHERE namespace_string = $1`,
      [namespaceString]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const { namespace_manager, lifetime } = namespaceResult.rows[0];
    const isManaged =
      namespace_manager !== "none" && namespace_manager !== null;

    const result = await pool.query(
      `SELECT 
      name_string,
      namespace_string,
      name_string || '.' || namespace_string AS full_name,
      owner,
      registered_at,
      renewal_height,
      stx_burn,
      revoked,
      imported_at,
      preordered_by,
      CASE 
        WHEN $4 = true THEN true  -- If managed namespace, always valid (unless revoked)
        WHEN renewal_height = 0 THEN true
        WHEN renewal_height > $3 THEN true
        ELSE false
      END as is_valid
     FROM ${schema}.names 
     WHERE name_string = $1 AND namespace_string = $2`,
      [nameString, namespaceString, currentBurnBlock, isManaged]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const nameData = result.rows[0];

    let status;
    if (nameData.revoked) {
      status = "revoked";
    } else if (isManaged) {
      status = "active";
    } else {
      status = await getNameStatus(nameData, network);
    }

    const isValid =
      !nameData.revoked &&
      (isManaged || status === "active" || status === "expiring-soon");

    const formattedResponse = {
      ...nameData,
      is_valid: isValid,
    };

    reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      current_burn_block: currentBurnBlock,
      status: status,
      is_managed: isManaged,
      data: formattedResponse,
    });
  },

  getAllNames: async (request, reply, { schema, network }) => {
    const { limit = 50, offset = 0 } = request.query;

    const safeLimit = Math.min(parseInt(limit), 100);

    const cacheKey = `all_names_${network}_${safeLimit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const queryConfig = {
      text: `SELECT COUNT(*) FROM ${schema}.names`,
      timeout: 30000,
    };

    try {
      const countCacheKey = `all_names_count_${network}`;
      let totalCount = cache.get(countCacheKey);

      if (totalCount === undefined) {
        const countResult = await pool.query(queryConfig);
        totalCount = parseInt(countResult.rows[0].count);
        cache.set(countCacheKey, totalCount, CACHE_TTL.NAME_COUNT);
      }

      const queryConfig2 = {
        text: `SELECT 
          name_string || '.' || namespace_string AS full_name,
          name_string,
          namespace_string,
          owner,
          registered_at,
          renewal_height,
          stx_burn,
          CASE 
            WHEN renewal_height = 0 THEN true
            WHEN renewal_height > $3 THEN true
            ELSE false
          END as is_valid
         FROM ${schema}.names 
         ORDER BY name_string || '.' || namespace_string ASC
         LIMIT $1 OFFSET $2`,
        values: [safeLimit, offset, currentBurnBlock],
        timeout: 30000,
      };

      const result = await pool.query(queryConfig2);

      const response = {
        ...(network === "testnet" && { network: "testnet" }),
        total: totalCount,
        current_burn_block: currentBurnBlock,
        limit: safeLimit,
        offset: parseInt(offset),
        names: result.rows,
      };

      cache.set(cacheKey, response, CACHE_TTL.NAME_LIST);

      reply.send(response);
    } catch (error) {
      if (error.message.includes("timeout")) {
        reply
          .status(504)
          .send({ error: "Query timeout - try with a smaller limit" });
      } else {
        throw error;
      }
    }
  },

  getValidNames: async (request, reply, { schema, network }) => {
    const { limit = 50, offset = 0 } = request.query;
    const cacheKey = `valid_names_${network}_${limit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const countCacheKey = `valid_names_count_${network}_${currentBurnBlock}`;
    let totalCount = cache.get(countCacheKey);

    if (totalCount === undefined) {
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM ${schema}.names 
         WHERE revoked = false 
         AND (renewal_height = 0 OR renewal_height > $1)`,
        [currentBurnBlock]
      );
      totalCount = parseInt(countResult.rows[0].count);
      cache.set(countCacheKey, totalCount, CACHE_TTL.NAME_COUNT);
    }

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn,
        revoked
       FROM ${schema}.names 
       WHERE revoked = false
       AND (renewal_height = 0 OR renewal_height > $3)
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      total: totalCount,
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    };

    cache.set(cacheKey, response, CACHE_TTL.NAME_LIST);

    reply.send(response);
  },

  getExpiredNames: async (request, reply, { schema, network }) => {
    const { limit = 50, offset = 0 } = request.query;
    const cacheKey = `expired_names_${network}_${limit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const countCacheKey = `expired_names_count_${network}_${currentBurnBlock}`;
    let totalCount = cache.get(countCacheKey);

    if (totalCount === undefined) {
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM ${schema}.names 
         WHERE renewal_height != 0 
         AND renewal_height <= $1 
         AND revoked = false`,
        [currentBurnBlock]
      );
      totalCount = parseInt(countResult.rows[0].count);
      cache.set(countCacheKey, totalCount, CACHE_TTL.NAME_COUNT);
    }

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM ${schema}.names 
       WHERE renewal_height != 0 
       AND renewal_height <= $3
       AND revoked = false
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset, currentBurnBlock]
    );

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      total: totalCount,
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    };

    cache.set(cacheKey, response, CACHE_TTL.NAME_LIST);

    reply.send(response);
  },

  getRevokedNames: async (request, reply, { schema, network }) => {
    const { limit = 50, offset = 0 } = request.query;
    const cacheKey = `revoked_names_${network}_${limit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const countCacheKey = `revoked_names_count_${network}`;
    let totalCount = cache.get(countCacheKey);

    if (totalCount === undefined) {
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM ${schema}.names WHERE revoked = true`
      );
      totalCount = parseInt(countResult.rows[0].count);
      cache.set(countCacheKey, totalCount, CACHE_TTL.NAME_COUNT * 2);
    }

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM ${schema}.names 
       WHERE revoked = true
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      total: totalCount,
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    };

    cache.set(cacheKey, response, CACHE_TTL.NAME_LIST * 2);

    reply.send(response);
  },

  getValidNamesByAddress: async (request, reply, { schema, network }) => {
    const { address } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const cacheKey = `valid_names_by_address_${network}_${address}_${limit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND (renewal_height = 0 OR renewal_height > $2)`,
      [address, currentBurnBlock]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn,
        revoked
       FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND (renewal_height = 0 OR renewal_height > $4)
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset, currentBurnBlock]
    );

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    };

    cache.set(cacheKey, response, CACHE_TTL.NAME_LIST / 2);

    reply.send(response);
  },

  getExpiredNamesByAddress: async (request, reply, { schema, network }) => {
    const { address } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const cacheKey = `expired_names_by_address_${network}_${address}_${limit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND renewal_height != 0 
       AND renewal_height <= $2`,
      [address, currentBurnBlock]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND renewal_height != 0 
       AND renewal_height <= $4
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset, currentBurnBlock]
    );

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    };

    cache.set(cacheKey, response, CACHE_TTL.NAME_LIST / 2);

    reply.send(response);
  },

  getExpiringNamesByAddress: async (request, reply, { schema, network }) => {
    const { address } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const cacheKey = `expiring_names_by_address_${network}_${address}_${limit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const expirationWindow = 4320;
    const expirationThreshold = currentBurnBlock + expirationWindow;
    const pool = getPool();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND renewal_height != 0 
       AND renewal_height > $2
       AND renewal_height <= $3`,
      [address, currentBurnBlock, expirationThreshold]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn,
        renewal_height - $4 as blocks_until_expiry
       FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = false
       AND renewal_height != 0 
       AND renewal_height > $4
       AND renewal_height <= $5
       ORDER BY renewal_height ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset, currentBurnBlock, expirationThreshold]
    );

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    };

    cache.set(cacheKey, response, CACHE_TTL.NAME_LIST / 3);

    reply.send(response);
  },

  getRevokedNamesByAddress: async (request, reply, { schema, network }) => {
    const { address } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const cacheKey = `revoked_names_by_address_${network}_${address}_${limit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = true`,
      [address]
    );

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM ${schema}.names 
       WHERE owner = $1 
       AND revoked = true
       ORDER BY name_string || '.' || namespace_string ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset]
    );

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      total: parseInt(countResult.rows[0].count),
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    };

    cache.set(cacheKey, response, CACHE_TTL.NAME_LIST);

    reply.send(response);
  },

  getNamesByNamespace: async (request, reply, { schema, network }) => {
    const { namespace } = request.params;
    const { limit = 50, offset = 0 } = request.query;
    const cacheKey = `names_by_namespace_${network}_${namespace}_${limit}_${offset}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const namespaceExists = await pool.query(
      `SELECT namespace_string FROM ${schema}.namespaces WHERE namespace_string = $1`,
      [namespace]
    );

    if (namespaceExists.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const countCacheKey = `namespace_names_count_${network}_${namespace}`;
    let totalCount = cache.get(countCacheKey);

    if (totalCount === undefined) {
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM ${schema}.names WHERE namespace_string = $1`,
        [namespace]
      );
      totalCount = parseInt(countResult.rows[0].count);
      cache.set(countCacheKey, totalCount, CACHE_TTL.NAME_COUNT);
    }

    const result = await pool.query(
      `SELECT 
        name_string || '.' || namespace_string AS full_name,
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height,
        stx_burn
       FROM ${schema}.names 
       WHERE namespace_string = $1
       ORDER BY name_string ASC
       LIMIT $2 OFFSET $3`,
      [namespace, limit, offset]
    );

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      total: totalCount,
      current_burn_block: currentBurnBlock,
      limit: parseInt(limit),
      offset: parseInt(offset),
      names: result.rows,
    };

    cache.set(cacheKey, response, CACHE_TTL.NAME_LIST);

    reply.send(response);
  },

  resolveName: async (request, reply, { schema, network, apiUrl }) => {
    const [nameString, namespaceString] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const result = await pool.query(
      `SELECT zonefile, owner
     FROM ${schema}.names 
     WHERE name_string = $1 
     AND namespace_string = $2
     AND owner IS NOT NULL
     AND revoked = false
     AND (renewal_height = 0 OR renewal_height > $3)`,
      [nameString, namespaceString, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply
        .code(404)
        .send({ error: "Name not found, expired or revoked" });
    }

    const { zonefile, owner } = result.rows[0];

    const zonefileResult = getAndValidateZonefile(zonefile, owner);

    if (!zonefileResult.success) {
      return reply
        .code(zonefileResult.code)
        .send({ error: zonefileResult.error });
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      zonefile: zonefileResult.zonefile,
    });
  },

  canNameBeRegistered: async (request, reply, { schema, network }) => {
    const { namespace, name } = request.params;
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const namespaceResult = await pool.query(
      `SELECT 
        launched_at,
        namespace_manager
       FROM ${schema}.namespaces 
       WHERE namespace_string = $1`,
      [namespace]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({
        error: "Namespace not found",
        can_register: false,
        reason: "NAMESPACE_NOT_FOUND",
      });
    }

    const namespaceData = namespaceResult.rows[0];

    if (!namespaceData.launched_at) {
      return reply.send({
        can_register: false,
        reason: "NAMESPACE_NOT_LAUNCHED",
      });
    }

    const nameResult = await pool.query(
      `SELECT 
        name_string,
        namespace_string,
        registered_at,
        renewal_height,
        revoked,
        imported_at,
        owner
       FROM ${schema}.names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [name, namespace]
    );

    if (nameResult.rows.length === 0) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        can_register: true,
        reason: "NAME_AVAILABLE",
      });
    }

    const nameData = nameResult.rows[0];

    if (nameData.imported_at) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        can_register: false,
        reason: "NAME_IMPORTED",
        current_owner: nameData.owner,
      });
    }

    if (!namespaceData.namespace_manager && nameData.renewal_height > 0) {
      const isExpired = nameData.renewal_height <= currentBurnBlock;
      if (isExpired) {
        return reply.send({
          ...(network === "testnet" && { network: "testnet" }),
          can_register: true,
          reason: "NAME_EXPIRED",
          previous_owner: nameData.owner,
          expired_at: nameData.renewal_height,
        });
      }
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      can_register: false,
      reason: "NAME_TAKEN",
      current_owner: nameData.owner,
    });
  },

  getNameRenewal: async (request, reply, { schema, network }) => {
    const [nameString, namespaceString] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const namespaceResult = await pool.query(
      `SELECT lifetime::integer, namespace_manager::text FROM ${schema}.namespaces WHERE namespace_string = $1`,
      [namespaceString]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const lifetime = parseInt(namespaceResult.rows[0].lifetime) || 0;
    const namespace_manager = namespaceResult.rows[0].namespace_manager;
    const isManaged =
      namespace_manager !== "none" && namespace_manager !== null;

    const nameResult = await pool.query(
      `SELECT 
        name_string,
        namespace_string,
        registered_at,
        renewal_height::integer,
        revoked,
        imported_at
       FROM ${schema}.names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [nameString, namespaceString]
    );

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const nameData = nameResult.rows[0];

    if (nameData.revoked) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        current_burn_block: currentBurnBlock,
        renewal_height: 0,
        blocks_until_expiry: 0,
        status: "revoked",
        needs_renewal: false,
        is_managed: isManaged,
      });
    }

    if (isManaged) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        current_burn_block: currentBurnBlock,
        renewal_height: 0,
        blocks_until_expiry: 0,
        status: "active",
        needs_renewal: false,
        is_managed: true,
      });
    }

    if (lifetime === 0) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        current_burn_block: currentBurnBlock,
        renewal_height: 0,
        blocks_until_expiry: 0,
        status: "active",
        needs_renewal: false,
        is_managed: false,
      });
    }

    const renewalHeight = parseInt(nameData.renewal_height) || 0;
    let status = "active";
    let needsRenewal = false;
    let blocksUntilExpiry =
      renewalHeight > currentBurnBlock ? renewalHeight - currentBurnBlock : 0;

    if (renewalHeight !== 0) {
      const gracePeriod = 5000;
      const expirationBlock = renewalHeight + gracePeriod;

      if (currentBurnBlock > expirationBlock) {
        status = "expired";
        needsRenewal = false;
      } else if (currentBurnBlock > renewalHeight) {
        status = "grace-period";
        needsRenewal = true;
      } else if (currentBurnBlock > renewalHeight - 4320) {
        status = "expiring-soon";
        needsRenewal = true;
      }
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      current_burn_block: currentBurnBlock,
      renewal_height: renewalHeight,
      blocks_until_expiry: blocksUntilExpiry,
      status: status,
      needs_renewal: needsRenewal,
      is_managed: false,
    });
  },

  canResolve: async (request, reply, { schema, network }) => {
    const [nameString, namespaceString] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const namespaceResult = await pool.query(
      `SELECT 
        lifetime::integer, 
        namespace_manager::text,
        launched_at
       FROM ${schema}.namespaces 
       WHERE namespace_string = $1`,
      [namespaceString]
    );

    if (namespaceResult.rows.length === 0) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const { lifetime, launched_at } = namespaceResult.rows[0];

    if (!launched_at) {
      return reply.status(400).send({
        can_resolve: false,
        error: "Namespace not launched",
      });
    }

    const nameResult = await pool.query(
      `SELECT 
        name_string,
        namespace_string,
        owner,
        registered_at,
        renewal_height::integer,
        revoked,
        imported_at
       FROM ${schema}.names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [nameString, namespaceString]
    );

    if (nameResult.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const nameData = nameResult.rows[0];

    if (nameData.revoked) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        can_resolve: false,
        error: "Name is revoked",
        current_burn_block: currentBurnBlock,
      });
    }

    let renewalHeight = nameData.renewal_height;

    if (lifetime === 0) {
      return reply.send({
        ...(network === "testnet" && { network: "testnet" }),
        can_resolve: true,
        renewal_height: 0,
        owner: nameData.owner,
        current_burn_block: currentBurnBlock,
      });
    }

    if (renewalHeight === 0 && nameData.imported_at) {
      renewalHeight = launched_at + lifetime;
    }

    const isWithinValidPeriod =
      renewalHeight === 0 || currentBurnBlock <= renewalHeight + 5000;

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      can_resolve: isWithinValidPeriod,
      renewal_height: renewalHeight,
      owner: nameData.owner,
      current_burn_block: currentBurnBlock,
      ...(isWithinValidPeriod ? {} : { error: "Name expired" }),
    });
  },

  getNameOwner: async (request, reply, { schema, network }) => {
    const [nameString, namespaceString] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const nameInfo = await getNameInfo(nameString, namespaceString, network);

    if (!nameInfo) {
      return reply.status(404).send({ error: "Name not found" });
    }

    const namespaceInfo = await getNamespaceInfo(namespaceString, network);

    if (!namespaceInfo) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    if (!namespaceInfo.launched_at) {
      return reply.status(400).send({ error: "Namespace not launched" });
    }

    const status = await getNameStatus(nameInfo, network);

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      owner: nameInfo.owner,
      current_burn_block: currentBurnBlock,
      renewal_height: nameInfo.renewal_height,
      status: status,
    });
  },

  getNameId: async (request, reply, { schema, network }) => {
    const [nameString, namespaceString] = request.params.full_name.split(".");
    const pool = getPool();

    const result = await pool.query(
      `SELECT id 
       FROM ${schema}.names 
       WHERE name_string = $1 AND namespace_string = $2`,
      [nameString, namespaceString]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Name not found" });
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      name: nameString,
      namespace: namespaceString,
      id: result.rows[0].id,
    });
  },

  getBtcAddress: async (request, reply, { schema, network }) => {
    const [nameString, namespaceString] = request.params.full_name.split(".");
    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const result = await pool.query(
      `SELECT zonefile, owner
    FROM ${schema}.names
    WHERE name_string = $1
      AND namespace_string = $2
      AND owner IS NOT NULL
      AND revoked = false
      AND (renewal_height = 0 OR renewal_height > $3)`,
      [nameString, namespaceString, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply
        .code(404)
        .send({ error: "Name not found, expired or revoked" });
    }

    const { zonefile, owner } = result.rows[0];

    const zonefileResult = getAndValidateZonefile(zonefile, owner);

    if (!zonefileResult.success) {
      return reply
        .code(zonefileResult.code)
        .send({ error: zonefileResult.error });
    }

    if (!hasValidBtcAddress(zonefileResult.zonefile)) {
      return reply.code(404).send({ error: "No BTC address set in zonefile" });
    }

    return reply.send({
      ...(network === "testnet" && { network: "testnet" }),
      btc: zonefileResult.zonefile.btc,
    });
  },
};

export default nameHandlers;
