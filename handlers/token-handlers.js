import { getCurrentBurnBlockHeight } from "../burnblock-service.js";
import cache from "../cache.js";
import { getPool } from "../db.js";
import { getNamespaceInfo } from "../query-utils.js";

const CACHE_TTL = {
  TOKEN_DATA: 300,
  LAST_TOKEN_ID: 600,
};

const tokenHandlers = {
  getLastTokenId: async (request, reply, { schema, network }) => {
    const cacheKey = `last_token_id_${network}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const pool = getPool();

    const result = await pool.query(
      `SELECT COALESCE(MAX(id), 0) as last_token_id FROM ${schema}.names`
    );

    const lastTokenId = result.rows[0].last_token_id;

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      last_token_id: lastTokenId,
    };

    cache.set(cacheKey, response, CACHE_TTL.LAST_TOKEN_ID);

    reply.send(response);
  },

  getTokenOwner: async (request, reply, { schema, network }) => {
    const { id } = request.params;
    const cacheKey = `token_owner_${network}_${id}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

    const tokenResult = await pool.query(
      `SELECT 
        n.name_string,
        n.namespace_string,
        n.owner,
        n.revoked,
        n.renewal_height::integer,
        n.registered_at,
        n.imported_at
       FROM ${schema}.names n
       WHERE n.id = $1`,
      [id]
    );

    if (tokenResult.rows.length === 0) {
      return reply.status(404).send({ error: "Token ID not found" });
    }

    const nameData = tokenResult.rows[0];

    const namespaceInfo = await getNamespaceInfo(
      nameData.namespace_string,
      network
    );

    if (!namespaceInfo) {
      return reply.status(404).send({ error: "Namespace not found" });
    }

    const { lifetime, launched_at } = namespaceInfo;

    if (!launched_at) {
      return reply.status(400).send({ error: "Namespace not launched" });
    }

    if (nameData.revoked) {
      const response = {
        ...(network === "testnet" && { network: "testnet" }),
        owner: nameData.owner,
        name: nameData.name_string,
        namespace: nameData.namespace_string,
        current_burn_block: currentBurnBlock,
        status: "revoked",
      };

      cache.set(cacheKey, response, CACHE_TTL.TOKEN_DATA);
      return reply.send(response);
    }

    let renewalHeight = nameData.renewal_height;
    if (renewalHeight === 0 && nameData.imported_at && lifetime !== 0) {
      renewalHeight = launched_at + lifetime;
    }

    if (lifetime === 0) {
      const response = {
        ...(network === "testnet" && { network: "testnet" }),
        owner: nameData.owner,
        name: nameData.name_string,
        namespace: nameData.namespace_string,
        current_burn_block: currentBurnBlock,
        status: "active",
      };

      cache.set(cacheKey, response, CACHE_TTL.TOKEN_DATA);
      return reply.send(response);
    }

    const isWithinValidPeriod =
      renewalHeight === 0 || currentBurnBlock <= renewalHeight + 5000;

    let status = "active";
    if (!isWithinValidPeriod) {
      status = "expired";
    } else if (currentBurnBlock > renewalHeight) {
      status = "grace-period";
    } else if (currentBurnBlock > renewalHeight - 4320) {
      status = "expiring-soon";
    }

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      owner: nameData.owner,
      name: nameData.name_string,
      namespace: nameData.namespace_string,
      current_burn_block: currentBurnBlock,
      renewal_height: renewalHeight,
      status: status,
    };

    cache.set(cacheKey, response, CACHE_TTL.TOKEN_DATA);

    reply.send(response);
  },

  getTokenName: async (request, reply, { schema, network }) => {
    const { id } = request.params;
    const cacheKey = `token_name_${network}_${id}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const pool = getPool();

    const result = await pool.query(
      `SELECT 
        name_string,
        namespace_string
       FROM ${schema}.names 
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Token ID not found" });
    }

    const { name_string, namespace_string } = result.rows[0];

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      id: parseInt(id),
      name: name_string,
      namespace: namespace_string,
      full_name: `${name_string}.${namespace_string}`,
    };

    cache.set(cacheKey, response, CACHE_TTL.TOKEN_DATA * 2);

    reply.send(response);
  },

  getTokenInfo: async (request, reply, { schema, network }) => {
    const { id } = request.params;
    const cacheKey = `token_info_${network}_${id}`;

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return reply.send(cachedResult);
    }

    const currentBurnBlock = await getCurrentBurnBlockHeight(network);
    const pool = getPool();

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
          WHEN renewal_height = 0 THEN true
          WHEN renewal_height > $2 THEN true
          ELSE false
        END as is_valid
       FROM ${schema}.names 
       WHERE id = $1`,
      [id, currentBurnBlock]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: "Token ID not found" });
    }

    const nameData = result.rows[0];
    let status = "active";

    if (nameData.revoked) {
      status = "revoked";
    } else if (!nameData.is_valid) {
      status = "expired";
    }

    const response = {
      ...(network === "testnet" && { network: "testnet" }),
      current_burn_block: currentBurnBlock,
      status: status,
      data: nameData,
    };

    cache.set(cacheKey, response, CACHE_TTL.TOKEN_DATA);

    reply.send(response);
  },
};

export default tokenHandlers;
